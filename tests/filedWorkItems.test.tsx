import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FiledWorkItems } from '../src/filedWorkItems';
import { WorkItemStrip } from '../src/WorkItemStrip';
import { WorkItemPills } from '../src/workItemPills';
import { decodeWorkItemSummary } from '../src/public019';
import { recordEventPresentation } from '../src/sessionRecordEvents';
import type { FiledWorkItemPage, SessionRecordEvent, WorkItemSummary } from '../src/types';

const event = (n: number): SessionRecordEvent => ({ eventId: `work_item.filed:wi_${n}`, sessionKey: 'selected', at: n,
  kind: 'work_item.filed', record: { type: 'work-item', id: `wi_${n}`, workItemId: `wi_${n}`, detail: `/api/work-items/wi_${n}` },
  actorSessionKey: 'selected', tiedAs: ['creator'], cause: null, noticeMessageIds: [] });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => event(from + i));
const item = (n: number, rowVersion = 1): WorkItemSummary => ({ id: `wi_${n}`, title: `Title ${n}`, state: 'open',
  started: false, holders: [], failReason: null, createdAt: n, rowVersion });
const flush = () => vi.advanceTimersByTimeAsync(0);

/** Lists newest first by position, as the Gateway does for one creator. */
function setup(total: number, onItems?: (items: ReadonlyMap<string, WorkItemSummary>) => void) {
  const gateway = { total, unreadable: 0, absent: 0, omitted: new Set<number>(), version: 1,
    calls: [] as Array<{ limit: number; before?: string }> };
  let items: ReadonlyMap<string, WorkItemSummary> = new Map();
  const failures: boolean[] = [];
  const reader = new FiledWorkItems('selected', async (_key, { limit, before }): Promise<FiledWorkItemPage> => {
    gateway.calls.push({ limit, before });
    const end = before ? Number(before) - 1 : gateway.total;
    const start = Math.max(1, end - limit + 1);
    // One bad row fails every page that includes it.
    if (gateway.unreadable >= start && gateway.unreadable <= end) throw new Error('unavailable');
    const scanned = range(start, end);
    return { items: scanned.filter(row => row.at !== gateway.absent && !gateway.omitted.has(row.at))
      .map(row => item(row.at, gateway.version)), oldestCursor: String(start), hasOlder: start > 1,
    ...(scanned.some(row => gateway.omitted.has(row.at)) ? { partial: true } : {}) };
  }, next => { items = next; onItems?.(next); }, undefined, failed => failures.push(failed));
  return { gateway, reader, failures, items: () => items };
}

describe('filed work item reads', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads one loaded page once, not once per event, and an older page only for its own rows', async () => {
    const { gateway, reader, items } = setup(200);
    reader.sync(range(161, 200), 'newest');
    await flush();
    expect(gateway.calls).toEqual([{ limit: 40, before: undefined }]);
    reader.sync(range(161, 200), 'newest');
    reader.sync(range(161, 200), 'older');
    await flush();
    expect(gateway.calls).toHaveLength(1);
    reader.sync(range(131, 200), 'older');
    await flush();
    expect(gateway.calls.slice(1)).toEqual([{ limit: 30, before: '161' }]);
    expect(items().size).toBe(70);
  });

  it('makes no read without filed items, and one bounded read however many a load holds', async () => {
    const { gateway, reader, items } = setup(120);
    reader.sync([{ ...event(1), kind: 'assignment.opened' }], 'newest');
    await flush();
    expect(gateway.calls).toHaveLength(0);
    for (const size of [50, 100, 120, 120]) {
      reader.sync(range(1, 120), 'newest');
      await flush();
      expect(items().size).toBe(size);
    }
    expect(gateway.calls.map(call => call.limit)).toEqual([50, 50, 20]);
  });

  it('opens a list from the first older filing and then follows its cursor', async () => {
    const readItem = vi.fn(async () => undefined);
    const pills = new WorkItemPills({
      transport: { readItem, readTurn: async () => undefined,
        openChanges: async () => ({ watch: async () => {}, unwatch() {}, close() {} }) },
      refreshItems: vi.fn(),
    });
    const { gateway, reader } = setup(3, items => pills.setItems(items));
    try {
      render(<WorkItemStrip pills={pills} folded={false} onOpen={() => {}} onShown={() => {}} />);
      const newest: SessionRecordEvent = { ...event(4), kind: 'assignment.opened' };
      await act(async () => { reader.sync([newest], 'newest'); await flush(); });
      expect(gateway.calls).toEqual([]);
      expect(screen.queryByRole('group')).toBeNull();

      await act(async () => { reader.sync([...range(3, 3), newest], 'older'); await flush(); });
      expect(gateway.calls).toEqual([{ limit: 1, before: undefined }]);
      expect(screen.getByRole('button', { name: 'Title 3. Not started' })).toBeTruthy();

      await act(async () => { reader.sync([...range(2, 3), newest], 'older'); await flush(); });
      expect(gateway.calls).toEqual([{ limit: 1, before: undefined }, { limit: 1, before: '3' }]);
      expect(screen.getByRole('button', { name: 'Title 2. Not started' })).toBeTruthy();
      expect(readItem).not.toHaveBeenCalled();
    } finally {
      cleanup();
      reader.stop();
      pills.dispose();
    }
  });

  it('does not use older scrolling to retry a failed initial tail', async () => {
    const { gateway, reader } = setup(3);
    gateway.unreadable = 3;
    reader.sync(range(3, 3), 'newest');
    await flush();
    reader.sync(range(2, 3), 'older');
    await flush();
    expect(gateway.calls).toEqual([{ limit: 1, before: undefined }]);
  });

  it('makes no read for live filings, and an older page does not catch them up', async () => {
    const { gateway, reader, items } = setup(110);
    reader.sync(range(100, 110), 'newest');
    await flush();
    gateway.total = 111;
    reader.sync(range(100, 111), 'live');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gateway.calls).toHaveLength(1);
    reader.sync(range(90, 111), 'older');
    await flush();
    expect(gateway.calls.slice(1)).toEqual([{ limit: 10, before: '100' }]);
    expect(items().has('wi_111')).toBe(false);
    reader.sync(range(90, 111), 'newest');
    await flush();
    expect(gateway.calls.slice(2)).toEqual([{ limit: 1, before: undefined }]);
    expect(items().get('wi_111')?.title).toBe('Title 111');
  });

  it('does not re-read a failed newest range for older pages, and retries it once per reload after 30 seconds', async () => {
    const { gateway, reader, items } = setup(110);
    gateway.unreadable = 110;
    reader.sync(range(100, 110), 'newest');
    await flush();
    for (const from of [90, 80]) {
      reader.sync(range(from, 110), 'older');
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(gateway.calls).toEqual([{ limit: 11, before: undefined }]);
    gateway.unreadable = 0;
    reader.sync(range(80, 110), 'newest');
    await flush();
    expect(gateway.calls.slice(1)).toEqual([{ limit: 31, before: undefined }]);
    expect(items().size).toBe(31);
  });

  it('does not retry a failed newest range on reloads within 30 seconds', async () => {
    const { gateway, reader } = setup(3);
    gateway.unreadable = 2;
    for (let reload = 0; reload < 5; reload++) {
      reader.sync(range(1, 3), 'newest');
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(gateway.calls).toHaveLength(1);
  });

  it('stops below a failed older range until a later reload reads it, keeping newer titles', async () => {
    const { gateway, reader, items } = setup(110);
    gateway.unreadable = 95;
    reader.sync(range(100, 110), 'newest');
    reader.sync(range(90, 110), 'older');
    await flush();
    reader.sync(range(80, 110), 'older');
    reader.sync(range(70, 110), 'older');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gateway.calls).toEqual([{ limit: 11, before: undefined }, { limit: 10, before: '100' }]);
    expect(items().size).toBe(11);
    gateway.unreadable = 0;
    reader.sync(range(70, 110), 'newest');
    await flush();
    expect(gateway.calls.slice(2)).toEqual([{ limit: 30, before: '100' }]);
    expect(items().size).toBe(41);
  });

  it('reads loads that overlap a slow read in turn, one read each', async () => {
    const { gateway, reader, items } = setup(30);
    reader.sync(range(21, 30), 'newest');
    reader.sync(range(11, 30), 'older');
    reader.sync(range(1, 30), 'older');
    await flush();
    expect(gateway.calls.map(call => call.limit)).toEqual([10, 10, 10]);
    expect(items().size).toBe(30);
  });

  it('asks only once for an item the list does not hold', async () => {
    const { gateway, reader, items } = setup(2);
    for (let reload = 0; reload < 3; reload++) {
      reader.sync(range(1, 3), 'newest');
      await flush();
    }
    expect(gateway.calls).toHaveLength(1);
    expect(items().size).toBe(2);
  });

  it('clears a failed list on a successful empty response using the existing retry', async () => {
    const { gateway, reader, failures, items } = setup(1);
    gateway.unreadable = 1;
    reader.sync(range(1, 1), 'newest');
    await flush();
    reader.sync(range(1, 1), 'newest');
    await flush();
    expect(failures).toEqual([true]);
    expect(gateway.calls).toHaveLength(1);
    gateway.unreadable = 0;
    gateway.total = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    reader.sync(range(1, 1), 'newest');
    await flush();
    expect(failures).toEqual([true, false]);
    expect(gateway.calls).toHaveLength(2);
    expect(items().size).toBe(0);
  });

  it('retains good rows during a failed refresh and publishes recovery on the next refresh', async () => {
    const { gateway, reader, failures, items } = setup(2);
    reader.sync(range(1, 2), 'newest');
    await flush();
    const cached = items();
    gateway.unreadable = 1;
    await reader.refresh();
    expect(failures).toEqual([true]);
    expect(items()).toBe(cached);
    gateway.unreadable = 0;
    gateway.version = 2;
    await reader.refresh();
    expect(failures).toEqual([true, false]);
    expect(items().get('wi_1')?.rowVersion).toBe(2);
    expect(gateway.calls).toHaveLength(3);
  });

  it('does not clear a failed full tail when a smaller tail succeeds', async () => {
    const { gateway, reader, failures } = setup(14);
    reader.sync(range(1, 14), 'newest');
    await flush();
    gateway.unreadable = 1;
    await reader.refresh();
    gateway.total = 15;
    reader.sync(range(1, 15), 'newest');
    await flush();
    expect(gateway.calls.map(call => call.limit)).toEqual([14, 14, 1]);
    expect(failures).toEqual([true]);
    gateway.unreadable = 0;
    await reader.refresh();
    expect(gateway.calls.map(call => call.limit)).toEqual([14, 14, 1, 15]);
    expect(failures).toEqual([true, false]);
  });

  it('clears a failed older range when a later tail returns all its rows', async () => {
    const { gateway, reader, failures, items } = setup(14);
    reader.sync(range(10, 14), 'newest');
    await flush();
    gateway.unreadable = 1;
    reader.sync(range(1, 14), 'older');
    await flush();
    expect(gateway.calls).toEqual([{ limit: 5, before: undefined }, { limit: 9, before: '10' }]);
    expect(failures).toEqual([true]);
    gateway.unreadable = 0;
    await reader.refresh();
    expect(gateway.calls.at(-1)).toEqual({ limit: 14, before: undefined });
    expect(items().size).toBe(14);
    expect(failures).toEqual([true, false]);
  });

  it('clears a failed older range when an exhaustive tail omits an absent filing', async () => {
    const { gateway, reader, failures, items } = setup(14);
    reader.sync(range(10, 14), 'newest');
    await flush();
    gateway.unreadable = 1;
    reader.sync(range(1, 14), 'older');
    await flush();
    expect(failures).toEqual([true]);

    gateway.unreadable = 0;
    gateway.absent = 1;
    await reader.refresh();
    expect(gateway.calls).toEqual([
      { limit: 5, before: undefined }, { limit: 9, before: '10' }, { limit: 14, before: undefined },
    ]);
    expect(items().size).toBe(13);
    expect(items().has('wi_1')).toBe(false);
    expect(failures).toEqual([true, false]);
  });

  it('keeps good rows and existing warning on an exhausted partial refresh until a covering complete read', async () => {
    const { gateway, reader, failures, items } = setup(4);
    reader.sync(range(1, 4), 'newest');
    await flush();
    gateway.unreadable = 1;
    await reader.refresh();
    gateway.unreadable = 0;
    gateway.omitted.add(1);
    gateway.version = 2;
    await reader.refresh();
    expect(failures).toEqual([true]);
    expect(items().get('wi_1')?.rowVersion).toBe(1);
    expect(items().get('wi_4')?.rowVersion).toBe(2);
    gateway.total = 5;
    reader.sync(range(1, 5), 'newest');
    await flush();
    expect(gateway.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(30_000);
    reader.sync(range(1, 5), 'newest');
    await flush();
    expect(gateway.calls.at(-1)).toEqual({ limit: 1, before: undefined });
    expect(failures).toEqual([true]);
    gateway.omitted.clear();
    await reader.refresh();
    expect(gateway.calls.map(call => call.limit)).toEqual([4, 4, 4, 1, 5]);
    expect(failures).toEqual([true, false]);
  });

  it.each([false, true])('follows the scanned cursor past omitted rows (all bad: %s)', async allBad => {
    const { gateway, reader, failures, items } = setup(5);
    gateway.omitted.add(4);
    gateway.omitted.add(2);
    if (allBad) {
      gateway.omitted.add(5);
      gateway.omitted.add(3);
    }
    reader.sync(range(4, 5), 'newest');
    await flush();
    expect(failures).toEqual([true]);
    expect([...items().keys()]).toEqual(allBad ? [] : ['wi_5']);
    reader.sync(range(4, 5), 'older');
    await flush();
    expect(gateway.calls).toEqual([{ limit: 2, before: undefined }]);
    reader.sync(range(2, 5), 'older');
    await flush();
    expect(gateway.calls.at(-1)).toEqual({ limit: 2, before: '4' });
    reader.sync(range(1, 5), 'older');
    await flush();
    expect(gateway.calls.at(-1)).toEqual({ limit: 1, before: '2' });
    expect(items().has('wi_1')).toBe(true);
    expect(failures).toEqual([true]);
    expect(gateway.calls).toHaveLength(3);
    gateway.omitted.clear();
    await reader.refresh();
    expect(items().size).toBe(5);
    expect(failures).toEqual([true, false]);
    expect(gateway.calls).toHaveLength(4);
  });

  it('continues below an older failure when a partial refresh advances the cursor', async () => {
    const { gateway, reader, failures, items } = setup(6);
    reader.sync(range(5, 6), 'newest');
    await flush();
    gateway.unreadable = 4;
    reader.sync(range(3, 6), 'older');
    await flush();
    gateway.unreadable = 0;
    gateway.omitted.add(4);
    await reader.refresh();
    reader.sync(range(1, 6), 'older');
    await flush();
    expect(gateway.calls).toEqual([
      { limit: 2, before: undefined }, { limit: 2, before: '5' },
      { limit: 4, before: undefined }, { limit: 2, before: '3' },
    ]);
    expect(items().size).toBe(5);
    expect(items().has('wi_4')).toBe(false);
    expect(failures).toEqual([true]);
  });

  it('refreshes known rows with one read and stops cleanly', async () => {
    const { gateway, reader, items } = setup(5);
    reader.sync(range(1, 5), 'newest');
    await flush();
    gateway.version = 2;
    await reader.refresh();
    expect(gateway.calls).toHaveLength(2);
    expect(items().get('wi_1')?.rowVersion).toBe(2);
    reader.stop();
    await reader.refresh();
    reader.sync(range(1, 6), 'newest');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gateway.calls).toHaveLength(2);
  });
});

describe('work item titles in event rows', () => {
  const titles = new Map([['wi_1', { ...item(1), title: 'A title\nover  two lines' }]]);

  it('shows the title on one line and keeps the id beside it', () => {
    expect(recordEventPresentation(event(1), titles)).toMatchObject({
      label: 'Work item', text: 'Filed · A title over two lines', metadata: 'wi_1' });
  });

  it('keeps the fixed wording when the title is missing or empty', () => {
    expect(recordEventPresentation(event(1)).text).toBe('Work item filed');
    expect(recordEventPresentation(event(2), titles).text).toBe('Work item filed');
    expect(recordEventPresentation(event(1), new Map([['wi_1', { ...item(1), title: ' \n' }]])).text).toBe('Work item filed');
  });

  it('names an opened assignment only from a title already held', () => {
    const opened: SessionRecordEvent = { ...event(1), kind: 'assignment.opened',
      record: { type: 'assignment', id: 'asg_1', workItemId: 'wi_1', detail: '' } };
    expect(recordEventPresentation(opened, titles)).toMatchObject({ text: 'Opened · A title over two lines', metadata: 'asg_1' });
    expect(recordEventPresentation({ ...opened, record: { ...opened.record, workItemId: 'wi_9' } }, titles).text).toBe('Assignment opened');
    expect(recordEventPresentation({ ...opened, kind: 'assignment.completed' }, titles).text).toBe('Assignment completed');
  });

  it('clips the row text to one line at every width', () => {
    const css = readFileSync('src/style.css', 'utf8');
    const blocks = [...css.matchAll(/\.tb-chat-activity-pill-text \{([^}]*)\}/g)].map(match => match[1]);
    expect(blocks[0]).toMatch(/min-width: 0;[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
    expect(css).toMatch(/\.tb-chat-activity-pill-meta-fixed \{ flex-shrink: 0; \}/);
    expect(blocks.slice(1).join()).not.toMatch(/white-space|text-overflow/);
  });

  it('decodes only the needed fields', () => {
    expect(decodeWorkItemSummary({ ...item(1), body: 'long', landings: [] })).toEqual(item(1));
    expect(() => decodeWorkItemSummary({ id: 'wi_1' })).toThrow();
  });
});
