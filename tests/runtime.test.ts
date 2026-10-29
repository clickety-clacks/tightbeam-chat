import { indexValues } from '../src/recordIndex';
import { describe, expect, it, vi } from 'vitest';
import { createTightbeamAdapter } from '../src/runtime';
import { AuthorizationError, UnsupportedTargetError } from '../src/types';
import { ToolHistoryUnavailableError } from '../src/toolHistory';
import type {
  RuntimeState, ToolCallRecord, ToolCallRange, CanonicalMessage, CanonicalTransition, CanonicalTurn, ChangeCallbacks, ChatTransport,
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
  readAfterCalls: string[] = [];
  readMessageCalls: string[] = [];
  readSessionCalls = 0;
  closed = 0;
  coverage = true;
  tailPage?: ConversationPage;
  afterHook?: (cursor: string) => ConversationPage | Promise<ConversationPage>;
  messageDetails = new Map<string, ConversationRecord>();
  clearBarrier = 0;
  openingFailures: Error[] = [];
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
    const failure = this.openingFailures.shift();
    if (failure) {
      if (this.callbacks === callbacks) this.callbacks = undefined;
      throw failure;
    }
    if (this.readyGate) await this.readyGate.promise;
    return { close: () => { this.closed++; if (this.callbacks === callbacks) this.callbacks = undefined; } };
  };
  readSession = async (): Promise<SessionRecord> => {
    this.readSessionCalls++;
    await this.readSessionHook?.(this.readSessionCalls);
    return { sessionKey, rowVersion: this.readSessionCalls, displayName: 'Fixture agent',
      clearedThroughSeq: this.clearBarrier, raw: { clearedThroughSeq: this.clearBarrier }, activity: 'idle' };
  };
  private page(rows: ConversationRecord[]): ConversationPage {
    const firstSeq = rows[0]?.seq;
    return { records: rows, oldestCursor: rows.length ? rows[0].id : null,
      newestCursor: rows.length ? `after:${rows.at(-1)!.seq}` : null, hasNewer: false,
      hasOlder: rows.length ? this.rows.some((row) => row.seq < firstSeq! && row.seq > this.clearBarrier) : false,
      coverage: 'controlled-fixture' };
  }
  readTail = async (): Promise<ConversationPage> => {
    this.readTailCalls++;
    const page = this.tailPage ?? this.page(this.rows.slice(-3));
    this.tailHook?.();
    return page;
  };
  readAfter: ChatTransport['readAfter'] = async (_key: string, cursor: string): Promise<ConversationPage> => {
    this.readAfterCalls.push(cursor);
    if (this.afterHook) return this.afterHook(cursor);
    const afterSeq = Number(cursor.slice('after:'.length));
    const newer = this.rows.filter((row) => row.seq > afterSeq);
    const rows = newer.slice(0, 3);
    return { ...this.page(rows), hasNewer: newer.length > rows.length };
  };
  readOlder = async (_key: string, before: string): Promise<ConversationPage> => {
    this.readOlderCalls++;
    const index = this.rows.findIndex((row) => row.id === before);
    if (index < 0) throw new Error('cursor missing');
    return this.page(this.rows.slice(Math.max(0, index - 3), index).filter((row) => row.seq > this.clearBarrier));
  };
  readMessage: ChatTransport['readMessage'] = async (_key: string, id: string): Promise<ConversationRecord> => {
    this.readMessageCalls.push(id);
    const detail = this.messageDetails.get(id) ?? this.rows.find((row) => row.id === id);
    if (!detail) throw new Error('message detail not found');
    return detail;
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
      sessionKey, rowVersion: 2, displayName: 'Fixture agent', raw: { clearedThroughSeq: this.clearBarrier }, activity: 'reset',
    } });
  }
  doubt() { this.callbacks?.onDoubt('connection lost'); }
}

async function settle() { await vi.waitFor(() => {}, { timeout: 50 }); }

describe('framework-independent runtime', () => {
  it('keeps activity without owner-turn evidence out of the live eligible set', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    const activity = message(9, { role: 'user', sender: 'session:helper', messageType: undefined });
    transport.emit(activity);
    expect(runtime.getSnapshot().liveActivityIds).toContain(activity.id);
    expect(runtime.getSnapshot().liveActivityEligibleIds).not.toContain(activity.id);
    runtime.dispose();
  });

  it('marks activity live-eligible only when the selected user turn is running at arrival', async () => {
    const transport = new ControlledTransport();
    const settledTurn: CanonicalTurn = { seq: 80, sessionKey, status: 'completed', messageId: 'm8',
      origin: 'user:person', triggerSource: 'mike', raw: { rowVersion: 1 } };
    transport.tailHook = () => transport.callbacks?.onNotice({ operation: 'turn', turn: settledTurn });
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    expect(runtime.getSnapshot().activityTurnStateAvailable).toBe(true);

    const idleActivity = message(9, { role: 'user', sender: 'agent:helper', messageType: 'agent' });
    transport.emit(idleActivity);
    expect(runtime.getSnapshot().liveActivityIds).toContain(idleActivity.id);
    expect(runtime.getSnapshot().liveActivityEligibleIds).not.toContain(idleActivity.id);

    const runningTurn: CanonicalTurn = { ...settledTurn, seq: 81, status: 'running', messageId: 'm9',
      triggerSource: 'agent',
      raw: { rowVersion: 1 } };
    transport.callbacks?.onNotice({ operation: 'turn', turn: runningTurn });
    expect(runtime.getSnapshot().activeTurn?.turn.seq).toBe(81);
    expect(runtime.getSnapshot().liveActivityEligibleIds).not.toContain(idleActivity.id);
    transport.emit({ ...idleActivity, rowVersion: 2, content: 'Updated after the next turn started' });
    expect(runtime.getSnapshot().liveActivityEligibleIds).not.toContain(idleActivity.id);

    const excludedWhileAnotherAgentRuns = [
      message(10, { role: 'assistant', sender: 'process:notifications', messageType: 'substrate', turnSeq: 77 }),
      message(11, { role: 'user', sender: 'agent:helper', messageType: 'agent', turnSeq: 77,
        content: "[woke: fallback deadline]\nWake outside the selected user's turn" }),
      message(12, { role: 'user', sender: 'process:events', messageType: 'process', turnSeq: 77 }),
    ];
    for (const activity of excludedWhileAnotherAgentRuns) {
      transport.emit(activity);
      expect(runtime.getSnapshot().liveActivityIds).toContain(activity.id);
      expect(runtime.getSnapshot().liveActivityEligibleIds).not.toContain(activity.id);
    }

    transport.callbacks?.onNotice({ operation: 'turn', turn: { ...runningTurn, status: 'completed',
      raw: { rowVersion: 2 } } });

    const ownerPrompt = message(20, { role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 82 });
    transport.emit(ownerPrompt);
    const ownerTurn: CanonicalTurn = { ...settledTurn, seq: 82, status: 'running', messageId: ownerPrompt.id,
      raw: { rowVersion: 1 } };
    transport.callbacks?.onNotice({ operation: 'turn', turn: ownerTurn });
    const interleavedNonOwnerActivity = [
      message(21, { role: 'assistant', sender: 'process:notifications', messageType: 'substrate', turnSeq: 77 }),
      message(22, { role: 'user', sender: 'agent:helper', messageType: 'agent', turnSeq: 77,
        content: '[woke: fallback deadline]\nWake from another agent during the selected user's turn' }),
      message(23, { role: 'user', sender: 'process:events', messageType: 'process', turnSeq: 77,
        content: 'Process notice during the selected user\'s turn' }),
    ];
    for (const activity of interleavedNonOwnerActivity) {
      transport.emit(activity);
      expect(runtime.getSnapshot().liveActivityIds).toContain(activity.id);
      expect(runtime.getSnapshot().liveActivityEligibleIds).not.toContain(activity.id);
    }

    const ownerActivity = message(24, { role: 'user', sender: 'process:work', messageType: 'substrate' });
    transport.emit(ownerActivity);
    expect(runtime.getSnapshot().liveActivityEligibleIds).toContain(ownerActivity.id);

    transport.emit({ ...ownerActivity, rowVersion: 2, content: 'Updated while the owner turn remains active' });
    expect(runtime.getSnapshot().liveActivityEligibleIds).toContain(ownerActivity.id);

    transport.callbacks?.onNotice({ operation: 'turn', turn: { ...ownerTurn, status: 'completed',
      raw: { rowVersion: 2 } } });
    const ownerReply = message(30, { role: 'assistant', sender: 'assistant-service', messageType: 'assistant',
      turnSeq: 82, replyToMessageId: ownerPrompt.id });
    transport.emit(ownerReply);
    const delayedOwnerActivity = message(31, { role: 'user', sender: 'process:work', messageType: 'substrate', turnSeq: 82 });
    transport.emit(delayedOwnerActivity);
    expect(runtime.getSnapshot().liveActivityEligibleIds).toContain(delayedOwnerActivity.id);

    const laterBatch = message(25, { role: 'user', sender: 'process:notifications', messageType: 'substrate', turnSeq: 77,
      isBatchCarrier: true, content: [
        '[from process:notifications]', '', '[batched notices: 1]', 'batchId=late-batch', 'release=example',
        '[5567] source=process:events sender=process:events cause=notice class=fyi',
        'A notice delivered between the owner prompt and reply', '', 'coalesced by notices',
      ].join('\n') });
    transport.emit(laterBatch);
    expect(runtime.getSnapshot().liveActivityEligibleIds).toContain(laterBatch.id);

    const outsideOwnerTurn = message(33, { role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 77 });
    transport.emit(outsideOwnerTurn);
    expect(runtime.getSnapshot().liveActivityEligibleIds).not.toContain(outsideOwnerTurn.id);
    runtime.dispose();
  });

  it('treats retained rows as history after opening a replacement live subscription', async () => {
    const transport = new ControlledTransport();
    const settledTurn: CanonicalTurn = { seq: 80, sessionKey, status: 'completed', messageId: 'm8',
      origin: 'user:person', triggerSource: 'mike', raw: { rowVersion: 1 } };
    transport.tailHook = () => transport.callbacks?.onNotice({ operation: 'turn', turn: settledTurn });
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    const activity = message(9, { role: 'user', sender: 'agent:helper', messageType: 'agent' });
    transport.emit(activity);
    expect(runtime.getSnapshot().records.some(record => record.id === activity.id)).toBe(true);
    const previousCallbacks = transport.callbacks;

    await runtime.rebuild({ restart: true });

    expect(transport.callbacks).not.toBe(previousCallbacks);
    expect(runtime.getSnapshot().records.some(record => record.id === activity.id)).toBe(true);
    expect(runtime.getSnapshot().liveActivityIds).not.toContain(activity.id);
    expect(runtime.getSnapshot().liveActivityEligibleIds).not.toContain(activity.id);
    runtime.dispose();
  });

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

  it.each(['live', 'buffered rebuild', 'forward-page overlap', 'older-page race'])(
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
      if (arrival === 'buffered rebuild') transport.tailHook = () => { emitTurn(); transport.emit(enriched); };
      const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
      await runtime.rebuild();
      if (arrival === 'forward-page overlap') {
        await runtime.loadOlder();
        transport.afterHook = (cursor) => {
          emitTurn();
          transport.emit(enriched);
          return { records: [], oldestCursor: null, newestCursor: cursor, hasNewer: false,
            hasOlder: false, coverage: 'controlled-fixture' };
        };
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
      runtime.dispose();
    });

  it('clears stale caption state on reconnect and restores it from the replacement feed', async () => {
    const transport = new ControlledTransport();
    transport.rows[7] = message(8, { role: 'user', sender: 'user:person', turnSeq: 90 });
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
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    expect(runtime.getSnapshot().activityTurnStateAvailable).toBe(false);
    // Freshness loss clears cached caption state. The active turn returns only
    // when the replacement subscription delivers its current turn records.
    transport.tailHook = undefined;
    await runtime.rebuild();
    const replacementCallbacks = transport.callbacks!;
    expect(replacementCallbacks).not.toBe(oldCallbacks);
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    replacementCallbacks.onNotice({ operation: 'turn', turn: active });
    expect(runtime.getSnapshot().activeTurn?.turn.seq).toBe(90);
    oldCallbacks.onNotice({ operation: 'turn', turn: active });
    expect(runtime.getSnapshot().activeTurn?.turn.seq).toBe(90);
    transport.callbacks?.onNotice({ operation: 'turn', turn: { ...active, sessionKey: 'another-session' } });
    expect(runtime.getSnapshot().activeTurn?.turn.seq).toBe(90);
    transport.callbacks?.onNotice({ operation: 'turn', turn: active });
    expect(runtime.getSnapshot().activeTurn?.sourceKind).toBe('human');
    for (const status of ['completed', 'failed', 'canceled']) {
      transport.callbacks?.onNotice({ operation: 'turn', turn: { ...active, status, raw: { rowVersion: 2 } } });
      expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    }
    // An older buffered seed must not resurrect a completed turn.
    transport.callbacks?.onNotice({ operation: 'turn', turn: active });
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    runtime.dispose();
  });

  it('retries an unavailable live stream without taking the conversation offline', async () => {
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
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(runtime.getSnapshot().liveError).toBe('Connection unavailable');
      expect(runtime.getSnapshot().liveConnectionState).toBe('reconnecting');
      expect(runtime.send('The conversation remains available while the feed is disconnected.')).toBeTruthy();
      expect(open).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(8250);
      expect(runtime.getSnapshot().liveConnectionState).toBe('disconnected');
      transport.rows.push(message(9));
      open.mockImplementation((...args) => connect(...args));
      await runtime.rebuild({ restart: true });
      expect(open).toHaveBeenCalledTimes(7);
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(runtime.getSnapshot().records.some(row => row.id === oldest)).toBe(true);
      expect(runtime.getSnapshot().records.at(-1)?.id).toBe('m9');
      await vi.advanceTimersByTimeAsync(1000);
      expect(runtime.getSnapshot().liveConnectionState).toBe('connected');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(open).toHaveBeenCalledTimes(7);
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it('keeps the connected indicator through a feed blip that recovers within a second', async () => {
    vi.useFakeTimers();
    const transport = new ControlledTransport();
    const connect = transport.openChanges;
    const open = vi.fn(async (...args: Parameters<typeof connect>) => connect(...args));
    transport.openChanges = open;
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    try {
      await runtime.rebuild();
      await vi.advanceTimersByTimeAsync(1000);
      expect(runtime.getSnapshot().liveConnectionState).toBe('connected');

      const transitions: RuntimeState['liveConnectionState'][] = [];
      let priorState = runtime.getSnapshot().liveConnectionState;
      const unsubscribe = runtime.subscribe(() => {
        const nextState = runtime.getSnapshot().liveConnectionState;
        if (nextState !== priorState) transitions.push(nextState);
        priorState = nextState;
      });
      transport.doubt();
      expect(runtime.getSnapshot().liveConnectionState).toBe('connected');
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(750);

      expect(runtime.getSnapshot().liveConnectionState).toBe('connected');
      expect(runtime.getSnapshot().liveError).toBeUndefined();
      expect(transitions).toEqual([]);
      await vi.advanceTimersByTimeAsync(250);
      expect(runtime.getSnapshot().liveConnectionState).toBe('connected');
      expect(transitions).toEqual([]);
      unsubscribe();
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it('keeps flapping yellow, shows red after ten seconds, and waits for a stable recovery', async () => {
    vi.useFakeTimers();
    const transport = new ControlledTransport();
    const connect = transport.openChanges;
    const open = vi.fn(async (...args: Parameters<typeof connect>) => connect(...args));
    transport.openChanges = open;
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    try {
      await runtime.rebuild();
      await vi.advanceTimersByTimeAsync(1000);
      expect(runtime.getSnapshot().liveConnectionState).toBe('connected');
      const transitions: Array<{ state: RuntimeState['liveConnectionState']; at: number }> = [];
      let priorState = runtime.getSnapshot().liveConnectionState;
      const unsubscribe = runtime.subscribe(() => {
        const nextState = runtime.getSnapshot().liveConnectionState;
        if (nextState !== priorState) transitions.push({ state: nextState, at: Date.now() });
        priorState = nextState;
      });

      const outageStartedAt = Date.now();
      open.mockRejectedValue(new Error('Connection unavailable'));
      transport.doubt();
      expect(runtime.getSnapshot().liveConnectionState).toBe('connected');
      await vi.advanceTimersByTimeAsync(1000);
      expect(runtime.getSnapshot().liveConnectionState).toBe('reconnecting');

      // A brief successful connection is not stable while the same outage is flapping.
      open.mockImplementation((...args) => connect(...args));
      await runtime.rebuild({ restart: true });
      expect(runtime.getSnapshot().liveConnectionState).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(500);
      open.mockRejectedValue(new Error('Connection unavailable'));
      transport.doubt();
      expect(runtime.getSnapshot().liveConnectionState).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(8500);

      expect(Date.now() - outageStartedAt).toBe(10_000);
      expect(runtime.getSnapshot().liveConnectionState).toBe('disconnected');
      expect(transitions.map(({ state }) => state)).toEqual(['reconnecting', 'disconnected']);

      open.mockImplementation((...args) => connect(...args));
      await runtime.rebuild({ restart: true });
      expect(runtime.getSnapshot().liveConnectionState).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(999);
      expect(runtime.getSnapshot().liveConnectionState).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(1);
      expect(runtime.getSnapshot().liveConnectionState).toBe('connected');
      expect(transitions.slice(1).every((change, index) =>
        change.at - transitions[index].at >= 1000)).toBe(true);
      unsubscribe();
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it('settles repeated feed failures as disconnected and catches up immediately when the feed returns', async () => {
    vi.useFakeTimers();
    const transport = new ControlledTransport();
    const connect = transport.openChanges;
    const open = vi.fn(async (...args: Parameters<typeof connect>) => connect(...args));
    transport.openChanges = open;
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    try {
      await runtime.rebuild();
      const oldest = runtime.getSnapshot().records[0].id;
      open.mockRejectedValue(new Error('Connection unavailable'));
      transport.doubt();
      for (const delay of [250, 500, 1000, 2000, 4000, 8000, 16000]) {
        await vi.advanceTimersByTimeAsync(delay);
      }
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(runtime.getSnapshot().liveConnectionState).toBe('disconnected');
      expect(runtime.getSnapshot().records.some(row => row.id === oldest)).toBe(true);

      const ready = deferred<{ close(): void }>();
      open.mockImplementation(async () => ready.promise);
      const latest = message(9);
      const recoveryReadStarted = deferred<void>();
      let recoveryReadSignaled = false;
      transport.afterHook = (cursor) => {
        const afterSeq = Number(cursor.slice('after:'.length));
        const records = transport.rows.filter(row => row.seq > afterSeq).slice(0, 3);
        if (open.mock.calls.length >= 9 && !recoveryReadSignaled) {
          recoveryReadSignaled = true;
          recoveryReadStarted.resolve();
        }
        return { records, oldestCursor: records[0]?.id ?? null,
          newestCursor: records.length ? `after:${records.at(-1)!.seq}` : cursor,
          hasNewer: false, hasOlder: false, coverage: 'controlled-fixture' };
      };
      await vi.advanceTimersByTimeAsync(30_000);
      expect(open).toHaveBeenCalledTimes(9);
      await recoveryReadStarted.promise;
      const readsBeforeOpen = transport.readAfterCalls.length;
      const caughtUp = deferred<void>();
      transport.afterHook = (cursor) => {
        if (transport.readAfterCalls.length > readsBeforeOpen) caughtUp.resolve();
        const afterSeq = Number(cursor.slice('after:'.length));
        const records = transport.rows.filter(row => row.seq > afterSeq).slice(0, 3);
        return { records, oldestCursor: records[0]?.id ?? null,
          newestCursor: records.length ? `after:${records.at(-1)!.seq}` : cursor,
          hasNewer: false, hasOlder: false, coverage: 'controlled-fixture' };
      };
      transport.rows.push(latest);
      ready.resolve({ close: vi.fn() });
      // Feed recovery schedules the held-cursor request on the reconnect
      // interval. Drive that timer explicitly before waiting for its response.
      await vi.advanceTimersByTimeAsync(250);
      await caughtUp.promise;
      for (let index = 0; index < 12; index++) await Promise.resolve();

      expect(transport.readAfterCalls.length).toBeGreaterThan(readsBeforeOpen);
      expect(runtime.getSnapshot().records.some(row => row.id === latest.id)).toBe(true);
      expect(runtime.getSnapshot().records.some(row => row.id === oldest)).toBe(true);
      expect(runtime.getSnapshot().liveConnectionState).toBe('disconnected');
      await vi.advanceTimersByTimeAsync(1000);
      expect(runtime.getSnapshot().liveConnectionState).toBe('connected');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(open).toHaveBeenCalledTimes(9);
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it('keeps conversation and sending available when only live-update authentication is refused', async () => {
    const transport = new ControlledTransport();
    transport.openChanges = async () => { throw new AuthorizationError('Live updates are not authorized.'); };
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(runtime.getSnapshot().records.length).toBeGreaterThan(0);
    expect(runtime.getSnapshot().liveError).toBe('Live updates are not authorized.');

    const id = runtime.send('Conversation and sending remain available.')!;
    await vi.waitFor(() => expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === id))
      .toMatchObject({ status: 'accepted' }));
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().records.length).toBeGreaterThan(0);
    runtime.dispose();
  });

  it('keeps conversation and sending available when an established live stream loses authorization', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));

    transport.callbacks?.onAuthorizationLost?.('Live updates are not authorized.');
    await vi.waitFor(() => expect(runtime.getSnapshot().liveError).toBe('Live updates are not authorized.'));
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().records.length).toBeGreaterThan(0);
    const id = runtime.send('The conversation remains available.')!;
    await vi.waitFor(() => expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === id))
      .toMatchObject({ status: 'accepted' }));
    runtime.dispose();
  });

  it('replaces a stalled recovery without hiding the existing conversation', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    try {
      await runtime.rebuild();
      const stalled = deferred<void>();
      const subscribed = deferred<void>();
      const history = deferred<void>();
      const connect = transport.openChanges;
      const readAfter = transport.readAfter!;
      let attempts = 0;
      let catchupAttempts = 0;
      let oldSignal: AbortSignal | undefined;
      transport.openChanges = async (key, callbacks, signal?: AbortSignal) => {
        attempts++;
        if (attempts === 1) { oldSignal = signal; await stalled.promise; }
        else await subscribed.promise;
        return connect(key, callbacks);
      };
      transport.readAfter = async (key, cursor, signal) => {
        catchupAttempts++;
        if (catchupAttempts <= 2) await history.promise;
        return readAfter(key, cursor, signal);
      };
      const pending = runtime.rebuild();
      await vi.waitFor(() => expect(attempts).toBe(1));
      await vi.waitFor(() => expect(catchupAttempts).toBe(1));
      const fresh = runtime.rebuild({ restart: true });
      await vi.waitFor(() => expect(attempts).toBe(2));
      expect(oldSignal?.aborted).toBe(true);
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(transport.readTailCalls).toBe(1);
      subscribed.resolve();
      await vi.waitFor(() => expect(transport.readSessionCalls).toBeGreaterThanOrEqual(3));
      await vi.waitFor(() => expect(catchupAttempts).toBe(2));
      expect(runtime.getSnapshot().status).toBe('ready');
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

  it('opens a transcript with only selected-session metadata and paged history reads', async () => {
    const transport = new ControlledTransport();
    const trigger = message(1, { role: 'user', sender: 'user:person', content: 'Earlier source prompt' });
    const reply = message(4, { turnSeq: 44, replyToMessageId: trigger.id, messageType: 'assistant', content: 'Selected agent reply' });
    transport.rows = [trigger, message(2), message(3), reply];

    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m2', 'm3', 'm4']);
    expect(runtime.getSnapshot().provenance).toEqual([]);
    expect(runtime.getSnapshot().provenanceAvailable).toBe(false);
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    expect(transport.readSessionCalls).toBe(1);
    expect(transport.readTailCalls).toBe(1);
    expect(transport.readOlderCalls).toBe(0);
    runtime.dispose();
  });

  it('keeps history and sending available without turn detail endpoints', async () => {
    const transport = new ControlledTransport();
    transport.rows = [message(7, { role: 'user', content: 'Can you help?' }),
      message(8, { content: 'The answer remains visible.', turnSeq: 44 })];
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);

    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m7', 'm8']);
    expect(runtime.getSnapshot().provenanceAvailable).toBe(false);
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    expect(transport.readSessionCalls).toBe(1);
    expect(transport.readTailCalls).toBe(1);

    const live = message(9, { content: 'A live reply also appears.' });
    transport.rows.push(live);
    transport.emit(live);
    await vi.waitFor(() => expect(runtime.getSnapshot().records.at(-1)?.id).toBe('m9'));
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(transport.readSessionCalls).toBe(1);
    expect(transport.readTailCalls).toBe(1);

    const clientMessageId = runtime.send('Still available');
    expect(clientMessageId).toBeTruthy();
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0]?.status).toBe('accepted'));
    expect(transport.submissions[0].content).toBe('Still available');
    expect(runtime.getSnapshot().status).toBe('ready');
    runtime.dispose();
  });

  it('loads and sends while the optional live subscription is still connecting', async () => {
    const transport = new ControlledTransport();
    const liveReady = deferred<void>();
    transport.readyGate = liveReady;
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);

    await runtime.rebuild();
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().records.length).toBeGreaterThan(0);
    expect(runtime.getSnapshot().liveError).toBe('Live updates are connecting.');
    const id = runtime.send('sending does not wait for live updates');
    expect(id).toBeTruthy();
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0].status).toBe('accepted'));

    liveReady.resolve();
    await vi.waitFor(() => expect(runtime.getSnapshot().liveError).toBeUndefined(), { timeout: 1500 });
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(transport.readSessionCalls).toBe(1);
    expect(transport.readTailCalls).toBe(1);
    expect(transport.readAfterCalls).toEqual(['after:8']);
    runtime.dispose();
  });

  it('catches up rows committed before initial feed readiness and restores older history', async () => {
    const transport = new ControlledTransport();
    const catchUpStarted = deferred<void>();
    const catchUpResponse = deferred<ConversationPage>();
    transport.afterHook = (cursor) => {
      expect(cursor).toBe('after:8');
      catchUpStarted.resolve();
      return catchUpResponse.promise;
    };
    transport.readyGate = deferred<void>();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(transport.readTailCalls).toBe(1);
    expect(runtime.getSnapshot().records.map((row) => row.id)).toEqual(['t6', 'm7', 'm8']);
    expect(runtime.getSnapshot().liveError).toBe('Live updates are connecting.');
    const recoveryRevisionBeforeCatchUp = runtime.getSnapshot().recoveryRevision ?? 0;

    // The row lands after the history response but before subscription_ready;
    // the server cannot replay it as a change frame, so cursor catch-up must.
    transport.rows.push(message(9, { content: 'committed during initial feed open' }));
    transport.readyGate.resolve();
    await catchUpStarted.promise;
    expect(runtime.getSnapshot().records.map((row) => row.id)).toEqual(['t6', 'm7', 'm8']);
    expect(runtime.getSnapshot().liveError).toBe('Live updates are connecting.');
    expect(transport.readSessionCalls).toBe(1);
    expect(transport.readTailCalls).toBe(1);

    const appended = message(9, { content: 'committed during initial feed open' });
    catchUpResponse.resolve({ records: [appended], oldestCursor: 'm9', newestCursor: 'after:9',
      hasOlder: false, hasNewer: false, coverage: 'controlled-fixture' });
    await vi.waitFor(() => expect(runtime.getSnapshot().records.some((row) => row.id === 'm9')).toBe(true));
    await vi.waitFor(() => expect(runtime.getSnapshot().liveError).toBeUndefined(), { timeout: 1500 });
    expect(runtime.getSnapshot().recoveryRevision).toBe(recoveryRevisionBeforeCatchUp + 1);
    expect(transport.readSessionCalls).toBe(1);
    expect(transport.readTailCalls).toBe(1);
    expect(transport.readAfterCalls).toEqual(['after:8']);
    expect(runtime.getSnapshot().session?.raw.clearedThroughSeq).toBe(0);
    while (runtime.getSnapshot().hasOlder) await runtime.loadOlder();
    expect(runtime.getSnapshot().records.map((row) => row.id)).toEqual(
      ['m1', 'm2', 't3', 'm4', 'm5', 't6', 'm7', 'm8', 'm9']);
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

  it('ignores ordinary and unknown startup observations without refetching or losing buffered rows', async () => {
    const transport = new ControlledTransport();
    const appended = message(9, { role: 'user', sender: undefined, content: 'An unmarked user row' });
    transport.tailHook = () => {
      transport.callbacks?.onNotice({ operation: 'unknown', sessionKey, resource: 'wake.fired' });
      transport.callbacks?.onNotice({ operation: 'unknown', sessionKey, resource: 'future.event' });
      transport.emit(appended);
    };
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(transport.readSessionCalls).toBe(1);
    expect(transport.readTailCalls).toBe(1);
    expect(runtime.getSnapshot().records.filter((row) => row.id === appended.id)).toHaveLength(1);
    expect(runtime.getSnapshot().status).toBe('ready');
    runtime.dispose();
  });

  it('ignores ordinary and unknown ready-state events without interrupting continuity or future messages', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    const reads = transport.readTailCalls;
    const closes = transport.closed;
    transport.callbacks?.onNotice({ operation: 'unknown', sessionKey, resource: 'wake.scheduled' });
    transport.callbacks?.onNotice({ operation: 'unknown', sessionKey, resource: 'future.event' });
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(transport.readTailCalls).toBe(reads);
    expect(transport.closed).toBe(closes);

    const appended = message(9, { content: 'Still connected' });
    transport.rows.push(appended);
    transport.emit(appended);
    expect(runtime.getSnapshot().records.at(-1)?.id).toBe(appended.id);
    expect(runtime.getSnapshot().status).toBe('ready');
    runtime.dispose();
  });

  it('keeps data and sending available when a constant profile or live coverage is unproved', async () => {
    const wrong = new ControlledTransport();
    wrong.observation = { ...profile, identity: 'unreviewed-build' };
    const runtime = createTightbeamAdapter(wrong, profile).open(sessionKey);
    await runtime.rebuild();
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(wrong.readTailCalls).toBe(1);
    expect(runtime.getSnapshot().records.length).toBeGreaterThan(0);
    expect(runtime.send('still available')).toBeTruthy();
    runtime.dispose();
    const noProof = new ControlledTransport();
    noProof.coverage = false;
    const second = createTightbeamAdapter(noProof, profile).open(sessionKey);
    await second.rebuild();
    expect(second.getSnapshot().status).toBe('ready');
    expect(second.getSnapshot().records.length).toBeGreaterThan(0);
    expect(second.getSnapshot().liveError).toContain('verify conversation updates');
    expect(second.send('send without live updates')).toBeTruthy();
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

  it('catches up after an initialization feed gap without repeating the settled tail', async () => {
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
    await vi.waitFor(() => expect(transport.readAfterCalls).toHaveLength(1));
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'), { timeout: 1000 });
    expect(transport.readTailCalls).toBe(1);
    expect(transport.readAfterCalls).toEqual(['after:8']);
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
    expect(runtime.getSnapshot().status).toBe('ready');
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

  it('keeps shown messages and older paging when a reconnect tail is temporarily incomplete', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    await runtime.loadOlder();
    const shownIds = runtime.getSnapshot().records.map((row) => row.id);
    expect(runtime.getSnapshot().hasOlder).toBe(true);

    // The bounded forward page is empty, so settled rows remain held and the
    // reader's existing older-page cursor stays usable.
    transport.doubt();
    await runtime.rebuild();

    const recovered = runtime.getSnapshot();
    expect(recovered.status).toBe('ready');
    expect(shownIds.every((id) => recovered.records.some((row) => row.id === id))).toBe(true);
    expect(recovered.hasOlder).toBe(true);

    await runtime.loadOlder();
    expect(runtime.getSnapshot().records.map((row) => row.id)).toContain('m1');
    expect(runtime.getSnapshot().records.map((row) => row.id)).toContain('m2');
    runtime.dispose();
  });

  it('catches up from the newest held cursor without rereading settled pages', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    await runtime.loadOlder();
    await runtime.loadOlder();
    const tailReads = transport.readTailCalls;
    const olderReads = transport.readOlderCalls;

    transport.rows.push(message(9), switchAt(10, 'harness'), message(11), message(12), message(13), message(14));
    transport.doubt();
    await vi.waitFor(() => expect(runtime.getSnapshot().records.some((row) => row.id === 'm14')).toBe(true));

    expect(transport.readAfterCalls).toEqual(['after:8', 'after:11']);
    expect(transport.readTailCalls).toBe(tailReads);
    expect(transport.readOlderCalls).toBe(olderReads);
    expect(runtime.getSnapshot().records.some((row) => row.id === 'm1')).toBe(true);

    transport.rows.push(message(15));
    transport.doubt();
    await vi.waitFor(() => expect(runtime.getSnapshot().records.some((row) => row.id === 'm15')).toBe(true));
    expect(transport.readAfterCalls).toEqual(['after:8', 'after:11', 'after:14']);
    expect(transport.readTailCalls).toBe(tailReads);
    runtime.dispose();
  });

  it('reconciles only high-attention substrate rows that Gateway can revise in place', async () => {
    const transport = new ControlledTransport();
    const original = message(6, { messageType: 'substrate', attentionTier: 1,
      clientMessageId: 'terminal-credential:tcf_test:person',
      createdAt: '2026-10-01T00:00:00.000Z' });
    transport.rows[5] = original;
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    const revised = { ...original, content: 'Revised source notice', createdAt: '2026-10-02T00:00:00.000Z' };
    transport.messageDetails.set(original.id, revised);
    transport.doubt();

    await vi.waitFor(() => expect((runtime.getSnapshot().records.find((row) => row.id === original.id) as CanonicalMessage)?.content)
      .toBe('Revised source notice'));
    expect(transport.readMessageCalls).toEqual([original.id]);
    expect(transport.readAfterCalls).toEqual(['after:8']);
    expect(transport.readTailCalls).toBe(1);
    runtime.dispose();
  });

  it('skips detail reads for immutable high-attention wake notices on reconnect', async () => {
    const transport = new ControlledTransport();
    transport.rows = transport.rows.map((record) => {
      if (record.kind !== 'message') return record;
      const clientMessageId = record.seq % 2 === 0
        ? `wake-undeliverable:${record.seq}` : `wake-undelivered:${record.seq}`;
      return { ...record, messageType: 'substrate', attentionTier: 1,
        clientMessageId };
    });
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    while (runtime.getSnapshot().hasOlder) await runtime.loadOlder();
    const immutableIds = runtime.getSnapshot().records
      .filter((record): record is CanonicalMessage => record.kind === 'message' &&
        record.messageType === 'substrate' && record.attentionTier === 1 &&
        record.clientMessageId?.startsWith('wake-') === true)
      .map((record) => record.id);
    const tailReads = transport.readTailCalls;
    const olderReads = transport.readOlderCalls;
    expect(immutableIds).toHaveLength(6);

    transport.rows.push(message(9));
    transport.doubt();
    await vi.waitFor(() => expect(runtime.getSnapshot().records.some((row) => row.id === 'm9')).toBe(true));

    expect(transport.readMessageCalls).toEqual([]);
    expect(transport.readAfterCalls).toEqual(['after:8']);
    expect(transport.readTailCalls).toBe(tailReads);
    expect(transport.readOlderCalls).toBe(olderReads);
    expect(immutableIds.every((id) => runtime.getSnapshot().records.some((row) => row.id === id))).toBe(true);
    runtime.dispose();
  });

  it('reanchors from a fresh tail when a session clear invalidates the held history cursor', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    await runtime.loadOlder();
    const tailReads = transport.readTailCalls;
    transport.clearBarrier = 5;
    transport.rows.push(message(9));
    transport.doubt();
    await vi.waitFor(() => expect(runtime.getSnapshot().records.some((row) => row.id === 'm9')).toBe(true));

    expect(transport.readTailCalls).toBe(tailReads + 1);
    expect(transport.readAfterCalls).toHaveLength(0);
    expect(runtime.getSnapshot().records.map((row) => row.seq)).toEqual([6, 7, 8, 9]);
    expect(runtime.getSnapshot().hasOlder).toBe(true);
    runtime.dispose();
  });

  it('keeps shown messages when a replacement feed closes before readiness', async () => {
    vi.useFakeTimers();
    try {
      const transport = new ControlledTransport();
      transport.openingFailures.push(new Error('Firehose closed before subscription readiness.'));
      const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
      await runtime.rebuild();
      await runtime.loadOlder();
      const shownIds = runtime.getSnapshot().records.map((row) => row.id);
      expect(shownIds.length).toBeGreaterThan(3);
      expect(runtime.getSnapshot().hasOlder).toBe(true);

      // The next reconnect attempt also closes before readiness; the forward
      // read still preserves the already displayed rows.
      transport.openingFailures.push(new Error('Firehose closed before subscription readiness.'));
      await vi.advanceTimersByTimeAsync(250);

      const recovered = runtime.getSnapshot();
      expect(recovered.status).toBe('ready');
      expect(shownIds.every((id) => recovered.records.some((row) => row.id === id))).toBe(true);
      expect(recovered.hasOlder).toBe(true);
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps out-of-order live rows visible in sequence order while older history loads', async () => {
    const transport = new ControlledTransport();
    transport.rows = [message(10), message(20), switchAt(30, 'harness'), message(40), message(50),
      switchAt(60, 'model'), message(70), message(80)];
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
    const changed = message(50, { rowVersion: 2, content: 'updated during page read' });
    const inserted = message(55, { id: 'late-human', role: 'user', sender: 'user:person',
      content: 'Human row received after a later row' });
    const insertedRevision = { ...inserted, rowVersion: 2, content: 'Latest human row revision' };
    transport.rows = [...transport.rows.map((record) => record.id === changed.id ? changed : record), insertedRevision]
      .sort((a, b) => a.seq - b.seq);
    const appended = message(90, { content: 'appended during page read' });
    transport.rows.push(appended);
    transport.emit(appended);
    transport.emit(changed);
    transport.emit(insertedRevision);
    // A delayed lower rowVersion must not replace the latest canonical row.
    transport.emit(inserted);
    const inFlightRows = runtime.getSnapshot().records;
    expect(inFlightRows.map((record) => record.id)).toEqual(['m50', 'late-human', 't60', 'm70', 'm80', 'm90']);
    expect(inFlightRows.filter((record) => record.id === 'late-human')).toHaveLength(1);
    expect(inFlightRows.find((record) => record.id === 'late-human')).toMatchObject({
      rowVersion: 2, content: 'Latest human row revision',
    });
    transport.reset();
    gate.resolve();
    await loading;
    expect((runtime.getSnapshot().records.find((record) => record.id === 'm50') as CanonicalMessage).content)
      .toBe('updated during page read');
    const settledRows = runtime.getSnapshot().records;
    expect(settledRows.map((record) => record.id)).toEqual(['t30', 'm40', 'm50', 'late-human', 't60', 'm70', 'm80', 'm90']);
    expect(settledRows.filter((record) => record.id === 'late-human')).toHaveLength(1);
    expect(settledRows.find((record) => record.id === 'late-human')).toMatchObject({
      rowVersion: 2, content: 'Latest human row revision',
    });
    expect(runtime.getSnapshot().session?.activity).toBe('reset');
    runtime.dispose();
  });

  it('restores across the old reading coordinate when that anchor row was deleted', async () => {
    const transport = new ControlledTransport();
    transport.readAfter = undefined;
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

  it('retains already shown history when forward catch-up fails', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    await runtime.loadOlder();
    const shownIds = runtime.getSnapshot().records.map((record) => record.id);

    transport.rows.push(message(9));
    transport.readAfter = async () => { throw new Error('Forward history is temporarily unavailable.'); };
    await runtime.rebuild();

    const state = runtime.getSnapshot();
    expect(state.status).toBe('ready');
    expect(state.conversationError).toBe('Forward history is temporarily unavailable.');
    expect(shownIds.every((id) => state.records.some((record) => record.id === id))).toBe(true);
    expect(state.records.some((record) => record.id === 'm9')).toBe(false);
    expect(runtime.send('sending remains available')).toBeTruthy();
    runtime.dispose();
  });

  it('keeps the conversation and sending available when an older page is invalid', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    transport.readOlder = async () => ({ records: [{ ...message(4), sessionKey: 'other' }],
      oldestCursor: 'bad', hasOlder: true, coverage: 'fixture' });
    await runtime.loadOlder();
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().records.length).toBeGreaterThan(0);
    expect(runtime.getSnapshot().historyError).toContain('History page crossed session boundary');
    expect(runtime.send('still send')).toBeTruthy();
    expect(transport.closed).toBe(0);
    runtime.dispose();

    const thrown = new ControlledTransport();
    const second = createTightbeamAdapter(thrown, profile).open(sessionKey);
    await second.rebuild();
    thrown.readOlder = async () => { throw new UnsupportedTargetError('wire schema changed'); };
    await second.loadOlder();
    expect(second.getSnapshot().status).toBe('ready');
    expect(second.getSnapshot().records.length).toBeGreaterThan(0);
    expect(second.getSnapshot().historyError).toBe('wire schema changed');
    second.dispose();
  });

  it('keeps the conversation and sending available when older-page access is denied', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    transport.readOlder = async () => { throw new AuthorizationError('Older history is not authorized.'); };

    await runtime.loadOlder();
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().historyError).toBe('Older history is not authorized.');
    expect(runtime.getSnapshot().records.length).toBeGreaterThan(0);
    const id = runtime.send('The visible conversation can still send.')!;
    await vi.waitFor(() => expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === id))
      .toMatchObject({ status: 'accepted' }));
    expect(runtime.getSnapshot().status).toBe('ready');
    runtime.dispose();
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
    expect(state.status).toBe('ready');
    expect(state.historyError).toBe('history schema changed');
    expect(state.sends).toEqual([
      expect.objectContaining({ clientMessageId: acceptedId, content: 'known accepted', status: 'accepted' }),
      expect.objectContaining({ clientMessageId: pendingId, content: '  exact pending text  ',
        sessionKey, deviceId: 'device', status: 'pending' }),
    ]);
    expect(runtime.send('new send')).toBeTruthy();
    await runtime.retrySend(pendingId);
    pendingAck.resolve({ outcome: 'accepted' });
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[1].status).toBe('accepted'));
    expect(transport.submissions).toHaveLength(3);
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

  it('reconciles a host retry from canonical history when session details are unavailable', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(runtime.getSnapshot().session).toMatchObject({
      sessionKey, displayName: 'Fixture agent',
    });

    const clientMessageId = 'c_018f1a62-7c73-4c7d-8c05-e53d5c542a07';
    const content = 'A host-composed prompt';
    transport.rows.push(message(9, {
      role: 'user', sender: 'user:person', deviceId: transport.identity.deviceId,
      clientMessageId, content,
    }));
    transport.readSession = async () => {
      throw new Error('Session details are temporarily unavailable.');
    };

    const outcomes: string[] = [];
    runtime.observeHostSend(clientMessageId, signal => outcomes.push(signal.kind));
    runtime.retryHostSend(clientMessageId, content, { lifetimeId: 'host-page', attempt: 1 });

    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0]).toMatchObject({
      clientMessageId, content, status: 'accepted', reconciled: true,
    }));
    expect(outcomes).toContain('reconciled');
    expect(runtime.getSnapshot().records.some(record => record.kind === 'message' &&
      record.sessionKey === sessionKey && record.deviceId === transport.identity.deviceId &&
      record.clientMessageId === clientMessageId)).toBe(true);
    expect(transport.submissions).toHaveLength(0);
    runtime.dispose();
  });

  it('keeps the conversation available when canonical send reconciliation cannot read history', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    transport.readTail = async () => { throw new AuthorizationError('History refresh is not authorized.'); };

    await expect(runtime.refreshHostSend('c_018f1a62-7c73-4c7d-8c05-e53d5c542a07')).resolves.toBe('unavailable');
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().records.length).toBeGreaterThan(0);
    const id = runtime.send('Sending stays available when reconciliation is not.')!;
    await vi.waitFor(() => expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === id))
      .toMatchObject({ status: 'accepted' }));
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

  it('keeps re-asking after reconnect failure until the same submission is acknowledged', async () => {
    const transport = new ControlledTransport();
    transport.nextSend = async () => transport.submissions.length === 1
      ? { outcome: 'retryable', reason: 'socket closed before acknowledgement' }
      : transport.submissions.length === 2
        ? { outcome: 'unreachable', reason: 'Not connected to the server.' }
        : { outcome: 'accepted' };
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();
    vi.useFakeTimers();
    try {
      const id = 'c_018f1a62-7c73-4c7d-8c05-e53d5c542a07';
      const signals: unknown[] = [];
      runtime.observeHostSend(id, (signal) => signals.push(signal));
      runtime.send('  same retry content  ', id, { lifetimeId: 'test-lifetime', attempt: 1 });
      await Promise.resolve();
      await Promise.resolve();
      expect(transport.submissions).toHaveLength(1);
      expect(runtime.getSnapshot().sends[0]).toMatchObject({ clientMessageId: id, status: 'pending' });

      await vi.advanceTimersByTimeAsync(249);
      expect(transport.submissions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.submissions).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(transport.submissions).toHaveLength(2);
      expect(runtime.getSnapshot().sends[0]).toMatchObject({
        clientMessageId: id, content: '  same retry content  ', status: 'pending',
      });
      expect(signals).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      await vi.waitFor(() => expect(runtime.getSnapshot().sends[0]).toMatchObject({
        clientMessageId: id, content: '  same retry content  ', status: 'accepted',
      }));
      const attempts = transport.submissions.filter((submission) => submission.clientMessageId === id);
      expect(attempts).toHaveLength(3);
      expect(attempts[1]).toEqual(attempts[0]);
      expect(attempts[2]).toEqual(attempts[0]);
      expect(signals).toEqual([{ kind: 'accepted' }]);
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps the transcript usable when history cannot prove a safe send retry', async () => {
    const transport = new ControlledTransport();
    const firstSend = deferred<HumanSendResult>();
    transport.nextSend = () => firstSend.promise;
    const noRetryProfile = { ...profile, capabilities: { ...capabilities, humanSendDedupe: false } };
    const runtime = createTightbeamAdapter(transport, noRetryProfile).open(sessionKey);
    await runtime.rebuild();

    const id = runtime.send('  ambiguous after target change  ')!;
    const signals: unknown[] = [];
    runtime.observeHostSend(id, (signal) => signals.push(signal));
    transport.readOlder = async () => { throw new UnsupportedTargetError('target changed during send'); };
    await runtime.loadOlder();
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().historyError).toBe('target changed during send');

    firstSend.resolve({ outcome: 'retryable', reason: 'socket closed before acknowledgement' });
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0]).toMatchObject({
      clientMessageId: id, content: '  ambiguous after target change  ',
      status: 'uncertain', reason: 'retry-unavailable',
    }));
    expect(transport.submissions).toHaveLength(1);
    expect(signals).toEqual([{ kind: 'uncertain', reason: 'ack-lost' }]);
    expect(runtime.send('still send')).toBeTruthy();
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
    expect(runtime.getSnapshot().status).toBe('ready');
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

  it('keeps an initial connection failure nonterminal and re-asks with the same submission when connected', async () => {
    const transport = new ControlledTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await runtime.rebuild();

    transport.nextSend = async () => ({ outcome: 'refused', reason: 'not allowed' });
    const refused = runtime.send('refused')!;
    await vi.waitFor(() => expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === refused))
      .toMatchObject({ status: 'failed', reason: 'not allowed' }));
    expect(transport.submissions.filter((submission) => submission.clientMessageId === refused)).toHaveLength(1);

    const firstConnection = deferred<HumanSendResult>();
    const reconnectAck = deferred<HumanSendResult>();
    transport.nextSend = async () => {
      const offlineAttempts = transport.submissions.filter((submission) => submission.content === 'offline').length;
      return offlineAttempts === 1 ? firstConnection.promise : reconnectAck.promise;
    };
    const offline = runtime.send('offline')!;
    const signals: unknown[] = [];
    runtime.observeHostSend(offline, (signal) => signals.push(signal));
    await vi.waitFor(() => expect(transport.submissions.filter((submission) => submission.clientMessageId === offline))
      .toHaveLength(1));
    vi.useFakeTimers();
    try {
      firstConnection.resolve({ outcome: 'unreachable', reason: 'Not connected to the server.' });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === offline))
        .toMatchObject({ status: 'pending', reason: 'unreachable' });
      expect(signals).toEqual([]);
      const original = transport.submissions.find((submission) => submission.clientMessageId === offline)!;

      await vi.advanceTimersByTimeAsync(249);
      expect(transport.submissions.filter((submission) => submission.clientMessageId === offline)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const attempts = transport.submissions.filter((submission) => submission.clientMessageId === offline);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toEqual(original);
      expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === offline))
        .toMatchObject({ status: 'pending', reason: undefined });

      reconnectAck.resolve({ outcome: 'accepted' });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.getSnapshot().sends.find((send) => send.clientMessageId === offline))
        .toMatchObject({ status: 'accepted' });
      expect(signals).toEqual([{ kind: 'accepted' }]);
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
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

function visibleTools(state: RuntimeState): ToolCallRecord[] {
  return [...indexValues(state.toolCallIndex)].flatMap(group => [...indexValues(group)]);
}

describe('optional tool history and live category', () => {
  const call = (id: string, anchor: number, patch: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
    id, seq: anchor, sessionKey, turnSeq: 1, afterMessageSeq: anchor, harnessToolCallId: id,
    title: 'Read source', kind: 'read', toolName: 'read_file', status: 'in_progress',
    rawInput: {}, rawOutput: null, content: null, truncated: [], startedAt: 1000, endedAt: null, rowVersion: 1, ...patch,
  });
  class ToolsTransport extends ControlledTransport {
    toolCallbacks?: ChangeCallbacks;
    toolClosed = 0;
    toolOpens = 0;
    toolReady = false;
    toolReadyGate?: ReturnType<typeof deferred<void>>;
    toolReadGate?: ReturnType<typeof deferred<void>>;
    ranges: ToolCallRange[] = [];
    calls = [call('tc_old', 3), call('tc_tail', 8)];
    toolHook?: () => void;
    toolError?: Error;
    openToolChanges = async (_key: string, callbacks: ChangeCallbacks) => {
      this.toolOpens++;
      this.toolCallbacks = callbacks;
      if (this.toolReadyGate) await this.toolReadyGate.promise;
      this.toolReady = true;
      return { close: () => { this.toolClosed++; if (this.toolCallbacks === callbacks) this.toolCallbacks = undefined; } };
    };
    readToolCalls = async (_key: string, range: ToolCallRange) => {
      expect(this.toolCallbacks).toBeDefined();
      expect(this.toolReady).toBe(true);
      this.ranges.push(range);
      await this.toolReadGate?.promise;
      const rows = this.calls.filter(call => call.afterMessageSeq >= range.fromInclusive &&
        (range.toExclusive === undefined || call.afterMessageSeq < range.toExclusive));
      this.toolHook?.();
      if (this.toolError) throw this.toolError;
      return rows;
    };
  }

  it('shows tool history by default, pages it by message anchors, and stops all tool reads while toggled off', async () => {
    const transport = new ToolsTransport();
    transport.toolHook = () => transport.toolCallbacks?.onNotice({ operation: 'tool',
      tool: call('tc_tail', 8, { status: 'completed', rowVersion: 2, endedAt: 2000, rawOutput: 'done' }) });
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(transport.toolOpens).toBe(1));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    expect(runtime.getSnapshot().toolCallsEnabled).toBe(true);
    expect(transport.ranges[0]).toEqual({ fromInclusive: 6 });
    expect(visibleTools(runtime.getSnapshot())).toMatchObject([{ id: 'tc_tail', status: 'completed' }]);
    await runtime.loadOlder();
    expect(transport.ranges[1]).toEqual({ fromInclusive: 3, toExclusive: 6 });
    expect(visibleTools(runtime.getSnapshot()).map(call => call.id)).toEqual(['tc_old', 'tc_tail']);
    runtime.setToolCallsEnabled!(false);
    expect(transport.toolCallbacks).toBeUndefined();
    expect(transport.toolClosed).toBe(1);
    expect(visibleTools(runtime.getSnapshot())).toEqual([]);
    expect(transport.closed).toBe(0);
    transport.emit(message(9));
    expect(runtime.getSnapshot().records.at(-1)?.id).toBe('m9');
    transport.calls.push(call('tc_while_off', 9));

    const toolReadsBeforeDisabledRebuild = transport.ranges.length;
    await runtime.rebuild();
    expect(transport.toolOpens).toBe(1);
    expect(transport.ranges).toHaveLength(toolReadsBeforeDisabledRebuild);
    const mainReadsAfterDisabledRebuild = transport.readAfterCalls.length;

    runtime.setToolCallsEnabled!(true);
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    expect(visibleTools(runtime.getSnapshot()).at(-1)?.id).toBe('tc_while_off');
    expect(transport.toolOpens).toBe(2);
    expect(transport.readAfterCalls).toHaveLength(mainReadsAfterDisabledRebuild);
    transport.rows.push(message(9));
    await runtime.rebuild();
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    expect(visibleTools(runtime.getSnapshot()).at(-1)?.id).toBe('tc_while_off');
    expect(transport.toolOpens).toBe(3);
    expect(transport.readAfterCalls).toHaveLength(mainReadsAfterDisabledRebuild + 1);
    runtime.dispose();
  });

  it('keeps shown tool rows while an optional history refresh is pending or unavailable', async () => {
    const transport = new ToolsTransport();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    const shown = visibleTools(runtime.getSnapshot());
    expect(shown.map(call => call.id)).toEqual(['tc_tail']);

    transport.calls = [call('tc_replacement', 8)];
    transport.toolReadGate = deferred<void>();
    transport.toolError = new Error('Tool history is unavailable.');
    runtime.retryToolCalls!();
    await vi.waitFor(() => expect(transport.ranges).toHaveLength(2));

    expect(runtime.getSnapshot().toolCallsLoading).toBe(false);
    expect(visibleTools(runtime.getSnapshot())).toEqual(shown);
    transport.toolCallbacks?.onNotice({ operation: 'tool', tool: call('tc_live', 8, { seq: 9 }) });
    transport.toolReadGate.resolve();
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsError).toBe('Tool history is unavailable.'));
    expect(new Set(visibleTools(runtime.getSnapshot()).map(call => call.id))).toEqual(new Set(['tc_tail', 'tc_live']));

    transport.toolReadGate = undefined;
    transport.toolError = undefined;
    runtime.retryToolCalls!();
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsError).toBeUndefined());
    expect(visibleTools(runtime.getSnapshot()).map(call => call.id)).toEqual(['tc_replacement']);
    runtime.dispose();
  });

  it('keeps the live tool feed without a history error when the history collection is absent', async () => {
    const transport = new ToolsTransport();
    transport.toolError = new ToolHistoryUnavailableError('Tool history is unavailable.');
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(transport.ranges).toHaveLength(1));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));

    expect(runtime.getSnapshot()).toMatchObject({ status: 'ready', toolCallsEnabled: true });
    expect(runtime.getSnapshot().records.length).toBeGreaterThan(0);
    expect(runtime.getSnapshot().toolCallsError).toBeUndefined();
    expect(transport.toolClosed).toBe(0);
    expect(transport.toolCallbacks).toBeDefined();

    runtime.retryToolCalls!();
    await vi.waitFor(() => expect(transport.toolOpens).toBe(2));
    expect(transport.ranges).toHaveLength(1);
    expect(runtime.getSnapshot().toolCallsError).toBeUndefined();
    transport.toolCallbacks?.onNotice({ operation: 'tool', tool: call('tc_live_only', 8) });
    expect(visibleTools(runtime.getSnapshot()).map(tool => tool.id)).toEqual(['tc_live_only']);
    runtime.dispose();
  });

  it('waits for tool subscription readiness before reading an older slice', async () => {
    const transport = new ToolsTransport();
    transport.toolReadyGate = deferred<void>();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    runtime.setToolCallsEnabled!(true);
    await vi.waitFor(() => expect(transport.toolOpens).toBe(1));
    const older = runtime.loadOlder();
    expect(transport.ranges).toEqual([]);
    transport.toolReadyGate.resolve();
    await older;
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    expect(visibleTools(runtime.getSnapshot()).map(call => call.id)).toEqual(['tc_old', 'tc_tail']);
    runtime.dispose();
  });

  it('updates a large retained tool history without revisiting its accumulated records', async () => {
    const transport = new ToolsTransport();
    let inspected = 0;
    transport.calls = Array.from({ length: 5000 }, (_, index) => {
      const record = call('tc_' + index, 8, { seq: index + 1 });
      return { ...record, get seq() { inspected++; return index + 1; },
        get afterMessageSeq() { inspected++; return 8; } };
    });
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    runtime.setToolCallsEnabled!(true);
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    inspected = 0;
    for (let index = 0; index < 100; index++) {
      transport.toolCallbacks?.onNotice({ operation: 'tool', tool: call('tc_' + index, 8,
        { seq: index + 1, rowVersion: 2, status: 'completed', endedAt: 2000 }) });
      transport.toolCallbacks?.onNotice({ operation: 'tool', tool: call('tc_new_' + index, 8, { seq: 5001 + index }) });
    }
    expect(inspected).toBeLessThan(1000);
    const retained = visibleTools(runtime.getSnapshot());
    expect(retained).toHaveLength(5100);
    expect(retained[0].status).toBe('completed');
    expect(retained.at(-1)?.id).toBe('tc_new_99');
    runtime.dispose();
  });

  it('keeps conversation available on tool failure and removes captions only through their own turn lifecycle', async () => {
    const transport = new ToolsTransport();
    transport.toolError = new AuthorizationError('Tool history is not authorized.');
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    runtime.setToolCallsEnabled!(true);
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsError).toContain('not authorized'));
    expect(runtime.getSnapshot().status).toBe('ready');
    transport.toolError = undefined;
    runtime.retryToolCalls!();
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsError).toBeUndefined());
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    transport.toolCallbacks?.onAuthorizationLost?.('Tool updates are not authorized.');
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsError).toBe('Tool updates are not authorized.'));
    expect(runtime.getSnapshot().status).toBe('ready');
    runtime.retryToolCalls!();
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsError).toBeUndefined());
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    transport.callbacks?.onNotice({ operation: 'turn', turn: { seq: 1, sessionKey, status: 'completed', origin: 'user:person', raw: {} } });
    expect(visibleTools(runtime.getSnapshot())[0].status).toBe('in_progress');
    runtime.dispose();
    expect(transport.toolCallbacks).toBeUndefined();
  });
});
