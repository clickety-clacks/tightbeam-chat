import type { ChatTransport, FiledWorkItemPage, SessionRecordEvent, WorkItemSummary } from './types';

const PAGE_LIMIT = 50;
// A reconnecting feed re-reads history often; a failing list must not follow it.
const RETRY_AFTER_MS = 30_000;
const WATCH_WAIT_MS = 1_500;
type Position = { readonly at: number; readonly id: string };
const newer = (a: Position, b: Position) => a.at > b.at || (a.at === b.at && a.id > b.id);

export type RecordEventLoad = 'newest' | 'older' | 'live';

/**
 * Optional names for the agent's loaded filed work items. A settled history load
 * makes at most one list read; nothing here delays or fails the events themselves.
 */
export class FiledWorkItems {
  private items: ReadonlyMap<string, WorkItemSummary> = new Map();
  private filed: readonly Position[] = []; // Newest first, as the Gateway lists them.
  private readonly absent = new Set<string>(); // Listed range held no such row for this reader.
  private floor?: Position; // Oldest decoded row. A partial page may scan past it.
  private cursor: string | null | undefined;
  private cursorPastFloor = false;
  private tailRequested = false;
  private olderFailed = false;
  private readonly failedPages = new Map<string | undefined, Set<string>>();
  // An incomplete scan's start and end are opaque. A row returned by a
  // continuation from its end gives us a position known to be below that end.
  private readonly partialPages = new Map<string | undefined, Map<string | null, Position | undefined>>();
  private readonly controller = new AbortController();
  private failedAt = -Infinity;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly sessionKey: string,
    private readonly read: NonNullable<ChatTransport['readFiledWorkItems']>,
    private readonly publish: (items: ReadonlyMap<string, WorkItemSummary>) => void,
    /** Watch the loaded items first, so a change cannot fall between the read and the watch. */
    private readonly beforeRead?: (ids: readonly string[]) => Promise<unknown>,
    private readonly onFailureChange?: (failed: boolean) => void) {}

  /** A live event makes no read; its title waits for the next newest-history load. */
  sync(events: readonly SessionRecordEvent[], load: RecordEventLoad): void {
    if (this.controller.signal.aborted) return;
    const before = new Set(this.filed.map(row => row.id));
    this.filed = events.filter(event => event.kind === 'work_item.filed')
      .map(event => ({ at: event.at, id: event.record.id }))
      .sort((a, b) => newer(a, b) ? -1 : 1);
    if (load === 'live') return;
    const added = this.filed.filter(row => !before.has(row.id));
    if (load === 'older' && !added.length) return;
    // Each load keeps its own rows, even when it waits behind a slow read.
    const filed = this.filed;
    this.queue = this.queue.then(() => this.load(load, filed, added)).catch(() => { this.failedAt = Date.now(); });
  }

  /** Re-read the newest loaded filed items, for a caller that needs fresh state. */
  async refresh(): Promise<void> {
    const limit = Math.min(PAGE_LIMIT, this.filed.length);
    if (!limit || this.controller.signal.aborted) return;
    try { await this.page(limit, this.filed.slice(0, limit)); } catch { /* Keep the last known rows. */ }
  }

  /** A row another read already brought, so its title shows without a read here. */
  adopt(item: WorkItemSummary): void {
    if (this.controller.signal.aborted || this.items.has(item.id)) return;
    this.items = new Map(this.items).set(item.id, item);
    this.publish(this.items);
  }

  private missing(rows: readonly Position[]): readonly Position[] {
    return rows.filter(row => !this.items.has(row.id) && !this.absent.has(row.id));
  }

  private below(rows: readonly Position[]): readonly Position[] {
    const floor = this.floor;
    if (floor) return this.missing(rows).filter(row => newer(floor, row));
    return this.cursor ? this.missing(rows) : [];
  }

  private async load(load: RecordEventLoad, filed: readonly Position[], added: readonly Position[]): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (load === 'older' && this.tailRequested) {
      // Once the tail has been requested, older loads only follow its cursor.
      // A failed tail has no cursor, so it still recovers on a newest load.
      const own = this.below(added);
      if (own.length && !this.olderFailed) await this.continueBelow(own);
      return;
    }
    if (Date.now() - this.failedAt < RETRY_AFTER_MS) return;
    const newest = filed.slice(0, PAGE_LIMIT);
    const floor = this.floor;
    const above = this.missing(newest).filter(row => !floor || newer(row, floor));
    if (above.length) {
      const limit = newest.indexOf(above[above.length - 1]) + 1;
      await this.watchFirst();
      const rows = newest.slice(0, limit);
      const page = await this.page(limit, rows);
      if (page && !page.partial) for (const row of this.missing(rows)) this.absent.add(row.id);
      return;
    }
    const left = this.below(filed);
    if (left.length) await this.continueBelow(left);
  }

  private async continueBelow(added: readonly Position[]): Promise<void> {
    if (!this.cursor) return;
    await this.watchFirst();
    const before = this.cursor;
    if (!before) return;
    const rows = this.below(this.filed);
    const canCheckAbsence = !this.cursorPastFloor;
    const limit = Math.min(PAGE_LIMIT, added.length);
    const page = await this.page(limit, (canCheckAbsence ? rows : added).slice(0, limit), before).catch(error => {
      // A concurrent refresh may already have replaced the failed cursor.
      if (this.cursor === before) this.olderFailed = true;
      throw error;
    });
    this.olderFailed = false;
    if (!page || page.partial || !canCheckAbsence) return;
    const floor = this.floor;
    for (const row of this.missing(rows)) if (floor && newer(row, floor)) this.absent.add(row.id);
  }

  /** Names and first paint never wait long for the change feed. */
  private async watchFirst(): Promise<void> {
    if (!this.beforeRead) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.beforeRead(this.filed.map(row => row.id)).catch(() => {}),
      new Promise<void>(resolve => { timer = setTimeout(resolve, WATCH_WAIT_MS); })]);
    clearTimeout(timer);
  }

  private async page(limit: number, rows: readonly Position[], before?: string): Promise<FiledWorkItemPage | undefined> {
    if (this.controller.signal.aborted) return;
    if (before === undefined) this.tailRequested = true;
    const signal = this.controller.signal;
    const page = await this.read(this.sessionKey, { limit, before }, signal).catch(error => {
      if (!signal.aborted) {
        const alreadyFailed = this.hasFailedCoverage;
        const failed = this.failedPages.get(before) ?? new Set<string>();
        for (const row of rows) failed.add(row.id);
        this.failedPages.set(before, failed);
        if (!alreadyFailed) this.onFailureChange?.(true);
      }
      throw error;
    });
    if (signal.aborted) return;
    const previousFloor = this.floor;
    let newest: Position | undefined;
    let oldest: Position | undefined;
    const items = new Map(this.items);
    for (const item of page.items) {
      const known = items.get(item.id);
      if (!known || known.rowVersion <= item.rowVersion) items.set(item.id, item);
      const position = { at: item.createdAt, id: item.id };
      if (!newest || newer(position, newest)) newest = position;
      if (!oldest || newer(oldest, position)) oldest = position;
    }
    this.updateCoverage(page, rows, before, newest, oldest);
    const floorAdvanced = oldest !== undefined && (!previousFloor || newer(previousFloor, oldest));
    if (floorAdvanced) this.floor = oldest;
    const followsCursor = before === this.cursor;
    const completeTail = before === undefined && !page.partial && !page.hasOlder;
    const nextCursor = page.hasOlder ? page.oldestCursor : null;
    // A fresh scan overlapping the loaded floor can replace a failed cursor
    // even if omitted rows leave the oldest decoded row unchanged.
    const replacesFailedCursor = before === undefined && this.olderFailed &&
      nextCursor !== null && nextCursor !== this.cursor &&
      (floorAdvanced || page.items.some(item => item.id === previousFloor?.id));
    // Advance even when every row in the scanned window was omitted. A newer
    // cursor-free refresh cannot rewind a cursor already past the decoded floor.
    if (replacesFailedCursor || (this.cursorPastFloor ? followsCursor || completeTail : floorAdvanced || (page.partial && followsCursor))) {
      // The server advanced past a failed older request while preserving its warning.
      if (nextCursor !== this.cursor) this.olderFailed = false;
      this.cursor = nextCursor;
      this.cursorPastFloor = page.hasOlder && (page.partial === true || !floorAdvanced && this.cursorPastFloor);
    }
    if (page.items.length) {
      this.items = items;
      this.publish(items);
    }
    return page;
  }

  private get hasFailedCoverage(): boolean {
    return this.failedPages.size > 0 || this.partialPages.size > 0;
  }

  private updateCoverage(page: FiledWorkItemPage, rows: readonly Position[], before: string | undefined,
    newest: Position | undefined, oldest: Position | undefined): void {
    const wasFailed = this.hasFailedCoverage;
    if (before !== undefined && newest) {
      for (const ends of this.partialPages.values()) {
        if (!ends.has(before)) continue;
        const below = ends.get(before);
        if (!below || newer(newest, below)) ends.set(before, newest);
      }
    }
    if (page.partial) {
      this.failedAt = Date.now();
      const ends = this.partialPages.get(before) ?? new Map<string | null, Position | undefined>();
      if (!ends.has(page.oldestCursor)) ends.set(page.oldestCursor, undefined);
      this.partialPages.set(before, ends);
    } else if (wasFailed) {
      if (before === undefined && !page.hasOlder) {
        this.failedPages.clear();
        this.partialPages.clear();
      } else {
        const returned = new Set(page.items.map(item => item.id));
        const requested = new Set(rows.map(row => row.id));
        // Limits and the client's event window do not prove what the server
        // scanned. A complete tail includes every newer start. It covers an
        // incomplete scan if its end matches or it returns a row past that end.
        for (const [start, ends] of this.partialPages) {
          if (before !== undefined && before !== start) continue;
          if (!page.hasOlder) ends.clear();
          else {
            if (page.oldestCursor !== null) ends.delete(page.oldestCursor);
            for (const [end, below] of ends) {
              if (oldest && below && !newer(oldest, below)) ends.delete(end);
            }
          }
          if (!ends.size) this.partialPages.delete(start);
        }
        for (const [cursor, failed] of this.failedPages) {
          for (const id of failed) {
            if (returned.has(id) || (cursor === before && requested.has(id))) failed.delete(id);
          }
          if (!failed.size) this.failedPages.delete(cursor);
        }
      }
    }
    if (wasFailed !== this.hasFailedCoverage) this.onFailureChange?.(this.hasFailedCoverage);
  }

  stop(): void {
    this.controller.abort();
  }
}
