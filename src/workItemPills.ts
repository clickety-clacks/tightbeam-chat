import type { WorkItemSummary } from './types';

export type { WorkItemSummary };

export interface WorkItemTurn {
  readonly seq: number;
  readonly workItemId: string | null;
  readonly status: string | null;
}

/** A change notice. It only says what to read again; it is never current state. */
export type WorkItemChange =
  | { readonly kind: 'item'; readonly workItemId: string }
  | { readonly kind: 'turn'; readonly workItemId: string; readonly turnSeq: number; readonly ended: boolean };

export interface WorkItemChangeConnection {
  /** Resolves once the Gateway confirms the subscription for this one work item. */
  watch(workItemId: string): Promise<void>;
  unwatch(workItemId: string): void;
  close(): void;
}

/** Live reads. Each call makes exactly one Gateway read, for one item or one turn. */
export interface WorkItemLiveTransport {
  /** Undefined when the Gateway has no such item for this reader. */
  readItem(id: string, signal: AbortSignal): Promise<WorkItemSummary | undefined>;
  readTurn(seq: number, signal: AbortSignal): Promise<WorkItemTurn | undefined>;
  openChanges(onChange: (change: WorkItemChange) => void, onLost: () => void,
    signal: AbortSignal): Promise<WorkItemChangeConnection>;
}

export type WorkItemPillState = 'not-started' | 'held' | 'working' | 'between-hands' | 'done' | 'failed' | 'shelved';

export interface WorkItemPill {
  readonly id: string;
  readonly title: string;
  readonly state: WorkItemPillState;
  /** Something changed and it has not been read again; show the state as past. */
  readonly stale: boolean;
  readonly summary: WorkItemSummary;
}

/** One connection accepts this many subscriptions. */
export const MAX_WORK_ITEM_PILLS = 100;
const SETTLE_MS = 5_000;
const REREAD_INTERVAL_MS = 120_000;
const RING_RECHECK_MS = 600_000;
/** More marked pills than this in view cost less as one page read. */
const SINGLE_REREAD_LIMIT = 3;
/** Pills that fall due this close together count as needing it together. */
const TOGETHER_MS = 1_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

interface Entry {
  summary: WorkItemSummary;
  stale: boolean;
  /** Advances with every notice, so a read cannot clear a change it did not see. */
  changes: number;
  firstChangeAt: number;
  lastChangeAt: number;
  lastRereadAt: number;
  reading: boolean;
  /** Turns to read before the ring may say anything about them. */
  unreadTurns: Set<number>;
  /** Turns this page read as running and has not read as ended. */
  runningTurns: Set<number>;
  readingTurns: Set<number>;
  ringReadAt: number;
}

export interface WorkItemPillsOptions {
  readonly transport: WorkItemLiveTransport;
  /** Repeat the one read of the loaded items; its result comes back through setItems. */
  readonly refreshItems: () => void;
  readonly now?: () => number;
}

const finished: Readonly<Record<string, WorkItemPillState>> = { closed: 'done', failed: 'failed', iceboxed: 'shelved' };

function baseState(summary: WorkItemSummary): WorkItemPillState {
  const end = finished[summary.state];
  if (end) return end;
  if (summary.holders.length) return 'held';
  return summary.started ? 'between-hands' : 'not-started';
}

/**
 * Keeps the loaded work items' pills current. First paint uses only the items it
 * is given. After that a change notice marks one pill, and only pills in view
 * are read again, after a quiet moment and at a bounded rate.
 */
export class WorkItemPills {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private readonly now: () => number;
  private pills: readonly WorkItemPill[] = Object.freeze([]);
  private visible: ReadonlySet<string> = new Set();
  private pageVisible = true;
  private wanted = new Set<string>();
  private watched = new Map<string, Promise<void>>();
  /** Items whose subscription the Gateway has confirmed on this connection. */
  private ready = new Set<string>();
  /** A change may have been missed, so the items need their one read again. */
  private gap = false;
  private connection: WorkItemChangeConnection | undefined;
  private connecting: Promise<void> | undefined;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastItems: ReadonlyMap<string, WorkItemSummary> | undefined;
  private changesAtRefresh = new Map<string, number>();

  constructor(private readonly options: WorkItemPillsOptions) {
    this.now = options.now ?? Date.now;
  }

  getSnapshot = (): readonly WorkItemPill[] => this.pills;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Watch the page's items before they are read, so no change falls between the
   * read and the subscription. Resolves when every one is watched.
   */
  async watch(ids: Iterable<string>): Promise<void> {
    for (const id of ids) if (this.wanted.size < MAX_WORK_ITEM_PILLS) this.wanted.add(id);
    if (!this.wanted.size) return;
    await this.connect();
    await Promise.all(this.watchWanted());
  }

  /** The result of the one read of the loaded items. */
  setItems(items: ReadonlyMap<string, WorkItemSummary>): void {
    if (this.lifetime.signal.aborted || items === this.lastItems) return;
    const previous = this.lastItems;
    this.lastItems = items;
    for (const summary of items.values()) {
      const entry = this.entries.get(summary.id);
      if (!entry) {
        if (this.entries.size >= MAX_WORK_ITEM_PILLS) continue;
        this.entries.set(summary.id, { summary, stale: false, changes: 0, firstChangeAt: 0, lastChangeAt: 0,
          lastRereadAt: -Infinity, reading: false, unreadTurns: new Set(), runningTurns: new Set(), readingTurns: new Set(), ringReadAt: 0 });
        this.wanted.add(summary.id);
        if (!this.ready.has(summary.id)) this.gap = true;
      } else if (previous?.get(summary.id) !== summary) {
        this.applyRead(entry, summary, this.changesAtRefresh.get(summary.id) ?? 0);
      }
    }
    void this.catchUp().catch(() => {});
    this.publish();
  }

  /** The pills the reader can see now; only these are ever read again. */
  setVisible(ids: ReadonlySet<string>, pageVisible = true): void {
    this.visible = ids;
    this.pageVisible = pageVisible;
    this.pump();
  }

  /** A tap read this item; use it rather than reading it again. */
  acceptRead(summary: WorkItemSummary, changes: number): void {
    const entry = this.entries.get(summary.id);
    if (!entry) return;
    this.applyRead(entry, summary, changes);
    this.publish();
  }

  changesSeen(id: string): number { return this.entries.get(id)?.changes ?? 0; }

  dispose(): void {
    this.lifetime.abort();
    this.connection?.close();
    if (this.timer) clearTimeout(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.listeners.clear();
  }

  private applyRead(entry: Entry, summary: WorkItemSummary, seen: number): void {
    // A slower answer can be older than one already shown.
    if (summary.rowVersion >= entry.summary.rowVersion) entry.summary = summary;
    if (entry.changes === seen) entry.stale = false;
  }

  private refresh(): void {
    this.gap = false;
    this.changesAtRefresh = new Map([...this.entries].map(([id, entry]) => [id, entry.changes]));
    this.options.refreshItems();
  }

  /** What changed while not listening is unknown, for items and for running turns. */
  private markAllUnknown(): void {
    if (this.entries.size) this.gap = true;
    for (const entry of this.entries.values()) {
      entry.stale = true;
      entry.changes += 1;
      for (const seq of entry.runningTurns) entry.unreadTurns.add(seq);
      entry.runningTurns.clear();
    }
    this.publish();
  }

  private async connect(): Promise<void> {
    if (this.connection || this.lifetime.signal.aborted) return;
    this.connecting ??= this.openConnection().finally(() => { this.connecting = undefined; });
    await this.connecting;
  }

  private async openConnection(): Promise<void> {
    let lost = false;
    let current: WorkItemChangeConnection | undefined;
    const onLost = () => {
      lost = true;
      if (!current || this.connection !== current || this.lifetime.signal.aborted) return;
      this.connection = undefined;
      this.watched.clear();
      this.ready.clear();
      this.markAllUnknown();
      this.scheduleReconnect();
    };
    try {
      current = await this.options.transport.openChanges((change) => this.receive(change), onLost, this.lifetime.signal);
      if (lost) throw new Error('Work item changes closed while connecting.');
      if (this.lifetime.signal.aborted) { current.close(); return; }
      this.connection = current;
      this.reconnectDelay = RECONNECT_MIN_MS;
    } catch (error) {
      current?.close();
      if (!this.lifetime.signal.aborted) { this.markAllUnknown(); this.scheduleReconnect(); }
      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.lifetime.signal.aborted) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.catchUp().catch(() => {});
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  /** Connect, watch every item, then repeat the one read if a change could have been missed. */
  private async catchUp(): Promise<void> {
    await this.connect();
    const connection = this.connection;
    await Promise.all(this.watchWanted());
    if (!connection || this.connection !== connection) return;
    if (this.gap) this.refresh();
    this.pump();
  }

  private watchWanted(): Promise<void>[] {
    const connection = this.connection;
    if (!connection) return [];
    for (const id of this.wanted) {
      if (this.watched.has(id)) continue;
      const ready = connection.watch(id).then(() => { if (this.connection === connection) this.ready.add(id); });
      ready.catch(() => {});
      this.watched.set(id, ready);
    }
    return [...this.watched.values()];
  }

  private receive(change: WorkItemChange): void {
    const entry = this.entries.get(change.workItemId);
    if (!entry) return;
    const at = this.now();
    if (change.kind === 'item') {
      if (!entry.stale) entry.firstChangeAt = at;
      entry.stale = true;
      entry.changes += 1;
      entry.lastChangeAt = at;
    } else if (change.ended && !entry.runningTurns.has(change.turnSeq) && !this.inView(change.workItemId) &&
        !entry.readingTurns.has(change.turnSeq)) {
      // Never shown as running, so there is nothing to correct when it is seen.
      entry.unreadTurns.delete(change.turnSeq);
    } else {
      entry.unreadTurns.add(change.turnSeq);
    }
    this.publish();
  }

  private inView(id: string): boolean { return this.pageVisible && this.visible.has(id); }

  private ringing(entry: Entry): boolean {
    return entry.runningTurns.size > 0 && entry.summary.state === 'open';
  }

  /** When this marked pill may be read again; Infinity while it may not. */
  private rereadAt(id: string, entry: Entry): number {
    if (!entry.stale || entry.reading || !this.connection || !this.inView(id) || this.ringing(entry)) return Infinity;
    const settled = Math.min(entry.lastChangeAt + SETTLE_MS, entry.firstChangeAt + REREAD_INTERVAL_MS);
    return Math.max(settled, entry.lastRereadAt + REREAD_INTERVAL_MS);
  }

  private pump(): void {
    if (this.lifetime.signal.aborted) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const at = this.now();
    let next = Infinity;
    const due: string[] = [];
    const together: string[] = [];
    for (const [id, entry] of this.entries) {
      if (this.connection && this.inView(id)) {
        if (this.ringing(entry)) {
          if (entry.ringReadAt + RING_RECHECK_MS <= at) for (const seq of entry.runningTurns) entry.unreadTurns.add(seq);
          else next = Math.min(next, entry.ringReadAt + RING_RECHECK_MS);
        }
        for (const seq of entry.unreadTurns) this.readTurn(id, entry, seq);
      }
      const reread = this.rereadAt(id, entry);
      if (reread <= at + TOGETHER_MS) together.push(id);
      if (reread <= at) due.push(id);
      else next = Math.min(next, reread);
    }
    if (due.length && together.length > SINGLE_REREAD_LIMIT) {
      for (const id of together) this.entries.get(id)!.lastRereadAt = at;
      this.refresh();
    } else for (const id of due) this.readItem(id, this.entries.get(id)!);
    if (next < Infinity) this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.max(0, next - at));
  }

  private readItem(id: string, entry: Entry): void {
    entry.reading = true;
    entry.lastRereadAt = this.now();
    const seen = entry.changes;
    this.options.transport.readItem(id, this.lifetime.signal).then((summary) => {
      entry.reading = false;
      if (this.lifetime.signal.aborted || this.entries.get(id) !== entry) return;
      if (summary) this.applyRead(entry, summary, seen);
      else this.forget(id);
      this.publish();
    }, () => {
      // Still marked; the interval bounds the next attempt.
      entry.reading = false;
      if (!this.lifetime.signal.aborted) this.pump();
    });
  }

  private readTurn(id: string, entry: Entry, seq: number): void {
    if (entry.readingTurns.has(seq)) return;
    entry.unreadTurns.delete(seq);
    entry.readingTurns.add(seq);
    entry.ringReadAt = this.now();
    const connection = this.connection;
    this.options.transport.readTurn(seq, this.lifetime.signal).then((turn) => {
      entry.readingTurns.delete(seq);
      if (this.lifetime.signal.aborted || this.entries.get(id) !== entry) return;
      if (connection !== this.connection) { entry.unreadTurns.add(seq); this.publish(); return; }
      const running = turn?.status === 'running' && turn.workItemId === id;
      const before = this.ringing(entry);
      if (running) entry.runningTurns.add(seq);
      else entry.runningTurns.delete(seq);
      // A change held back by the ring settles from when the ring ends.
      if (before && !this.ringing(entry) && entry.stale) entry.firstChangeAt = entry.lastChangeAt = this.now();
      this.publish();
    }, () => {
      // The ring keeps its last read answer until the bounded recheck.
      entry.readingTurns.delete(seq);
      if (!this.lifetime.signal.aborted) this.pump();
    });
  }

  private forget(id: string): void {
    this.entries.delete(id);
    this.wanted.delete(id);
    if (this.watched.delete(id)) this.connection?.unwatch(id);
  }

  private publish(): void {
    if (this.lifetime.signal.aborted) return;
    const next = [...this.entries.values()]
      .sort((a, b) => b.summary.createdAt - a.summary.createdAt || b.summary.id.localeCompare(a.summary.id))
      .map((entry): WorkItemPill => {
        const ringing = this.ringing(entry);
        return Object.freeze({ id: entry.summary.id, title: entry.summary.title, summary: entry.summary,
          state: ringing ? 'working' : baseState(entry.summary),
          // A confirmed running turn is the newest thing known, so the ring stands.
          stale: entry.stale && !ringing });
      });
    const same = next.length === this.pills.length && next.every((pill, index) => {
      const old = this.pills[index];
      return old.id === pill.id && old.state === pill.state && old.stale === pill.stale && old.summary === pill.summary;
    });
    if (!same) {
      this.pills = Object.freeze(next);
      for (const listener of this.listeners) listener();
    }
    this.pump();
  }
}
