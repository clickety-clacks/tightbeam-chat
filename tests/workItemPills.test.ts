import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkItemPills, type WorkItemSummary } from '../src/workItemPills';
import { createWorkItemPillsTransport } from '../src/workItemPillsTransport';

const summary = (n: number, patch: Partial<WorkItemSummary> = {}): WorkItemSummary => ({
  id: `wi_${n}`, title: `Item ${n}`, state: 'open', started: true, holders: ['agent:a'], failReason: null,
  createdAt: n, rowVersion: 1, ...patch });
const mapOf = (items: readonly WorkItemSummary[]) => new Map(items.map((item) => [item.id, item]));

/** Counts every Gateway read a strip makes, and plays the change connection. */
class FakeGateway {
  items = new Map<string, WorkItemSummary>();
  turns = new Map<number, { workItemId: string; status: string }>();
  pageReads = 0;
  itemReads: string[] = [];
  turnReads: number[] = [];
  subscriptions: string[] = [];
  removed: string[] = [];
  connections = 0;
  failReads = false;
  refuseConnections = false;
  silent = false;
  private emit: ((frame: unknown) => void) | undefined;
  private lose: (() => void) | undefined;
  private seq = 0;
  pills: WorkItemPills;

  constructor(items: readonly WorkItemSummary[]) {
    this.items = new Map(items.map((item) => [item.id, item]));
    const transport = createWorkItemPillsTransport({ baseUrl: 'https://chat.example/__chat',
      fetch: async (input) => {
        if (this.failReads) throw new Error('offline');
        const url = new URL(input);
        const [, kind, id] = /\/api\/pills\/([a-z-]+)\/(.+)$/.exec(url.pathname)!;
        if (kind === 'work-item') {
          this.itemReads.push(id);
          const item = this.items.get(id);
          return new Response(JSON.stringify(item ? { item } : { error: {} }), { status: item ? 200 : 404 });
        }
        const seq = Number(id);
        this.turnReads.push(seq);
        return new Response(JSON.stringify({ turn: { seq, sessionKey: 'agent:a', ...this.turns.get(seq) } }));
      },
      openAuthenticatedWorkChanges: async () => {
        if (this.refuseConnections) throw new Error('refused');
        this.connections += 1;
        this.seq = 0;
        const beat = setInterval(() => { if (!this.silent) this.emit?.({ type: 'heartbeat', seq: this.seq }); }, 15_000);
        return {
          send: (frame) => {
            if (frame.type === 'unsubscribe') this.removed.push(String(frame.subscriptionId));
            if (frame.type !== 'subscribe') return;
            expect(frame.filters).toEqual({ workItemId: expect.stringMatching(/^wi_/), classes: ['work_item.', 'turn.started', 'turn.ended'] });
            this.subscriptions.push(String(frame.subscriptionId));
            queueMicrotask(() => this.emit?.({ type: 'subscription_ready', subscriptionId: frame.subscriptionId }));
          },
          listen: (onFrame, onClose) => { this.emit = onFrame; this.lose = () => onClose(); return () => { this.emit = undefined; }; },
          close: () => { clearInterval(beat); this.emit = undefined; },
        };
      } });
    this.pills = new WorkItemPills({ transport, refreshItems: () => this.readPage() });
  }
  readPage() { this.pageReads += 1; this.pills.setItems(mapOf([...this.items.values()].map((item) => ({ ...item })))); }
  async load() { await this.pills.watch(this.items.keys()); this.readPage(); await settle(); }
  notice(name: string, refs: Record<string, unknown>) {
    this.emit?.({ type: 'change', seq: ++this.seq, class: name, refs, payload: { state: 'never used as state' } });
  }
  change(n: number, patch: Partial<WorkItemSummary> = {}, name = 'work_item.updated') {
    const old = this.items.get(`wi_${n}`)!;
    this.items.set(old.id, { ...old, ...patch, rowVersion: old.rowVersion + 1 });
    this.notice(name, { workItemId: old.id });
  }
  turn(seq: number, n: number, status: 'running' | 'delivered') {
    this.turns.set(seq, { workItemId: `wi_${n}`, status });
    this.notice(status === 'running' ? 'turn.started' : 'turn.ended', { workItemId: `wi_${n}`, turnSeq: seq });
  }
  disconnect() { this.lose?.(); }
  raw(frame: unknown) { this.emit?.(frame); }
  see(...ns: number[]) { this.pills.setVisible(new Set(ns.map((n) => `wi_${n}`))); }
  pill(n: number) { return this.pills.getSnapshot().find((pill) => pill.id === `wi_${n}`)!; }
  get liveReads() { return this.itemReads.length + this.turnReads.length; }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const pass = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await settle(); };
const gateways: FakeGateway[] = [];
const strip = async (count: number, patch: Partial<WorkItemSummary> = {}) => {
  const gateway = new FakeGateway(Array.from({ length: count }, (_, i) => summary(i + 1, patch)));
  gateways.push(gateway);
  await gateway.load();
  return gateway;
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const gateway of gateways.splice(0)) gateway.pills.dispose(); vi.useRealTimers(); });

describe('reads per loaded screen', () => {
  it.each([10, 50])('paints %i pills from the one page read and nothing else', async (count) => {
    const gateway = await strip(count);
    gateway.see(1, 2, 3);
    await pass(3_600_000);
    expect(gateway.pills.getSnapshot()).toHaveLength(count);
    expect(gateway.pills.getSnapshot().every((pill) => !pill.stale)).toBe(true);
    expect({ pages: gateway.pageReads, live: gateway.liveReads, connections: gateway.connections }).toEqual({ pages: 1, live: 0, connections: 1 });
    expect(new Set(gateway.subscriptions).size).toBe(count);
  });

  it.each([10, 50])('an hour of changes to every one of %i pills reads only the three in view', async (count) => {
    const gateway = await strip(count);
    gateway.see(1, 2, 3);
    // One change per item every 20 minutes: 3 an hour, the busy pace.
    for (let round = 0; round < 3; round++) {
      for (let n = 1; n <= count; n++) gateway.change(n);
      await pass(1_200_000);
    }
    expect({ pages: gateway.pageReads, items: gateway.itemReads.length, turns: gateway.turnReads.length })
      .toEqual({ pages: 1, items: 9, turns: 0 });
    expect(new Set(gateway.itemReads)).toEqual(new Set(['wi_1', 'wi_2', 'wi_3']));
  });

  it.each([10, 50])('a turn on every one of %i pills costs one read at its start and one at its end, in view only', async (count) => {
    const gateway = await strip(count);
    gateway.see(1, 2, 3);
    for (let n = 1; n <= count; n++) gateway.turn(100 + n, n, 'running');
    await pass(60_000);
    for (let n = 1; n <= count; n++) gateway.turn(100 + n, n, 'delivered');
    await pass(3_600_000);
    expect(gateway.turnReads).toHaveLength(6);
    expect(gateway.itemReads).toHaveLength(0);
    gateway.see(...Array.from({ length: count }, (_, i) => i + 1));
    await pass(60_000);
    expect(gateway.turnReads).toHaveLength(6);
  });

  it('never subscribes to or reads more than one connection can carry', async () => {
    const gateway = await strip(120);
    expect(gateway.pills.getSnapshot()).toHaveLength(100);
    expect(new Set(gateway.subscriptions).size).toBe(100);
  });
});

describe('states from the one read', () => {
  it('names each state, newest first, without a ring', async () => {
    const gateway = await strip(0);
    gateway.pills.setItems(mapOf([
      summary(1, { started: false, holders: [] }), summary(2), summary(3, { holders: [] }), summary(4, { state: 'closed' }),
      summary(5, { state: 'failed' }), summary(6, { state: 'iceboxed' })]));
    expect(gateway.pills.getSnapshot().map((pill) => [pill.id, pill.state])).toEqual([
      ['wi_6', 'shelved'], ['wi_5', 'failed'], ['wi_4', 'done'], ['wi_3', 'between-hands'], ['wi_2', 'held'], ['wi_1', 'not-started']]);
  });
});

describe('changes', () => {
  it('marks a pill at once, never takes state from the notice, and reads it after five quiet seconds', async () => {
    const gateway = await strip(3);
    gateway.see(1);
    gateway.change(1, { state: 'closed' }, 'work_item.closed');
    expect(gateway.pill(1)).toMatchObject({ state: 'held', stale: true });
    await pass(4_000);
    gateway.change(1);
    await pass(4_999);
    expect(gateway.itemReads).toEqual([]);
    await pass(1);
    expect(gateway.itemReads).toEqual(['wi_1']);
    expect(gateway.pill(1)).toMatchObject({ state: 'done', stale: false });
  });

  it('reads one item at most every two minutes and keeps it marked meanwhile', async () => {
    const gateway = await strip(1);
    gateway.see(1);
    gateway.change(1);
    await pass(5_000);
    gateway.change(1, { holders: [] });
    await pass(115_000);
    expect(gateway.itemReads).toHaveLength(1);
    expect(gateway.pill(1)).toMatchObject({ state: 'held', stale: true });
    await pass(5_000);
    expect(gateway.itemReads).toHaveLength(2);
    expect(gateway.pill(1)).toMatchObject({ state: 'between-hands', stale: false });
  });

  it('waits for five quiet seconds however long a pill keeps changing', async () => {
    const gateway = await strip(1);
    gateway.see(1);
    for (let i = 0; i < 100; i++) { gateway.change(1); await pass(4_000); }
    expect(gateway.itemReads).toEqual([]);
    expect(gateway.pill(1).stale).toBe(true);
    await pass(1_000);
    expect(gateway.itemReads).toEqual(['wi_1']);
  });

  it('waits for a pill out of view or a page in the background', async () => {
    const gateway = await strip(2);
    gateway.see(1);
    gateway.change(2);
    await pass(600_000);
    expect(gateway.itemReads).toEqual([]);
    expect(gateway.pill(2).stale).toBe(true);
    gateway.pills.setVisible(new Set(['wi_2']), false);
    await pass(60_000);
    expect(gateway.itemReads).toEqual([]);
    gateway.pills.setVisible(new Set(['wi_2']), true);
    await settle();
    expect(gateway.itemReads).toEqual(['wi_2']);
  });

  it('runs the one page read when more than three pills in view need it', async () => {
    const gateway = await strip(10);
    gateway.see(1, 2, 3, 4);
    for (const n of [1, 2, 3, 4]) { gateway.change(n, { holders: [] }); vi.advanceTimersByTime(40); }
    await pass(5_000);
    expect({ pages: gateway.pageReads, items: gateway.itemReads.length }).toEqual({ pages: 2, items: 0 });
    expect(gateway.pill(4)).toMatchObject({ state: 'between-hands', stale: false });
  });

  it('keeps a pill marked when it changes again during its read, and after a failed read', async () => {
    const gateway = await strip(1);
    gateway.see(1);
    gateway.change(1);
    vi.advanceTimersByTime(5_000);
    gateway.change(1);
    await settle();
    expect(gateway.pill(1).stale).toBe(true);
    gateway.failReads = true;
    await pass(120_000);
    expect(gateway.pill(1).stale).toBe(true);
    gateway.failReads = false;
    await pass(120_000);
    expect(gateway.pill(1).stale).toBe(false);
  });

  it('drops a pill the Gateway no longer shows this reader', async () => {
    const gateway = await strip(2);
    gateway.see(1);
    gateway.change(1);
    gateway.items.delete('wi_1');
    await pass(5_000);
    expect(gateway.pills.getSnapshot().map((pill) => pill.id)).toEqual(['wi_2']);
  });
});

describe('the ring', () => {
  it('goes on only for a turn read as running on this item, and off when every confirmed turn is read as ended', async () => {
    const gateway = await strip(1);
    gateway.see(1);
    gateway.turn(7, 1, 'running');
    expect(gateway.pill(1).state).toBe('held');
    await settle();
    expect(gateway.pill(1).state).toBe('working');
    gateway.turn(8, 1, 'running');
    await settle();
    gateway.turn(7, 1, 'delivered');
    await settle();
    expect(gateway.pill(1).state).toBe('working');
    gateway.turn(8, 1, 'delivered');
    await settle();
    expect(gateway.pill(1).state).toBe('held');
    expect(gateway.turnReads).toEqual([7, 8, 7, 8]);
  });

  it('ignores a turn that has already ended or belongs to other work', async () => {
    const gateway = await strip(1);
    gateway.see(1);
    gateway.turns.set(7, { workItemId: 'wi_1', status: 'delivered' });
    gateway.notice('turn.started', { workItemId: 'wi_1', turnSeq: 7 });
    gateway.turns.set(8, { workItemId: 'wi_9', status: 'running' });
    gateway.notice('turn.started', { workItemId: 'wi_1', turnSeq: 8 });
    await settle();
    expect(gateway.pill(1).state).toBe('held');
  });

  it('holds an item re-read until the ring ends', async () => {
    const gateway = await strip(1);
    gateway.see(1);
    gateway.turn(7, 1, 'running');
    await settle();
    gateway.change(1, { holders: [] });
    await pass(300_000);
    expect(gateway.itemReads).toEqual([]);
    expect(gateway.pill(1)).toMatchObject({ state: 'working', stale: false });
    gateway.turn(7, 1, 'delivered');
    await settle();
    expect(gateway.pill(1)).toMatchObject({ state: 'held', stale: true });
    await pass(5_000);
    expect(gateway.pill(1)).toMatchObject({ state: 'between-hands', stale: false });
  });

  it('checks a ring still on every ten minutes, so a missed end clears', async () => {
    const gateway = await strip(1);
    gateway.see(1);
    gateway.turn(7, 1, 'running');
    await settle();
    gateway.turns.set(7, { workItemId: 'wi_1', status: 'delivered' });
    await pass(599_999);
    expect(gateway.pill(1).state).toBe('working');
    await pass(1);
    expect(gateway.pill(1).state).toBe('held');
    expect(gateway.turnReads).toEqual([7, 7]);
  });

  it('reads a turn that started out of view when its pill comes into view', async () => {
    const gateway = await strip(2);
    gateway.see(1);
    gateway.turn(7, 2, 'running');
    await pass(60_000);
    expect(gateway.turnReads).toEqual([]);
    gateway.see(2);
    await settle();
    expect(gateway.pill(2).state).toBe('working');
  });
});

describe('a turn read that fails', () => {
  it('is tried again ever less often while in view, until the ring can be shown', async () => {
    const gateway = await strip(1);
    gateway.see(1);
    gateway.failReads = true;
    gateway.turn(7, 1, 'running');
    await pass(59_999);
    expect(gateway.pill(1).state).toBe('held');
    gateway.failReads = false;
    await pass(1);
    expect(gateway.pill(1).state).toBe('working');
    gateway.failReads = true;
    gateway.turn(7, 1, 'delivered');
    await pass(60_000);
    await pass(60_000);
    gateway.failReads = false;
    expect(gateway.pill(1).state).toBe('working');
    await pass(60_000);
    expect(gateway.pill(1).state).toBe('held');
  });

  it('waits out of view', async () => {
    const gateway = await strip(1);
    gateway.see(1);
    gateway.failReads = true;
    gateway.turn(7, 1, 'running');
    await settle();
    gateway.see();
    gateway.failReads = false;
    await pass(3_600_000);
    expect(gateway.turnReads).toEqual([]);
    gateway.see(1);
    await settle();
    expect(gateway.turnReads).toEqual([7]);
  });
});

describe('the loaded items', () => {
  it('drops items that are no longer loaded, with their subscriptions', async () => {
    const gateway = await strip(3);
    gateway.pills.setItems(mapOf([summary(2), summary(3)]));
    expect(gateway.pills.getSnapshot().map((pill) => pill.id)).toEqual(['wi_3', 'wi_2']);
    expect(gateway.removed).toEqual(['work-item:wi_1']);
    gateway.subscriptions = [];
    gateway.disconnect();
    await pass(1_000);
    expect(gateway.subscriptions.sort()).toEqual(['work-item:wi_2', 'work-item:wi_3']);
  });

  it('never fills the connection with items that have left', async () => {
    const gateway = await strip(0);
    for (let page = 0; page < 5; page++) {
      const items = Array.from({ length: 60 }, (_, i) => summary(page * 60 + i + 1));
      await gateway.pills.watch(items.map((item) => item.id));
      gateway.pills.setItems(mapOf(items));
    }
    expect(gateway.pills.getSnapshot()).toHaveLength(60);
    expect(gateway.pills.getSnapshot()[0].id).toBe('wi_300');
  });

  it('reads one newly filed item once, and a burst as one list read', async () => {
    const gateway = await strip(2);
    gateway.see(1);
    gateway.items.set('wi_9', summary(9));
    gateway.pills.addFiled('wi_9');
    gateway.pills.addFiled('wi_9');
    await settle();
    expect(gateway.itemReads).toEqual([]);
    await pass(5_000);
    expect(gateway.itemReads).toEqual(['wi_9']);
    expect(gateway.pills.getSnapshot()[0].id).toBe('wi_9');
    await pass(600_000);
    for (let n = 10; n < 16; n++) { gateway.items.set(`wi_${n}`, summary(n)); gateway.pills.addFiled(`wi_${n}`); }
    await pass(5_000);
    expect({ pages: gateway.pageReads, items: gateway.itemReads.length }).toEqual({ pages: 2, items: 1 });
    expect(gateway.pills.getSnapshot()[0].id).toBe('wi_15');
  });

  it('keeps a filed item that its list read has not covered yet, and waits while out of view', async () => {
    const gateway = await strip(1);
    gateway.items.set('wi_9', summary(9));
    gateway.pills.addFiled('wi_9');
    await pass(600_000);
    expect(gateway.itemReads).toEqual([]);
    gateway.see(1);
    await settle();
    expect(gateway.itemReads).toEqual(['wi_9']);
    gateway.pills.setItems(mapOf([summary(1, { rowVersion: 2 })]));
    expect(gateway.pills.getSnapshot().map((pill) => pill.id)).toEqual(['wi_9', 'wi_1']);
  });
});

describe('the connection', () => {
  it('reads nothing on reconnecting while hidden, and at most one list in two minutes however often it drops', async () => {
    const gateway = await strip(3);
    gateway.pills.setVisible(new Set(['wi_1']), false);
    gateway.disconnect();
    await pass(60_000);
    expect(gateway.pageReads).toBe(1);
    gateway.see(1);
    await settle();
    expect(gateway.pageReads).toBe(2);
    for (let i = 0; i < 10; i++) { gateway.disconnect(); await pass(8_000); }
    expect({ pages: gateway.pageReads, live: gateway.liveReads }).toEqual({ pages: 2, live: 0 });
    expect(gateway.pill(1).stale).toBe(true);
    await pass(120_000);
    expect(gateway.pageReads).toBe(3);
    expect(gateway.pill(1).stale).toBe(false);
  });

  it.each([10, 50])('marks all %i pills and drops rings when it is lost, then repeats one page read', async (count) => {
    const gateway = await strip(count);
    gateway.see(1, 2, 3);
    gateway.turn(7, 1, 'running');
    await settle();
    gateway.turns.set(7, { workItemId: 'wi_1', status: 'delivered' });
    gateway.disconnect();
    expect(gateway.pills.getSnapshot().every((pill) => pill.stale && pill.state === 'held')).toBe(true);
    await pass(1_000);
    expect(gateway.connections).toBe(2);
    expect(gateway.pills.getSnapshot().every((pill) => !pill.stale)).toBe(true);
    expect({ pages: gateway.pageReads, items: gateway.itemReads.length, turns: gateway.turnReads }).toEqual({ pages: 2, items: 0, turns: [7, 7] });
    expect(gateway.pill(1).state).toBe('held');
  });

  it('treats a gap in the notices as a lost connection', async () => {
    const gateway = await strip(2);
    gateway.see(1);
    gateway.raw({ type: 'change', seq: 5, class: 'work_item.updated', refs: { workItemId: 'wi_1' } });
    expect(gateway.pill(2).stale).toBe(true);
    await pass(1_000);
    expect(gateway.pill(2).stale).toBe(false);
  });

  it('paints without the connection, marked, and backs off while it is refused', async () => {
    const gateway = new FakeGateway([summary(1)]);
    gateways.push(gateway);
    gateway.refuseConnections = true;
    await gateway.pills.watch(['wi_1']).catch(() => {});
    gateway.readPage();
    await settle();
    expect(gateway.pill(1)).toMatchObject({ state: 'held', stale: true });
    gateway.refuseConnections = false;
    gateway.see(1);
    await pass(60_000);
    expect(gateway.pill(1).stale).toBe(false);
    expect(gateway.pageReads).toBe(2);
  });

  it('repeats the page read once when items arrived before they were watched', async () => {
    const gateway = new FakeGateway([summary(1), summary(2)]);
    gateways.push(gateway);
    gateway.readPage();
    gateway.see(1);
    await settle();
    expect(gateway.pageReads).toBe(2);
  });

  it('stops everything when disposed', async () => {
    const gateway = await strip(1);
    gateway.see(1);
    gateway.change(1);
    gateway.pills.dispose();
    await pass(600_000);
    expect(gateway.liveReads).toBe(0);
  });

  it('closes a silent connection and refuses notices for items it does not show', async () => {
    const gateway = await strip(1);
    gateway.notice('work_item.updated', { workItemId: 'wi_other' });
    expect(gateway.pill(1).stale).toBe(false);
    gateway.silent = true;
    await pass(45_000);
    await pass(1_000);
    expect(gateway.connections).toBe(2);
  });
});
