import { describe, expect, it, vi } from 'vitest';
import { SessionRecordEvents, uncoveredRecordEvents, recordEventPresentation } from '../src/sessionRecordEvents';
import type { CanonicalMessage, RecordEventPage, RuntimeState, SessionRecordEvent } from '../src/types';

function event(id: string, at: number, kind = 'work_item.filed'): SessionRecordEvent {
  return { eventId: `${kind}:${id}`, sessionKey: 'selected', at, kind,
    record: { type: 'work item', id, detail: '/api/work-items/' + id }, actorSessionKey: 'selected',
    tiedAs: ['creator'], cause: null, noticeMessageIds: [] };
}
const page = (items: readonly SessionRecordEvent[], oldestCursor: string | null = null, hasOlder = false): RecordEventPage =>
  ({ items, oldestCursor, hasOlder });

describe('session record-event history', () => {
  it('unions overlapping live and newest/older history by occurrence, then repairs a missed event on reconnect', async () => {
    let state: Partial<RuntimeState> = {};
    let newest = page([event('w3', 30)], 'p3', true);
    const reads: Array<string | undefined> = [];
    const history = new SessionRecordEvents('selected', async (_session, before) => {
      reads.push(before);
      if (before === 'p3') return page([event('w2', 20)], 'p2', true);
      if (before === 'p2') return page([event('w1', 10)]);
      return newest;
    }, patch => { state = { ...state, ...patch }; });
    history.receive(event('w3', 30));
    await history.refresh(20);
    expect(state.recordEvents?.map(row => row.record.id)).toEqual(['w2', 'w3']);
    await history.older(10);
    expect(state.recordEvents?.map(row => row.record.id)).toEqual(['w1', 'w2', 'w3']);
    newest = page([event('w3', 30), event('w4', 40)], 'p3', true);
    await history.refresh(20);
    expect(state.recordEvents?.map(row => row.record.id)).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(reads).toEqual([undefined, 'p3', 'p2', undefined]);
    history.stop();
  });

  it('loads 10,000 rows in one batch merge and catches up only the new interval, not retained history', async () => {
    const all = Array.from({ length: 10_120 }, (_, i) => event(String(i + 1).padStart(5, '0'), i + 1));
    let count = 10_000;
    let state: Partial<RuntimeState> = {};
    const reads: Array<string | undefined> = [];
    const history = new SessionRecordEvents('selected', async (_session, before) => {
      reads.push(before);
      const end = before === undefined ? count : Number(before);
      const start = Math.max(0, end - 50);
      return page(all.slice(start, end), start ? String(start) : null, start > 0);
    }, patch => { state = { ...state, ...patch }; });
    // Count retained row references materialized in immutable snapshots, rather
    // than using a timing limit. Per-event full-array copying is quadratic here.
    let materializedRows = 0;
    const freeze = Object.freeze;
    const snapshots = vi.spyOn(Object, 'freeze').mockImplementation(value => {
      if (Array.isArray(value) && value[0]?.eventId) materializedRows += value.length;
      return freeze(value);
    });
    try {
      await history.refresh(0);
      expect(reads).toHaveLength(200);
      expect(state.recordEvents).toEqual(all.slice(0, count));
      expect(materializedRows).toBeLessThanOrEqual(10_000);
      const retained = state.recordEvents!;
      snapshots.mockRestore();

      // A far-ahead live frame is not proof that the interval before it arrived.
      count = all.length;
      history.receive(all[count - 1]);
      reads.length = 0;
      await history.refresh(0);
      expect(reads).toEqual([undefined, '10070', '10020']);
      expect(state.recordEvents).toEqual(all);
      expect(state.recordEvents?.[0]).toBe(retained[0]);
      expect(state.recordEventsHasOlder).toBe(false);
      const complete = state.recordEvents;
      reads.length = 0;
      await history.refresh(0);
      expect(reads).toEqual([undefined]);
      expect(state.recordEvents).toBe(complete);
    } finally {
      snapshots.mockRestore();
      history.stop();
    }
  });

  it('retains the older cursor across catch-up and extends history directly when the reading floor moves', async () => {
    const all = Array.from({ length: 12 }, (_, i) => event(String(i + 1).padStart(2, '0'), i + 1));
    let count = 10;
    let state: Partial<RuntimeState> = {};
    const reads: Array<string | undefined> = [];
    const history = new SessionRecordEvents('selected', async (_session, before) => {
      reads.push(before);
      const end = before === undefined ? count : Number(before);
      const start = Math.max(0, end - 2);
      return page(all.slice(start, end), start ? String(start) : null, start > 0);
    }, patch => { state = { ...state, ...patch }; });
    await history.refresh(7);
    expect(state.recordEvents).toEqual(all.slice(6, 10));
    count = 12;
    reads.length = 0;
    await history.refresh(7);
    expect(reads).toEqual([undefined, '10']);
    reads.length = 0;
    await history.older(5);
    expect(reads).toEqual(['6']);
    expect(state.recordEvents).toEqual(all.slice(4));
    reads.length = 0;
    await history.refresh(3);
    expect(reads).toEqual([undefined, '4']);
    expect(state.recordEvents).toEqual(all.slice(2));
    expect(state.recordEventsHasOlder).toBe(true);
    history.stop();
  });

  it('does not advance the history boundary past a failed catch-up interval', async () => {
    const all = Array.from({ length: 8 }, (_, i) => event(String(i + 1), i + 1));
    let count = 4;
    let fail = false;
    let state: Partial<RuntimeState> = {};
    const reads: Array<string | undefined> = [];
    const history = new SessionRecordEvents('selected', async (_session, before) => {
      reads.push(before);
      if (fail && before === '6') throw new Error('History unavailable');
      const end = before === undefined ? count : Number(before);
      const start = Math.max(0, end - 2);
      return page(all.slice(start, end), start ? String(start) : null, start > 0);
    }, patch => { state = { ...state, ...patch }; });
    await history.refresh(0);
    count = 8;
    fail = true;
    await history.refresh(0);
    expect(state.recordEventsError).toBe('History unavailable');
    expect(state.recordEvents?.map(row => row.at)).toEqual([1, 2, 3, 4, 7, 8]);
    fail = false;
    reads.length = 0;
    await history.refresh(0);
    expect(reads).toEqual([undefined, '6', '4']);
    expect(state.recordEvents).toEqual(all);
    expect(state.recordEventsError).toBeUndefined();
    history.stop();
  });

  it('keeps exact notice coverage when a live frame arrives during a stale R1 request', async () => {
    let state: Partial<RuntimeState> = {};
    let resolve!: (page: RecordEventPage) => void;
    const history = new SessionRecordEvents('selected', () => new Promise(done => { resolve = done; }),
      patch => { state = { ...state, ...patch }; });
    const reading = history.refresh(Infinity);
    const occurrence = event('a1', 20, 'assignment.opened');
    history.receive({ ...occurrence, noticeMessageIds: ['notice-1'] });
    resolve(page([occurrence]));
    await reading;
    expect(state.recordEvents).toHaveLength(1);
    expect(state.recordEvents![0].noticeMessageIds).toEqual(['notice-1']);
    // The referenced notice is not loaded yet: retain the pill until its exact
    // message-side coverage can replace it with the visible notice.
    expect(uncoveredRecordEvents(state.recordEvents!, [])).toHaveLength(1);
    history.stop();
  });

  it('uses exact notice IDs, never similarity, while retaining later kinds without displaying them', () => {
    const opened = event('a1', 20, 'assignment.opened');
    const filed = event('w1', 10);
    const later = event('artifact-1', 30, 'artifact.recorded');
    const notice: CanonicalMessage = { kind: 'message', id: 'notice', sessionKey: 'selected', seq: 1,
      rowVersion: 1, role: 'assistant', content: 'assignment opened a1', raw: {} };
    expect(uncoveredRecordEvents([filed, opened, later], [notice])).toEqual([filed, opened]);
    expect(uncoveredRecordEvents([filed, opened, later], [{ ...notice, recordEventIds: [opened.eventId] }]))
      .toEqual([filed]);
    expect(recordEventPresentation(later).text).toBe('Artifact recorded');
  });

  it('keeps an unavailable optional history local and retries without manufacturing pre-activation events', async () => {
    let fail = true;
    let state: Partial<RuntimeState> = {};
    const history = new SessionRecordEvents('selected', async () => {
      if (fail) throw new Error('History unavailable');
      return page([]);
    }, patch => { state = { ...state, ...patch }; });
    await history.refresh(0);
    expect(state.recordEventsError).toBe('History unavailable');
    expect(state.status).toBeUndefined();
    fail = false;
    await history.refresh(0);
    expect(state.recordEvents).toEqual([]);
    expect(state.recordEventsError).toBeUndefined();
    history.stop();
  });
});
