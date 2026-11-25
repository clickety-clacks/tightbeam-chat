import type { WorkItemSummary } from './types';

export interface WorkItemCards {
  readonly item: WorkItemSummary;
  readonly cards: readonly { readonly id: string; readonly open: boolean; readonly holderKey: string | null }[];
}

/** One bounded answer about what an item, one of its cards, or an agent is doing. */
export interface WorkItemBreathing {
  readonly reason: string;
  readonly holders: readonly string[];
  readonly turn?: { readonly seq: number | null; readonly sessionKey: string | null; readonly workItemId: string | null;
    readonly startedAt: number | null; readonly endedAt: number | null };
  readonly wake?: { readonly wakeId: string; readonly sessionKey: string | null;
    readonly dueAt: number | null; readonly createdAt: number | null };
}

export interface WorkItemWait {
  readonly id: string;
  readonly sessionKey: string | null;
  readonly creatorSessionKey: string | null;
  readonly state: string | null;
  readonly recurring: boolean;
  readonly conditionKind: string | null;
  readonly conditionScope: string | null;
  readonly dueAt: number | null;
  readonly createdAt: number | null;
  readonly reason: string | null;
}

export interface WorkItemQuestion {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly assignmentId: string | null;
  readonly raiserId: string | null;
  readonly raisedAt: number | null;
  readonly deadlineAt: number | null;
}

export interface AgentQuestion {
  readonly question: string;
  readonly assignmentId: string | null;
  readonly raiserSessionKey: string | null;
  readonly expecterSessionKey: string | null;
  readonly raisedAt: number | null;
}

/** Reads made only for one tapped item. Each call is exactly one Gateway read. */
export interface WorkItemSheetTransport {
  readCards(id: string, signal: AbortSignal): Promise<WorkItemCards | undefined>;
  readItem(id: string, signal: AbortSignal): Promise<WorkItemSummary | undefined>;
  readBreathing(kind: 'work-item' | 'assignment' | 'session', id: string, signal: AbortSignal): Promise<WorkItemBreathing | undefined>;
  readWait(id: string, signal: AbortSignal): Promise<WorkItemWait | undefined>;
  readMyQuestions(signal: AbortSignal): Promise<readonly WorkItemQuestion[]>;
  readAgentQuestions(raisers: readonly string[], signal: AbortSignal): Promise<readonly AgentQuestion[]>;
  readAgentName(sessionKey: string, signal: AbortSignal): Promise<string | undefined>;
}

/** What a wait is for, as far as it can be read. */
export type WaitTarget =
  | { readonly kind: 'item'; readonly title: string }
  | { readonly kind: 'notice'; readonly name: string; readonly scope: string | null }
  | { readonly kind: 'agent'; readonly agent: string }
  | { readonly kind: 'time' };

export type ChainStep =
  | { readonly kind: 'wait'; readonly agent: string; readonly target: WaitTarget; readonly since: number | null;
      readonly until: number | null; readonly recurring: boolean; readonly reason: string | null;
      /** False when the agent did not tie this wait to the tapped item. */
      readonly tied: boolean;
      /** Set by someone other than the agent it wakes. */
      readonly setByOther: boolean }
  | { readonly kind: 'running'; readonly agent: string; readonly title: string | null; readonly since: number | null; readonly tied: boolean }
  | { readonly kind: 'queued'; readonly agent: string }
  | { readonly kind: 'idle'; readonly agent: string; readonly title: string | null; readonly endedAt: number | null }
  | { readonly kind: 'retired'; readonly agent: string }
  | { readonly kind: 'ended'; readonly title: string; readonly state: WorkItemSummary['state'] }
  | { readonly kind: 'nobody'; readonly title: string }
  | { readonly kind: 'loop'; readonly title: string }
  | { readonly kind: 'unreadable'; readonly what: 'notice' | 'time' | 'item' | 'wait' }
  | { readonly kind: 'limit' };

export interface ChainGroup { readonly agent: string; readonly steps: readonly ChainStep[] }

export interface WorkItemSheetData {
  readonly item: WorkItemSummary;
  /** Undefined when the list could not be read, so its absence is never shown as none. */
  readonly questions: readonly (WorkItemQuestion & { readonly asker: string })[] | undefined;
  readonly groups: readonly ChainGroup[];
  readonly moreHolders: number;
  readonly reads: number;
}

export const MAX_CHAIN_STEPS = 6;
export const MAX_SHEET_READS = 30;
const MAX_CARDS = 6;
const FULL_ITEM = /^(?:wi:)?(wi_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const UNKNOWN_AGENT = 'An agent';
const IDLE_REASONS = new Set(['no_current_path', 'latest_terminal_failed', 'latest_terminal_canceled', 'all_open_assignments_not_lively']);

class ReadLimit extends Error {}

/** Names are stable enough for one page; each agent is asked for once. */
export class AgentNames {
  private readonly names = new Map<string, string>();
  get(key: string): string | undefined { return this.names.get(key); }
  set(key: string, name: string): void { this.names.set(key, name); }
}

/**
 * Read one tapped item's open questions and follow each of its agents' waits to
 * the agent that is running, or to the point where nothing more can be read.
 */
export async function readWorkItemSheet(id: string, transport: WorkItemSheetTransport, names: AgentNames,
  signal: AbortSignal, now: () => number = Date.now): Promise<WorkItemSheetData | undefined> {
  let reads = 0;
  const spend = <T>(read: () => Promise<T>): Promise<T> => {
    if (reads >= MAX_SHEET_READS) return Promise.reject(new ReadLimit());
    reads += 1;
    return read();
  };
  // Cards of one item often lead to the same agent or wait; one tap reads each record once.
  const answers = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    let answer = answers.get(key) as Promise<T> | undefined;
    if (!answer) answers.set(key, answer = spend(read));
    return answer;
  };
  const readBreathing = (kind: 'work-item' | 'assignment' | 'session', target: string) =>
    once(`${kind} ${target}`, () => transport.readBreathing(kind, target, signal));
  const pendingNames = new Map<string, Promise<string>>();
  const name = (key: string | null): Promise<string> => {
    if (!key) return Promise.resolve(UNKNOWN_AGENT);
    const known = names.get(key);
    if (known) return Promise.resolve(known);
    let pending = pendingNames.get(key);
    if (!pending) {
      pending = spend(() => transport.readAgentName(key, signal)).then((found) => {
        if (found) names.set(key, found);
        return found ?? UNKNOWN_AGENT;
      }, () => UNKNOWN_AGENT);
      pendingNames.set(key, pending);
    }
    return pending;
  };

  const cards = await spend(() => transport.readCards(id, signal));
  if (!cards) return undefined;
  const { item } = cards;
  const open = item.state === 'open' ? cards.cards.filter((card) => card.open) : [];
  // Every agent before any agent's second card.
  const repeats = (card: typeof open[number], at: number) => card.holderKey !== null && open.findIndex((other) => other.holderKey === card.holderKey) < at;
  const shown = [...open.filter((card, at) => !repeats(card, at)), ...open.filter(repeats)].slice(0, MAX_CARDS);
  const raisers = [...new Set(shown.flatMap((card) => card.holderKey ?? []))];
  const [mine, asked] = await Promise.all([
    item.state === 'open' ? spend(() => transport.readMyQuestions(signal)).catch(() => undefined) : Promise.resolve([]),
    raisers.length ? spend(() => transport.readAgentQuestions(raisers, signal)).catch(() => []) : Promise.resolve([]),
  ]);
  const cardIds = new Set(cards.cards.map((card) => card.id));
  const questions = mine && await Promise.all(mine.filter((question) => question.assignmentId && cardIds.has(question.assignmentId))
    .map(async (question) => ({ ...question, asker: await name(raiserSession(question.raiserId)) })));

  const stopped = (error: unknown): ChainStep[] => [error instanceof ReadLimit ? { kind: 'limit' } : { kind: 'unreadable', what: 'item' }];

  /** A wait's record, then whatever it names. What was already read stays shown. */
  async function followWait(wakeId: string, holder: string | null, title: string | null, tied: boolean,
    visited: ReadonlySet<string>): Promise<ChainStep[]> {
    const wait = await once(`wake ${wakeId}`, () => transport.readWait(wakeId, signal));
    if (!wait) return [{ kind: 'unreadable', what: 'wait' }];
    const agent = await name(wait.sessionKey ?? holder);
    const step = { kind: 'wait' as const, agent, since: wait.createdAt, until: wait.dueAt, recurring: wait.recurring,
      reason: wait.reason, tied, setByOther: Boolean(wait.creatorSessionKey && wait.creatorSessionKey !== wait.sessionKey) };
    if (!wait.conditionKind) return [{ ...step, target: { kind: 'time' } }, { kind: 'unreadable', what: 'time' }];
    const target = FULL_ITEM.exec(wait.conditionScope ?? '')?.[1];
    if (!target) return [{ ...step, target: { kind: 'notice', name: wait.conditionKind, scope: wait.conditionScope } },
      { kind: 'unreadable', what: 'notice' }];
    if (visited.has(target)) {
      return [{ ...step, target: { kind: 'item', title: target === item.id ? item.title : title ?? item.title } },
        { kind: 'loop', title: target === item.id ? item.title : title ?? item.title }];
    }
    let named: WorkItemSummary | undefined;
    try { named = await once(`item ${target}`, () => transport.readItem(target, signal)); }
    catch (error) { return [{ ...step, target: { kind: 'notice', name: wait.conditionKind, scope: null } }, ...stopped(error)]; }
    if (!named) return [{ ...step, target: { kind: 'notice', name: wait.conditionKind, scope: null } }, { kind: 'unreadable', what: 'item' }];
    return [{ ...step, target: { kind: 'item', title: named.title } }, ...await followItem(named, new Set([...visited, target])).catch(stopped)];
  }

  async function followItem(target: WorkItemSummary, visited: ReadonlySet<string>): Promise<ChainStep[]> {
    if (target.state !== 'open') return [{ kind: 'ended', title: target.title, state: target.state }];
    // An unheld item only carries Tightbeam's own reminder, which is not an agent's wait.
    if (!target.holders.length) return [{ kind: 'nobody', title: target.title }];
    if (visited.size >= MAX_CHAIN_STEPS) return [{ kind: 'limit' }];
    const state = await readBreathing('work-item', target.id);
    if (!state) return [{ kind: 'unreadable', what: 'item' }];
    const holder = state.holders[0] ?? target.holders[0];
    const step = await followState(state, holder, target.title, true, visited);
    if (step) return step;
    const agent = await readBreathing('session', holder);
    const own = agent && await followState(agent, holder, target.title, false, visited, target.id);
    return own ?? [await idle(agent, holder, target.title)];
  }

  /** Undefined when nothing is going on, so the caller can look at the agent itself. */
  async function followState(state: WorkItemBreathing, holder: string, title: string | null, tied: boolean,
    visited: ReadonlySet<string>, forItem?: string): Promise<ChainStep[] | undefined> {
    if (state.reason === 'running_turn') {
      const sessionKey = state.turn?.sessionKey ?? holder;
      return [{ kind: 'running', agent: await name(sessionKey), title, since: state.turn?.startedAt ?? null,
        tied: tied || (forItem !== undefined && state.turn?.workItemId === forItem) }];
    }
    if (state.reason === 'queued_turn') return [{ kind: 'queued', agent: await name(state.turn?.sessionKey ?? holder) }];
    if (state.reason === 'holder_retired' || state.reason === 'session_retired') return [{ kind: 'retired', agent: await name(holder) }];
    if (state.reason === 'pending_wake' && state.wake) {
      // Already due means a message on its way, not something the agent waits for.
      if (state.wake.dueAt !== null && state.wake.dueAt <= now()) return [{ kind: 'queued', agent: await name(state.wake.sessionKey ?? holder) }];
      return followWait(state.wake.wakeId, holder, title, tied, visited);
    }
    return undefined;
  }

  /** Only a read answer that nothing is going on may say so. */
  async function idle(state: WorkItemBreathing | undefined, holder: string, title: string | null): Promise<ChainStep> {
    if (!state || !IDLE_REASONS.has(state.reason)) return { kind: 'unreadable', what: 'item' };
    return { kind: 'idle', agent: await name(holder), title, endedAt: state.turn?.endedAt ?? null };
  }

  async function followCard(card: { readonly id: string; readonly holderKey: string | null }): Promise<ChainGroup> {
    const holder = card.holderKey;
    const steps = await (async (): Promise<readonly ChainStep[]> => {
      const visited = new Set([item.id]);
      const state = await readBreathing('assignment', card.id);
      const question = asked.find((row) => row.assignmentId === card.id);
      if (state?.reason !== 'running_turn' && state?.reason !== 'queued_turn' && question) {
        const agent = await name(holder);
        const other = await name(question.expecterSessionKey);
        const wait: ChainStep = { kind: 'wait', agent, target: { kind: 'agent', agent: other }, since: question.raisedAt, until: null,
          recurring: false, reason: question.question || null, tied: true, setByOther: false };
        if (!question.expecterSessionKey) return [wait];
        const expecter = question.expecterSessionKey;
        const doing = await readBreathing('session', expecter);
        return [wait, ...(doing && await followState(doing, expecter, null, false, visited, item.id)) ??
          [await idle(doing, expecter, null)]];
      }
      const own = state && holder && await followState(state, holder, null, true, visited);
      if (own) return own;
      if (!holder) return [{ kind: 'unreadable', what: 'item' }];
      const agent = await readBreathing('session', holder);
      return (agent && await followState(agent, holder, null, false, visited, item.id)) ??
        [await idle(state && agent, holder, null)];
    })().catch(stopped);
    return { agent: await name(holder), steps };
  }

  const followed: { readonly holder: string | null; readonly group: ChainGroup }[] = [];
  // One agent at a time, so a tap never bursts and the read limit falls on the last ones.
  for (const card of shown) followed.push({ holder: card.holderKey, group: await followCard(card) });
  if (signal.aborted) throw new Error('Work item sheet closed.');
  const groups = onePerChain(followed);
  const seen = new Set(shown.map((card) => card.holderKey ?? card.id));
  const moreHolders = new Set(open.map((card) => card.holderKey ?? card.id).filter((key) => !seen.has(key))).size;
  return { item, questions, groups, moreHolders, reads };
}

/** An agent's several cards repeat what it is doing. Show each chain once, and what it did not tie to this item only if nothing is tied. */
function onePerChain(followed: readonly { readonly holder: string | null; readonly group: ChainGroup }[]): ChainGroup[] {
  const tied = ({ group }: { readonly group: ChainGroup }) => {
    const [first] = group.steps;
    return (first?.kind === 'wait' || first?.kind === 'running') ? first.tied : first?.kind === 'queued';
  };
  const same = (group: ChainGroup) => JSON.stringify(group.steps);
  return followed.filter((row, at) => row.holder === null || (
    (tied(row) || !followed.some((other) => other.holder === row.holder && tied(other))) &&
    !followed.slice(0, at).some((other) => other.holder === row.holder && same(other.group) === same(row.group))
  )).map(({ group }) => group);
}

function raiserSession(raiserId: string | null): string | null {
  return raiserId?.startsWith('agent:agent:') ? raiserId.slice('agent:'.length)
    : raiserId?.startsWith('session:') ? raiserId.slice('session:'.length) : null;
}

/** The state a tap found, shown on the sheet in place of the pill's cheaper one. */
export function foundState(data: WorkItemSheetData): 'you' | 'waiting' | 'working' | undefined {
  if (data.questions?.length) return 'you';
  const first = data.groups.flatMap((group) => group.steps[0] ?? []);
  if (first.some((step) => step.kind === 'running' && step.tied)) return 'working';
  return first.some((step) => step.kind === 'wait' && step.tied) ? 'waiting' : undefined;
}
