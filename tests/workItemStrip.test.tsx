import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalFixtureTransport, fixtureTarget } from '../examples/mockTransport';
import { createTightbeamAdapter, TightbeamChat } from '../src';
import { pillTitle } from '../src/WorkItemStrip';
import { decodeWorkItemSummary } from '../src/public019';
import { agoText, clockText, durationText, untilText } from '../src/workItemTime';
import type { ChangeCallbacks, SessionRecordEvent, WorkItemSummary } from '../src/types';
import type { WorkItemChange } from '../src/workItemPills';
import type { WorkItemPillsTransport } from '../src/workItemPillsTransport';

const uuid = (n: number) => `wi_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const summary = (n: number, patch: Partial<WorkItemSummary> = {}): WorkItemSummary => ({ id: uuid(n), title: `Product: Item ${n}`,
  state: 'open', started: true, holders: ['agent:a'], failReason: null, createdAt: Date.now() - n * 1000, rowVersion: 1, ...patch });

class Visible {
  static all: Visible[] = [];
  readonly seen = new Set<Element>();
  constructor(readonly report: (entries: { target: Element; intersectionRatio: number }[]) => void) { Visible.all.push(this); }
  observe(element: Element) { this.seen.add(element); }
  unobserve(element: Element) { this.seen.delete(element); }
  disconnect() { this.seen.clear(); }
  show(...ids: string[]) {
    this.report([...this.seen].map((target) => ({ target,
      intersectionRatio: ids.includes((target as HTMLElement).dataset.workItem!) ? 1 : 0 })));
  }
}

function chat(items: readonly WorkItemSummary[], options: { pills?: boolean; failList?: boolean | 'network'; emptyList?: boolean } = {}) {
  const counts: Record<string, number> = {};
  const count = (name: string) => { counts[name] = (counts[name] ?? 0) + 1; };
  let emit: (change: WorkItemChange) => void = () => {};
  const order: string[] = [];
  let notices: ChangeCallbacks | undefined;
  const fixture = new LocalFixtureTransport();
  const filed = (item: WorkItemSummary, sessionKey: string): SessionRecordEvent => ({ eventId: `work_item.filed:${item.id}`, sessionKey,
    kind: 'work_item.filed', at: item.createdAt, record: { type: 'work-item', id: item.id, workItemId: item.id, detail: '' },
    actorSessionKey: sessionKey, tiedAs: ['creator'], cause: null, noticeMessageIds: [] });
  const pills: WorkItemPillsTransport = {
    openChanges: async (onChange) => { emit = onChange; return { watch: async () => { order.push('watch'); }, unwatch() {}, close() {} }; },
    readItem: async (id) => { count('item'); return items.find((item) => item.id === id); },
    readTurn: async (seq) => { count('turn'); return { seq, workItemId: uuid(1), status: 'running' }; },
    readCards: async (id) => { count('cards'); const item = items.find((row) => row.id === id)!;
      return { item, cards: [{ id: 'asg_1', open: item.holders.length > 0, holderKey: 'agent:a' }] }; },
    readBreathing: async () => { count('breathing'); return { reason: 'pending_wake', holders: [],
      wake: { wakeId: 'w1', sessionKey: 'agent:a', dueAt: Date.now() + 3_600_000, createdAt: 1 } }; },
    readWait: async (id) => { count('wait'); return { id, sessionKey: 'agent:a', creatorSessionKey: 'agent:a', state: 'pending', recurring: false,
      conditionKind: null, conditionScope: null, dueAt: Date.now() + 3_600_000, createdAt: Date.now() - 60_000, reason: null }; },
    readMyQuestions: async () => { count('questions'); return items.some((row) => !row.holders.length) ? [{ id: 'dr_1', question: 'Go ahead?', options: ['Yes'],
      assignmentId: 'asg_1', raiserId: null, raisedAt: 1, deadlineAt: null }] : []; },
    readAgentQuestions: async () => { count('agent questions'); return []; },
    readAgentName: async () => { count('name'); return 'Coder'; },
  };
  const { openChanges, readTail, readOlder } = fixture;
  const forSession = async (sessionKey: string, result: ReturnType<typeof readTail>) => {
    const page = await result;
    return { ...page, records: page.records.map(record => ({ ...record, sessionKey })) };
  };
  const transport = Object.assign(fixture, { targetGateway: 'https://gateway.example',
    openChanges: (_key: string, callbacks: ChangeCallbacks, signal: AbortSignal) => {
      notices = callbacks;
      return openChanges('fixture-session', callbacks, signal);
    },
    readTail: (key: string) => forSession(key, readTail()),
    readOlder: (key: string, before: string) => forSession(key, readOlder(key, before)),
    readRecordEvents: async (sessionKey: string) => ({ items: items.map((item) => filed(item, sessionKey)), oldestCursor: null, hasOlder: false }),
    readFiledWorkItems: async (sessionKey: string) => {
      count('page');
      order.push('page');
      if (sessionKey === 'fixture-session') {
        if (options.failList === 'network') throw new TypeError('Failed to fetch');
        if (options.failList) throw new Error('HTTP 500');
      }
      return { items: options.emptyList ? [] : [...items], oldestCursor: null, hasOlder: false };
    },
    ...(options.pills === false ? {} : { workItemPills: pills }),
  });
  const adapter = createTightbeamAdapter(transport, { ...fixtureTarget, label: 'fixture' });
  const view = render(<TightbeamChat sessionKey="fixture-session" adapter={adapter} />);
  const switchSession = () => view.rerender(<TightbeamChat sessionKey="next-session" adapter={adapter} />);
  const file = (item: WorkItemSummary) => act(async () => {
    (items as WorkItemSummary[]).push(item);
    notices!.onNotice({ operation: 'record-event', event: filed(item, 'fixture-session') });
  });
  return { view, counts, order, file, switchSession, emit: (change: WorkItemChange) => act(async () => { emit(change); }) };
}
const strip = () => screen.findByRole('group', { name: 'Work items, newest first' });
const pills = async () => within(await strip()).getAllByRole('button');

beforeEach(() => {
  Visible.all = [];
  vi.stubGlobal('IntersectionObserver', Visible);
  window.localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the strip', () => {
  it('does not exist unless the host turns pills on, or while there is nothing to show', async () => {
    const off = chat([summary(1)], { pills: false });
    await waitFor(() => expect(off.counts.page).toBe(1));
    expect(off.view.container.querySelector('.tb-chat-work-items')).toBeNull();
    expect(off.view.container.querySelector('.tb-chat-has-work-items')).toBeNull();
    cleanup();
    const empty = chat([]);
    await screen.findByText(/Fixture message 124/);
    expect(empty.view.container.querySelector('.tb-chat-work-items')).toBeNull();
    expect(empty.counts).toEqual({});
  });

  it.each([10, 50])('paints %i pills from one page read, watched first', async (n) => {
    const run = chat(Array.from({ length: n }, (_, i) => summary(i + 1)));
    expect(await pills()).toHaveLength(n);
    await act(async () => { Visible.all.at(-1)!.show(uuid(1), uuid(2), uuid(3)); });
    expect(run.counts).toEqual({ page: 1 });
    expect(run.order.indexOf('page')).toBe(n);
    expect(run.view.container.querySelector('.tb-chat-has-work-items')).not.toBeNull();
  });

  it('shows each state in words, drops the product from the pill and keeps it in the label', async () => {
    const run = chat([summary(1), summary(2, { holders: [] }), summary(3, { holders: [], started: false }), summary(4, { state: 'closed', holders: [] })]);
    const shown = await pills();
    expect(shown.map((pill) => pill.textContent)).toEqual(['Item 1Assigned', 'Item 2Between hands', 'Item 3Not started', 'Item 4Closed']);
    expect(shown[0].getAttribute('aria-label')).toBe('Product: Item 1. Assigned');
    expect(shown[3].getAttribute('aria-label')).toBe('Product: Item 4. Closed');
    fireEvent.click(shown[3]);
    const dialog = await screen.findByRole('dialog', { name: 'Product: Item 4' });
    expect(within(dialog).getByText('Closed', { exact: true })).toBeTruthy();
    expect(run.counts).toEqual({ page: 1 });
  });

  it('marks a changed pill as past and rings only after its turn is read', async () => {
    const run = chat([summary(1)]);
    await pills();
    await run.emit({ kind: 'item', workItemId: uuid(1) });
    expect((await pills())[0].textContent).toBe('Item 1Was assigned');
    expect((await pills())[0].getAttribute('aria-label')).toBe('Product: Item 1. Was assigned. Changed, not read again yet');
    await act(async () => { Visible.all.at(-1)!.show(uuid(1)); });
    await run.emit({ kind: 'turn', workItemId: uuid(1), turnSeq: 4, ended: false });
    await waitFor(async () => expect((await pills())[0].textContent).toBe('Item 1Working now'));
    expect(run.counts.turn).toBe(1);
    expect((await pills())[0].querySelector('.tb-chat-work-ring')).not.toBeNull();
  });

  it('adds one filed while the page is open, from one item read and no list read', async () => {
    const run = chat([summary(1)]);
    await pills();
    await act(async () => { Visible.all.at(-1)!.show(uuid(1)); });
    await run.file(summary(2, { title: 'Product: Filed now', createdAt: Date.now() + 1000 }));
    await waitFor(async () => expect((await pills())[0].textContent).toBe('Filed nowAssigned'), { timeout: 7_000 });
    expect(run.counts).toEqual({ page: 1, item: 1 });
    // The same read names its message; titles make none of their own for it.
    expect(run.view.container.textContent).toContain('Filed · Product: Filed now');
  }, 10_000);

  it('folds to its button and remembers it', async () => {
    const run = chat([summary(1), summary(2)]);
    await pills();
    fireEvent.click(screen.getByRole('button', { name: 'Hide 2 work items' }));
    expect(screen.queryByRole('group', { name: 'Work items, newest first' })).toBeNull();
    run.view.unmount();
    chat([summary(1), summary(2)]);
    expect(await screen.findByRole('button', { name: 'Show 2 work items' })).toBeTruthy();
  });
});

describe('the sheet', () => {
  it.each([
    ['completed', 'Completed'], ['canceled', 'Canceled'], ['superseded', 'Superseded'],
    [null, 'Closed'], ['unrecognized', 'Closed'], [undefined, 'Closed'],
  ] as const)('shows the closed reason %s as %s without an extra read', async (closeReason, label) => {
    const item = decodeWorkItemSummary({ ...summary(1, { state: 'closed', holders: [] }), closeReason });
    const run = chat([item]);
    const pill = (await pills())[0];
    expect(pill.textContent).toBe(`Item 1${label}`);
    expect(pill.getAttribute('aria-label')).toBe(`Product: Item 1. ${label}`);
    fireEvent.click(pill);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(label, { exact: true })).toBeTruthy();
    expect(run.counts).toEqual({ page: 1 });
  });

  it('uses the closed reason from the existing dialog read', async () => {
    const items = [summary(1)];
    const run = chat(items);
    const pill = (await pills())[0];
    items[0] = summary(1, { state: 'closed', closeReason: 'superseded', holders: [], rowVersion: 2 });
    fireEvent.click(pill);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Superseded', { exact: true })).toBeTruthy();
    expect(run.counts).toEqual({ page: 1, cards: 1 });
  });

  it.each([false, true])('updates the open dialog after an ordinary pill refresh (reopening: %s)', async reopening => {
    const items = [summary(1)];
    const run = chat(items);
    const pill = (await pills())[0];
    if (reopening) {
      items[0] = summary(1, { state: 'closed', closeReason: 'canceled', holders: [], rowVersion: 2 });
    }
    fireEvent.click(pill);
    const dialog = await screen.findByRole('dialog');
    const oldLabel = reopening ? 'Canceled' : 'Waiting';
    await within(dialog).findByText(oldLabel, { exact: true });
    const reads = { ...run.counts };

    await act(async () => { Visible.all.at(-1)!.show(uuid(1)); });
    items[0] = reopening ? summary(1, { rowVersion: 3 })
      : summary(1, { state: 'closed', closeReason: 'completed', holders: [], rowVersion: 3 });
    await run.emit({ kind: 'item', workItemId: uuid(1) });
    const label = reopening ? 'Assigned' : 'Completed';
    await waitFor(() => expect(pill.getAttribute('aria-label')).toBe(`Product: Item 1. ${label}`), { timeout: 8_000 });
    expect(within(dialog).getByText(label, { exact: true })).toBeTruthy();
    expect(within(dialog).queryByText(oldLabel, { exact: true })).toBeNull();
    expect(within(dialog).queryByText('No reason given')).toBeNull();
    expect(run.counts).toEqual({ ...reads, item: 1 });
  }, 12_000);

  it.each([false, true])('keeps title updates but discards stale wait details (close/reopen: %s)', async reopen => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const items = [summary(1)];
      const run = chat(items);
      fireEvent.click((await pills())[0]);
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText('Waiting', { exact: true });
      const reads = { ...run.counts };

      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await act(async () => { Visible.all.at(-1)!.show(uuid(1)); });
      const refresh = async (patch: Partial<WorkItemSummary>) => {
        items[0] = { ...items[0], ...patch, rowVersion: items[0].rowVersion + 1 };
        await run.emit({ kind: 'item', workItemId: uuid(1) });
        now += 120_000;
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      };

      await refresh({ title: 'Renamed work item' });
      expect(within(dialog).getByRole('heading', { name: 'Renamed work item' })).toBeTruthy();
      expect(within(dialog).getByText('Waiting', { exact: true })).toBeTruthy();

      if (reopen) {
        await refresh({ state: 'closed', closeReason: 'completed', holders: [] });
        expect(within(dialog).getByText('Completed', { exact: true })).toBeTruthy();
        await refresh({ state: 'open', closeReason: undefined, holders: ['agent:a'] });
        expect(within(dialog).getByText('Assigned', { exact: true })).toBeTruthy();
      } else {
        await refresh({ holders: [] });
        expect(within(dialog).getByText('Between hands', { exact: true })).toBeTruthy();
      }
      expect(within(dialog).queryByText('Waiting', { exact: true })).toBeNull();
      expect(within(dialog).queryByText('Coder')).toBeNull();
      expect(run.counts).toEqual({ ...reads, item: reopen ? 3 : 2 });
    } finally {
      vi.useRealTimers();
      clock.mockRestore();
    }
  });

  it.each(['open', 'failed', 'iceboxed'])('ignores closure reasons for %s items', (state) => {
    expect(decodeWorkItemSummary({ ...summary(1, { state }), closeReason: 'canceled' }).closeReason).toBeUndefined();
  });

  it('reads nothing until a tap, then shows the wait, its time and that no reason was given', async () => {
    const run = chat([summary(1)]);
    fireEvent.click((await pills())[0]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Assigned', { exact: true })).toBeTruthy();
    expect(await within(dialog).findByText('This is what it waits on, step by step.')).toBeTruthy();
    expect(dialog.textContent).toContain('Waiting');
    expect(dialog.textContent).toContain('Coder');
    expect(dialog.textContent).toContain('No reason given');
    expect(dialog.textContent).toContain('in 1 h');
    expect(dialog.textContent).toContain('Can’t tell what comes next');
    expect(run.counts).toEqual({ page: 1, cards: 1, questions: 1, 'agent questions': 1, breathing: 1, wait: 1, name: 1 });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close work item' }));
  });

  it('opens finished work without a read, and reads it once it has changed', async () => {
    const run = chat([summary(1, { state: 'failed', holders: [], failReason: 'A duplicate.' })]);
    fireEvent.click((await pills())[0]);
    expect((await screen.findByRole('dialog')).textContent).toContain('A duplicate.');
    expect(run.counts).toEqual({ page: 1 });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await run.emit({ kind: 'item', workItemId: uuid(1) });
    fireEvent.click((await pills())[0]);
    await waitFor(() => expect(run.counts.cards).toBe(1));
  });

  it.each([['between hands', { holders: [] }], ['not started', { holders: [], started: false }]])(
    'still reads the open questions of work %s', async (_name, patch) => {
      const run = chat([summary(1, patch)]);
      fireEvent.click((await pills())[0]);
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(run.counts).toEqual({ page: 1, cards: 1, questions: 1 }));
      expect(await within(dialog).findByText(/Go ahead\?/)).toBeTruthy();
      expect(dialog.textContent).toContain('Waiting on you');
    });

  it.each([true, 'network'] as const)('shows a failed list (%s) and isolates it from the next session', async failList => {
    const run = chat([summary(1)], { failList });
    const failure = await screen.findByText('Couldn’t load work items');
    expect(failure.getAttribute('role')).toBe('status');
    expect(failure.closest('.tb-chat-work-strip')).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'Work items, newest first' })).toBeNull();
    expect(run.counts).toEqual({ page: 1 });
    run.switchSession();
    expect(await pills()).toHaveLength(1);
    expect(screen.queryByText('Couldn’t load work items')).toBeNull();
    expect(run.counts).toEqual({ page: 2 });
  });

  it('leaves the strip absent after a successful empty list', async () => {
    const run = chat([summary(1)], { emptyList: true });
    await waitFor(() => expect(run.counts).toEqual({ page: 1 }));
    expect(run.view.container.querySelector('.tb-chat-work-strip')).toBeNull();
    expect(screen.queryByText('Couldn’t load work items')).toBeNull();
  });

  it('keeps focus inside and returns it to the pill', async () => {
    chat([summary(1)]);
    const pill = (await pills())[0];
    pill.focus();
    fireEvent.click(pill);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('No reason given');
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(pill);
  });

  it('tells a host when the sheet opens and closes', async () => {
    const events: { event: string; open?: boolean }[] = [];
    Object.assign(window, { __TIGHTBEAM_CHAT_HOST__: { versions: [1], onEvent: (event: { event: string; open?: boolean }) => events.push(event) } });
    try {
      const run = chat([summary(1)]);
      await waitFor(() => expect(events.some((event) => event.event === 'ready')).toBe(true));
      fireEvent.click((await pills())[0]);
      await screen.findByRole('dialog');
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => expect(events.filter((event) => event.event === 'overlay').map((event) => event.open)).toEqual([true, false]));
      run.view.unmount();
    } finally { delete (window as unknown as Record<string, unknown>).__TIGHTBEAM_CHAT_HOST__; }
  });
});

it('writes titles and times plainly', () => {
  expect(pillTitle('Tightbeam Chat: Show it')).toBe('Show it');
  expect(pillTitle('Plain title')).toBe('Plain title');
  expect(pillTitle('A very long sentence that only later reaches: a colon')).toBe('A very long sentence that only later reaches: a colon');
  expect([0, 59, 192, 1440, 2520, 13_000].map((minutes) => durationText(minutes * 60_000)))
    .toEqual(['less than a minute', '59 min', '3 h 12 min', '1 day', '1 day 18 h', '9 days']);
  const now = new Date(2026, 10, 24, 12, 0).getTime();
  expect(clockText(now + 60_000, now)).not.toContain(',');
  expect(clockText(now + 86_400_000, now)).toContain(',');
  expect(agoText(now - 60_000, now)).toBe('1 min ago');
  expect(untilText(now + 60_000, now)).toBe('in 1 min');
  expect(untilText(now - 60_000, now)).toBe('1 min ago');
});
