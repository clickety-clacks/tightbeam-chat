import type {
  CanonicalMessage, CanonicalTransition, CanonicalTurn, ChangeCallbacks, ChangeConnection,
  ChatTransport, ConversationPage, ConversationRecord, HostIdentity,
  HumanSendResult, HumanSubmission, SessionRecord, TargetObservation,
} from '../src/types';

const sessionKey = 'fixture-session';
const pageSize = 20;
const identity: HostIdentity = { principalKey: 'fixture-person', deviceId: 'fixture-device' };
export const fixtureTarget: TargetObservation = {
  identity: 'fixture:local-memory-v1',
  capabilities: {
    newestTail: true, stableOlderCursor: true, retainedHistoryAcrossResets: true,
    orderedTransitions: true, snapshotCoverage: true, versionedNotices: true,
    humanSendDedupe: true, authoritativeTurnProvenance: true,
  },
};

function message(seq: number, content: string, role = 'assistant', extra: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    kind: 'message', id: `m_${seq}`, sessionKey, seq, rowVersion: 1,
    role, sender: role === 'user' ? 'You' : 'Fixture assistant', content,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString(),
    raw: { fixture: true, sequence: seq }, ...extra,
  };
}

function transition(seq: number, kind: 'harness' | 'model', from: string, to: string): CanonicalTransition {
  return { kind: 'transition', id: `t_${seq}`, sessionKey, seq, rowVersion: 1,
    transition: kind, from, to, raw: { fixture: true, storedTransitionId: `t_${seq}` } };
}

export class LocalFixtureTransport implements ChatTransport {
  private rows: ConversationRecord[] = Array.from({ length: 124 }, (_, index) =>
    message(index + 1, `Fixture message ${index + 1}. Older human history stays available across agent resets.`,
      index % 5 === 0 ? 'user' : 'assistant',
      index === 112 ? { messageType: 'future-kind', attachments: [{ name: 'fixture.txt' }] } : {}));
  private callbacks = new Set<ChangeCallbacks>();
  private version = 1;
  private nextSeq = 125;
  private postOutcomes = new Map<string, HumanSendResult>();
  private turns = new Map<number, CanonicalTurn>();

  constructor() {
    let latestHuman: CanonicalMessage | undefined;
    this.rows = this.rows.map((record) => {
      if (record.kind !== 'message') return record;
      if (record.role === 'user') {
        latestHuman = { ...record, turnSeq: record.seq };
        this.turns.set(record.seq, { seq: record.seq, sessionKey, status: 'completed',
          messageId: record.id, origin: 'user:fixture-person', raw: { fixture: true } });
        return latestHuman;
      }
      if (latestHuman) {
        const turnSeq = latestHuman.seq;
        latestHuman = undefined;
        return { ...record, turnSeq };
      }
      this.turns.set(record.seq, { seq: record.seq, sessionKey, status: 'completed',
        messageId: record.id, origin: 'process:fixture', raw: { fixture: true } });
      return { ...record, turnSeq: record.seq };
    });
    this.rows.push(transition(31, 'harness', 'Claude', 'Codex'));
    this.rows.push(transition(72, 'model', 'model-A', 'model-B'));
    this.rows.push(transition(103, 'harness', 'Codex', 'Claude'));
    this.rows.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  }

  currentIdentity = () => identity;
  inspectTarget = async () => fixtureTarget;
  openChanges = async (selected: string, callbacks: ChangeCallbacks, signal: AbortSignal): Promise<ChangeConnection> => {
    if (selected !== sessionKey) throw new Error('Fixture permits only fixture-session.');
    if (signal.aborted) throw new Error('Aborted');
    this.callbacks.add(callbacks);
    const close = () => this.callbacks.delete(callbacks);
    signal.addEventListener('abort', close, { once: true });
    return { close };
  };
  readSession = async (selected: string): Promise<SessionRecord> => ({
    sessionKey: selected, rowVersion: this.version, displayName: 'Example agent',
    model: 'example model', harness: 'example harness', activity: 'Fixture idle',
    raw: { fixture: true, clearedThroughSeq: 90 },
  });
  private page(records: ConversationRecord[]): ConversationPage {
    return {
      records, oldestCursor: records.length ? `before:${records[0].id}` : null,
      hasOlder: records.length ? this.rows.some((row) => row.seq < records[0].seq ||
        (row.seq === records[0].seq && row.id < records[0].id)) : false,
      coverage: { fixtureVersion: this.version },
    };
  }
  readTail = async (): Promise<ConversationPage> => this.page(this.rows.slice(-pageSize));
  readOlder = async (_selected: string, before: string): Promise<ConversationPage> => {
    const id = before.startsWith('before:') ? before.slice(7) : '';
    const index = this.rows.findIndex((row) => row.id === id);
    if (index < 0) throw new Error('Invalid fixture cursor.');
    return this.page(this.rows.slice(Math.max(0, index - pageSize), index));
  };
  proveCoverage = () => true; // Fixture-only synchronous in-memory store, not backend proof.
  sendHuman = async (submission: HumanSubmission): Promise<HumanSendResult> => {
    const existing = this.postOutcomes.get(submission.clientMessageId);
    if (existing) return existing;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result: HumanSendResult = { outcome: 'accepted' };
    this.postOutcomes.set(submission.clientMessageId, result);
    const row = message(this.nextSeq++, submission.content, 'user', {
      clientMessageId: submission.clientMessageId, deviceId: submission.deviceId, turnSeq: this.nextSeq - 1,
    });
    this.turns.set(row.turnSeq!, { seq: row.turnSeq!, sessionKey, status: 'completed',
      messageId: row.id, origin: 'user:fixture-person', raw: { fixture: true } });
    this.rows.push(row);
    this.emit({ operation: 'upsert', record: row });
    return result;
  };

  private emit(notice: Parameters<ChangeCallbacks['onNotice']>[0]) {
    for (const callback of this.callbacks) callback.onNotice(notice);
  }
  appendAssistant() {
    const seq = this.nextSeq++;
    const row = message(seq, 'A new fixture response arrived.', 'assistant', { turnSeq: seq });
    this.turns.set(seq, { seq, sessionKey, status: 'completed', messageId: row.id,
      origin: 'process:fixture', raw: { fixture: true } });
    this.rows.push(row);
    this.emit({ operation: 'upsert', record: row });
  }
  resetAgentContext() {
    this.version++;
    this.emit({ operation: 'session', session: {
      sessionKey, rowVersion: this.version, displayName: 'Example agent', model: 'example model',
      harness: 'example harness', activity: 'Fixture context reset',
      raw: { fixture: true, clearedThroughSeq: this.nextSeq - 1 },
    } });
  }
  disconnect() {
    for (const callback of [...this.callbacks]) callback.onDoubt('Fixture connection interrupted.');
  }
}
