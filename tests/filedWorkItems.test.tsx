import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FiledWorkItems } from '../src/filedWorkItems';
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
function setup(total: number) {
  const gateway = { total, fail: false, version: 1, calls: [] as Array<{ limit: number; before?: string }> };
  let items: ReadonlyMap<string, WorkItemSummary> = new Map();
  const reader = new FiledWorkItems('selected', async (_key, { limit, before }): Promise<FiledWorkItemPage> => {
    gateway.calls.push({ limit, before });
    if (gateway.fail) throw new Error('unavailable');
    const end = before ? Number(before) - 1 : gateway.total;
    const start = Math.max(1, end - limit + 1);
    return { items: range(start, end).map(row => item(row.at, gateway.version)), oldestCursor: String(start), hasOlder: start > 1 };
  }, next => { items = next; });
  return { gateway, reader, items: () => items };
}

describe('filed work item reads', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reads one loaded page once, not once per event, and does not repeat a page it knows', async () => {
    vi.useFakeTimers();
    const { gateway, reader, items } = setup(200);
    reader.sync(range(161, 200), true);
    await flush();
    expect(gateway.calls).toEqual([{ limit: 40, before: undefined }]);
    expect(items().size).toBe(40);
    reader.sync(range(161, 200), true);
    await flush();
    expect(gateway.calls).toHaveLength(1);
    reader.sync(range(131, 200), true);
    await flush();
    expect(gateway.calls.slice(1)).toEqual([{ limit: 30, before: '161' }]);
    expect(items().size).toBe(70);
  });

  it('makes no read without filed items, and at most one per 50 of them', async () => {
    vi.useFakeTimers();
    const { gateway, reader } = setup(120);
    reader.sync([{ ...event(1), kind: 'assignment.opened' }], true);
    await flush();
    expect(gateway.calls).toHaveLength(0);
    reader.sync(range(1, 120), true);
    await flush();
    expect(gateway.calls.map(call => call.limit)).toEqual([50, 50, 20]);
  });

  it('coalesces live filings into one read of just the new rows', async () => {
    vi.useFakeTimers();
    const { gateway, reader, items } = setup(10);
    reader.sync(range(1, 10), true);
    await flush();
    gateway.total = 13;
    for (const last of [11, 12, 13]) reader.sync(range(1, last), false);
    await flush();
    expect(gateway.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gateway.calls.slice(1)).toEqual([{ limit: 3, before: undefined }]);
    expect(items().get('wi_13')?.title).toBe('Title 13');
  });

  it('retries a failed read only on a completed history read at least 30 seconds later, and an unlisted item never again', async () => {
    vi.useFakeTimers();
    const { gateway, reader, items } = setup(2);
    gateway.fail = true;
    reader.sync(range(1, 3), true);
    await flush();
    reader.sync(range(1, 3), false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gateway.calls).toHaveLength(1);
    gateway.fail = false;
    reader.sync(range(1, 3), true);
    await flush();
    expect(gateway.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    reader.sync(range(1, 3), true);
    await flush();
    expect(items().size).toBe(2);
    reader.sync(range(1, 3), true);
    await flush();
    expect(gateway.calls).toHaveLength(2);
    reader.stop();
  });

  it('refreshes known rows with one read and stops cleanly', async () => {
    vi.useFakeTimers();
    const { gateway, reader, items } = setup(5);
    reader.sync(range(1, 5), true);
    await flush();
    gateway.version = 2;
    await reader.refresh();
    expect(gateway.calls).toHaveLength(2);
    expect(items().get('wi_1')?.rowVersion).toBe(2);
    reader.stop();
    await reader.refresh();
    reader.sync(range(1, 6), true);
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
    expect(css).toMatch(/\.tb-chat-record-event-row > \.tb-chat-activity-pill-meta \{ flex-shrink: 0; \}/);
    expect(blocks.slice(1).join()).not.toMatch(/white-space|text-overflow/);
  });

  it('decodes only the needed fields', () => {
    expect(decodeWorkItemSummary({ ...item(1), body: 'long', landings: [] })).toEqual(item(1));
    expect(() => decodeWorkItemSummary({ id: 'wi_1' })).toThrow();
  });
});
