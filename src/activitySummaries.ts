import type { ActivityLine } from './activityTrail';

export interface SummarySource { readonly lineId: string; readonly sourceText: string }
export interface SummaryAnswer {
  readonly index: number;
  readonly state: 'pending' | 'waiting' | 'summary' | 'unsummarized';
  readonly summary?: string;
}
export interface ActivitySummaryTransport {
  stream(sources: readonly SummarySource[], receive: (answer: SummaryAnswer) => void, signal: AbortSignal): Promise<void>;
  readAttestNote?(id: string, signal: AbortSignal): Promise<string | undefined>;
}
export interface ActivitySummaryDisplay {
  readonly original?: string;
  readonly text?: string;
  readonly state?: SummaryAnswer['state'];
}
const emptyDisplay: ActivitySummaryDisplay = Object.freeze({});
const normalized = (text: string) => text.replace(/\r\n?/g, '\n').trim();

/** Same-origin transport used by both the standalone and embedded served page. */
export function createActivitySummaryTransport(fetcher: (url: string, init: RequestInit) => Promise<Response>,
  baseUrl: string): ActivitySummaryTransport {
  return {
    async stream(sources, receive, signal) {
      const response = await fetcher(`${baseUrl}/summaries`, { method: 'POST', signal, cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(sources) });
      if (!response.ok || !response.body) throw new Error('Summaries unavailable.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        while (true) {
          const part = await reader.read();
          pending += decoder.decode(part.value, { stream: !part.done });
          let newline;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (line.trim()) receive(JSON.parse(line) as SummaryAnswer);
          }
          if (part.done) break;
        }
      } finally { reader.releaseLock(); }
    },
    async readAttestNote(id, signal) {
      const response = await fetcher(`${baseUrl}/api/attests/${encodeURIComponent(id)}`, { method: 'GET', signal, cache: 'no-store' });
      if (!response.ok) return undefined;
      const body = await response.json();
      const note = body.attest?.note ?? body.note;
      return typeof note === 'string' && note.trim() ? note : undefined;
    },
  };
}

export function activitySummaryDescriptor(entry: ActivityLine): {
  lineId: string; sourceText?: string; prefix: string; attestId?: string;
} | undefined {
  const presentation = entry.presentation;
  if (!presentation || (!presentation.summaryText && !presentation.attestId)) return undefined;
  return { lineId: presentation.attestId ?? entry.id.replace(/^(message|member):/, ''),
    sourceText: presentation.summaryText, prefix: presentation.summaryPrefix ?? '', attestId: presentation.attestId };
}

interface Entry {
  readonly key: string;
  readonly descriptor: NonNullable<ReturnType<typeof activitySummaryDescriptor>>;
  readonly listeners: Set<() => void>;
  display: ActivitySummaryDisplay;
  source?: SummarySource;
  requested?: boolean;
}
interface Batch { entries: Entry[]; controller?: AbortController; waiting: boolean }

/** Page-local delivery only. Durable attempt ownership belongs to the server. */
export class ActivitySummaryViewer {
  private readonly entries = new Map<string, Entry>();
  private readonly batches = new Set<Batch>();
  private readonly controller = new AbortController();
  private queued = false;
  private disposed = false;
  private owners = 0;
  retain() { this.owners++; }
  release() {
    this.owners--;
    queueMicrotask(() => { if (!this.owners) this.dispose(); });
  }
  constructor(private readonly transport: ActivitySummaryTransport,
    private readonly available = () => typeof document === 'undefined' ||
      (document.visibilityState !== 'hidden' && navigator.onLine !== false)) {}
  key(entry: ActivityLine): string | undefined {
    const descriptor = activitySummaryDescriptor(entry);
    return descriptor ? JSON.stringify([descriptor.lineId, normalized(descriptor.sourceText ?? '')]) : undefined;
  }
  snapshot(key?: string): ActivitySummaryDisplay { return key ? this.entries.get(key)?.display ?? emptyDisplay : emptyDisplay; }
  subscribe(entry: ActivityLine, listener: () => void): () => void {
    const descriptor = activitySummaryDescriptor(entry);
    const key = this.key(entry);
    if (!descriptor || !key || this.disposed) return () => {};
    let held = this.entries.get(key);
    if (!held) {
      held = { key, descriptor, listeners: new Set(), display: emptyDisplay };
      this.entries.set(key, held);
      if (descriptor.sourceText) held.source = { lineId: descriptor.lineId, sourceText: normalized(descriptor.sourceText) };
      else if (descriptor.attestId && this.transport.readAttestNote) {
        const target = held;
        void this.transport.readAttestNote(descriptor.attestId, this.controller.signal).then(note => {
          if (!note || this.disposed) return;
          target.source = { lineId: descriptor.lineId, sourceText: normalized(note) };
          this.update(target, { original: note, text: note });
          this.queue();
        }).catch(() => {}); // An unreadable note retains the fixed presentation.
      }
    }
    held.listeners.add(listener);
    this.queue();
    return () => { held.listeners.delete(listener); };
  }
  private update(entry: Entry, display: ActivitySummaryDisplay) {
    if (this.disposed) return;
    entry.display = display;
    for (const listener of entry.listeners) listener();
  }
  private queue() {
    if (this.queued || this.disposed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.disposed) return;
      const entries = [...this.entries.values()].filter(entry => entry.source && !entry.requested && entry.listeners.size);
      if (!entries.length) return;
      for (const entry of entries) entry.requested = true;
      const batch: Batch = { entries, waiting: false };
      this.batches.add(batch);
      void this.open(batch, false);
    });
  }
  private unresolved(batch: Batch) {
    return batch.entries.filter(entry => entry.listeners.size &&
      (entry.display.state === 'pending' || entry.display.state === 'waiting'));
  }
  private async open(batch: Batch, reopening: boolean) {
    batch.waiting = false;
    const controller = new AbortController();
    batch.controller = controller;
    const entries = batch.entries;
    try {
      await this.transport.stream(entries.map(entry => entry.source!), answer => {
        const entry = entries[answer.index];
        if (!entry || controller.signal.aborted) return;
        this.update(entry, { original: entry.display.original,
          text: answer.state === 'summary' ? entry.descriptor.prefix + answer.summary : entry.display.original,
          state: answer.state });
      }, controller.signal);
    } catch { /* Originals remain readable; delivery resumes only on the rules below. */ }
    if (this.disposed || controller.signal.aborted) return;
    batch.controller = undefined;
    batch.entries = this.unresolved(batch);
    if (!batch.entries.length) { this.batches.delete(batch); return; }
    // A disconnected pending stream no longer proves inference is in flight.
    for (const entry of batch.entries) if (entry.display.state === 'pending') {
      this.update(entry, { ...entry.display, state: 'waiting' });
    }
    if (!reopening && this.available()) void this.open(batch, true);
    else batch.waiting = true;
  }
  /** Visibility, network and live-feed recovery events; never called on a timer. */
  resume = () => {
    if (this.disposed || !this.available()) return;
    for (const batch of this.batches) if (batch.waiting && this.unresolved(batch).length) void this.open(batch, true);
  };
  dispose() {
    this.disposed = true;
    this.controller.abort();
    for (const batch of this.batches) batch.controller?.abort();
    this.batches.clear();
  }
}
