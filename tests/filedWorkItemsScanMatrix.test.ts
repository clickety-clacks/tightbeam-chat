import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FiledWorkItems } from '../src/filedWorkItems';
import type { FiledWorkItemPage, SessionRecordEvent, WorkItemSummary } from '../src/types';

type Step = {
  readonly newest?: number;
  readonly omit?: readonly number[];
  readonly failBefore?: number | null;
  readonly load?: readonly [from: number, to: number, kind: 'newest' | 'older' | 'live'];
  readonly refresh?: true;
};
type Request = readonly [limit: number, before?: number];
type Case = {
  readonly name: string;
  readonly newest: number;
  readonly legacyFalse?: boolean;
  readonly steps: readonly Step[];
  readonly calls: readonly Request[];
  readonly shown: readonly number[];
  readonly warnings: readonly boolean[];
};
const load = (from: number, to: number, kind: 'newest' | 'older' | 'live' = 'older'): Step => ({ load: [from, to, kind] });
const refresh = { refresh: true } as const;
const range = (first: number, last: number) => Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);

const cases: Case[] = [
  ...[false, true].map((partialFirst): Case => ({
    name: 'keeps a failed cursor on an unprovable partial refresh, partial first page ' + partialFirst, newest: 6,
    steps: [{ omit: partialFirst ? [5] : [] }, load(5, 6, 'newest'),
      { failBefore: 5 }, load(3, 6), { failBefore: null, omit: partialFirst ? [5, 4] : [4, 3] }, refresh, load(1, 6)],
    calls: [[2], [2, 5], [4]], shown: partialFirst ? [3, 6] : [5, 6], warnings: [true],
  })),
  {
    name: 'complete nonexhaustive tail reaches the incomplete boundary', newest: 8,
    steps: [load(7, 8, 'newest'), { omit: [5] }, load(5, 8), { omit: [] }, refresh],
    calls: [[2], [2, 7], [4]], shown: [5, 6, 7, 8], warnings: [true, false],
  },
  {
    name: 'equal-limit tail shifted by a new filing does not clear coverage', newest: 6,
    steps: [{ omit: [4] }, load(4, 6, 'newest'), { newest: 7 }, refresh],
    calls: [[3], [3]], shown: [5, 6, 7], warnings: [true],
  },
  ...[false, true].map((legacyFalse): Case => ({
    name: 'preserves legacy paging with ' + (legacyFalse ? 'false' : 'absent') + ' partial marker', newest: 5, legacyFalse,
    steps: [load(4, 5, 'newest'), load(2, 5), load(1, 5)],
    calls: [[2], [2, 4], [1, 2]], shown: [1, 2, 3, 4, 5], warnings: [],
  })),
  {
    name: 'two empty partial windows continue to an older item and then recover', newest: 5,
    steps: [{ omit: [2, 3, 4, 5] }, load(4, 5, 'newest'), load(2, 5), load(1, 5), { omit: [] }, refresh],
    calls: [[2], [2, 4], [1, 2], [5]], shown: [1, 2, 3, 4, 5], warnings: [true, false],
  },
  {
    name: 'exhausted partial refresh retains cached good rows and stays warned until a complete read', newest: 4,
    steps: [load(1, 4, 'newest'), { omit: [1] }, refresh, { omit: [] }, refresh],
    calls: [[4], [4], [4]], shown: [1, 2, 3, 4], warnings: [true, false],
  },
  {
    name: 'a deeper complete tail returns rows below an earlier partial end', newest: 8,
    steps: [load(7, 8, 'newest'), { omit: [5] }, load(5, 8), load(3, 8), { omit: [] }, refresh],
    calls: [[2], [2, 7], [2, 5], [6]], shown: [3, 4, 5, 6, 7, 8], warnings: [true, false],
  },
  {
    name: 'overlapping partial tails with the same decoded floor do not prove order', newest: 8,
    steps: [{ omit: [7] }, load(6, 8, 'newest'), { failBefore: 6 }, load(4, 8),
      { failBefore: null, omit: [7, 5, 4] }, refresh, load(2, 8)],
    calls: [[3], [2, 6], [5]], shown: [6, 8], warnings: [true],
  },
  {
    name: 'a complete tail renders repaired rows and keeps an unordered partial cursor', newest: 8,
    steps: [load(7, 8, 'newest'), { failBefore: 7 }, load(5, 8), { failBefore: null, omit: [6] }, refresh,
      { failBefore: 5 }, load(3, 8), { failBefore: null, omit: [] }, refresh, load(1, 8)],
    calls: [[2], [2, 7], [4], [2, 5], [6]], shown: range(3, 8), warnings: [true],
  },
  {
    name: 'complete refresh covers a partial range proved through an empty continuation', newest: 9,
    steps: [{ omit: [8, 6] }, load(7, 9, 'newest'), load(6, 9), load(4, 9), { omit: [] }, refresh],
    calls: [[3], [1, 7], [2, 6], [6]], shown: range(4, 9), warnings: [true, false],
  },
  ...[false, true].map((partialRefresh): Case => ({
    name: 'shifted ' + (partialRefresh ? 'partial' : 'complete') + ' tail cannot rewind a failed cursor', newest: 8,
    steps: [{ omit: [5] }, load(5, 8, 'newest'), { failBefore: 5 }, load(4, 8),
      { failBefore: null, newest: 10, omit: partialRefresh ? [9, 5] : [5] }, refresh, load(3, 8)],
    calls: [[4], [1, 5], [5]], shown: partialRefresh ? [6, 7, 8, 10] : [6, 7, 8, 9, 10], warnings: [true],
  })),
  {
    name: 'does not form a complete chain across an unordered failed continuation', newest: 8,
    steps: [load(7, 8, 'newest'), { omit: [6] }, load(5, 8), { failBefore: 5 }, load(3, 8),
      { failBefore: null, omit: [] }, refresh, load(1, 8)],
    calls: [[2], [2, 7], [2, 5], [6]], shown: range(3, 8), warnings: [true],
  },
  {
    name: 'two complete responses with a matching boundary cover the whole failed range', newest: 8,
    steps: [load(7, 8, 'newest'), load(3, 8, 'live'), { omit: [3, 4, 5, 6] }, refresh,
      load(7, 8, 'live'), { omit: [] }, refresh, load(1, 8)],
    calls: [[2], [6], [2], [6, 7]], shown: range(1, 8), warnings: [true, false],
  },
];

const ids = new Map(range(1, 10).map(number => [number, 'wi_' + number]));
const cursors = new Map(range(1, 10).map(number => [
  number, ['dawn', 'elm', 'frost', 'grove', 'harbor', 'iris', 'jade', 'kite', 'linen', 'mist'][number - 1],
]));
const item = (number: number): WorkItemSummary => ({
  id: ids.get(number)!, createdAt: number, rowVersion: 1, title: 'Item ' + number,
  state: 'open', started: false, holders: [], failReason: null,
});
function event(number: number): SessionRecordEvent {
  const id = ids.get(number)!;
  return { eventId: 'filed:' + id, kind: 'work_item.filed', sessionKey: 'selected', at: number,
    record: { type: 'work-item', id, workItemId: id, detail: '' },
    actorSessionKey: 'selected', tiedAs: ['creator'], cause: null, noticeMessageIds: [] };
}

describe('partial scoped list cursor and warning matrix', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(cases)('$name', async example => {
    let newest = example.newest;
    let omitted: readonly number[] = [];
    let failBefore: number | null = null;
    let shown: ReadonlyMap<string, WorkItemSummary> = new Map();
    const calls: Request[] = [];
    const warnings: boolean[] = [];
    const reader = new FiledWorkItems('selected', async (session, { limit, before }): Promise<FiledWorkItemPage> => {
      expect(session).toBe('selected');
      const boundary = before === undefined ? undefined : [...cursors].find(([, token]) => token === before)?.[0];
      if (before !== undefined) expect(boundary).toBeDefined();
      calls.push(boundary === undefined ? [limit] : [limit, boundary]);
      if (boundary === failBefore) throw new Error('Synthetic scoped list failure');
      const top = boundary === undefined ? newest : boundary - 1;
      const scanned = range(Math.max(1, top - limit + 1), top);
      const oldest = scanned[0];
      return {
        items: scanned.filter(number => !omitted.includes(number)).reverse().map(item),
        oldestCursor: cursors.get(oldest) ?? null,
        hasOlder: oldest > 1,
        ...(scanned.some(number => omitted.includes(number)) ? { partial: true } :
          // The direct legacy fixture deliberately bypasses the decoder's strict true check.
          example.legacyFalse ? { partial: false as never } : {}),
      };
    }, items => { shown = items; }, undefined, failed => warnings.push(failed));
    try {
      for (const step of example.steps) {
        if (step.newest !== undefined) newest = step.newest;
        if (step.omit !== undefined) omitted = step.omit;
        if (step.failBefore !== undefined) failBefore = step.failBefore;
        if (step.load) {
          const [from, to, kind] = step.load;
          reader.sync(range(from, to).map(event), kind);
          await vi.advanceTimersByTimeAsync(0);
        }
        if (step.refresh) await reader.refresh();
      }
      expect(calls).toEqual(example.calls);
      expect([...shown.values()].map(row => row.createdAt).sort((a, b) => a - b)).toEqual(example.shown);
      expect(warnings).toEqual(example.warnings);
    } finally {
      reader.stop();
    }
  });
});
