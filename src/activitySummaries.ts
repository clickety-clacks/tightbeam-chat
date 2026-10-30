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
  readonly text?: string;
  readonly state?: SummaryAnswer['state'];
}
const emptyDisplay: ActivitySummaryDisplay = Object.freeze({});
const normalized = (text: string) => text.replace(/\r\n?/g, '\n').trim();

// The page-local key must distinguish text revisions without retaining the
// text in a Map key. The server remains authoritative for the durable SHA-256.
function sourceFingerprint(text: string): string {
  let a = 0x811c9dc5, b = 0x9e3779b9, c = 0x85ebca6b, d = 0xc2b2ae35;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ (code + i), 0x5bd1e995);
    c = Math.imul(c ^ (code + (i << 1)), 0x27d4eb2d);
    d = Math.imul(d ^ (code + (i << 2)), 0x165667b1);
  }
  const finish = (value: number) => {
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    value = Math.imul(value, 0x846ca68b);
    value ^= value >>> 16;
    return (value >>> 0).toString(16).padStart(8, '0');
  };
  return [a, b, c, d].map(finish).join('');
}

/** Same-origin transport used by both the standalone and embedded served page. */
export function createActivitySummaryTransport(fetcher: (url: string, init: RequestInit) => Promise<Response>,
  baseUrl: string): ActivitySummaryTransport {
  return {
    async stream(sources, receive, signal) {
      let body = JSON.stringify(sources);
      sources = [];
      let response: Response;
      try {
        response = await fetcher(`${baseUrl}/summaries`, { method: 'POST', signal, cache: 'no-store',
          headers: { 'content-type': 'application/json' }, body });
      } finally { body = ''; }
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
  readonly lineId: string;
  readonly prefix: string;
  readonly attestId?: string;
  line: WeakRef<ActivityLine>;
  readonly listeners: Set<{
    notify: () => void;
    receiveOriginal?: (text: string) => void;
    currentOriginal?: () => string | undefined;
  }>;
  display: ActivitySummaryDisplay;
  requested?: boolean;
  opening?: boolean;
}
interface Batch { entries: Entry[]; controller?: AbortController; waiting: boolean }

/** Page-local delivery only. Durable attempt ownership belongs to the server. */
export class ActivitySummaryViewer {
  private readonly entries = new Map<string, Entry>();
  private readonly batches = new Set<Batch>();
  private readonly queuedEntries = new Set<Entry>();
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
    if (!descriptor) return undefined;
    const sourceText = normalized(descriptor.sourceText ?? '');
    return JSON.stringify([descriptor.lineId, sourceText.length, sourceFingerprint(sourceText)]);
  }
  snapshot(key?: string): ActivitySummaryDisplay { return key ? this.entries.get(key)?.display ?? emptyDisplay : emptyDisplay; }
  subscribe(entry: ActivityLine, listener: () => void, receiveOriginal?: (text: string) => void,
    currentOriginal?: () => string | undefined): () => void {
    const descriptor = activitySummaryDescriptor(entry);
    const key = this.key(entry);
    if (!descriptor || !key || this.disposed) return () => {};
    let held = this.entries.get(key);
    const redisplaying = !!held?.requested && held.listeners.size === 0;
    if (!held) {
      held = { key, lineId: descriptor.lineId, prefix: descriptor.prefix, attestId: descriptor.attestId,
        line: new WeakRef(entry), listeners: new Set(), display: emptyDisplay };
      this.entries.set(key, held);
    } else held.line = new WeakRef(entry);
    const subscriber = { notify: listener, receiveOriginal, currentOriginal };
    held.listeners.add(subscriber);
    this.queue(held);
    if (redisplaying && this.available()) {
      for (const batch of this.batches) if (batch.waiting && batch.entries.includes(held)) void this.open(batch, true);
    }
    return () => { held.listeners.delete(subscriber); };
  }
  private update(entry: Entry, display: ActivitySummaryDisplay) {
    if (this.disposed) return;
    entry.display = display;
    for (const listener of entry.listeners) listener.notify();
  }
  private publishOriginal(entry: Entry, text: string) {
    for (const listener of entry.listeners) {
      listener.receiveOriginal?.(text);
      listener.notify();
    }
  }
  private canResolve(entry: Entry) {
    const line = entry.line.deref();
    const descriptor = line && activitySummaryDescriptor(line);
    return !!descriptor?.sourceText || (!!entry.attestId && !!this.transport.readAttestNote);
  }
  private async sourceFor(entry: Entry, signal: AbortSignal): Promise<SummarySource | undefined> {
    if (signal.aborted) return undefined;
    const line = entry.line.deref();
    const descriptor = line && activitySummaryDescriptor(line);
    if (descriptor?.sourceText) {
      return { lineId: descriptor.lineId, sourceText: normalized(descriptor.sourceText) };
    }
    if (!entry.attestId || !this.transport.readAttestNote) return undefined;
    try {
      const cached = [...entry.listeners].map(listener => listener.currentOriginal?.())
        .find((value): value is string => !!value?.trim());
      const note = cached ?? await this.transport.readAttestNote(entry.attestId, signal);
      if (!note || signal.aborted) return undefined;
      if (!cached) this.publishOriginal(entry, note);
      return { lineId: entry.lineId, sourceText: normalized(note) };
    } catch { return undefined; } // An unreadable note retains the fixed presentation.
  }
  private queue(entry: Entry) {
    if (!entry.requested && !entry.opening && this.canResolve(entry)) this.queuedEntries.add(entry);
    if (this.queued || this.disposed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (this.disposed) return;
      const entries = [...this.queuedEntries].filter(entry =>
        !entry.requested && !entry.opening && entry.listeners.size && this.canResolve(entry));
      this.queuedEntries.clear();
      if (!entries.length) return;
      for (const entry of entries) entry.opening = true;
      const batch: Batch = { entries, waiting: false };
      this.batches.add(batch);
      void this.open(batch, false);
    });
  }
  private unresolved(batch: Batch) {
    return batch.entries.filter(entry => entry.display.state === 'pending' || entry.display.state === 'waiting');
  }
  private async open(batch: Batch, reopening: boolean) {
    batch.waiting = false;
    const controller = new AbortController();
    batch.controller = controller;
    const entries = batch.entries.filter(entry => entry.listeners.size && this.canResolve(entry));
    let prepared = await Promise.all(entries.map(async entry => {
      const source = await this.sourceFor(entry, controller.signal);
      return source ? { entry, source } : undefined;
    }));
    if (this.disposed || controller.signal.aborted) return;
    const ready = prepared.filter((value): value is { entry: Entry; source: SummarySource } =>
      !!value && value.entry.listeners.size > 0);
    for (const entry of entries) if (!ready.some(value => value.entry === entry)) entry.opening = false;
    if (!ready.length) {
      batch.controller = undefined;
      if (reopening) batch.waiting = true;
      else this.batches.delete(batch);
      return;
    }
    const requestEntries = ready.map(value => value.entry);
    let sources = ready.map(value => value.source);
    prepared.length = 0;
    ready.length = 0;
    batch.entries = requestEntries;
    for (const entry of requestEntries) {
      entry.opening = false;
      if (!reopening) entry.requested = true;
    }
    try {
      const stream = this.transport.stream(sources, answer => {
        const entry = requestEntries[answer.index];
        if (!entry || controller.signal.aborted) return;
        this.update(entry, {
          text: answer.state === 'summary' ? entry.prefix + answer.summary : undefined,
          state: answer.state });
      }, controller.signal);
      // The request body is serialized synchronously by the transport. Drop the
      // per-line strings from the page-local request array while the answer
      // stream remains open; reopens resolve sources from mounted rows again.
      sources = [];
      await stream;
    } catch {
      sources = [];
      // Originals remain readable; delivery resumes only on the rules below.
    }
    if (this.disposed || controller.signal.aborted) return;
    batch.controller = undefined;
    batch.entries = this.unresolved(batch);
    if (!batch.entries.length) { this.batches.delete(batch); return; }
    // A disconnected pending stream no longer proves inference is in flight.
    for (const entry of batch.entries) if (entry.display.state === 'pending') {
      this.update(entry, { ...entry.display, state: 'waiting' });
    }
    if (!reopening && this.available() && batch.entries.some(entry => entry.listeners.size)) void this.open(batch, true);
    else batch.waiting = true;
  }
  /** Visibility, network and live-feed recovery events; never called on a timer. */
  resume = () => {
    if (this.disposed || !this.available()) return;
    for (const batch of this.batches) if (batch.waiting && this.unresolved(batch).some(entry => entry.listeners.size)) void this.open(batch, true);
  };
  dispose() {
    this.disposed = true;
    for (const batch of this.batches) batch.controller?.abort();
    this.batches.clear();
    this.queuedEntries.clear();
    this.entries.clear();
  }
}
