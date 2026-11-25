import { describe, expect, it } from 'vitest';
import {
  AgentNames, foundState, readWorkItemSheet, MAX_SHEET_READS, type AgentQuestion, type ChainStep, type WorkItemBreathing,
  type WorkItemCards, type WorkItemQuestion, type WorkItemSheetTransport, type WorkItemWait,
} from '../src/workItemChain';
import type { WorkItemSummary } from '../src/workItemPills';
import { createWorkItemPillsTransport } from '../src/workItemPillsTransport';

const NOW = 1_000_000;
const uuid = (n: number) => `wi_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, patch: Partial<WorkItemSummary> = {}): WorkItemSummary => ({ id: uuid(n), title: `Item ${n}`, state: 'open',
  started: true, holders: [`agent:${n}`], failReason: null, createdAt: n, rowVersion: 1, ...patch });
const wait = (id: string, patch: Partial<WorkItemWait> = {}): WorkItemWait => ({ id, sessionKey: 'agent:1', creatorSessionKey: 'agent:1',
  state: 'pending', recurring: false, conditionKind: null, conditionScope: null, dueAt: NOW + 60_000, createdAt: NOW - 60_000, reason: null, ...patch });
const pending = (wakeId: string, dueAt = NOW + 60_000): WorkItemBreathing => ({ reason: 'pending_wake', holders: [], wake: { wakeId, sessionKey: null, dueAt, createdAt: 1 } });
const idle: WorkItemBreathing = { reason: 'no_current_path', holders: [] };
const running = (sessionKey: string, workItemId: string): WorkItemBreathing => ({ reason: 'running_turn', holders: [],
  turn: { seq: 5, sessionKey, workItemId, startedAt: NOW - 1_000, endedAt: null } });

class Fake implements WorkItemSheetTransport {
  items = new Map<string, WorkItemSummary>();
  cards: WorkItemCards['cards'] = [{ id: 'asg_1', open: true, holderKey: 'agent:1' }];
  states = new Map<string, WorkItemBreathing>();
  waits = new Map<string, WorkItemWait>();
  mine: readonly WorkItemQuestion[] = [];
  asked: readonly AgentQuestion[] = [];
  calls: string[] = [];
  constructor(...items: WorkItemSummary[]) { for (const entry of items) this.items.set(entry.id, entry); }
  private call<T>(name: string, value: T): Promise<T> { this.calls.push(name); return Promise.resolve(value); }
  readCards = (id: string) => { const found = this.items.get(id); return this.call('cards', found && { item: found, cards: this.cards }); };
  readItem = (id: string) => this.call('item', this.items.get(id));
  readBreathing = (kind: string, id: string): Promise<WorkItemBreathing | undefined> => this.call(`breathing ${kind}`, this.states.get(id) ?? idle);
  readWait = (id: string) => this.call('wait', this.waits.get(id));
  readMyQuestions = () => this.call('my questions', this.mine);
  readAgentQuestions = () => this.call('agent questions', this.asked);
  readAgentName = (key: string) => this.call('name', key.replace('agent:', 'Agent '));
  again() { this.calls = []; return this.open(); }
  async open(n = 1, names = new AgentNames()) {
    const data = await readWorkItemSheet(uuid(n), this, names, new AbortController().signal, () => NOW);
    expect(data!.reads).toBe(this.calls.length);
    return data!;
  }
}
const kinds = (steps: readonly ChainStep[]) => steps.map((step) => step.kind);

describe('a tap follows the waits', () => {
  it('through other items to the agent that is running, and counts every read', async () => {
    const fake = new Fake(item(1), item(2), item(3));
    fake.states.set('asg_1', pending('w1'));
    fake.waits.set('w1', wait('w1', { conditionKind: 'two-live', conditionScope: uuid(2), reason: 'Needs the wording' }));
    fake.states.set(uuid(2), pending('w2'));
    fake.waits.set('w2', wait('w2', { sessionKey: 'agent:2', creatorSessionKey: 'agent:2', conditionKind: 'three-live', conditionScope: `wi:${uuid(3)}` }));
    fake.states.set(uuid(3), running('agent:3', uuid(3)));
    const data = await fake.open();
    expect(data.groups[0].steps).toEqual([
      { kind: 'wait', agent: 'Agent 1', target: { kind: 'item', title: 'Item 2' }, since: NOW - 60_000, until: NOW + 60_000,
        recurring: false, reason: 'Needs the wording', tied: true, setByOther: false },
      { kind: 'wait', agent: 'Agent 2', target: { kind: 'item', title: 'Item 3' }, since: NOW - 60_000, until: NOW + 60_000,
        recurring: false, reason: null, tied: true, setByOther: false },
      { kind: 'running', agent: 'Agent 3', title: 'Item 3', since: NOW - 1_000, tied: true }]);
    expect(data.reads).toBe(13);
    expect(foundState(data)).toBe('waiting');
  });

  it('shows a plain time and says what it cannot read', async () => {
    const fake = new Fake(item(1));
    fake.states.set('asg_1', pending('w1'));
    fake.waits.set('w1', wait('w1'));
    const data = await fake.open();
    expect(data.groups[0].steps).toEqual([expect.objectContaining({ kind: 'wait', target: { kind: 'time' }, until: NOW + 60_000, reason: null }),
      { kind: 'unreadable', what: 'time' }]);
    expect(data.reads).toBe(6);
  });

  it('keeps a named notice that leads nowhere, and an id it cannot look up', async () => {
    const fake = new Fake(item(1));
    fake.states.set('asg_1', pending('w1'));
    fake.waits.set('w1', wait('w1', { conditionKind: 'release-live', conditionScope: 'release:1' }));
    expect((await fake.open()).groups[0].steps).toEqual([
      expect.objectContaining({ target: { kind: 'notice', name: 'release-live', scope: 'release:1' } }), { kind: 'unreadable', what: 'notice' }]);
    fake.waits.set('w1', wait('w1', { conditionKind: 'live', conditionScope: 'wi_1234abcd' }));
    fake.calls = [];
    expect(kinds((await fake.open()).groups[0].steps)).toEqual(['wait', 'unreadable']);
    fake.waits.set('w1', wait('w1', { conditionKind: 'live', conditionScope: uuid(9) }));
    fake.calls = [];
    expect((await fake.open()).groups[0].steps[1]).toEqual({ kind: 'unreadable', what: 'item' });
  });

  it('stops at a loop', async () => {
    const fake = new Fake(item(1), item(2));
    fake.states.set('asg_1', pending('w1'));
    fake.waits.set('w1', wait('w1', { conditionKind: 'a', conditionScope: uuid(2) }));
    fake.states.set(uuid(2), pending('w2'));
    fake.waits.set('w2', wait('w2', { sessionKey: 'agent:2', conditionKind: 'b', conditionScope: uuid(1) }));
    expect((await fake.open()).groups[0].steps.slice(1)).toEqual([
      expect.objectContaining({ kind: 'wait', target: { kind: 'item', title: 'Item 1' } }), { kind: 'loop', title: 'Item 1' }]);
  });

  it('stops after six items and after thirty reads, keeping what it found', async () => {
    const fake = new Fake(...Array.from({ length: 12 }, (_, i) => item(i + 1)));
    fake.states.set('asg_1', pending('w1'));
    for (let n = 1; n <= 11; n++) {
      fake.waits.set(`w${n}`, wait(`w${n}`, { conditionKind: 'next', conditionScope: uuid(n + 1), sessionKey: `agent:${n}` }));
      fake.states.set(uuid(n + 1), pending(`w${n + 1}`));
    }
    const deep = await fake.open();
    expect(kinds(deep.groups[0].steps)).toEqual(['wait', 'wait', 'wait', 'wait', 'wait', 'limit']);
    expect(deep.reads).toBeLessThanOrEqual(MAX_SHEET_READS);
    fake.calls = [];
    fake.cards = Array.from({ length: 9 }, (_, i) => ({ id: `asg_${i + 1}`, open: true, holderKey: `agent:${i}` }));
    for (let card = 1; card <= 6; card++) {
      const at = (n: number) => uuid(100 * card + n);
      fake.states.set(`asg_${card}`, pending(`c${card}w0`));
      for (let n = 0; n <= 4; n++) {
        fake.items.set(at(n + 1), item(100 * card + n + 1));
        fake.waits.set(`c${card}w${n}`, wait(`c${card}w${n}`, { conditionKind: 'next', conditionScope: at(n + 1) }));
        fake.states.set(at(n + 1), pending(`c${card}w${n + 1}`));
      }
    }
    const wide = await fake.open();
    expect(wide.reads).toBe(MAX_SHEET_READS);
    expect(wide.moreHolders).toBe(3);
    expect(wide.groups[0].steps[0].kind).toBe('wait');
    expect(kinds(wide.groups.at(-1)!.steps)).toEqual(['limit']);
  });

  it('shows an agent with several cards once for each thing it waits on, and reads each record once', async () => {
    const card = (id: string, holderKey: string) => ({ id, open: true, holderKey });
    const fake = new Fake(item(1));
    fake.cards = [card('asg_1', 'agent:1'), card('asg_2', 'agent:1'), card('asg_3', 'agent:1')];
    fake.states.set('agent:1', pending('w1'));
    fake.waits.set('w1', wait('w1'));
    const loose = await fake.open();
    expect(loose.groups.map((group) => kinds(group.steps))).toEqual([['wait', 'unreadable']]);
    expect(fake.calls.filter((call) => call === 'breathing session' || call === 'wait')).toEqual(['breathing session', 'wait']);
    fake.states.set('asg_2', pending('w2'));
    fake.states.set('asg_3', pending('w3'));
    fake.waits.set('w2', wait('w2', { conditionKind: 'two' }));
    fake.waits.set('w3', wait('w3', { conditionKind: 'three' }));
    expect((await fake.again()).groups.map(({ steps: [step] }) => step)).toEqual([
      expect.objectContaining({ tied: true, target: { kind: 'notice', name: 'two', scope: null } }),
      expect.objectContaining({ tied: true, target: { kind: 'notice', name: 'three', scope: null } })]);
  });

  it('follows every agent before any agent’s second card', async () => {
    const fake = new Fake(item(1));
    fake.cards = [1, 1, 1, 1, 1, 1, 2, 3].map((agent, i) => ({ id: `asg_${i + 1}`, open: true, holderKey: `agent:${agent}` }));
    const data = await fake.open();
    expect(data.groups.map((group) => group.agent)).toEqual(['Agent 1', 'Agent 2', 'Agent 3']);
    expect(data.moreHolders).toBe(0);
  });

  it('looks at the agent itself when nothing is tied to the work', async () => {
    const fake = new Fake(item(1));
    fake.states.set('agent:1', pending('w1'));
    fake.waits.set('w1', wait('w1'));
    expect((await fake.open()).groups[0].steps[0]).toMatchObject({ kind: 'wait', tied: false });
    fake.states.set('agent:1', running('agent:1', uuid(8)));
    fake.calls = [];
    const busy = await fake.open();
    expect(busy.groups[0].steps).toEqual([{ kind: 'running', agent: 'Agent 1', title: null, since: NOW - 1_000, tied: false }]);
    expect(foundState(busy)).toBeUndefined();
    fake.states.set('agent:1', { ...idle, turn: { seq: 1, sessionKey: 'agent:1', workItemId: null, startedAt: 1, endedAt: 9 } });
    expect((await fake.again()).groups[0].steps).toEqual([{ kind: 'idle', agent: 'Agent 1', title: null, endedAt: 9 }]);
  });

  it('never calls an answer it did not get idle, or another wait this item’s', async () => {
    const fake = new Fake(item(1), item(2));
    fake.readBreathing = async () => { fake.calls.push('breathing'); return undefined; };
    expect((await fake.open()).groups[0].steps).toEqual([{ kind: 'unreadable', what: 'item' }]);
    const gone = new Fake(item(1));
    gone.states.set('asg_1', { reason: 'assignment_missing', holders: [] });
    gone.states.set('agent:1', { reason: 'session_missing', holders: [] });
    expect((await gone.open()).groups[0].steps).toEqual([{ kind: 'unreadable', what: 'item' }]);
    const asked = new Fake(item(1));
    asked.asked = [{ question: 'Which?', assignmentId: 'asg_1', raiserSessionKey: 'agent:1', expecterSessionKey: 'agent:2', raisedAt: 3 }];
    asked.states.set('agent:2', { reason: 'session_missing', holders: [] });
    expect(kinds((await asked.open()).groups[0].steps)).toEqual(['wait', 'unreadable']);
    const untied = new Fake(item(1));
    untied.states.set('agent:1', pending('w1'));
    untied.waits.set('w1', wait('w1'));
    expect(foundState(await untied.open())).toBeUndefined();
  });

  it('shows a question to another agent, and what that agent is doing', async () => {
    const fake = new Fake(item(1));
    fake.asked = [{ question: 'Which scope?', assignmentId: 'asg_1', raiserSessionKey: 'agent:1', expecterSessionKey: 'agent:2', raisedAt: 3 }];
    fake.states.set('agent:2', running('agent:2', uuid(8)));
    const data = await fake.open();
    expect(data.groups[0].steps).toEqual([
      { kind: 'wait', agent: 'Agent 1', target: { kind: 'agent', agent: 'Agent 2' }, since: 3, until: null, recurring: false,
        reason: 'Which scope?', tied: true, setByOther: false },
      { kind: 'running', agent: 'Agent 2', title: null, since: NOW - 1_000, tied: false }]);
    expect(data.reads).toBe(7);
  });

  it('names the ends that are not waits', async () => {
    const fake = new Fake(item(1), item(2, { state: 'closed' }), item(3, { holders: [] }));
    fake.states.set('asg_1', pending('w1', NOW - 1));
    expect((await fake.open()).groups[0].steps).toEqual([{ kind: 'queued', agent: 'Agent 1' }]);
    fake.states.set('asg_1', { reason: 'holder_retired', holders: [] });
    expect((await fake.again()).groups[0].steps).toEqual([{ kind: 'retired', agent: 'Agent 1' }]);
    fake.states.set('asg_1', pending('w1'));
    fake.waits.set('w1', wait('w1', { conditionKind: 'a', conditionScope: uuid(2) }));
    expect((await fake.again()).groups[0].steps[1]).toEqual({ kind: 'ended', title: 'Item 2', state: 'closed' });
    fake.waits.set('w1', wait('w1', { conditionKind: 'a', conditionScope: uuid(3) }));
    expect((await fake.again()).groups[0].steps[1]).toEqual({ kind: 'nobody', title: 'Item 3' });
  });
});

describe('questions to the reader', () => {
  const question = (assignmentId: string | null): WorkItemQuestion => ({ id: `dr_${assignmentId}`, question: 'Go ahead?', options: ['Yes', 'No'],
    assignmentId, raiserId: 'agent:agent:1', raisedAt: 1, deadlineAt: 2 });

  it('shows only this item’s, including ones asked on finished hand-outs', async () => {
    const fake = new Fake(item(1));
    fake.cards = [{ id: 'asg_1', open: true, holderKey: 'agent:1' }, { id: 'asg_0', open: false, holderKey: 'agent:0' }];
    fake.mine = [question('asg_0'), question('asg_elsewhere'), question(null)];
    const data = await fake.open();
    expect(data.questions).toEqual([{ ...question('asg_0'), asker: 'Agent 1' }]);
    expect(foundState(data)).toBe('you');
    expect(fake.calls.filter((call) => call === 'my questions')).toHaveLength(1);
  });

  it('never shows an unread list as no questions', async () => {
    const fake = new Fake(item(1));
    fake.readMyQuestions = () => { fake.calls.push('my questions'); return Promise.reject(new Error('offline')); };
    expect((await fake.open()).questions).toBeUndefined();
  });

  it('asks nothing more about finished or unheld work', async () => {
    const done = new Fake(item(1, { state: 'closed', holders: [] }));
    done.cards = [];
    expect(await done.open()).toMatchObject({ groups: [], questions: [], reads: 1 });
    const unheld = new Fake(item(1, { holders: [] }));
    unheld.cards = [];
    expect((await unheld.open()).reads).toBe(2);
    expect(await readWorkItemSheet(uuid(9), unheld, new AgentNames(), new AbortController().signal)).toBeUndefined();
  });

  it('asks for each agent’s name once per page', async () => {
    const fake = new Fake(item(1));
    const names = new AgentNames();
    await fake.open(1, names);
    fake.calls = [];
    await fake.open(1, names);
    expect(fake.calls).not.toContain('name');
  });
});

it('maps every sheet read to exactly one service request', async () => {
  const requests: string[] = [];
  const replies: Record<string, unknown> = {
    '/cards/': { item: item(1), cards: [{ id: 'asg_1', state: 'open', holderKey: 'agent:1' }, {}] },
    '/breathing/': { reason: 'pending_wake', holders: ['agent:1'], wake: { wakeId: 'w1', dueAt: 4 } },
    '/wake/': { wake: { conditionKind: 'k', conditionScope: 's', consumer: 'cron', dueAt: 4 } },
    '/open-questions': { questions: [{ id: 'dr_1', question: 'Q', options: ['Yes', 3] }] },
    '/agent-questions': { questions: [{ question: 'Help', assignmentId: 'asg_1' }] },
    '/sessions/': { item: { displayName: 'Agent 1' } },
  };
  const transport = createWorkItemPillsTransport({ baseUrl: 'https://chat.example/__chat/', fetch: async (input) => {
    const url = new URL(input);
    requests.push(url.pathname + url.search);
    return new Response(JSON.stringify(Object.entries(replies).find(([part]) => url.pathname.includes(part))![1]));
  }, openAuthenticatedWorkChanges: async () => { throw new Error('unused'); } });
  const { signal } = new AbortController();
  expect((await transport.readCards('wi_1', signal))!.cards).toEqual([{ id: 'asg_1', open: true, holderKey: 'agent:1' }]);
  expect(await transport.readBreathing('session', 'agent:1 a', signal)).toEqual({ reason: 'pending_wake', holders: ['agent:1'],
    wake: { wakeId: 'w1', sessionKey: null, dueAt: 4, createdAt: null } });
  expect(await transport.readWait('w1', signal)).toMatchObject({ id: 'w1', recurring: true, conditionKind: 'k', reason: null });
  expect((await transport.readMyQuestions(signal))[0]).toMatchObject({ id: 'dr_1', options: ['Yes'] });
  expect(await transport.readAgentQuestions(['agent:1', 'agent:2'], signal)).toHaveLength(1);
  expect(await transport.readAgentName('agent:1', signal)).toBe('Agent 1');
  expect(requests).toEqual(['/__chat/api/pills/cards/wi_1', '/__chat/api/pills/breathing/session/agent%3A1%20a', '/__chat/api/pills/wake/w1',
    '/__chat/api/pills/open-questions', '/__chat/api/pills/agent-questions?raiser=agent%3A1&raiser=agent%3A2', '/__chat/api/sessions/agent%3A1']);
});
