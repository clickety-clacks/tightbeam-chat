import { describe, expect, it, vi } from 'vitest';
import { createTightbeamAdapter } from '../src/runtime';
import { AuthorizationError, UnsupportedTargetError } from '../src/types';
import type {
  CanonicalMessage, CanonicalTransition, CanonicalTurn, ChangeCallbacks, ChatTransport,
  ConversationPage, ConversationRecord, HostIdentity, HumanSendResult,
  HumanSubmission, SessionRecord, TargetObservation, TargetProfile,
} from '../src/types';

const sessionKey = 's1';
const capabilities = {
  newestTail: true, stableOlderCursor: true, retainedHistoryAcrossResets: true,
  orderedTransitions: true, snapshotCoverage: true, versionedNotices: true,
  humanSendDedupe: true, authoritativeTurnProvenance: true,
} as const;
const profile: TargetProfile = { identity: 'fixture:controlled', label: 'TEST FIXTURE', capabilities };

function message(seq: number, extra: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return { kind: 'message', id: `m${seq}`, sessionKey, seq, rowVersion: 1,
    role: 'assistant', content: `message ${seq}`, raw: { fixture: true }, ...extra };
}
function switchAt(seq: number, transition: 'model' | 'harness'): CanonicalTransition {
  return { kind: 'transition', id: `t${seq}`, sessionKey, seq, rowVersion: 1,
    transition, from: 'A', to: 'B', raw: { stored: true } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlledTransport implements ChatTransport {
  rows: ConversationRecord[] = [message(1), message(2), switchAt(3, 'harness'),
    message(4), message(5), switchAt(6, 'model'), message(7), message(8)];
  identity: HostIdentity = { principalKey: 'person', deviceId: 'device' };
  observation: TargetObservation = profile;
  callbacks?: ChangeCallbacks;
  readTailCalls = 0;
  readOlderCalls = 0;
  readSessionCalls = 0;
  closed = 0;
  coverage = true;
  recentTurns: CanonicalTurn[] = [];
  readyGate?: ReturnType<typeof deferred<void>>;
  tailHook?: () => void;
  readSessionHook?: (call: number) => Promise<void> | void;
  nextSend?: (submission: HumanSubmission) => Promise<HumanSendResult>;
  submissions: HumanSubmission[] = [];
  sendSignals: AbortSignal[] = [];

  currentIdentity = () => this.identity;
  inspectTarget = async () => this.observation;
  openChanges = async (_key: string, callbacks: ChangeCallbacks) => {
    this.callbacks = callbacks;
    if (this.readyGate) await this.readyGate.promise;
    return { close: () => { this.closed++; if (this.callbacks === callbacks) this.callbacks = undefined; } };
  };
  readSession = async (): Promise<SessionRecord> => {
    this.readSessionCalls++;
    await this.readSessionHook?.(this.readSessionCalls);
    return { sessionKey, rowVersion: 1, displayName: 'Fixture agent', raw: { clearedThroughSeq: 7 }, activity: 'idle' };
  };
  readTurn = async (_key: string, _seq: number): Promise<CanonicalTurn | null> => null;
  readMessage = async (_key: string, id: string): Promise<CanonicalMessage | null> =>
    this.rows.find((row): row is CanonicalMessage => row.kind === 'message' && row.id === id) ?? null;
  readRecentTurns = async (): Promise<readonly CanonicalTurn[]> => this.recentTurns;
  resolveOriginDisplayName = async () => undefined;
  private page(rows: ConversationRecord[]): ConversationPage {
    return { records: rows, oldestCursor: rows.length ? rows[0].id : null,
      hasOlder: rows.length ? this.rows.findIndex((row) => row.id === rows[0].id) > 0 : false,
      coverage: 'controlled-fixture' };
  }
  readTail = async (): Promise<ConversationPage> => {
    this.readTailCalls++;
    const page = this.page(this.rows.slice(-3));
    this.tailHook?.();
    return page;
  };
  readOlder = async (_key: string, before: string): Promise<ConversationPage> => {
    this.readOlderCalls++;
    const index = this.rows.findIndex((row) => row.id === before);
    if (index < 0) throw new Error('cursor missing');
    return this.page(this.rows.slice(Math.max(0, index - 3), index));
  };
  proveCoverage = () => this.coverage;
  sendHuman = async (submission: HumanSubmission, signal: AbortSignal): Promise<HumanSendResult> => {
    this.submissions.push(submission);
    this.sendSignals.push(signal);
    return this.nextSend ? this.nextSend(submission) : { outcome: 'accepted' };
  };
  emit(record: ConversationRecord) { this.callbacks?.onNotice({ operation: 'upsert', record }); }
  reset() {
    this.callbacks?.onNotice({ operation: 'session', session: {
      sessionKey, rowVersion: 2, displayName: 'Fixture agent', raw: { clearedThroughSeq: 100 }, activity: 'reset',
    } });
  }
  doubt() { this.callbacks?.onDoubt('connection lost'); }
}

async function settle() { await vi.waitFor(() => {}, { timeout: 50 }); }

describe('framework-independent runtime', () => {
  it.each(['live', 'running-first seed', 'queued-first seed'])(
    'keeps the running caption across queued successors (%s)', async (arrival) => {
      const transport = new ControlledTransport();
      transport.rows[7] = message(8, { role: 'user', sender: 'user:person', turnSeq: 90 });
      const running: CanonicalTurn = { seq: 90, sessionKey, status: 'running', messageId: 'm8',
        origin: 'user:person', triggerSource: 'mike', raw: { rowVersion: 1 } };
      const queued: CanonicalTurn = { ...running, seq: 91, status: 'queued' };
      const emit = (turn: CanonicalTurn) => transport.callbacks?.onNotice({ operation: 'turn', turn });
      if (arrival !== 'live') transport.tailHook = () => {
        for (const turn of arrival === 'running-first seed' ? [running, queued] : [queued, running]) emit(turn);
      };
      const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
      await runtime.rebuild();
      if (arrival === 'live') { emit(running); emit(queued); }
      const caption = () => runtime.getSnapshot().activeTurn?.turn.seq;
      expect(caption()).toBe(90);
      emit({ ...queued, status: 'canceled', raw: { rowVersion: 2 } });
      expect(caption()).toBe(90);
      emit({ ...queued, seq: 92 });
      expect(caption()).toBe(90);
      emit({ ...running, status: 'completed', raw: { rowVersion: 2 } });
      expect(caption()).toBeUndefined();
      emit({ ...queued, seq: 92, status: 'running', raw: { rowVersion: 2 } });
      expect(caption()).toBe(92);
      emit({ ...running, status: 'completed', raw: { rowVersion: 3 } });
      expect(caption()).toBe(92);
      emit({ ...queued, seq: 92, status: 'completed', raw: { rowVersion: 3 } });
      expect(caption()).toBeUndefined();
      runtime.dispose();
    });

  it.each(['live', 'buffered rebuild', 'restored-page overlap', 'older-page race'])(
    'enriches a missing same-version turn link without replacing other message fields (%s)', async (arrival) => {
      const transport = new ControlledTransport();
      const index = arrival === 'older-page race' ? 4 : 7;
      const original = message(index + 1, { role: 'user', sender: 'user:person', content: 'Original human words',
        attachments: [{ name: 'original.txt' }], raw: { turnSeq: null, preserved: 'metadata' } });
      transport.rows[index] = original;
      const enriched = { ...original, turnSeq: 90, content: 'Do not replace the stored words', sender: 'user:another',
        attachments: [], turnIncludesHuman: false, raw: { turnSeq: 90, unrelated: 'not a new version' } };
      const active: CanonicalTurn = { seq: 90, sessionKey, status: 'running', messageId: 'carrier',
        origin: 'process:notifications', triggerSource: 'batch', batchMemberCount: 1, raw: { rowVersion: 1 } };
      const emitTurn = () => transport.callbacks?.onNotice({ operation: 'turn', turn: active });
      const reads = [vi.spyOn(transport, 'readTurn'), vi.spyOn(transport, 'readMessage'), vi.spyOn(transport, 'readRecentTurns')];
      if (arrival === 'buffered rebuild') transport.tailHook = () => { emitTurn(); transport.emit(enriched); };
      const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
      await runtime.rebuild();
      if (arrival === 'restored-page overlap') {
        await runtime.loadOlder();
        transport.readOlder = async () => ({ records: [message(5), enriched], oldestCursor: 'm5', hasOlder: false, coverage: 'controlled-fixture' });
        transport.tailHook = emitTurn;
        await runtime.rebuild();
      } else if (arrival !== 'buffered rebuild') {
        emitTurn();
        expect(runtime.getSnapshot().activeTurn?.sourceKind).toBe('unknown');
        if (arrival === 'older-page race') {
          // The original row arrives on the page after its enrichment notice.
          transport.emit(original);
          transport.emit(enriched);
          await runtime.loadOlder();
        } else transport.emit(enriched);
      }
      const stored = () => runtime.getSnapshot().records.find(row => row.id === original.id) as CanonicalMessage;
      expect(stored()).toEqual({ ...original, turnSeq: 90, raw: { ...original.raw, turnSeq: 90 } });
      expect(original.turnSeq).toBeUndefined();
      expect(runtime.getSnapshot().activeTurn?.sourceKind).toBe('human');
      transport.emit(original);
      transport.emit({ ...enriched, turnSeq: 91 });
      expect(stored().turnSeq).toBe(90);
      expect(stored().content).toBe(original.content);
      expect(reads.every(read => read.mock.calls.length === 0)).toBe(true);
      runtime.dispose();
    });

  it('keeps live activity through paging, rebuilds it from the new subscription, and ignores the old generation', async () => {
    const transport = new ControlledTransport();
    transport.rows[7] = message(8, { role: 'user', sender: 'user:person', turnSeq: 90 });
    const reads = [vi.spyOn(transport, 'readTurn'), vi.spyOn(transport, 'readMessage'), vi.spyOn(transport, 'readRecentTurns'),
      vi.spyOn(transport, 'resolveOriginDisplayName')];
    const active: CanonicalTurn = { seq: 90, sessionKey, status: 'running', messageId: 'm8',
      origin: 'user:someone-else', triggerSource: 'mike', raw: { rowVersion: 1 } };
    transport.tailHook = () => transport.callbacks?.onNotice({ operation: 'turn', turn: active });
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    expect(runtime.getSnapshot().activeTurn?.sourceKind).toBe('human');
    await runtime.loadOlder();
    expect(runtime.getSnapshot().activeTurn?.turn.seq).toBe(90);
    const oldCallbacks = transport.callbacks!;
    transport.doubt();
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    transport.tailHook = undefined;
    await runtime.rebuild();
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    oldCallbacks.onNotice({ operation: 'turn', turn: active });
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    transport.callbacks?.onNotice({ operation: 'turn', turn: { ...active, sessionKey: 'another-session' } });
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    transport.callbacks?.onNotice({ operation: 'turn', turn: active });
    expect(runtime.getSnapshot().activeTurn?.sourceKind).toBe('human');
    for (const status of ['completed', 'failed', 'canceled']) {
      transport.callbacks?.onNotice({ operation: 'turn', turn: { ...active, status, raw: { rowVersion: 2 } } });
      expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    }
    // An older buffered seed must not resurrect a completed turn.
    transport.callbacks?.onNotice({ operation: 'turn', turn: active });
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    expect(reads.every(read => read.mock.calls.length === 0)).toBe(true);
    runtime.dispose();
  });

  it('starts recovery immediately after repeated failures and cancels the old backoff retry', async () => {
    vi.useFakeTimers();
    const transport = new ControlledTransport();
    const connect = transport.openChanges;
    const open = vi.fn(async (...args: Parameters<typeof connect>) => connect(...args));
    transport.openChanges = open;
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    try {
      await runtime.rebuild();
      await runtime.loadOlder();
      const oldest = runtime.getSnapshot().records[0].id;
      open.mockRejectedValue(new Error('Connection unavailable'));
      transport.doubt();
      for (const delay of [250, 500, 1000]) await vi.advanceTimersByTimeAsync(delay);
      expect(runtime.getSnapshot().status).toBe('error');
      expect(open).toHaveBeenCalledTimes(4);
      transport.rows.push(message(9));
      open.mockImplementation((...args) => connect(...args));
      await runtime.rebuild({ restart: true });
      expect(open).toHaveBeenCalledTimes(5);
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(runtime.getSnapshot().records.some(row => row.id === oldest)).toBe(true);
      expect(runtime.getSnapshot().records.at(-1)?.id).toBe('m9');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(open).toHaveBeenCalledTimes(5);
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it('replaces a stalled recovery and stays stale until fresh subscription and history catch-up complete', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    try {
      await runtime.rebuild();
      const stalled = deferred<void>();
      const subscribed = deferred<void>();
      const history = deferred<void>();
      const connect = transport.openChanges;
      let attempts = 0;
      let oldSignal: AbortSignal | undefined;
      transport.openChanges = async (key, callbacks, signal?: AbortSignal) => {
        attempts++;
        if (attempts === 1) { oldSignal = signal; await stalled.promise; }
        else await subscribed.promise;
        return connect(key, callbacks);
      };
      const pending = runtime.rebuild();
      await vi.waitFor(() => expect(attempts).toBe(1));
      const readTail = transport.readTail;
      transport.readTail = async () => { await history.promise; return readTail(); };
      const fresh = runtime.rebuild({ restart: true });
      await vi.waitFor(() => expect(attempts).toBe(2));
      expect(oldSignal?.aborted).toBe(true);
      expect(runtime.getSnapshot().status).toBe('stale');
      expect(transport.readTailCalls).toBe(1);
      subscribed.resolve();
      await vi.waitFor(() => expect(transport.readSessionCalls).toBe(2));
      expect(runtime.getSnapshot().status).toBe('stale');
      transport.rows.push(message(9));
      transport.emit(message(10));
      history.resolve();
      await fresh;
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(runtime.getSnapshot().records.map(row => row.id)).toContain('m9');
      expect(runtime.getSnapshot().records.map(row => row.id)).toContain('m10');
      const generation = runtime.getSnapshot().generation;
      stalled.resolve();
      await pending;
      expect(runtime.getSnapshot().generation).toBe(generation);
      expect(runtime.getSnapshot().status).toBe('ready');
    } finally { runtime.dispose(); }
  });

  it('keeps filtering on message records and performs no turn or trigger lookups', async () => {
    const transport = new ControlledTransport();
    const trigger = message(1, { role: 'user', sender: 'user:person', content: 'Earlier source prompt' });
    const reply = message(4, { turnSeq: 44, replyToMessageId: trigger.id, messageType: 'assistant', content: 'Selected agent reply' });
    const active: CanonicalTurn = { seq: 44, sessionKey, status: 'running', messageId: trigger.id,
      origin: 'user:person', raw: { seq: 44 } };
    transport.rows = [trigger, message(2), message(3), reply];
    transport.recentTurns = [active];
    const readRecentTurns = vi.spyOn(transport, 'readRecentTurns');
    const readTurn = vi.spyOn(transport, 'readTurn');
    const readMessage = vi.spyOn(transport, 'readMessage');
    const resolveOriginDisplayName = vi.spyOn(transport, 'resolveOriginDisplayName');

    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m2', 'm3', 'm4']);
    expect(runtime.getSnapshot().provenance).toEqual([]);
    expect(runtime.getSnapshot().provenanceAvailable).toBe(false);
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    expect(readRecentTurns).not.toHaveBeenCalled();
    expect(readTurn).not.toHaveBeenCalled();
    expect(readMessage).not.toHaveBeenCalled();
    expect(resolveOriginDisplayName).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('keeps history and sends available without optional turn reads', async () => {
    const transport = new ControlledTransport();
    transport.rows = [message(7, { role: 'user', content: 'Can you help?' }),
      message(8, { content: 'The answer remains visible.', turnSeq: 44 })];
    transport.readRecentTurns = async () => { throw new AuthorizationError('Recent turns are not authorized.'); };
    transport.readTurn = async () => { throw new AuthorizationError('Exact turn detail is not authorized.'); };
    const readRecentTurns = vi.spyOn(transport, 'readRecentTurns');
    const readTurn = vi.spyOn(transport, 'readTurn');
    const readMessage = vi.spyOn(transport, 'readMessage');
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);

    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m7', 'm8']);
    expect(runtime.getSnapshot().provenanceAvailable).toBe(false);
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    expect(readRecentTurns).not.toHaveBeenCalled();
    expect(readTurn).not.toHaveBeenCalled();
    expect(readMessage).not.toHaveBeenCalled();

    const live = message(9, { content: 'A live reply also appears.' });
    transport.rows.push(live);
    transport.emit(live);
    await vi.waitFor(() => expect(runtime.getSnapshot().records.at(-1)?.id).toBe('m9'));
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(readRecentTurns).not.toHaveBeenCalled();
    expect(readTurn).not.toHaveBeenCalled();
    expect(readMessage).not.toHaveBeenCalled();

    const clientMessageId = runtime.send('Still available');
    expect(clientMessageId).toBeTruthy();
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0]?.status).toBe('accepted'));
    expect(transport.submissions[0].content).toBe('Still available');
    expect(runtime.getSnapshot().status).toBe('ready');
    runtime.dispose();
  });

  it('waits for readiness, closes snapshot overlap, and pages retained pre-reset history with recorded switches', async () => {
    const transport = new ControlledTransport();
    transport.readyGate = deferred<void>();
    transport.tailHook = () => {
      // A newer version delivered after the candidate snapshot is captured.
      transport.emit(message(8, { rowVersion: 2, content: 'updated eight' }));
      transport.reset();
    };
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await settle();
    expect(transport.readTailCalls).toBe(0);
    transport.readyGate.resolve();
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(runtime.getSnapshot().records.map((row) => row.id)).toEqual(['t6', 'm7', 'm8']);
    expect((runtime.getSnapshot().records[2] as CanonicalMessage).content).toBe('updated eight');
    expect(runtime.getSnapshot().session?.raw.clearedThroughSeq).toBe(100);
    while (runtime.getSnapshot().hasOlder) await runtime.loadOlder();
    expect(runtime.getSnapshot().records.map((row) => row.id)).toEqual(
      ['m1', 'm2', 't3', 'm4', 'm5', 't6', 'm7', 'm8']);
    expect(transport.readOlderCalls).toBe(2);
    runtime.dispose();
  });

  it('publishes a committed startup-overlap row exactly once with the initial tail', async () => {
    const transport = new ControlledTransport();
    const appended = message(9, { content: 'assistant startup response' });
    transport.tailHook = () => {
      // The tail page was already captured when the row is committed and noticed.
      transport.rows.push(appended);
      transport.emit(appended);
    };
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    const readyRecords: ConversationRecord[][] = [];
    runtime.subscribe(() => {
      const snapshot = runtime.getSnapshot();
      if (snapshot.status === 'ready') readyRecords.push([...snapshot.records]);
    });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(readyRecords[0].filter((row) => row.id === appended.id)).toHaveLength(1);
    expect(runtime.getSnapshot().records.map((row) => row.id)).toEqual(['t6', 'm7', 'm8', 'm9']);
    runtime.dispose();
  });

  it('includes a marker row emitted during the startup session refetch before first ready publication', async () => {
    const transport = new ControlledTransport();
    const refresh = deferred<void>();
    const marker = switchAt(9, 'harness');
    transport.readSessionHook = async (call) => {
      if (call === 2) await refresh.promise;
    };
    transport.tailHook = () => {
      transport.callbacks?.onNotice({ operation: 'observe', sessionKey, resource: 'turn.started' });
    };
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    const readyRecords: ConversationRecord[][] = [];
    runtime.subscribe(() => {
      const snapshot = runtime.getSnapshot();
      if (snapshot.status === 'ready') readyRecords.push([...snapshot.records]);
    });

    await vi.waitFor(() => expect(transport.readSessionCalls).toBe(2));
    transport.rows.push(marker);
    transport.emit(marker);
    refresh.resolve();

    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(readyRecords[0].filter((row) => row.id === marker.id)).toHaveLength(1);
    expect(readyRecords[0].at(-1)).toMatchObject({ id: marker.id, kind: 'transition', transition: 'harness' });
    expect(runtime.getSnapshot().records.filter((row) => row.id === marker.id)).toHaveLength(1);
    runtime.dispose();
  });

  it('refuses unsupported identity or unproved snapshot coverage', async () => {
    const wrong = new ControlledTransport();
    wrong.observation = { ...profile, identity: 'unreviewed-build' };
    const runtime = createTightbeamAdapter(wrong, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('unsupported'));
    expect(wrong.readTailCalls).toBe(0);
    runtime.dispose();
    const noProof = new ControlledTransport();
    noProof.coverage = false;
    const second = createTightbeamAdapter(noProof, profile).open(sessionKey);
    await vi.waitFor(() => expect(second.getSnapshot().status).toBe('unsupported'));
    second.dispose();
  });

  it('ignores older versions, honors only canonical deletes, and does not infer a switch from message text', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    transport.emit(message(8, { rowVersion: 0, content: 'older revision' }));
    expect((runtime.getSnapshot().records.find((row) => row.id === 'm8') as CanonicalMessage).content).toBe('message 8');
    transport.reset();
    expect(runtime.getSnapshot().records.some((row) => row.id === 'm8')).toBe(true);
    transport.callbacks?.onNotice({ operation: 'delete', sessionKey, id: 'm8', rowVersion: 2 });
    expect(runtime.getSnapshot().records.some((row) => row.id === 'm8')).toBe(false);
    transport.emit(message(8, { rowVersion: 1, content: 'resurrected' }));
    expect(runtime.getSnapshot().records.some((row) => row.id === 'm8')).toBe(false);
    transport.emit(message(9, { content: 'harness switched to model-C', messageType: 'marker' }));
    expect(runtime.getSnapshot().records.filter((row) => row.kind === 'transition')).toHaveLength(1);
    runtime.dispose();
  });

  it('rejects an initialization interrupted after the tail read and starts a fresh generation', async () => {
    const transport = new ControlledTransport();
    let first = true;
    transport.tailHook = () => {
      if (first) {
        first = false;
        transport.rows.push(switchAt(9, 'model'));
        transport.doubt();
      }
    };
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('stale'));
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'), { timeout: 1000 });
    expect(transport.readTailCalls).toBe(2);
    expect(runtime.getSnapshot().records.at(-1)).toMatchObject({ id: 't9', kind: 'transition', transition: 'model' });
    runtime.dispose();
  });

  it('rebuilds after a connection gap and restores older history across a reset', async () => {
    vi.useFakeTimers();
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    await runtime.loadOlder();
    const before = runtime.getSnapshot().records[0].id;
    transport.rows.push(message(9), switchAt(10, 'harness'), message(11));
    transport.reset();
    transport.doubt();
    expect(runtime.getSnapshot().status).toBe('stale');
    await vi.advanceTimersByTimeAsync(300);
    await runtime.rebuild();
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().records.some((row) => row.id === before)).toBe(true);
    expect(runtime.getSnapshot().records.some((row) => row.id === 't10')).toBe(true);
    while (runtime.getSnapshot().hasOlder) await runtime.loadOlder();
    expect(runtime.getSnapshot().records[0].id).toBe('m1');
    runtime.dispose();
    vi.useRealTimers();
  });

  it('keeps a versioned notice for an older row while its stale page is in flight', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    const gate = deferred<void>();
    const readOlder = transport.readOlder;
    transport.readOlder = async (key, before) => {
      const stalePage = await readOlder(key, before);
      await gate.promise;
      return stalePage;
    };
    const loading = runtime.loadOlder();
    await vi.waitFor(() => expect(transport.readOlderCalls).toBe(1));
    const changed = message(5, { rowVersion: 2, content: 'updated during page read' });
    const inserted = message(5.5, { content: 'inserted during page read' });
    transport.rows = [...transport.rows.map((record) => record.id === changed.id ? changed : record), inserted]
      .sort((a, b) => a.seq - b.seq);
    transport.emit(changed);
    transport.emit(inserted);
    const appended = message(9, { content: 'appended during page read' });
    transport.rows.push(appended);
    transport.emit(appended);
    transport.reset();
    gate.resolve();
    await loading;
    expect((runtime.getSnapshot().records.find((record) => record.id === 'm5') as CanonicalMessage).content)
      .toBe('updated during page read');
    expect(runtime.getSnapshot().records.some((record) => record.id === 'm5.5')).toBe(true);
    expect(runtime.getSnapshot().records.some((record) => record.id === 'm9')).toBe(true);
    expect(runtime.getSnapshot().session?.activity).toBe('reset');
    runtime.dispose();
  });

  it('restores across the old reading coordinate when that anchor row was deleted', async () => {
    const transport = new ControlledTransport();
    transport.rows = Array.from({ length: 30 }, (_, index) => message(index + 1));
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    await runtime.loadOlder();
    const oldStart = runtime.getSnapshot().records[0];
    transport.rows = [
      ...transport.rows.filter((record) => record.id !== oldStart.id),
      ...Array.from({ length: 6 }, (_, index) => message(index + 31)),
    ];
    const before = transport.readOlderCalls;
    await runtime.rebuild();
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().records[0].seq).toBeLessThan(oldStart.seq);
    expect(transport.readOlderCalls - before).toBeLessThanOrEqual(5);
    runtime.dispose();
  });

  it('fails closed when an older page violates the pinned target contract', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    transport.readOlder = async () => ({ records: [{ ...message(4), sessionKey: 'other' }],
      oldestCursor: 'bad', hasOlder: true, coverage: 'fixture' });
    await runtime.loadOlder();
    expect(runtime.getSnapshot().status).toBe('unsupported');
    expect(runtime.getSnapshot().records).toHaveLength(0);
    expect(runtime.send('must not send')).toBeNull();
    expect(transport.closed).toBeGreaterThan(0);
    runtime.dispose();

    const thrown = new ControlledTransport();
    const second = createTightbeamAdapter(thrown, profile).open(sessionKey);
    await second.rebuild();
    thrown.readOlder = async () => { throw new UnsupportedTargetError('wire schema changed'); };
    await second.loadOlder();
    expect(second.getSnapshot().status).toBe('unsupported');
    second.dispose();
  });

  it('preserves same-principal send recovery state when an older page becomes unsupported', async () => {
    const transport = new ControlledTransport();
    const pendingAck = deferred<HumanSendResult>();
    let attempt = 0;
    transport.nextSend = async () => ++attempt === 1 ? { outcome: 'accepted' } : pendingAck.promise;
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    const acceptedId = runtime.send('known accepted')!;
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0].status).toBe('accepted'));
    const pendingId = runtime.send('  exact pending text  ')!;
    expect(transport.submissions).toHaveLength(2);
    transport.readOlder = async () => { throw new UnsupportedTargetError('history schema changed'); };
    await runtime.loadOlder();
    const state = runtime.getSnapshot();
    expect(state.status).toBe('unsupported');
    expect(state.sends).toEqual([
      expect.objectContaining({ clientMessageId: acceptedId, content: 'known accepted', status: 'accepted' }),
      expect.objectContaining({ clientMessageId: pendingId, content: '  exact pending text  ',
        sessionKey, deviceId: 'device', status: 'pending' }),
    ]);
    expect(runtime.send('blocked new send')).toBeNull();
    await runtime.retrySend(pendingId);
    pendingAck.resolve({ outcome: 'accepted' });
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[1].status).toBe('accepted'));
    expect(transport.submissions).toHaveLength(2);
    runtime.dispose();
  });

  it('keeps ack, canonical reconciliation, refusal, uncertainty and exact retry identity distinct', async () => {
    const transport = new ControlledTransport();
    const ack = deferred<HumanSendResult>();
    transport.nextSend = async () => ack.promise;
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    const id = runtime.send('  exact text  ')!;
    expect(id.startsWith('c_')).toBe(true);
    expect(runtime.getSnapshot().sends[0].status).toBe('pending');
    ack.resolve({ outcome: 'accepted' });
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0].status).toBe('accepted'));
    expect(runtime.getSnapshot().sends[0].reconciled).toBe(false);
    transport.emit(message(9, { clientMessageId: id, deviceId: 'device', content: '  exact text  ', role: 'user' }));
    expect(runtime.getSnapshot().sends[0].reconciled).toBe(true);
    expect(runtime.getSnapshot().records.filter((row) => row.id === 'm9')).toHaveLength(1);

    transport.nextSend = async () => ({ outcome: 'refused', reason: 'not allowed' });
    const refused = runtime.send('refused')!;
    await vi.waitFor(() => expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === refused)?.status).toBe('failed'));
    transport.nextSend = async () => ({ outcome: 'uncertain', reason: 'ack lost' });
    const uncertain = runtime.send('retry unchanged')!;
    await vi.waitFor(() => expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === uncertain)?.status).toBe('uncertain'));
    transport.nextSend = async () => ({ outcome: 'accepted' });
    await runtime.retrySend(uncertain);
    const attempts = transport.submissions.filter((submission) => submission.clientMessageId === uncertain);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    runtime.dispose();
  });

  it('re-asks after a dropped send socket with the exact same ID and content', async () => {
    const transport = new ControlledTransport();
    transport.nextSend = async () => transport.submissions.length === 1
      ? { outcome: 'retryable', reason: 'socket closed before acknowledgement' }
      : { outcome: 'accepted' };
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();

    const id = runtime.send('  exact content  ')!;
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0]?.status).toBe('accepted'));
    const attempts = transport.submissions.filter((submission) => submission.clientMessageId === id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(runtime.getSnapshot().sends[0]).toMatchObject({ clientMessageId: id,
      content: '  exact content  ', status: 'accepted' });
    runtime.dispose();
  });

  it('keeps an in-flight send pending and accepts its late ack across live-stream doubt and rebuild', async () => {
    const transport = new ControlledTransport();
    const acknowledgement = deferred<HumanSendResult>();
    transport.nextSend = () => acknowledgement.promise;
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();

    const id = runtime.send('slow acknowledgement')!;
    const sendSignal = transport.sendSignals[0];
    expect(runtime.getSnapshot().sends[0]).toMatchObject({ clientMessageId: id, status: 'pending' });
    transport.doubt();
    expect(runtime.getSnapshot().status).toBe('stale');
    expect(runtime.getSnapshot().sends[0]).toMatchObject({ status: 'pending' });
    expect(sendSignal.aborted).toBe(false);

    await runtime.rebuild();
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(sendSignal.aborted).toBe(false);
    acknowledgement.resolve({ outcome: 'accepted' });
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0]).toMatchObject({ status: 'accepted' }));
    expect(transport.submissions.filter((submission) => submission.clientMessageId === id)).toHaveLength(1);
    runtime.dispose();
  });

  it('shows a failed connection separately and does not re-ask a refused or unreachable send', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();

    transport.nextSend = async () => ({ outcome: 'refused', reason: 'not allowed' });
    const refused = runtime.send('refused')!;
    await vi.waitFor(() => expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === refused))
      .toMatchObject({ status: 'failed', reason: 'not allowed' }));
    expect(transport.submissions.filter((submission) => submission.clientMessageId === refused)).toHaveLength(1);

    transport.nextSend = async () => ({ outcome: 'unreachable', reason: 'Not connected to the server.' });
    const offline = runtime.send('offline')!;
    await vi.waitFor(() => expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === offline))
      .toMatchObject({ status: 'failed', reason: 'unreachable' }));
    expect(transport.submissions.filter((submission) => submission.clientMessageId === offline)).toHaveLength(1);
    runtime.dispose();
  });

  it('rejects late work and clears old principal data after identity change', async () => {
    const transport = new ControlledTransport();
    const pending = deferred<HumanSendResult>();
    transport.nextSend = async () => pending.promise;
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    const id = runtime.send('private')!;
    transport.identity = { principalKey: 'different-person', deviceId: 'other-device' };
    await runtime.loadOlder();
    expect(runtime.getSnapshot().status).toBe('unauthorized');
    expect(runtime.getSnapshot().records).toHaveLength(0);
    pending.resolve({ outcome: 'accepted' });
    await settle();
    expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === id)).toBeUndefined();
    expect(transport.closed).toBeGreaterThan(0);
    runtime.dispose();
  });

  it('hides cached conversation when the human send transport reports authorization loss', async () => {
    const transport = new ControlledTransport();
    transport.nextSend = async () => { throw new AuthorizationError('human access revoked'); };
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    expect(runtime.getSnapshot().records.length).toBeGreaterThan(0);
    runtime.send('private');
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('unauthorized'));
    expect(runtime.getSnapshot().records).toHaveLength(0);
    expect(runtime.getSnapshot().sends).toHaveLength(0);
    runtime.dispose();
  });
});
