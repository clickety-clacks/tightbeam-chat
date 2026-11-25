import { decodeWorkItemSummary, type Public019Channel } from './public019';
import type {
  WorkItemBreathing, WorkItemCards, WorkItemQuestion, WorkItemSheetTransport, WorkItemWait, AgentQuestion,
} from './workItemChain';
import type {
  WorkItemChange, WorkItemChangeConnection, WorkItemLiveTransport, WorkItemTurn,
} from './workItemPills';

export type WorkItemPillsTransport = WorkItemLiveTransport & WorkItemSheetTransport;

export interface WorkItemPillsTransportConfig {
  /** Approved host route; no credentials, query, or fragment. */
  readonly baseUrl: string;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  /** Connect the change stream without a selected session and authenticate it. */
  readonly openAuthenticatedWorkChanges: (signal: AbortSignal) => Promise<Public019Channel>;
  readonly responseTimeoutMs?: number;
  /** The Gateway sends a heartbeat every 15 seconds; the default allows three. */
  readonly heartbeatTimeoutMs?: number;
}

const CHANGE_CLASSES = ['work_item.', 'turn.started', 'turn.ended'];

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter(isRow) : [];

export function createWorkItemPillsTransport(config: WorkItemPillsTransportConfig): WorkItemPillsTransport {
  const base = config.baseUrl.replace(/\/$/, '');
  const responseTimeoutMs = config.responseTimeoutMs ?? 15_000;
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 45_000;

  async function read(path: string, signal: AbortSignal): Promise<Row | undefined> {
    const response = await config.fetch(`${base}/api/${path}`, { method: 'GET', signal, cache: 'no-store' });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Work item read failed with HTTP ${response.status}.`);
    const body: unknown = await response.json();
    if (!isRow(body)) throw new Error('Work item read returned unusable data.');
    return body;
  }
  const one = (name: string, id: string) => `pills/${name}/${encodeURIComponent(id)}`;
  const usable = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('Work item read returned unusable data.');
    return value;
  };

  return {
    async readItem(id, signal) {
      const body = await read(one('work-item', id), signal);
      return body && decodeWorkItemSummary(body.item);
    },
    async readTurn(seq, signal): Promise<WorkItemTurn | undefined> {
      const body = await read(one('turn', String(seq)), signal);
      if (!body) return undefined;
      if (!isRow(body.turn) || number(body.turn.seq) !== seq) throw new Error('Work item read returned unusable data.');
      return { seq, workItemId: text(body.turn.workItemId), status: text(body.turn.status) };
    },
    async readCards(id, signal): Promise<WorkItemCards | undefined> {
      const body = await read(one('cards', id), signal);
      return body && { item: decodeWorkItemSummary(body.item), cards: rows(body.cards).flatMap((card) => {
        const cardId = text(card.id);
        return cardId ? [{ id: cardId, open: card.state === 'open', holderKey: text(card.holderKey) }] : [];
      }) };
    },
    async readBreathing(kind, id, signal): Promise<WorkItemBreathing | undefined> {
      const body = await read(`pills/breathing/${kind}/${encodeURIComponent(id)}`, signal);
      if (!body) return undefined;
      const reason = usable(text(body.reason) ?? undefined);
      const turn = isRow(body.turn) ? { seq: number(body.turn.seq), sessionKey: text(body.turn.sessionKey),
        workItemId: text(body.turn.workItemId), startedAt: number(body.turn.startedAt), endedAt: number(body.turn.endedAt) } : undefined;
      const wakeId = isRow(body.wake) ? text(body.wake.wakeId) : null;
      const wake = isRow(body.wake) && wakeId ? { wakeId, sessionKey: text(body.wake.sessionKey),
        dueAt: number(body.wake.dueAt), createdAt: number(body.wake.createdAt) } : undefined;
      return { reason, holders: Array.isArray(body.holders) ? body.holders.filter((key): key is string => typeof key === 'string') : [],
        ...(turn ? { turn } : {}), ...(wake ? { wake } : {}) };
    },
    async readWait(id, signal): Promise<WorkItemWait | undefined> {
      const body = await read(one('wake', id), signal);
      if (!body) return undefined;
      if (!isRow(body.wake)) throw new Error('Work item read returned unusable data.');
      const { wake } = body;
      return { id, sessionKey: text(wake.sessionKey), creatorSessionKey: text(wake.creatorSessionKey), state: text(wake.state),
        recurring: wake.consumer === 'cron', conditionKind: text(wake.conditionKind), conditionScope: text(wake.conditionScope),
        dueAt: number(wake.dueAt), createdAt: number(wake.createdAt), reason: text(wake.reason) };
    },
    async readMyQuestions(signal): Promise<readonly WorkItemQuestion[]> {
      const body = usable(await read('pills/open-questions', signal));
      return rows(body.questions).flatMap((row) => {
        const id = text(row.id);
        return id ? [{ id, question: text(row.question) ?? '', assignmentId: text(row.assignmentId), raiserId: text(row.raiserId),
          raisedAt: number(row.raisedAt), deadlineAt: number(row.deadlineAt),
          options: Array.isArray(row.options) ? row.options.filter((label): label is string => typeof label === 'string') : [] }] : [];
      });
    },
    async readAgentQuestions(raisers, signal): Promise<readonly AgentQuestion[]> {
      const query = new URLSearchParams(raisers.map((raiser) => ['raiser', raiser]));
      const body = usable(await read(`pills/agent-questions?${query}`, signal));
      return rows(body.questions).map((row) => ({ question: text(row.question) ?? '', assignmentId: text(row.assignmentId),
        raiserSessionKey: text(row.raiserSessionKey), expecterSessionKey: text(row.expecterSessionKey), raisedAt: number(row.raisedAt) }));
    },
    async readAgentName(sessionKey, signal) {
      const body = await read(`sessions/${encodeURIComponent(sessionKey)}`, signal);
      return (body && isRow(body.item) && text(body.item.displayName)) || undefined;
    },

    async openChanges(onChange: (change: WorkItemChange) => void, onLost: () => void, signal): Promise<WorkItemChangeConnection> {
      const channel = await config.openAuthenticatedWorkChanges(signal);
      const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      const watched = new Set<string>();
      let closed = false;
      let lastSeq = 0;
      let heartbeat: ReturnType<typeof setTimeout> | undefined;
      let stopListening = () => {};
      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearTimeout(heartbeat);
        stopListening();
        signal.removeEventListener('abort', close);
        for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new Error('Work item changes closed.')); }
        pending.clear();
        channel.close();
      };
      const lose = () => { if (!closed) { close(); onLost(); } };
      const alive = () => {
        if (heartbeat) clearTimeout(heartbeat);
        if (!closed) heartbeat = setTimeout(lose, heartbeatTimeoutMs);
      };
      stopListening = channel.listen((frame) => {
        if (closed) return;
        if (!isRow(frame)) { lose(); return; }
        if (frame.type === 'subscription_ready') {
          const wait = pending.get(String(frame.subscriptionId));
          if (wait) { pending.delete(String(frame.subscriptionId)); clearTimeout(wait.timer); wait.resolve(); }
        } else if (frame.type === 'change' || frame.type === 'heartbeat') {
          // A gap means a notice was missed, so nothing shown can be trusted until it is read again.
          const expected = frame.type === 'change' ? lastSeq + 1 : lastSeq;
          if (frame.seq !== expected) { lose(); return; }
          lastSeq = expected;
          if (frame.type === 'change') {
            const refs = isRow(frame.refs) ? frame.refs : {};
            const workItemId = text(refs.workItemId);
            const name = text(frame.class) ?? '';
            if (workItemId && watched.has(workItemId)) {
              if (name.startsWith('work_item.')) onChange({ kind: 'item', workItemId });
              else if ((name === 'turn.started' || name === 'turn.ended') && Number.isSafeInteger(refs.turnSeq)) {
                onChange({ kind: 'turn', workItemId, turnSeq: refs.turnSeq as number, ended: name === 'turn.ended' });
              }
            }
          }
        } else if (frame.type !== 'subscription_removed') { lose(); return; }
        alive();
      }, lose);
      signal.addEventListener('abort', close, { once: true });
      if (signal.aborted) { close(); throw new Error('Work item changes aborted.'); }
      alive();
      return {
        watch(workItemId) {
          return new Promise<void>((resolve, reject) => {
            if (closed) { reject(new Error('Work item changes closed.')); return; }
            const subscriptionId = `work-item:${workItemId}`;
            watched.add(workItemId);
            const timer = setTimeout(() => lose(), responseTimeoutMs);
            pending.set(subscriptionId, { resolve, reject, timer });
            channel.send({ type: 'subscribe', protocolVersion: 2, subscriptionId, filters: { workItemId, classes: CHANGE_CLASSES } });
          });
        },
        unwatch(workItemId) {
          if (closed || !watched.delete(workItemId)) return;
          channel.send({ type: 'unsubscribe', subscriptionId: `work-item:${workItemId}` });
        },
        close,
      };
    },
  };
}
