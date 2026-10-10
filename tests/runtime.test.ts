import { describe, expect, it, vi } from 'vitest';
import { createTightbeamAdapter } from '../src/runtime';
import { AuthorizationError } from '../src/types';
import type {
  CanonicalMessage, CanonicalTransition, ChangeCallbacks, ChatTransport,
  ConversationPage, ConversationRecord, HostIdentity, HumanSendResult,
  HumanSubmission, SessionRecord, TargetObservation, TargetProfile,
} from '../src/types';

const sessionKey = 's1';
const capabilities = {
  newestTail: true, stableOlderCursor: true, retainedHistoryAcrossResets: true,
  orderedTransitions: true, snapshotCoverage: true, versionedNotices: true,
  humanSendDedupe: true,
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
  closed = 0;
  coverage = true;
  readyGate?: ReturnType<typeof deferred<void>>;
  tailHook?: () => void;
  nextSend?: (submission: HumanSubmission) => Promise<HumanSendResult>;
  submissions: HumanSubmission[] = [];

  currentIdentity = () => this.identity;
  inspectTarget = async () => this.observation;
  openChanges = async (_key: string, callbacks: ChangeCallbacks) => {
    this.callbacks = callbacks;
    if (this.readyGate) await this.readyGate.promise;
    return { close: () => { this.closed++; if (this.callbacks === callbacks) this.callbacks = undefined; } };
  };
  readSession = async (): Promise<SessionRecord> => ({
    sessionKey, rowVersion: 1, raw: { clearedThroughSeq: 7 }, activity: 'idle',
  });
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
  sendHuman = async (submission: HumanSubmission): Promise<HumanSendResult> => {
    this.submissions.push(submission);
    return this.nextSend ? this.nextSend(submission) : { outcome: 'accepted' };
  };
  emit(record: ConversationRecord) { this.callbacks?.onNotice({ operation: 'upsert', record }); }
  reset() {
    this.callbacks?.onNotice({ operation: 'session', session: {
      sessionKey, rowVersion: 2, raw: { clearedThroughSeq: 100 }, activity: 'reset',
    } });
  }
  doubt() { this.callbacks?.onDoubt('connection lost'); }
}

async function settle() { await vi.waitFor(() => {}, { timeout: 50 }); }

describe('framework-independent runtime', () => {
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
      if (first) { first = false; transport.doubt(); }
    };
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('stale'));
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'), { timeout: 1000 });
    expect(transport.readTailCalls).toBe(2);
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
