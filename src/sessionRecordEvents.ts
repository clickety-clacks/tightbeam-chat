import type { ActivityPillPresentation } from './activityPresentation';
import type { ChatTransport, ConversationRecord, RuntimeState, SessionRecordEvent } from './types';

const compare = (a: SessionRecordEvent, b: SessionRecordEvent) => a.at - b.at || a.eventId.localeCompare(b.eventId);

/** R1 alone decides active kinds and cutoffs. Never synthesize or backfill events. */
export class SessionRecordEvents {
  private rows: readonly SessionRecordEvent[] = Object.freeze([]);
  private byId = new Map<string, SessionRecordEvent>();
  private cursor: string | undefined;
  private hasOlder = false;
  private controller?: AbortController;
  private stopped = false;
  private requestedFloor = Infinity;
  private loadedFloor = Infinity;
  // Only a completed R1 catch-up advances this boundary; a live frame can
  // arrive beyond a missed interval and must never stand in for history.
  private historyHead?: SessionRecordEvent;

  constructor(private readonly sessionKey: string,
    private readonly read: NonNullable<ChatTransport['readRecordEvents']>,
    private readonly publish: (patch: Partial<RuntimeState>) => void) {}

  private merge(events: readonly SessionRecordEvent[]): void {
    if (this.stopped) return;
    const changed = new Map<string, SessionRecordEvent>();
    const added: SessionRecordEvent[] = [];
    for (let event of events) {
      if (event.sessionKey !== this.sessionKey) continue;
      const previous = changed.get(event.eventId) ?? this.byId.get(event.eventId);
      if (previous) {
        // Coverage can grow without changing immutable occurrence identity.
        const notices = [...new Set([...previous.noticeMessageIds, ...event.noticeMessageIds])];
        if (notices.length === previous.noticeMessageIds.length) continue;
        event = Object.freeze({ ...previous, noticeMessageIds: Object.freeze(notices) });
      }
      changed.set(event.eventId, event);
    }
    if (!changed.size) return;
    for (const [id, event] of changed) {
      if (!this.byId.has(id)) added.push(event);
      this.byId.set(id, event);
    }
    added.sort(compare);
    // One linear merge for the whole read, not a full retained-array copy for
    // each occurrence on each page. Unchanged row objects keep their identity.
    const merged: SessionRecordEvent[] = [];
    let next = 0;
    for (const row of this.rows) {
      while (next < added.length && compare(added[next], row) < 0) merged.push(added[next++]);
      merged.push(changed.get(row.eventId) ?? row);
    }
    while (next < added.length) merged.push(added[next++]);
    this.rows = Object.freeze(merged);
  }

  receive(event: SessionRecordEvent): void {
    const previous = this.rows;
    this.merge([event]);
    if (this.rows !== previous) this.publish({ recordEvents: this.rows });
  }

  refresh(floor: number): Promise<void> {
    // Restart after subscription readiness so a lossy disconnect is repaired by R1.
    this.controller?.abort();
    return this.readPages(undefined, floor);
  }

  older(floor: number): Promise<void> {
    this.requestedFloor = Math.min(this.requestedFloor, floor);
    if (this.controller || !this.hasOlder || !this.cursor) return Promise.resolve();
    return this.readPages(this.cursor, this.requestedFloor);
  }

  private async readPages(before: string | undefined, floor: number): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.controller = controller;
    this.requestedFloor = floor;
    this.publish({ recordEventsLoading: true, recordEventsError: undefined });
    const pending: SessionRecordEvent[] = [];
    let overlap = before === undefined ? this.historyHead : undefined;
    let head = this.historyHead;
    let first = before === undefined;
    let cursor = this.cursor;
    let hasOlder = this.hasOlder;
    let loadedFloor = this.loadedFloor;
    const commit = () => {
      this.merge(pending);
      this.cursor = cursor;
      this.hasOlder = hasOlder;
      this.loadedFloor = loadedFloor;
    };
    try {
      const cursors = new Set<string>();
      while (true) {
        const page = await this.read(this.sessionKey, before, controller.signal);
        if (controller.signal.aborted || this.stopped) return;
        if (page.items.some(row => row.sessionKey !== this.sessionKey) ||
            (page.hasOlder && (!page.oldestCursor || !page.items.length || page.oldestCursor === before || cursors.has(page.oldestCursor)))) {
          throw new Error('Record-event history did not advance in this conversation.');
        }
        for (const row of page.items) pending.push(row);
        if (first) {
          head = page.items[page.items.length - 1] ?? head;
          first = false;
        }
        const oldest = page.items[0];
        if (overlap) {
          // R1 is append-only with fixed cutoffs. Once we reach the previous
          // history head, the interval below it is already retained. Keep its
          // oldest cursor instead of walking all those pages again.
          if (!page.hasOlder || (oldest && compare(oldest, overlap) <= 0)) {
            overlap = undefined;
            if (!hasOlder || loadedFloor <= this.requestedFloor) break;
            before = cursor;
            continue;
          }
        } else {
          cursor = page.oldestCursor ?? undefined;
          hasOlder = page.hasOlder;
          loadedFloor = Math.min(loadedFloor, oldest?.at ?? Infinity);
          if (!hasOlder || loadedFloor <= this.requestedFloor) break;
        }
        before = page.oldestCursor ?? undefined;
        cursors.add(before!);
      }
      commit();
      this.historyHead = head;
      this.publish({ recordEvents: this.rows, recordEventsHasOlder: this.hasOlder,
        recordEventsLoading: false, recordEventsError: undefined });
    } catch (error) {
      if (!controller.signal.aborted && !this.stopped) {
        // Retain successfully read rows, but do not advance the catch-up head:
        // a retry must still fill the failed interval before it is complete.
        commit();
        this.publish({ recordEvents: this.rows,
          recordEventsHasOlder: this.hasOlder, recordEventsLoading: false,
          recordEventsError: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
  }
}

// The first client stage surfaces only these kinds. The wire model retains
// later kinds without assuming that they have shipped or inventing a cutoff.
const displayedRecordEventKinds = new Set(['work_item.filed', 'assignment.opened']);

/** A loaded notice's exact coverage wins, regardless of arrival order or text. */
export function uncoveredRecordEvents(events: readonly SessionRecordEvent[], records: readonly ConversationRecord[]) {
  const covered = new Set(records.flatMap(row => row.recordEventIds ?? []));
  return events.filter(event => displayedRecordEventKinds.has(event.kind) && !covered.has(event.eventId));
}

const presentations: Readonly<Record<string, ActivityPillPresentation>> = {
  'work_item.filed': { label: 'Work item', text: 'Work item filed', tone: 'blue', icon: 'work-item' },
  'assignment.opened': { label: 'Assignment', text: 'Assignment opened', tone: 'blue', icon: 'assignment' },
  'assignment.completed': { label: 'Assignment', text: 'Assignment completed', tone: 'green', icon: 'assignment' },
  'assignment.revoked': { label: 'Assignment', text: 'Assignment revoked', tone: 'slate', icon: 'assignment' },
  'attest.filed': { label: 'Attest', text: 'Attest filed', tone: 'green', icon: 'attest' },
  'decision.raised': { label: 'Decision', text: 'Decision raised', tone: 'amber', icon: 'decision' },
  'decision.answered': { label: 'Decision', text: 'Decision answered', tone: 'green', icon: 'decision-answered' },
  'decision.ruled': { label: 'Decision', text: 'Decision ruled', tone: 'green', icon: 'decision-answered' },
  'artifact.recorded': { label: 'Artifact', text: 'Artifact recorded', tone: 'blue', icon: 'activity' },
};
export function recordEventPresentation(event: SessionRecordEvent): ActivityPillPresentation {
  return { ...(presentations[event.kind] ?? { label: 'Activity', text: event.kind, tone: 'slate', icon: 'activity' }),
    metadata: event.record.id.replace(/^([a-z]+_)(.{4}).*$/, '$1$2') };
}
