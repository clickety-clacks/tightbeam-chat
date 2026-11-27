import type { ChatTransport, SessionRecordEvent, WorkItemSummary } from './types';

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
  private floor?: Position; // Oldest row listed so far; `cursor` continues below it.
  private cursor: string | null = null;
  private tailRequested = false;
  private olderFailed = false;
  private readonly controller = new AbortController();
  private failedAt = -Infinity;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly sessionKey: string,
    private readonly read: NonNullable<ChatTransport['readFiledWorkItems']>,
    private readonly publish: (items: ReadonlyMap<string, WorkItemSummary>) => void,
    /** Watch the loaded items first, so a change cannot fall between the read and the watch. */
    private readonly beforeRead?: (ids: readonly string[]) => Promise<unknown>) {}

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
    try { await this.page(limit); } catch { /* Keep the last known rows. */ }
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
    return floor ? this.missing(rows).filter(row => newer(floor, row)) : [];
  }

  private async load(load: RecordEventLoad, filed: readonly Position[], added: readonly Position[]): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (load === 'older' && this.tailRequested) {
      // Once the tail has been requested, older loads only follow its cursor.
      // A failed tail has no cursor, so it still recovers on a newest load.
      const own = this.below(added).length;
      if (own && !this.olderFailed) await this.continueBelow(own);
      return;
    }
    if (Date.now() - this.failedAt < RETRY_AFTER_MS) return;
    const newest = filed.slice(0, PAGE_LIMIT);
    const floor = this.floor;
    const above = this.missing(newest).filter(row => !floor || newer(row, floor));
    if (above.length) {
      const limit = newest.indexOf(above[above.length - 1]) + 1;
      await this.watchFirst();
      await this.page(limit);
      for (const row of this.missing(newest.slice(0, limit))) this.absent.add(row.id);
      return;
    }
    const left = this.below(filed).length;
    if (left) await this.continueBelow(left);
  }

  private async continueBelow(count: number): Promise<void> {
    if (!this.cursor) return;
    await this.watchFirst();
    const rows = this.below(this.filed);
    this.olderFailed = true;
    await this.page(Math.min(PAGE_LIMIT, count), this.cursor);
    this.olderFailed = false;
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

  private async page(limit: number, before?: string): Promise<void> {
    if (this.controller.signal.aborted) return;
    if (before === undefined) this.tailRequested = true;
    const page = await this.read(this.sessionKey, { limit, before }, this.controller.signal);
    if (this.controller.signal.aborted || !page.items.length) return;
    const items = new Map(this.items);
    for (const item of page.items) {
      const known = items.get(item.id);
      if (!known || known.rowVersion <= item.rowVersion) items.set(item.id, item);
      const position = { at: item.createdAt, id: item.id };
      if (!this.floor || newer(this.floor, position)) {
        this.floor = position;
        this.cursor = page.hasOlder ? page.oldestCursor : null;
      }
    }
    this.items = items;
    this.publish(items);
  }

  stop(): void {
    this.controller.abort();
  }
}
