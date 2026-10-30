import { describe, expect, it } from 'vitest';
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
    expect(reads).toEqual([undefined, 'p3', 'p2', undefined, 'p3', 'p2']);
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
    expect(uncoveredRecordEvents(state.recordEvents!, [])).toEqual([]);
    history.stop();
  });

  it('uses exact notice IDs, never record-name or text similarity, and preserves later active kinds', () => {
    const opened = event('a1', 20, 'assignment.opened');
    const filed = event('w1', 10);
    const later = event('artifact-1', 30, 'artifact.recorded');
    const notice: CanonicalMessage = { kind: 'message', id: 'notice', sessionKey: 'selected', seq: 1,
      rowVersion: 1, role: 'assistant', content: 'assignment opened a1', raw: {} };
    expect(uncoveredRecordEvents([filed, opened, later], [notice])).toHaveLength(3);
    expect(uncoveredRecordEvents([filed, opened, later], [{ ...notice, recordEventIds: [opened.eventId] }]))
      .toEqual([filed, later]);
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
