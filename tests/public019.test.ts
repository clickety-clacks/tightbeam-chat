import { describe, expect, it, vi } from 'vitest';
import { createTightbeamAdapter } from '../src/runtime';
import {
  PUBLIC_019_BUILD, PUBLIC_019_GATEWAY_SHA, PUBLIC_019_BUILD_2844, PUBLIC_019_GATEWAY_SHA_2844,
  PUBLIC_019_SOURCE_2857, PUBLIC_019_BUILD_2857, PUBLIC_019_GATEWAY_SHA_2857,
  PUBLIC_019_SOURCE_2887, PUBLIC_019_BUILD_2887, PUBLIC_019_GATEWAY_SHA_2887,
  PUBLIC_019_SOURCE_2908, PUBLIC_019_BUILD_2908, PUBLIC_019_GATEWAY_SHA_2908,
  createPublic019Transport, decodePublic019Message, decodeToolCall,
  decodePublic019Notice, type Public019Channel, type Public019Host,
} from '../src/public019';
import { AuthorizationError, UnsupportedTargetError } from '../src/types';

const sessionKey = 's-public';
const identity = { principalKey: 'person-1', deviceId: 'device-1' };
const version = { server: 'tightbeam', version: '0.1.9', build: PUBLIC_019_BUILD_2887, sha: PUBLIC_019_GATEWAY_SHA_2887, protocolVersion: 1 };
const legacy2476 = { ...version, build: PUBLIC_019_BUILD, sha: PUBLIC_019_GATEWAY_SHA };
const assessed2844 = { ...version, build: PUBLIC_019_BUILD_2844, sha: PUBLIC_019_GATEWAY_SHA_2844 };
const identified2857 = { ...version, build: PUBLIC_019_BUILD_2857, sha: PUBLIC_019_GATEWAY_SHA_2857 };
const identified2887 = { ...version, build: PUBLIC_019_BUILD_2887, sha: PUBLIC_019_GATEWAY_SHA_2887 };
const identified2908 = { ...version, build: PUBLIC_019_BUILD_2908, sha: PUBLIC_019_GATEWAY_SHA_2908 };
const item = {
  id: 'm_1', seq: 9, sessionKey, role: 'user', content: 'hello', replyToMessageId: 'parent-1', at: Date.parse('2026-10-12T00:00:00Z'),
  sender: 'person-1', deviceId: 'device-1', clientMessageId: 'c_1', attachments: [],
  rowVersion: 9, model: 'source-supplied-model', unknownMetadata: { preserved: true },
};
const session = { sessionKey, rowVersion: 4, displayName: 'Example agent', model: 'model-x', harness: 'codex', state: 'active', clearedThroughSeq: 7 };

class Channel implements Public019Channel {
  sent: Readonly<Record<string, unknown>>[] = [];
  closed = false;
  autoReady = false;
  get listening() { return this.frame !== undefined; }
  private frame?: (value: unknown) => void;
  private disconnected?: () => void;
  send(frame: Readonly<Record<string, unknown>>) {
    this.sent.push(frame);
    if (this.autoReady) queueMicrotask(() => this.emit({ type: 'subscription_ready', subscriptionId: frame.subscriptionId }));
  }
  listen(onFrame: (frame: unknown) => void, onClose: () => void) {
    this.frame = onFrame;
    this.disconnected = onClose;
    return () => { this.frame = undefined; this.disconnected = undefined; };
  }
  close() { this.closed = true; }
  emit(value: unknown) { this.frame?.(value); }
  disconnect() { this.disconnected?.(); }
}

function setup(heartbeatTimeoutMs?: number, observedVersion = version, configuredVersion = observedVersion,
  historyItems: unknown[] = [item]) {
  const changes = new Channel();
  const human = new Channel();
  const paths: string[] = [];
  const host: Public019Host = {
    currentIdentity: () => identity,
    fetch: async (path) => {
      paths.push(path);
      if (path.includes('/tool-calls?')) return new Response(JSON.stringify({
        schemaVersion: 1, resource: 'tool calls', items: [], page: { hasMoreBefore: false },
      }), { status: 200 });
      const body = path.endsWith('/version') ? observedVersion : path.includes('/messages?')
        ? { schemaVersion: 1, resource: 'transcript messages', items: historyItems,
          page: { oldestCursor: 'older-cursor', hasMoreBefore: true } }
        : { schemaVersion: 1, resource: 'sessions', item: session };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    openAuthenticatedChanges: async () => {
      if (!changes.listening) return changes;
      const tools = new Channel();
      tools.autoReady = true;
      return tools;
    },
    openAuthenticatedHuman: async () => human,
  };
  const { transport, profile } = createPublic019Transport({
    baseUrl: 'https://host.example', build: configuredVersion.build, sha: configuredVersion.sha, host,
    responseTimeoutMs: 1000, heartbeatTimeoutMs,
  });
  return { transport, profile, paths, changes, human, host };
}

describe('public 0.1.9 released wire mapping and capability gates', () => {
  it('consumes selected-session turn lifecycle payloads without turn queries or history refreshes', async () => {
    const humanRow = { ...item, sender: 'user:person-1', turnSeq: 12 };
    const candidate = setup(undefined, version, version, [humanRow]);
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent).toHaveLength(1));
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    let sequence = 0;
    const turnEvent = (status: string, extra: Record<string, unknown> = {}) => candidate.changes.emit({
      type: 'change', schemaVersion: 2, subscriptionId: `chat:${sessionKey}`, seq: ++sequence,
      class: status === 'queued' ? 'turn.queued' : status === 'running' ? 'turn.started' : 'turn.ended',
      resource: 'turns', op: 'upsert', refs: { sessionKey, turnSeq: 12 },
      payload: { seq: 12, rowVersion: sequence, sessionKey, status, messageId: humanRow.id,
        origin: 'user:person-1', triggerSource: 'mike', ...extra },
    });
    turnEvent('running');
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(candidate.paths.some(path => path.includes('/tool-calls?'))).toBe(true));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    expect(runtime.getSnapshot().toolCallsEnabled).toBe(true);
    expect(runtime.getSnapshot().principalKey).toBe('person-1');
    expect(runtime.getSnapshot().activeTurn).toMatchObject({ sourceKind: 'human', turn: { seq: 12, status: 'running' } });
    const history = runtime.getSnapshot().records;
    const paths = [...candidate.paths];
    turnEvent('completed');
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    turnEvent('queued', { seq: 13, messageId: null });
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    turnEvent('running', { seq: 13, messageId: null, triggerSource: 'batch', batchMemberCount: 2 });
    expect(runtime.getSnapshot().activeTurn).toMatchObject({ batchCount: 2, turn: { seq: 13 } });
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().records).toBe(history);
    expect(candidate.paths).toEqual(paths);
    expect(candidate.paths.some(path => path.includes('/turns'))).toBe(false);
    candidate.changes.disconnect();
    expect(runtime.getSnapshot().status).toBe('stale');
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    runtime.dispose();
  });

  it('identifies Gateway 0.1.9+2857 exactly while keeping unqualified capabilities disabled', async () => {
    expect(PUBLIC_019_SOURCE_2857).toBe('45580d9ebac42218bbf35e1ce9694d536b378d76');
    const candidate = setup(undefined, identified2857);
    expect(candidate.profile.identity).toBe('0.1.9+2857/45580d9e');
    expect(candidate.profile.capabilities).toEqual({
      newestTail: false, stableOlderCursor: false, retainedHistoryAcrossResets: false,
      orderedTransitions: false, snapshotCoverage: false, versionedNotices: false,
      humanSendDedupe: false, authoritativeTurnProvenance: false,
    });
    expect(await candidate.transport.inspectTarget(new AbortController().signal)).toEqual({
      identity: candidate.profile.identity, capabilities: candidate.profile.capabilities,
    });

    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('unsupported'));
    expect(candidate.changes.sent).toHaveLength(0);
    expect(candidate.human.sent).toHaveLength(0);
    expect(runtime.send('must not post')).toBeNull();
    runtime.dispose();
  });

  it('qualifies ordered 2887 transitions and opens only after its exact profile passes the capability gate', async () => {
    expect(PUBLIC_019_SOURCE_2887).toBe('0198c918dbd86861297aca19e7c3dc583943bbac');
    const earlierTransition = { ...item, id: 'marker_before', seq: 8, rowVersion: 8,
      messageType: 'marker', marker: { kind: 'session-restart', from: 'old', to: 'new' } };
    const laterTransition = { ...item, id: 'marker_after', seq: 10, rowVersion: 10,
      messageType: 'marker', marker: { kind: 'harness-switch', from: 'old-harness', to: 'new-harness' } };
    const candidate = setup(undefined, identified2887, identified2887,
      [laterTransition, item, earlierTransition]);
    expect(candidate.profile.identity).toBe('0.1.9+2887/0198c918');
    expect(candidate.profile.capabilities).toEqual({
      newestTail: true, stableOlderCursor: true, retainedHistoryAcrossResets: true,
      orderedTransitions: true, snapshotCoverage: true, versionedNotices: true,
      humanSendDedupe: true, authoritativeTurnProvenance: true,
    });
    expect(await candidate.transport.inspectTarget(new AbortController().signal)).toEqual({
      identity: candidate.profile.identity, capabilities: candidate.profile.capabilities,
    });

    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent).toEqual([{
      type: 'subscribe', protocolVersion: 2, subscriptionId: `chat:${sessionKey}`,
      filters: { sessionKey, classes: ['message.created', 'session.', 'turn.started', 'turn.ended'] },
    }]));
    expect(candidate.paths).toEqual(['https://host.example/version']);
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(candidate.paths.some(path => path.includes('/tool-calls?'))).toBe(true));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    expect(runtime.getSnapshot().toolCallsEnabled).toBe(true);
    expect(candidate.paths).toEqual([
      'https://host.example/version',
      'https://host.example/api/sessions/s-public',
      'https://host.example/api/sessions/s-public/messages?limit=50&tail=true',
      'https://host.example/api/sessions/s-public/tool-calls?limit=50&afterMessageSeqFromInclusive=8',
    ]);
    expect(runtime.getSnapshot().records.map((record) => record.id))
      .toEqual(['marker_before', 'm_1', 'marker_after']);
    expect(runtime.getSnapshot().records.map((record) => record.kind))
      .toEqual(['transition', 'message', 'transition']);
    expect(candidate.changes.sent).toHaveLength(1);
    expect(candidate.human.sent).toHaveLength(0);
    runtime.dispose();
  });

  it('checks Gateway identity once per transport while true recovery rereads canonical session history', async () => {
    const candidate = setup(undefined, identified2887);
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent).toHaveLength(1));
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(candidate.paths.filter(path => path.includes('/tool-calls?'))).toHaveLength(1));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    expect(candidate.paths.filter((path) => path.endsWith('/version'))).toHaveLength(1);
    expect(candidate.paths.filter((path) => path.includes('/messages?'))).toHaveLength(1);

    const recovery = runtime.rebuild({ restart: true });
    await vi.waitFor(() => expect(candidate.changes.sent).toHaveLength(2));
    expect(candidate.paths.filter((path) => path.endsWith('/version'))).toHaveLength(1);
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await recovery;
    await vi.waitFor(() => expect(candidate.paths.filter(path => path.includes('/tool-calls?'))).toHaveLength(2));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));

    expect(runtime.getSnapshot().status).toBe('ready');
    expect(candidate.paths.filter((path) => path.endsWith('/version'))).toHaveLength(1);
    expect(candidate.paths.filter((path) => path.endsWith('/api/sessions/s-public'))).toHaveLength(2);
    expect(candidate.paths.filter((path) => path.includes('/messages?'))).toHaveLength(2);
    expect(candidate.paths.filter((path) => path.includes('/tool-calls?'))).toHaveLength(2);
    runtime.dispose();
  });

  it('carries the reviewed 2887 profile floor through 2908 while negotiating Firehose protocol 2 separately', async () => {
    expect(PUBLIC_019_SOURCE_2908).toBe('8433d22fdf86027d62a34e9923501775225813ad');
    const candidate = setup(undefined, identified2908, identified2908);
    expect(candidate.profile.identity).toBe('0.1.9+2908/8433d22f');
    expect(candidate.profile.capabilities).toEqual({
      newestTail: true, stableOlderCursor: true, retainedHistoryAcrossResets: true,
      orderedTransitions: true, snapshotCoverage: true, versionedNotices: true,
      humanSendDedupe: true, authoritativeTurnProvenance: true,
    });
    expect(await candidate.transport.inspectTarget(new AbortController().signal)).toEqual({
      identity: candidate.profile.identity, capabilities: candidate.profile.capabilities,
    });

    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent).toEqual([{
      type: 'subscribe', protocolVersion: 2, subscriptionId: `chat:${sessionKey}`,
      filters: { sessionKey, classes: ['message.created', 'session.', 'turn.started', 'turn.ended'] },
    }]));
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(candidate.paths.some(path => path.includes('/tool-calls?'))).toBe(true));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    expect(candidate.paths).toEqual([
      'https://host.example/version',
      'https://host.example/api/sessions/s-public',
      'https://host.example/api/sessions/s-public/messages?limit=50&tail=true',
      'https://host.example/api/sessions/s-public/tool-calls?limit=50&afterMessageSeqFromInclusive=9',
    ]);
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m_1']);
    expect(candidate.human.sent).toHaveLength(0);
    runtime.dispose();
  });

  it('does not call turn or trigger detail routes while loading a transcript', async () => {
    const messages = [
      { ...item, id: 'human-message', seq: 9, role: 'user', sender: 'person-1', messageType: 'chat',
        clientMessageId: 'client-human', deviceId: 'device-1', turnSeq: 12, content: 'Can you help?' },
      { ...item, id: 'agent-message', seq: 10, role: 'assistant', messageType: 'assistant',
        turnSeq: 12, content: 'Here is the answer.' },
      { ...item, id: 'system-batch', seq: 11, role: 'user', sender: 'process:notifications',
        messageType: 'substrate', content: '[batched notices: 1]' },
      { ...item, id: 'system-marker', seq: 12, role: 'assistant', sender: 'process:notifications',
        messageType: 'substrate', content: 'A system event marker' },
    ];
    const candidate = setup(undefined, identified2887, identified2887, messages);
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);

    await vi.waitFor(() => expect(candidate.changes.sent).toEqual([{
      type: 'subscribe', protocolVersion: 2, subscriptionId: `chat:${sessionKey}`,
      filters: { sessionKey, classes: ['message.created', 'session.', 'turn.started', 'turn.ended'] },
    }]));
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(candidate.paths.some(path => path.includes('/tool-calls?'))).toBe(true));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));

    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual([
      'human-message', 'agent-message', 'system-batch', 'system-marker',
    ]);
    expect(runtime.getSnapshot().provenanceAvailable).toBe(false);
    expect(runtime.getSnapshot().provenance).toEqual([]);
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    expect(candidate.paths).toEqual([
      'https://host.example/version',
      'https://host.example/api/sessions/s-public',
      'https://host.example/api/sessions/s-public/messages?limit=50&tail=true',
      'https://host.example/api/sessions/s-public/tool-calls?limit=50&afterMessageSeqFromInclusive=9',
    ]);
    expect(candidate.changes.closed).toBe(false);

    const clientMessageId = runtime.send('Still available');
    expect(clientMessageId).toBeTruthy();
    await vi.waitFor(() => expect(candidate.human.sent).toHaveLength(1));
    candidate.human.emit({ type: 'ack', id: clientMessageId });
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0]?.status).toBe('accepted'));
    expect(runtime.getSnapshot().status).toBe('ready');
    runtime.dispose();
  });

  it('fails closed when the Gateway API protocol version differs from the elected line', async () => {
    const incompatibleProtocol = { ...identified2908, protocolVersion: 2 };
    const candidate = setup(undefined, incompatibleProtocol, identified2908);
    expect(await candidate.transport.inspectTarget(new AbortController().signal)).toEqual({
      identity: candidate.profile.identity,
      capabilities: {
        newestTail: false, stableOlderCursor: false, retainedHistoryAcrossResets: false,
        orderedTransitions: false, snapshotCoverage: false, versionedNotices: false,
        humanSendDedupe: false, authoritativeTurnProvenance: false,
      },
    });

    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('unsupported'));
    expect(candidate.changes.sent).toHaveLength(0);
    expect(candidate.human.sent).toHaveLength(0);
    runtime.dispose();
  });

  it('uses 2887 subscribe-before-REST overlap for snapshot coverage, without a watermark claim', async () => {
    const candidate = setup(undefined, identified2887);
    const signal = new AbortController().signal;
    expect(candidate.profile.capabilities.snapshotCoverage).toBe(true);

    const pending = candidate.transport.openChanges(sessionKey, {
      onNotice: () => {}, onDoubt: () => {},
    }, signal);
    await vi.waitFor(() => expect(candidate.changes.sent).toEqual([{
      type: 'subscribe', protocolVersion: 2, subscriptionId: `chat:${sessionKey}`,
      filters: { sessionKey, classes: ['message.created', 'session.', 'turn.started', 'turn.ended'] },
    }]));
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    const connection = await pending;

    const page = await candidate.transport.readTail(sessionKey, signal);
    expect(candidate.paths).toEqual([
      'https://host.example/api/sessions/s-public/messages?limit=50&tail=true',
    ]);
    expect(candidate.transport.proveCoverage({ sessionKey, rowVersion: 4, displayName: 'Fixture agent', raw: {} }, page, [])).toBe(true);
    expect(candidate.transport.proveCoverage({ sessionKey, rowVersion: 4, displayName: 'Fixture agent', raw: {} }, page, [
      { operation: 'unknown', sessionKey, resource: 'future.event' },
    ])).toBe(true);

    connection.close();
    expect(candidate.transport.proveCoverage({ sessionKey, rowVersion: 4, displayName: 'Fixture agent', raw: {} }, page, [])).toBe(false);
  });

  it('refuses pre-floor releases while supporting later identities on the elected line', async () => {
    for (const observed of [legacy2476, assessed2844, identified2857,
      { ...assessed2844, sha: version.sha }]) {
      const other = setup(undefined, observed);
      const runtime = createTightbeamAdapter(other.transport, other.profile).open(sessionKey);
      await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('unsupported'));
      expect(runtime.getSnapshot().statusDetail).toContain('capability');
      expect(other.changes.sent).toHaveLength(0);
      expect(runtime.send('must not post')).toBeNull();
      expect(other.human.sent).toHaveLength(0);
      runtime.dispose();
    }

    for (const assessed of [version, identified2908, { ...identified2887, sha: '00000000' }]) {
      const supported = setup(undefined, assessed);
      const ready = createTightbeamAdapter(supported.transport, supported.profile).open(sessionKey);
      await vi.waitFor(() => expect(supported.changes.sent).toHaveLength(1));
      supported.changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
      await vi.waitFor(() => expect(ready.getSnapshot().status).toBe('ready'));
      expect(ready.getSnapshot().records.map((record) => record.id)).toEqual(['m_1']);
      ready.dispose();
    }
  });

  it('refuses an observed target that differs from its assessed configuration before subscribing', async () => {
    for (const observed of [version, { ...assessed2844, sha: '00000000' }]) {
      const mismatched = setup(undefined, observed, assessed2844);
      const runtime = createTightbeamAdapter(mismatched.transport, mismatched.profile).open(sessionKey);
      await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('unsupported'));
      expect(runtime.getSnapshot().statusDetail).toContain('identity');
      expect(mismatched.changes.sent).toHaveLength(0);
      expect(runtime.send('must not post')).toBeNull();
      runtime.dispose();
    }

    const later2887 = setup(undefined, { ...identified2887, sha: '00000000' }, { ...identified2887, sha: '00000000' });
    expect(await later2887.transport.inspectTarget(new AbortController().signal)).toEqual({
      identity: '0.1.9+2887/00000000',
      capabilities: later2887.profile.capabilities,
    });
    expect(later2887.profile.capabilities.authoritativeTurnProvenance).toBe(true);
  });

  it('refreshes activity after a committed turn arrives during the history read', async () => {
    let releaseTail!: () => void;
    const tailGate = new Promise<void>((resolve) => { releaseTail = resolve; });
    const changes = new Channel();
    const human = new Channel();
    let sessionReads = 0;
    let tailStarted = false;
    const host: Public019Host = {
      currentIdentity: () => identity,
      fetch: async (path) => {
        let body: unknown;
        if (path.endsWith('/version')) body = version;
        else if (path.includes('/messages?')) {
          tailStarted = true;
          await tailGate;
          body = { schemaVersion: 1, resource: 'transcript messages', items: [item],
            page: { oldestCursor: null, hasMoreBefore: false } };
        } else if (path.includes('/tool-calls?')) {
          body = { schemaVersion: 1, resource: 'tool calls', items: [], page: { hasMoreBefore: false } };
        } else {
          sessionReads++;
          body = { schemaVersion: 1, resource: 'sessions', item: {
            ...session, rowVersion: sessionReads === 1 ? 4 : 5,
            mechanicalStatus: sessionReads === 1 ? 'idle' : 'running',
          } };
        }
        return new Response(JSON.stringify(body), { status: 200 });
      },
      openAuthenticatedChanges: async () => {
      if (!changes.listening) return changes;
      const tools = new Channel();
      tools.autoReady = true;
      return tools;
    },
      openAuthenticatedHuman: async () => human,
    };
    const { transport, profile } = createPublic019Transport({ baseUrl: 'https://host.example',
      build: version.build, sha: version.sha, host });
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(changes.sent).toHaveLength(1));
    changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
    await vi.waitFor(() => expect(tailStarted).toBe(true));
    changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 1,
      class: 'turn.started', resource: 'turns', op: 'upsert', refs: { sessionKey, turnSeq: 10 },
      payload: { seq: 10, sessionKey, status: 'running', messageId: item.id, origin: 'user:person-1', triggerSource: 'mike' } });
    changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 2,
      class: 'session.updated', resource: 'sessions', op: 'upsert', refs: { sessionKey },
      payload: { ...session, rowVersion: 5, mechanicalStatus: 'running' } });
    releaseTail();
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(sessionReads).toBe(1);
    expect(runtime.getSnapshot().session?.activity).toBe('running');
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m_1']);
    expect(runtime.send('one human message')).toBeTruthy();
    await vi.waitFor(() => expect(human.sent).toHaveLength(1));
    human.emit({ type: 'ack', id: human.sent[0].id });
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0].status).toBe('accepted'));
    expect(human.sent).toHaveLength(1);
    runtime.dispose();
  });

  it('keeps history and human acknowledgement live across ordinary observational notices', async () => {
    const base = setup();
    let releaseTail!: () => void;
    const tailGate = new Promise<void>((resolve) => { releaseTail = resolve; });
    let readingTail = false;
    const transport = { ...base.transport, readTail: async (...args: Parameters<typeof base.transport.readTail>) => {
      readingTail = true;
      await tailGate;
      return base.transport.readTail(...args);
    } };
    const accepted = (seq: number) => ({
      type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq,
      class: 'verb.accepted', op: 'observe', refs: { sessionKey }, payload: { verb: 'post' },
    });
    const runtime = createTightbeamAdapter(transport, base.profile).open(sessionKey);
    await vi.waitFor(() => expect(base.changes.sent).toHaveLength(1));
    base.changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
    await vi.waitFor(() => expect(readingTail).toBe(true));
    base.changes.emit(accepted(1));
    releaseTail();
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m_1']);
    expect(runtime.getSnapshot().session?.sessionKey).toBe(sessionKey);
    const id = runtime.send('one exact human post');
    expect(id).toBeTruthy();
    await vi.waitFor(() => expect(base.human.sent).toHaveLength(1));
    expect(runtime.getSnapshot().sends[0]).toMatchObject({ clientMessageId: id, status: 'pending' });
    base.changes.emit(accepted(2));
    base.changes.emit({ type: 'heartbeat', seq: 2 });
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().sends[0].status).toBe('pending');
    expect(base.changes.closed).toBe(false);
    base.human.emit({ type: 'ack', id });
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0].status).toBe('accepted'));
    expect(base.human.sent).toHaveLength(1);
    runtime.dispose();
  });

  it('keeps history ready when unknown and wake observations arrive during the tail read', async () => {
    const historyItems: unknown[] = [item];
    const base = setup(undefined, version, version, historyItems);
    let releaseTail!: () => void;
    const tailGate = new Promise<void>((resolve) => { releaseTail = resolve; });
    let readingTail = false;
    let tailReads = 0;
    const transport = { ...base.transport, readTail: async (...args: Parameters<typeof base.transport.readTail>) => {
      const page = await base.transport.readTail(...args);
      tailReads++;
      if (tailReads === 1) {
        readingTail = true;
        await tailGate;
      }
      return page;
    } };
    const runtime = createTightbeamAdapter(transport, base.profile).open(sessionKey);
    await vi.waitFor(() => expect(base.changes.sent).toHaveLength(1));
    base.changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
    await vi.waitFor(() => expect(readingTail).toBe(true));
    base.changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 1,
      class: 'unrecognized.state', resource: 'turns', op: 'upsert', refs: { sessionKey }, payload: {} });
    const live = { ...item, id: 'm_2', seq: 10, rowVersion: 10, content: 'Received during the tail read' };
    historyItems.push(live);
    base.changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 2,
      class: 'wake.fired', resource: 'wakes', op: 'upsert', refs: { sessionKey }, payload: {} });
    base.changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 3,
      class: 'message.created', resource: 'messages', op: 'upsert', refs: { sessionKey, messageId: live.id }, payload: live });
    releaseTail();
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(tailReads).toBe(1);
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m_1', 'm_2']);
    expect(runtime.getSnapshot().records[1]).toMatchObject({ kind: 'message', content: 'Received during the tail read' });
    expect(runtime.getSnapshot().session?.sessionKey).toBe(sessionKey);
    expect(base.changes.sent).toHaveLength(1);
    runtime.dispose();
  });

  it('accounts for unknown selected-session events without rebuilding and keeps later events live', async () => {
    const historyItems: unknown[] = [item];
    const base = setup(undefined, version, version, historyItems);
    const runtime = createTightbeamAdapter(base.transport, base.profile).open(sessionKey);
    await vi.waitFor(() => expect(base.changes.sent).toHaveLength(1));
    base.changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));

    const live = { ...item, id: 'm_2', seq: 10, rowVersion: 10, content: 'Visible on the same subscription' };
    base.changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 1,
      class: 'attest.filed', resource: 'attests', op: 'upsert', refs: { sessionKey }, payload: {} });
    base.changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 2,
      class: 'message.created', resource: 'messages', op: 'upsert', refs: { sessionKey, messageId: live.id }, payload: live });
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(base.paths.filter((path) => path.includes('/messages?'))).toHaveLength(1);
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m_1', 'm_2']);
    expect(runtime.getSnapshot().records[1]).toMatchObject({ kind: 'message', content: 'Visible on the same subscription' });
    expect(base.changes.sent).toHaveLength(1);
    runtime.dispose();
  });

  it('pins the exact observed build, retains raw metadata, and reads session detail', async () => {
    const { transport, profile, paths } = setup();
    const signal = new AbortController().signal;
    expect(await transport.inspectTarget(signal)).toEqual({ identity: profile.identity, capabilities: profile.capabilities });
    expect(await transport.readSession(sessionKey, signal)).toMatchObject({ sessionKey, rowVersion: 4, raw: { clearedThroughSeq: 7 } });
    expect(paths).toEqual(['https://host.example/version', 'https://host.example/api/sessions/s-public']);
    expect(decodePublic019Message(item, sessionKey)).toMatchObject({
      id: 'm_1', seq: 9, createdAt: '2026-10-12T00:00:00.000Z',
      clientMessageId: 'c_1', replyToMessageId: 'parent-1', raw: { at: item.at, unknownMetadata: { preserved: true } },
    });
    expect(() => decodePublic019Message({ ...item, at: '2026-10-12T00:00:00Z' }, sessionKey))
      .toThrow(UnsupportedTargetError);
  });

  it('reads bounded tail and opaque before pages and gates coverage on an active subscription', async () => {
    const { transport, profile, changes, paths } = setup();
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(changes.sent).toHaveLength(1));
    changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(runtime.getSnapshot().records).toHaveLength(1);
    const page = await transport.readOlder(sessionKey, 'opaque+/=', new AbortController().signal);
    expect(page.oldestCursor).toBe('older-cursor');
    expect(paths.some((path) => path.endsWith('limit=50&tail=true'))).toBe(true);
    expect(paths.some((path) => path.endsWith('before=opaque%2B%2F%3D'))).toBe(true);
    expect(transport.proveCoverage({ sessionKey, rowVersion: 4, displayName: 'Fixture agent', raw: {} }, page, [])).toBe(true);
    runtime.dispose();
    expect(transport.proveCoverage({ sessionKey, rowVersion: 4, displayName: 'Fixture agent', raw: {} }, page, [])).toBe(false);
  });

  it('keeps failed-park recovery lifecycle-only and decodes the projected transcript markers', () => {
    for (const [kind, transition] of [['harness-switch', 'harness'], ['model-retune', 'model'], ['session-restart', 'restart']]) {
      expect(decodePublic019Message({ ...item, messageType: 'marker',
        marker: { kind, from: 'old', to: 'new' } }, sessionKey)).toMatchObject({ kind: 'transition', transition, from: 'old', to: 'new' });
    }
    expect(() => decodePublic019Message({ ...item, messageType: 'marker' }, sessionKey)).toThrow(UnsupportedTargetError);
    expect(decodePublic019Message({ ...item, messageType: 'marker',
      marker: { kind: 'future-boundary', from: 'old', to: 'new' } }, sessionKey))
      .toMatchObject({ kind: 'transition', transition: 'unknown', content: item.content });
  });

  it('decodes protocol-2 selected-session notices and refuses fabricated marker data', () => {
    const notice = {
      type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 1,
      class: 'message.created', resource: 'messages', op: 'upsert',
      refs: { sessionKey, messageId: 'm_1' }, payload: item,
    };
    expect(decodePublic019Notice(notice, sessionKey)).toMatchObject({ operation: 'upsert',
      record: { id: 'm_1', createdAt: '2026-10-12T00:00:00.000Z', raw: { at: item.at } } });
    expect(() => decodePublic019Notice({ ...notice, payload: { ...item, messageType: 'marker' } }, sessionKey))
      .toThrow(UnsupportedTargetError);
    expect(decodePublic019Notice({ ...notice, class: 'turn.started', resource: 'turns', payload: {
      seq: 12, sessionKey, status: 'running', messageId: null, origin: 'process:events', triggerSource: 'batch', batchMemberCount: 2,
    } }, sessionKey)).toMatchObject({ operation: 'turn', turn: {
      seq: 12, sessionKey, status: 'running', messageId: undefined, triggerSource: 'batch', batchMemberCount: 2,
    } });
    expect(decodePublic019Notice({ ...notice, class: 'turn.queued', resource: 'turns' }, sessionKey))
      .toEqual({ operation: 'unknown', sessionKey, resource: 'turn.queued' });
    expect(decodePublic019Notice({ ...notice, class: 'wake.fired', resource: 'wakes' }, sessionKey))
      .toEqual({ operation: 'unknown', sessionKey, resource: 'wake.fired' });
    expect(decodePublic019Notice({ ...notice,
      class: 'lifecycle.harness_failed_park_reconciled', op: 'observe', resource: undefined }, sessionKey))
      .toEqual({ operation: 'unknown', sessionKey, resource: 'lifecycle.harness_failed_park_reconciled' });
    for (const observationalClass of ['verb.accepted', 'verb.denied', 'rail.denied',
      'lifecycle.boot', 'prod.fired']) {
      expect(decodePublic019Notice({ ...notice, class: observationalClass,
        op: 'observe', resource: undefined }, sessionKey))
        .toEqual({ operation: 'unknown', sessionKey, resource: observationalClass });
    }
    expect(decodePublic019Notice({ ...notice, class: 'verb.accepted' }, sessionKey))
      .toEqual({ operation: 'unknown', sessionKey, resource: 'verb.accepted' });
    expect(decodePublic019Notice({ ...notice, class: 'unrecognized.state',
      op: 'observe', resource: undefined }, sessionKey))
      .toEqual({ operation: 'unknown', sessionKey, resource: 'unrecognized.state' });
    expect(decodePublic019Notice({ ...notice, class: 'unrecognized.state', resource: 'turns' }, sessionKey))
      .toEqual({ operation: 'unknown', sessionKey, resource: 'unrecognized.state' });
    expect(() => decodePublic019Notice({ ...notice, refs: { sessionKey: 'other' } }, sessionKey))
      .toThrow(UnsupportedTargetError);
  });

  it('subscribes after host auth, waits for readiness, and fails closed on a sequence gap', async () => {
    const { transport, changes } = setup();
    const notices: string[] = [];
    const doubts: string[] = [];
    const pending = transport.openChanges(sessionKey, {
      onNotice: (notice) => notices.push(notice.operation), onDoubt: (reason) => doubts.push(reason),
    }, new AbortController().signal);
    await vi.waitFor(() => expect(changes.sent).toHaveLength(1));
    expect(changes.sent[0]).toEqual({ type: 'subscribe', protocolVersion: 2,
      subscriptionId: 'chat:s-public', filters: { sessionKey, classes: ['message.created', 'session.', 'turn.started', 'turn.ended'] } });
    changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
    const connection = await pending;
    changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 1,
      class: 'message.created', resource: 'messages', op: 'upsert',
      refs: { sessionKey, messageId: 'm_1' }, payload: item });
    expect(notices).toEqual(['upsert']);
    changes.emit({ type: 'heartbeat', seq: 3 });
    expect(doubts).toHaveLength(1);
    expect(changes.closed).toBe(true);
    connection.close();
    expect(doubts).toHaveLength(1);
  });

  it('detects absent post-readiness heartbeats, renews on healthy frames, and cancels on close', async () => {
    vi.useFakeTimers();
    try {
      const silent = setup(50);
      const silentDoubts: string[] = [];
      const silentPending = silent.transport.openChanges(sessionKey, {
        onNotice: () => {}, onDoubt: (reason) => silentDoubts.push(reason),
      }, new AbortController().signal);
      await Promise.resolve();
      silent.changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
      await silentPending;
      await vi.advanceTimersByTimeAsync(51);
      expect(silentDoubts).toEqual(['Firehose heartbeat or change timed out.']);
      expect(silent.changes.closed).toBe(true);

      const healthy = setup(50);
      const healthyDoubts: string[] = [];
      const healthyPending = healthy.transport.openChanges(sessionKey, {
        onNotice: () => {}, onDoubt: (reason) => healthyDoubts.push(reason),
      }, new AbortController().signal);
      await Promise.resolve();
      healthy.changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
      const connection = await healthyPending;
      await vi.advanceTimersByTimeAsync(40);
      healthy.changes.emit({ type: 'heartbeat', seq: 0 });
      await vi.advanceTimersByTimeAsync(40);
      expect(healthyDoubts).toEqual([]);
      connection.close();
      await vi.advanceTimersByTimeAsync(60);
      expect(healthyDoubts).toEqual([]);
      expect(healthy.changes.closed).toBe(true);

      const disconnected = setup(50);
      const disconnectDoubts: string[] = [];
      const disconnectPending = disconnected.transport.openChanges(sessionKey, {
        onNotice: () => {}, onDoubt: (reason) => disconnectDoubts.push(reason),
      }, new AbortController().signal);
      await Promise.resolve();
      disconnected.changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
      await disconnectPending;
      disconnected.changes.disconnect();
      expect(disconnectDoubts).toEqual(['Firehose disconnected.']);
      expect(disconnected.changes.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(60);
      expect(disconnectDoubts).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('sends human /ws frames with the same client ID and distinguishes ack, refusal and dropped sockets', async () => {
    const accepted = setup();
    const submission = { sessionKey, deviceId: 'device-1', clientMessageId: 'c_1', content: 'hello' };
    const first = accepted.transport.sendHuman(submission, new AbortController().signal);
    await vi.waitFor(() => expect(accepted.human.sent).toHaveLength(1));
    expect(accepted.human.sent[0]).toEqual({ type: 'message', id: 'c_1', sessionKey, content: 'hello' });
    accepted.human.emit({ type: 'ack', id: 'c_other' });
    accepted.human.emit({ type: 'ack', id: 'c_1' });
    expect(await first).toEqual({ outcome: 'accepted' });

    const refused = setup();
    const second = refused.transport.sendHuman(submission, new AbortController().signal);
    await vi.waitFor(() => expect(refused.human.sent).toHaveLength(1));
    refused.human.emit({ type: 'error', code: 'invalid_message', messageId: 'c_1' });
    expect(await second).toEqual({ outcome: 'refused', reason: 'invalid_message' });

    const uncertain = setup();
    const third = uncertain.transport.sendHuman(submission, new AbortController().signal);
    await vi.waitFor(() => expect(uncertain.human.sent).toHaveLength(1));
    uncertain.human.disconnect();
    expect(await third).toMatchObject({ outcome: 'retryable' });
  });

  it('keeps waiting for a human acknowledgement beyond the general response timeout', async () => {
    vi.useFakeTimers();
    try {
      const candidate = setup();
      const submission = { sessionKey, deviceId: 'device-1', clientMessageId: 'c_late', content: 'slow acknowledgement' };
      const pending = candidate.transport.sendHuman(submission, new AbortController().signal);
      await Promise.resolve();
      await Promise.resolve();
      expect(candidate.human.sent).toEqual([{ type: 'message', id: 'c_late', sessionKey, content: 'slow acknowledgement' }]);
      let settled = false;
      void pending.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(16_000);
      expect(settled).toBe(false);
      expect(candidate.human.sent).toHaveLength(1);
      candidate.human.emit({ type: 'ack', id: 'c_late' });
      await expect(pending).resolves.toEqual({ outcome: 'accepted' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a human socket that cannot be opened as unreachable before posting', async () => {
    const candidate = setup();
    candidate.host.openAuthenticatedHuman = async () => { throw new Error('socket unavailable'); };
    await expect(candidate.transport.sendHuman({ sessionKey, deviceId: 'device-1',
      clientMessageId: 'c_offline', content: 'offline message' }, new AbortController().signal))
      .resolves.toEqual({ outcome: 'unreachable', reason: 'Not connected to the server.' });
    expect(candidate.human.sent).toHaveLength(0);
  });

  it('does not post when the host principal changes while opening the human socket', async () => {
    const channel = new Channel();
    let principal = 'person-1';
    const host: Public019Host = {
      currentIdentity: () => ({ principalKey: principal, deviceId: 'device-1' }),
      fetch: async () => new Response(JSON.stringify(version), { status: 200 }),
      openAuthenticatedChanges: async () => new Channel(),
      openAuthenticatedHuman: async () => { principal = 'person-2'; return channel; },
    };
    const { transport } = createPublic019Transport({ baseUrl: 'https://host.example',
      build: version.build, sha: version.sha, host });
    expect(await transport.sendHuman({ sessionKey, deviceId: 'device-1',
      clientMessageId: 'c_1', content: 'hello' }, new AbortController().signal))
      .toMatchObject({ outcome: 'refused' });
    expect(channel.sent).toEqual([]);
    expect(channel.closed).toBe(true);
  });

  it('preserves typed human authentication rejection without posting a frame', async () => {
    const sendSpy = vi.spyOn(Channel.prototype, 'send');
    const rejection = new AuthorizationError('device revoked');
    const host: Public019Host = {
      currentIdentity: () => identity,
      fetch: async () => new Response(JSON.stringify(version), { status: 200 }),
      openAuthenticatedChanges: async () => new Channel(),
      openAuthenticatedHuman: async () => { throw rejection; },
    };
    const { transport } = createPublic019Transport({ baseUrl: 'https://host.example',
      build: version.build, sha: version.sha, host });
    await expect(transport.sendHuman({ sessionKey, deviceId: 'device-1',
      clientMessageId: 'c_1', content: 'hello' }, new AbortController().signal))
      .rejects.toBe(rejection);
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });
});

describe('tool-call contract and transition category', () => {
  const call = { id: 'tc_first', seq: 2, sessionKey, turnSeq: 3, afterMessageSeq: 9,
    harnessToolCallId: 'invocation-1', title: 'Read source', kind: 'read', toolName: 'read_file',
    status: 'in_progress', rawInput: { path: 'source.ts' }, rawOutput: null, content: null,
    truncated: [], startedAt: 1000, endedAt: null, rowVersion: 1 };

  it('decodes live and retained projections including unknown transition text and truncated prefixes', () => {
    const terminal = { ...call, status: 'completed', rowVersion: 2, endedAt: 2000,
      rawOutput: '{"partial":', truncated: [{ field: 'rawOutput', originalBytes: 20000 }] };
    expect(decodeToolCall(terminal, sessionKey)).toEqual(terminal);
    expect(decodePublic019Notice({ type: 'change', schemaVersion: 2, class: 'tool_call.ended',
      resource: 'tool calls', op: 'upsert', refs: { sessionKey, toolCallId: call.id }, payload: terminal }, sessionKey))
      .toEqual({ operation: 'tool', tool: terminal });
    const marker = { ...item, messageType: 'marker', marker: { kind: 'context-compacted', from: 'large', to: 'compact' } };
    expect(decodePublic019Notice({ type: 'change', schemaVersion: 2, class: 'message.created',
      resource: 'transcript messages', op: 'upsert', refs: { sessionKey }, payload: marker }, sessionKey))
      .toMatchObject({ operation: 'upsert', record: { transition: 'compaction', content: item.content } });
    expect(decodePublic019Notice({ type: 'change', schemaVersion: 2, class: 'transition.recorded',
      resource: 'transcript messages', op: 'upsert', refs: { sessionKey }, payload: marker }, sessionKey))
      .toEqual({ operation: 'unknown', sessionKey, resource: 'transition.recorded' });
  });

  it('exhausts fixed-range tool pages and keeps tool subscriptions separate from transcript classes', async () => {
    const paths: URL[] = [];
    const channels: Channel[] = [];
    const host: Public019Host = {
      currentIdentity: () => identity,
      fetch: async path => {
        const url = new URL(path); paths.push(url);
        const older = url.searchParams.has('before');
        return new Response(JSON.stringify({ schemaVersion: 1, resource: 'tool calls',
          items: [{ ...call, id: older ? 'tc_older' : 'tc_newer', seq: older ? 1 : 2 }],
          page: { oldestCursor: older ? 'end' : 'opaque-next', hasMoreBefore: !older } }));
      },
      openAuthenticatedChanges: async () => { const channel = new Channel(); channel.autoReady = true; channels.push(channel); return channel; },
      openAuthenticatedHuman: async () => new Channel(),
    };
    const { transport } = createPublic019Transport({ baseUrl: 'https://host.example', build: version.build, sha: version.sha, host });
    const controller = new AbortController();
    const callbacks = { onNotice: vi.fn(), onDoubt: vi.fn() };
    const main = await transport.openChanges(sessionKey, callbacks, controller.signal);
    const tools = await transport.openToolChanges!(sessionKey, callbacks, controller.signal);
    expect((channels[0].sent[0].filters as { classes: string[] }).classes).not.toContain('tool_call.');
    expect(channels[1].sent[0].filters).toEqual({ sessionKey, classes: ['tool_call.'] });
    const rows = await transport.readToolCalls!(sessionKey, { fromInclusive: 8, toExclusive: 10 }, controller.signal);
    expect(rows.map(row => row.id)).toEqual(['tc_older', 'tc_newer']);
    expect(paths.map(url => [url.searchParams.get('afterMessageSeqFromInclusive'), url.searchParams.get('afterMessageSeqToExclusive')]))
      .toEqual([['8', '10'], ['8', '10']]);
    expect(paths[1].searchParams.get('before')).toBe('opaque-next');
    tools.close();
    expect(channels[0].closed).toBe(false);
    main.close();
  });
});
