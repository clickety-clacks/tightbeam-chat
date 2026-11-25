import type { ChatTransport, SessionRecordEvent, WorkItemSummary } from './types';

const PAGE_LIMIT = 50;
// A reconnecting feed re-reads history often; a failing list must not follow it.
const RETRY_AFTER_MS = 30_000;
const WATCH_WAIT_MS = 1_500;
type Position = { readonly at: number; readonly id: string };
const newer = (a: Position, b: Position) => a.at > b.at || (a.at === b.at && a.id > b.id);

/**
 * Optional names for the agent's loaded filed work items. One list read covers
 * a page of filed events; nothing here delays or fails the events themselves.
 */
export class FiledWorkItems {
  private items: ReadonlyMap<string, WorkItemSummary> = new Map();
  private filed: readonly Position[] = []; // Newest first, as the Gateway lists them.
  private readonly tried = new Set<string>();
  private readonly failed = new Set<string>();
  private floor?: Position; // Oldest row listed so far; `cursor` continues below it.
  private cursor: string | null = null;
  private readonly controller = new AbortController();
  private failedAt = -Infinity;
  private running = false;
  private again = false;

  constructor(private readonly sessionKey: string,
    private readonly read: NonNullable<ChatTransport['readFiledWorkItems']>,
    private readonly publish: (items: ReadonlyMap<string, WorkItemSummary>) => void,
    /** Watch the loaded items first, so a change cannot fall between the read and the watch. */
    private readonly beforeRead?: (ids: readonly string[]) => Promise<unknown>) {}

  /** Reads only for a completed history read. A live event waits for the next one: no read per message. */
  sync(events: readonly SessionRecordEvent[], settled: boolean): void {
    if (this.controller.signal.aborted) return;
    this.filed = events.filter(event => event.kind === 'work_item.filed')
      .map(event => ({ at: event.at, id: event.record.id }))
      .sort((a, b) => newer(a, b) ? -1 : 1);
    if (settled && Date.now() - this.failedAt >= RETRY_AFTER_MS) {
      for (const id of this.failed) this.tried.delete(id);
      this.failed.clear();
    }
    if (settled && this.missing().length) void this.run();
  }

  /** Re-read the newest loaded filed items, for a caller that needs fresh state. */
  async refresh(): Promise<void> {
    const limit = Math.min(PAGE_LIMIT, this.filed.length);
    if (!limit || this.controller.signal.aborted) return;
    try { await this.page(limit); } catch { /* Keep the last known rows. */ }
  }

  private missing(): readonly Position[] {
    return this.filed.filter(row => !this.items.has(row.id) && !this.tried.has(row.id));
  }

  private async run(): Promise<void> {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        const missing = this.missing();
        for (const row of missing) this.tried.add(row.id);
        const floor = this.floor;
        const above = floor ? missing.filter(row => newer(row, floor)) : missing;
        try {
          if (above.length) await this.walk(this.filed.indexOf(above[above.length - 1]) + 1);
          if (missing.length > above.length && this.cursor && !this.controller.signal.aborted) {
            await this.walk(missing.length - above.length, this.cursor);
          }
        } catch {
          this.failedAt = Date.now();
          for (const row of missing) if (!this.items.has(row.id)) this.failed.add(row.id);
        }
      } while (this.again && !this.controller.signal.aborted);
    } finally { this.running = false; }
  }

  /** Names and first paint never wait long for the change feed. */
  private async watchFirst(): Promise<void> {
    if (!this.beforeRead) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.beforeRead(this.filed.map(row => row.id)).catch(() => {}),
      new Promise<void>(resolve => { timer = setTimeout(resolve, WATCH_WAIT_MS); })]);
    clearTimeout(timer);
  }

  private async walk(count: number, before?: string): Promise<void> {
    await this.watchFirst();
    for (let left = count; left > 0; left -= PAGE_LIMIT) {
      const next = await this.page(Math.min(PAGE_LIMIT, left), before);
      if (!next || next === before) return;
      before = next;
    }
  }

  private async page(limit: number, before?: string): Promise<string | null> {
    const page = await this.read(this.sessionKey, { limit, before }, this.controller.signal);
    if (this.controller.signal.aborted || !page.items.length) return null;
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
    return page.hasOlder ? page.oldestCursor : null;
  }

  stop(): void {
    this.controller.abort();
  }
}
