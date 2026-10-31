import { describe, expect, it, vi } from 'vitest';
import { createTightbeamAdapter } from '../src/runtime';
import { advanceReadMarkerForwardOnly } from '../src/readMarker';
import {
  createPublic019Transport, decodePublic019Message, decodeToolCall,
  decodePublic019Notice, type Public019Channel, type Public019Host,
} from '../src/public019';
import { AuthorizationError, SessionNotFoundError, UnsupportedTargetError } from '../src/types';
import { ToolHistoryUnavailableError } from '../src/toolHistory';

const sessionKey = 's-public';
const identity = { principalKey: 'person-1', deviceId: 'device-1' };
const version = { server: 'tightbeam', version: '0.1.11', build: 3390, sha: '306f423d', protocolVersion: 1 };
const laterPatch = { ...version, version: '0.1.12', build: 3402, sha: '7c4d2e11' };
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
  private disconnected?: (event?: { code?: number }) => void;
  send(frame: Readonly<Record<string, unknown>>) {
    this.sent.push(frame);
    if (this.autoReady) queueMicrotask(() => this.emit({ type: 'subscription_ready', subscriptionId: frame.subscriptionId }));
  }
  listen(onFrame: (frame: unknown) => void, onClose: (event?: { code?: number }) => void) {
    this.frame = onFrame;
    this.disconnected = onClose;
    return () => { this.frame = undefined; this.disconnected = undefined; };
  }
  close() { this.closed = true; }
  emit(value: unknown) { this.frame?.(value); }
  disconnect(event?: { code?: number }) { this.disconnected?.(event); }
}

function setup(heartbeatTimeoutMs?: number, observedVersion = version, historyItems: unknown[] = [item],
  turnItems: unknown[] = [], turnStatus = 200, railDenials?: unknown) {
  const changes = new Channel();
  const human = new Channel();
  const paths: string[] = [];
  const host: Public019Host = {
    currentIdentity: () => identity,
    fetch: async (path) => {
      paths.push(path);
      if (path.includes('/record-events?')) return new Response(JSON.stringify({
        schemaVersion: 1, resource: 'record events', items: [], page: { hasMoreBefore: false },
      }));
      if (path.includes('/tool-calls?')) return new Response(JSON.stringify({
        schemaVersion: 1, resource: 'tool calls', items: [], page: { hasMoreBefore: false },
      }), { status: 200 });
      if (path.includes('/turns?')) return new Response(JSON.stringify({
        schemaVersion: 1, resource: 'turns', items: turnItems, page: { hasMoreBefore: false },
      }), { status: turnStatus });
      if (path.includes('/messages/')) return new Response(JSON.stringify({
        schemaVersion: 1, resource: 'transcript messages', item,
      }), { status: 200 });
      const afterCurrentCursor = path.includes('/messages?') && new URL(path).searchParams.get('after') === 'newer-cursor';
      const pageBody = { schemaVersion: 1, resource: 'transcript messages', items: afterCurrentCursor ? [] : historyItems,
          page: { oldestCursor: afterCurrentCursor ? null : 'older-cursor', newestCursor: 'newer-cursor',
            hasMoreBefore: !afterCurrentCursor, hasMoreAfter: false },
          ...(railDenials === undefined ? {} : { railDenials }) };
      const body = path.endsWith('/version') ? observedVersion : path.includes('/messages?')
        ? pageBody
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
    baseUrl: 'https://host.example', host,
    responseTimeoutMs: 1000, heartbeatTimeoutMs,
  });
  return { transport, profile, paths, changes, human, host };
}

describe('Gateway wire mapping and behavior checks', () => {
  it('keeps marker transport unavailable without a declared user-device route', () => {
    const candidate = setup();
    candidate.host.currentIdentity = () => ({ principalKey: 'mike', deviceId: 'device-mike' });

    expect(candidate.transport.readReadMarker).toBeUndefined();
    expect(candidate.transport.writeReadMarker).toBeUndefined();
    expect(candidate.paths).toEqual([]);
  });

  it('opens normally for Mike on a host without a compatible marker route', async () => {
    const candidate = setup();
    candidate.host.currentIdentity = () => ({ principalKey: 'mike', deviceId: 'fixture-device' });
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await runtime.markReadPosition?.();

    expect(runtime.getSnapshot().status).toBe('ready');
    expect(candidate.paths.some(path => path.includes('/api/read-markers/'))).toBe(false);
    expect(candidate.paths.some(path => path.endsWith('/agent/dispatch'))).toBe(false);
    runtime.dispose();
  });

  it('encodes the full scope key and retains the higher marker after a conditional-write conflict', async () => {
    const scopeKey = 'agent:sample assistant with space:session-read-position';
    const requests: Array<{ input: string; init: RequestInit }> = [];
    let marker: string | null = null;
    const host: Public019Host = {
      readMarkerRoute: 'gateway-user-device',
      currentIdentity: () => ({ principalKey: 'mike', deviceId: 'fixture-device' }),
      fetch: async (input, init) => {
        requests.push({ input, init });
        const url = new URL(input);
        if (url.pathname.startsWith('/api/read-markers/')) {
          if (init.method === 'GET') return new Response(JSON.stringify({ schemaVersion: 1,
            resource: 'read markers', item: { userId: 'mike', scopeKey, marker } }), { status: 200 });
        }
        if (url.pathname === '/agent/dispatch' && init.method === 'POST') {
          marker = '90071992547409931';
          return new Response(JSON.stringify({ error: { code: 'read_marker_conflict' } }), { status: 409 });
        }
        throw new Error(`Unexpected marker request: ${init.method} ${url.pathname}`);
      },
      openAuthenticatedChanges: async () => new Channel(),
      openAuthenticatedHuman: async () => new Channel(),
    };
    const { transport } = createPublic019Transport({ baseUrl: 'https://gateway.example', host });
    const port = { readReadMarker: transport.readReadMarker!, writeReadMarker: transport.writeReadMarker! };

    await advanceReadMarkerForwardOnly(port, { userId: 'mike', scopeKey, sequence: '90071992547409930' },
      new AbortController().signal);

    const encodedPath = `/api/read-markers/${encodeURIComponent(scopeKey)}`;
    expect(requests.map(({ input, init }) => [init.method, new URL(input).pathname])).toEqual([
      ['GET', encodedPath], ['POST', '/agent/dispatch'], ['GET', encodedPath],
    ]);
    expect(JSON.parse(String(requests[1].init.body))).toEqual({
      verb: 'read-marker-set',
      params: { scopeKey, marker: '90071992547409930', expectedCurrent: null },
    });
    expect(requests[0].input).toContain(encodeURIComponent(scopeKey));
    expect(requests[0].init.cache).toBe('no-store');
    expect(requests[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves a stored integer marker type in conditional writes, including after conflict reread', async () => {
    const scopeKey = 'agent:sample assistant with space:session-read-position';
    const requests: Array<{ input: string; init: RequestInit }> = [];
    let marker: number | string = 41;
    let conflictNextWrite = true;
    const host: Public019Host = {
      readMarkerRoute: 'gateway-user-device',
      currentIdentity: () => ({ principalKey: 'mike', deviceId: 'fixture-device' }),
      fetch: async (input, init) => {
        requests.push({ input, init });
        const url = new URL(input);
        if (url.pathname.startsWith('/api/read-markers/') && init.method === 'GET') {
          return new Response(JSON.stringify({ schemaVersion: 1, resource: 'read markers',
            item: { userId: 'mike', scopeKey, marker } }), { status: 200 });
        }
        if (url.pathname === '/agent/dispatch' && init.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { params: { expectedCurrent: number | string | null; marker: string } };
          if (conflictNextWrite) {
            conflictNextWrite = false;
            marker = 42;
            return new Response(JSON.stringify({ error: { code: 'read_marker_conflict' } }), { status: 409 });
          }
          if (body.params.expectedCurrent !== marker) {
            return new Response(JSON.stringify({ error: { code: 'read_marker_conflict' } }), { status: 409 });
          }
          marker = body.params.marker;
          return new Response(JSON.stringify({ result: { changed: true } }), { status: 200 });
        }
        throw new Error(`Unexpected marker request: ${init.method} ${url.pathname}`);
      },
      openAuthenticatedChanges: async () => new Channel(),
      openAuthenticatedHuman: async () => new Channel(),
    };
    const { transport } = createPublic019Transport({ baseUrl: 'https://gateway.example', host });

    await advanceReadMarkerForwardOnly({
      readReadMarker: transport.readReadMarker!,
      writeReadMarker: transport.writeReadMarker!,
    }, { userId: 'mike', scopeKey, sequence: '43' }, new AbortController().signal);

    const writes = requests.filter(({ input }) => new URL(input).pathname === '/agent/dispatch');
    expect(writes).toHaveLength(2);
    expect(JSON.parse(String(writes[0].init.body)).params.expectedCurrent).toBe(41);
    expect(JSON.parse(String(writes[1].init.body)).params.expectedCurrent).toBe(42);
    expect(JSON.parse(String(writes[1].init.body)).params.marker).toBe('43');
  });

  it('consumes live turn lifecycle payloads and checks the current turn without refreshing history', async () => {
    const humanRow = { ...item, sender: 'user:person-1', turnSeq: 12 };
    const candidate = setup(undefined, version, [humanRow]);
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent).toHaveLength(2));
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
    expect(candidate.paths.some(path => path.includes('/turns?'))).toBe(false);
    expect(candidate.paths.some(path => /^https:\/\/host\.example\/api\/turns\//.test(path))).toBe(false);
    candidate.changes.disconnect();
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    expect(runtime.getSnapshot().activityTurnStateAvailable).toBe(false);
    runtime.dispose();
  });

  it('declares the same backend profile for the current release and routine patches', async () => {
    const current = setup(undefined, version);
    expect(current.profile.identity).toBe('tightbeam-gateway');
    expect(Object.values(current.profile.capabilities).every(Boolean)).toBe(true);
    expect(await current.transport.inspectTarget(new AbortController().signal)).toEqual({
      identity: 'tightbeam-gateway', capabilities: current.profile.capabilities,
    });
    expect(current.paths).toEqual([]);

    const runtime = createTightbeamAdapter(current.transport, current.profile).open(sessionKey);
    await vi.waitFor(() => expect(current.changes.sent).toHaveLength(2));
    current.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m_1']);
    runtime.dispose();

    const later = setup(undefined, laterPatch);
    expect(await later.transport.inspectTarget(new AbortController().signal)).toEqual({
      identity: 'tightbeam-gateway', capabilities: later.profile.capabilities,
    });
    expect(later.paths).toEqual([]);
    expect(later.profile.capabilities.authoritativeTurnProvenance).toBe(true);
  });

  it('keeps a missing-session response local and distinguishes its detail 404', async () => {
    const candidate = setup();
    candidate.host.fetch = async () => new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    await expect(candidate.transport.readSession(sessionKey, new AbortController().signal))
      .rejects.toBeInstanceOf(SessionNotFoundError);

    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await runtime.rebuild();
    expect(runtime.getSnapshot()).toMatchObject({
      status: 'ready', sessionNotFound: true, sessionError: 'This conversation no longer exists.',
    });
    expect(runtime.send('a missing session does not block the rest of Chat')).toBeTruthy();
    runtime.dispose();
  });

  it('classifies only a missing tool-history collection as optional history', async () => {
    const candidate = setup();
    candidate.host.fetch = async () => new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    await expect(candidate.transport.readToolCalls!(sessionKey, { fromInclusive: 0 }, new AbortController().signal))
      .rejects.toBeInstanceOf(ToolHistoryUnavailableError);
    await expect(candidate.transport.readTail(sessionKey, new AbortController().signal))
      .rejects.toThrow('HTTP 404 (not_found)');

    candidate.host.fetch = async () => new Response(JSON.stringify({ error: { code: 'chat_gateway_unavailable' } }), { status: 404 });
    await expect(candidate.transport.readToolCalls!(sessionKey, { fromInclusive: 0 }, new AbortController().signal))
      .rejects.toThrow('No Gateway access is provisioned');
  });

  it('reads ordered transitions while using a protocol-2 Firehose subscription', async () => {
    const earlierTransition = { ...item, id: 'marker_before', seq: 8, rowVersion: 8,
      messageType: 'marker', marker: { kind: 'session-restart', from: 'old', to: 'new' } };
    const laterTransition = { ...item, id: 'marker_after', seq: 10, rowVersion: 10,
      messageType: 'marker', marker: { kind: 'harness-switch', from: 'old-harness', to: 'new-harness' } };
    const candidate = setup(undefined, version,
      [laterTransition, item, earlierTransition]);
    expect(candidate.profile.identity).toBe('tightbeam-gateway');
    expect(candidate.profile.capabilities).toEqual({
      newestTail: true, stableOlderCursor: true, retainedHistoryAcrossResets: true,
      orderedTransitions: true, snapshotCoverage: true, versionedNotices: true,
      humanSendDedupe: true, authoritativeTurnProvenance: true,
    });
    expect(await candidate.transport.inspectTarget(new AbortController().signal)).toEqual({
      identity: candidate.profile.identity, capabilities: candidate.profile.capabilities,
    });

    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent).toEqual([
      { type: 'subscribe', protocolVersion: 2, subscriptionId: `chat:${sessionKey}`,
        filters: { sessionKey, classes: ['message.created', 'transition.recorded', 'session.', 'turn.started', 'turn.ended', 'session_record_event.created'] } },
      { type: 'subscribe', protocolVersion: 2, subscriptionId: `rail:${sessionKey}`,
        filters: { sessionKey, classes: ['rail.denied'] } },
    ]));
    await vi.waitFor(() => expect(candidate.paths.some(path => path.includes('/messages?'))).toBe(true));
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().records.map((record) => record.id))
      .toEqual(['marker_before', 'm_1', 'marker_after']);
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(candidate.paths.some(path => path.includes('/tool-calls?'))).toBe(true));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    expect(runtime.getSnapshot().toolCallsEnabled).toBe(true);
    expect(candidate.paths).toEqual([
      'https://host.example/api/sessions/s-public',
      'https://host.example/api/sessions/s-public/messages?limit=50&tail=true',
      'https://host.example/api/sessions/s-public/record-events?limit=50',
      'https://host.example/api/sessions/s-public/tool-calls?limit=50&afterMessageSeqFromInclusive=8',
    ]);
    expect(runtime.getSnapshot().records.map((record) => record.id))
      .toEqual(['marker_before', 'm_1', 'marker_after']);
    expect(runtime.getSnapshot().records.map((record) => record.kind))
      .toEqual(['transition', 'message', 'transition']);
    expect(candidate.changes.sent).toHaveLength(2);
    expect(candidate.human.sent).toHaveLength(0);
    runtime.dispose();
  });

  it('skips release metadata during startup and recovery', async () => {
    const candidate = setup(undefined, version);
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent).toHaveLength(2));
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(candidate.paths.filter(path => path.includes('/tool-calls?'))).toHaveLength(1));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    expect(candidate.paths.some((path) => path.endsWith('/version'))).toBe(false);
    expect(candidate.paths.filter((path) => path.includes('/messages?'))).toHaveLength(1);

    const recovery = runtime.rebuild({ restart: true });
    await vi.waitFor(() => expect(candidate.paths.filter(path => path.includes('/messages?'))).toHaveLength(2));
    expect(candidate.changes.sent).toHaveLength(2);
    expect(candidate.paths.some((path) => path.endsWith('/version'))).toBe(false);
    await recovery;
    await vi.waitFor(() => expect(candidate.paths.filter(path => path.includes('/tool-calls?'))).toHaveLength(2));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));

    expect(runtime.getSnapshot().status).toBe('ready');
    expect(candidate.paths.some((path) => path.endsWith('/version'))).toBe(false);
    expect(candidate.paths.filter((path) => path.endsWith('/api/sessions/s-public'))).toHaveLength(2);
    expect(candidate.paths.filter((path) => path.includes('/messages?'))).toHaveLength(2);
    expect(candidate.paths.some(path => path.includes('/turns?'))).toBe(false);
    expect(candidate.paths.filter((path) => path.includes('/tool-calls?'))).toHaveLength(2);
    runtime.dispose();
  });

  it('keeps the protocol-2 Firehose exchange separate from REST behavior', async () => {
    const candidate = setup(undefined, version);
    expect(candidate.profile.identity).toBe('tightbeam-gateway');
    expect(candidate.profile.capabilities).toEqual({
      newestTail: true, stableOlderCursor: true, retainedHistoryAcrossResets: true,
      orderedTransitions: true, snapshotCoverage: true, versionedNotices: true,
      humanSendDedupe: true, authoritativeTurnProvenance: true,
    });
    expect(await candidate.transport.inspectTarget(new AbortController().signal)).toEqual({
      identity: candidate.profile.identity, capabilities: candidate.profile.capabilities,
    });

    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent[0]).toEqual({
      type: 'subscribe', protocolVersion: 2, subscriptionId: `chat:${sessionKey}`,
      filters: { sessionKey, classes: ['message.created', 'transition.recorded', 'session.', 'turn.started', 'turn.ended', 'session_record_event.created'] },
    }));
    expect(candidate.changes.sent[1]).toEqual({ type: 'subscribe', protocolVersion: 2,
      subscriptionId: `rail:${sessionKey}`, filters: { sessionKey, classes: ['rail.denied'] } });
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(candidate.paths.some(path => path.includes('/tool-calls?'))).toBe(true));
    await vi.waitFor(() => expect(runtime.getSnapshot().toolCallsLoading).toBe(false));
    expect(candidate.paths).toEqual([
      'https://host.example/api/sessions/s-public',
      'https://host.example/api/sessions/s-public/messages?limit=50&tail=true',
      'https://host.example/api/sessions/s-public/record-events?limit=50',
      'https://host.example/api/sessions/s-public/tool-calls?limit=50&afterMessageSeqFromInclusive=9',
    ]);
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m_1']);
    expect(candidate.human.sent).toHaveLength(0);
    runtime.dispose();
  });

  it('shows a running turn delivered on the current feed when opening mid-turn', async () => {
    const human = { ...item, id: 'human-message', seq: 9, role: 'user', sender: 'user:person-1',
      messageType: 'chat', clientMessageId: 'client-human', deviceId: 'device-1', turnSeq: 12,
      content: 'Can you help?' };
    const turn = { seq: 12, rowVersion: 1, sessionKey, status: 'running', messageId: human.id,
      origin: 'user:person-1', triggerSource: 'mike' };
    const candidate = setup(undefined, version, [human], [turn]);
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent).toHaveLength(2));
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    candidate.changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: `chat:${sessionKey}`, seq: 1,
      class: 'turn.started', resource: 'turns', op: 'upsert', refs: { sessionKey, turnSeq: 12 }, payload: turn });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    await vi.waitFor(() => expect(runtime.getSnapshot().activeTurn).toMatchObject({
      sourceKind: 'human', turn: { seq: 12, status: 'running' },
    }));
    expect(candidate.paths.some(path => path.includes('/turns?'))).toBe(false);
    expect(candidate.paths.some((path) => /^https:\/\/host\.example\/api\/turns\//.test(path))).toBe(false);
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['human-message']);
    runtime.dispose();
  });

  it('clears stale turn state at disconnect and only uses records delivered after reconnect', async () => {
    const running = { seq: 12, rowVersion: 1, sessionKey, status: 'running', messageId: 'human-message',
      origin: 'user:person-1', triggerSource: 'mike' };
    const human = { ...item, id: 'human-message', seq: 9, role: 'user', sender: 'user:person-1',
      messageType: 'chat', clientMessageId: 'client-human', deviceId: 'device-1', turnSeq: 12,
      content: 'Can you help?' };
    const candidate = setup(undefined, version, [human]);
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent).toHaveLength(2));
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    candidate.changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: `chat:${sessionKey}`, seq: 1,
      class: 'turn.started', resource: 'turns', op: 'upsert', refs: { sessionKey, turnSeq: 12 }, payload: running });
    await vi.waitFor(() => expect(runtime.getSnapshot().activeTurn?.turn).toMatchObject({ seq: 12, status: 'running' }));

    candidate.changes.disconnect({ code: 4008 });
    await vi.waitFor(() => expect(runtime.getSnapshot().liveError).toBe('Firehose disconnected (close code 4008).'));
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    expect(runtime.getSnapshot().activityTurnStateAvailable).toBe(false);

    await vi.waitFor(() => expect(candidate.changes.sent).toHaveLength(4));
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().liveError).toBeUndefined());
    candidate.changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: `chat:${sessionKey}`, seq: 1,
      class: 'turn.ended', resource: 'turns', op: 'upsert', refs: { sessionKey, turnSeq: 12 },
      payload: { ...running, status: 'completed', rowVersion: 2 } });
    expect(runtime.getSnapshot().activityTurnStateAvailable).toBe(true);
    expect(runtime.getSnapshot().activeTurn).toBeUndefined();
    expect(candidate.paths.some(path => path.includes('/turns?'))).toBe(false);
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['human-message']);
    runtime.dispose();
  });

  it('reports the peer close code for a ready live-update socket', async () => {
    const candidate = setup();
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent).toHaveLength(2));
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));

    candidate.changes.disconnect({ code: 4008 });
    await vi.waitFor(() => expect(runtime.getSnapshot().liveError).toBe('Firehose disconnected (close code 4008).'));
    expect(runtime.getSnapshot().status).toBe('ready');
    runtime.dispose();
  });

  it('keeps conversation and sending available without a separate turn snapshot', async () => {
    const candidate = setup(undefined, version, [item]);
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);

    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(runtime.getSnapshot().status).toBe('ready');
    expect(candidate.paths.some(path => path.includes('/turns?'))).toBe(false);
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m_1']);
    const clientMessageId = runtime.send('Still available while activity status is unavailable');
    expect(clientMessageId).toBeTruthy();
    await vi.waitFor(() => expect(candidate.human.sent).toHaveLength(1));
    candidate.human.emit({ type: 'ack', id: clientMessageId });
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0]?.status).toBe('accepted'));
    expect(runtime.getSnapshot().status).toBe('ready');
    runtime.dispose();
  });

  it('does not call exact-turn or trigger-message detail routes while loading a transcript', async () => {
    const messages = [
      { ...item, id: 'human-message', seq: 9, role: 'user', sender: 'user:person-1', messageType: 'chat',
        clientMessageId: 'client-human', deviceId: 'device-1', turnSeq: 12, content: 'Can you help?' },
      { ...item, id: 'agent-message', seq: 10, role: 'assistant', messageType: 'assistant',
        turnSeq: 12, content: 'Here is the answer.' },
      { ...item, id: 'system-batch', seq: 11, role: 'user', sender: 'process:notifications',
        messageType: 'substrate', content: '[batched notices: 1]' },
      { ...item, id: 'system-marker', seq: 12, role: 'assistant', sender: 'process:notifications',
        messageType: 'substrate', content: 'A system event marker' },
    ];
    const candidate = setup(undefined, version, messages);
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);

    await vi.waitFor(() => expect(candidate.changes.sent[0]).toEqual({
      type: 'subscribe', protocolVersion: 2, subscriptionId: `chat:${sessionKey}`,
      filters: { sessionKey, classes: ['message.created', 'transition.recorded', 'session.', 'turn.started', 'turn.ended', 'session_record_event.created'] },
    }));
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
      'https://host.example/api/sessions/s-public',
      'https://host.example/api/sessions/s-public/messages?limit=50&tail=true',
      'https://host.example/api/sessions/s-public/record-events?limit=50',
      'https://host.example/api/sessions/s-public/tool-calls?limit=50&afterMessageSeqFromInclusive=9',
    ]);
    expect(candidate.paths.some((path) => /^https:\/\/host\.example\/api\/turns\//.test(path))).toBe(false);
    expect(candidate.changes.closed).toBe(false);

    const clientMessageId = runtime.send('Still available');
    expect(clientMessageId).toBeTruthy();
    await vi.waitFor(() => expect(candidate.human.sent).toHaveLength(1));
    candidate.human.emit({ type: 'ack', id: clientMessageId });
    await vi.waitFor(() => expect(runtime.getSnapshot().sends[0]?.status).toBe('accepted'));
    expect(runtime.getSnapshot().status).toBe('ready');
    runtime.dispose();
  });

  it('does not gate conversation loading on protocol metadata', async () => {
    const arbitraryProtocol = { ...version, protocolVersion: 42 };
    const candidate = setup(undefined, arbitraryProtocol);
    const runtime = createTightbeamAdapter(candidate.transport, candidate.profile).open(sessionKey);
    await vi.waitFor(() => expect(candidate.changes.sent).toHaveLength(2));
    expect(candidate.paths.some((path) => path.endsWith('/version'))).toBe(false);
    candidate.changes.emit({ type: 'subscription_ready', subscriptionId: `chat:${sessionKey}` });
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(candidate.human.sent).toHaveLength(0);
    expect(candidate.paths).toContain('https://host.example/api/sessions/s-public');
    expect(candidate.paths).toContain('https://host.example/api/sessions/s-public/messages?limit=50&tail=true');
    runtime.dispose();
  });

  it('uses subscribe-before-REST overlap for snapshot coverage, without a watermark claim', async () => {
    const candidate = setup(undefined, version);
    const signal = new AbortController().signal;
    expect(candidate.profile.capabilities.snapshotCoverage).toBe(true);

    const pending = candidate.transport.openChanges(sessionKey, {
      onNotice: () => {}, onDoubt: () => {},
    }, signal);
    await vi.waitFor(() => expect(candidate.changes.sent).toHaveLength(2));
    expect(candidate.changes.sent[0]).toEqual({
      type: 'subscribe', protocolVersion: 2, subscriptionId: `chat:${sessionKey}`,
      filters: { sessionKey, classes: ['message.created', 'transition.recorded', 'session.', 'turn.started', 'turn.ended', 'session_record_event.created'] },
    });
    expect(candidate.changes.sent[1]).toEqual({ type: 'subscribe', protocolVersion: 2,
      subscriptionId: `rail:${sessionKey}`, filters: { sessionKey, classes: ['rail.denied'] } });
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

  it('does not gate on Gateway release, build, source, or protocol metadata', async () => {
    for (const observed of [
      version,
      laterPatch,
      { ...laterPatch, build: 2476, sha: 'f724fc41' },
      { ...laterPatch, sha: '00000000' },
      { ...laterPatch, protocolVersion: 42 },
    ]) {
      const supported = setup(undefined, observed);
      const runtime = createTightbeamAdapter(supported.transport, supported.profile).open(sessionKey);
    await vi.waitFor(() => expect(supported.changes.sent).toHaveLength(2));
      supported.changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
      await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
      expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(['m_1']);
      expect(supported.paths.some((path) => path.endsWith('/version'))).toBe(false);
      runtime.dispose();
    }
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
            page: { oldestCursor: null, newestCursor: 'newer-cursor', hasMoreBefore: false, hasMoreAfter: false } };
        } else if (path.includes('/record-events?')) {
          body = { schemaVersion: 1, resource: 'record events', items: [], page: { hasMoreBefore: false } };
        } else if (path.includes('/tool-calls?')) {
          body = { schemaVersion: 1, resource: 'tool calls', items: [], page: { hasMoreBefore: false } };
        } else if (path.includes('/turns?')) {
          body = { schemaVersion: 1, resource: 'turns', items: [], page: { hasMoreBefore: false } };
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
    const { transport, profile } = createPublic019Transport({ baseUrl: 'https://host.example', host });
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(changes.sent).toHaveLength(2));
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
    await vi.waitFor(() => expect(base.changes.sent).toHaveLength(2));
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
    const base = setup(undefined, version, historyItems);
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
    await vi.waitFor(() => expect(base.changes.sent).toHaveLength(2));
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
    expect(base.changes.sent).toHaveLength(2);
    runtime.dispose();
  });

  it('accounts for unknown selected-session events without rebuilding and keeps later events live', async () => {
    const historyItems: unknown[] = [item];
    const base = setup(undefined, version, historyItems);
    const runtime = createTightbeamAdapter(base.transport, base.profile).open(sessionKey);
    await vi.waitFor(() => expect(base.changes.sent).toHaveLength(2));
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
    expect(base.changes.sent).toHaveLength(2);
    runtime.dispose();
  });

  it('uses a stable backend profile, retains raw metadata, and reads session detail', async () => {
    const { transport, profile, paths } = setup();
    const signal = new AbortController().signal;
    expect(await transport.inspectTarget(signal)).toEqual({ identity: profile.identity, capabilities: profile.capabilities });
    expect(await transport.readSession(sessionKey, signal)).toMatchObject({ sessionKey, rowVersion: 4, raw: { clearedThroughSeq: 7 } });
    expect(paths).toEqual(['https://host.example/api/sessions/s-public']);
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
    await vi.waitFor(() => expect(changes.sent).toHaveLength(2));
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

  it('decodes additive refused-action history while keeping older Gateway pages compatible', async () => {
    const denial = { id: 'rd_14', sessionKey, principal: `session:${sessionKey}`, verb: 'send',
      rule: 'owner-policy', origin: 'chat', payload: { verb: 'send', rule: 'owner-policy', detail: 'Refused' },
      occurredAt: Date.parse('2026-10-12T00:00:01Z'), afterMessageSeq: 9 };
    const supported = setup(undefined, version, [item], [], 200, [denial]);
    const page = await supported.transport.readTail(sessionKey, new AbortController().signal);
    expect(page.railDenials).toEqual([denial]);
    expect((await supported.transport.readOlder(sessionKey, 'older-cursor', new AbortController().signal)).railDenials)
      .toEqual([denial]);

    const olderGateway = setup(undefined, { ...version, version: '0.1.13' });
    const oldPage = await olderGateway.transport.readTail(sessionKey, new AbortController().signal);
    expect(oldPage.railDenials).toBeUndefined();

    const crossSession = setup(undefined, version, [item], [], 200,
      [{ ...denial, sessionKey: 'other', principal: 'session:other' }]);
    await expect(crossSession.transport.readTail(sessionKey, new AbortController().signal))
      .rejects.toThrow('Refused action belongs to a different session.');
    const crossPrincipal = setup(undefined, version, [item], [], 200,
      [{ ...denial, principal: 'session:other' }]);
    await expect(crossPrincipal.transport.readTail(sessionKey, new AbortController().signal))
      .rejects.toThrow('Refused action belongs to a different principal.');
  });

  it('keeps transcript metadata complete and accepts an empty after page without a backward cursor', async () => {
    const invalidTail = setup();
    invalidTail.host.fetch = async () => new Response(JSON.stringify({
      schemaVersion: 1, resource: 'transcript messages', items: [item],
      page: { oldestCursor: 'older-cursor', hasMoreBefore: true },
    }), { status: 200 });
    await expect(invalidTail.transport.readTail(sessionKey, new AbortController().signal))
      .rejects.toThrow('Invalid transcript page metadata.');

    const candidate = setup();
    candidate.host.fetch = async () => new Response(JSON.stringify({
      schemaVersion: 1, resource: 'transcript messages', items: [],
      page: { oldestCursor: null, newestCursor: null, hasMoreBefore: true, hasMoreAfter: false },
    }), { status: 200 });
    const page = await candidate.transport.readAfter!(sessionKey, 'newer-cursor', new AbortController().signal);

    expect(page).toMatchObject({ records: [], oldestCursor: null, hasOlder: false,
      newestCursor: null, hasNewer: false });
  });

  it('reads forward pages and individual transcript details through the 0.1.11 routes', async () => {
    const { transport, paths } = setup();
    const signal = new AbortController().signal;
    const page = await transport.readAfter!(sessionKey, 'opaque+/=', signal);
    expect(page.records.map((row) => row.id)).toEqual(['m_1']);
    expect(page.newestCursor).toBe('newer-cursor');
    expect(page.hasNewer).toBe(false);
    expect(paths.at(-1)).toBe('https://host.example/api/sessions/s-public/messages?limit=50&after=opaque%2B%2F%3D');

    const detail = await transport.readMessage!(sessionKey, 'm_1', signal);
    expect(detail).toMatchObject({ id: 'm_1', sessionKey, seq: 9, content: 'hello' });
    expect(paths.at(-1)).toBe('https://host.example/api/sessions/s-public/messages/m_1');
  });

  it('keeps failed-park recovery lifecycle-only and decodes the projected transcript markers', () => {
    for (const [kind, transition] of [['harness-switch', 'harness'], ['model-retune', 'model'], ['session-restart', 'restart']]) {
      expect(decodePublic019Message({ ...item, messageType: 'marker',
        marker: { kind, from: 'old', to: 'new' } }, sessionKey)).toMatchObject({ kind: 'transition', transition, from: 'old', to: 'new' });
    }
    expect(decodePublic019Message({ ...item, messageType: 'marker' }, sessionKey))
      .toMatchObject({ kind: 'transition', transition: 'unknown', content: item.content });
    expect(decodePublic019Message({ ...item, messageType: 'marker',
      marker: { kind: 'future-boundary', from: 'old', to: 'new' } }, sessionKey))
      .toMatchObject({ kind: 'transition', transition: 'unknown', content: item.content });
  });

  it('decodes protocol-2 selected-session notices without inventing transition details', () => {
    const notice = {
      type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 1,
      class: 'message.created', resource: 'messages', op: 'upsert',
      refs: { sessionKey, messageId: 'm_1' }, payload: item,
    };
    expect(decodePublic019Notice(notice, sessionKey)).toMatchObject({ operation: 'upsert',
      record: { id: 'm_1', createdAt: '2026-10-12T00:00:00.000Z', raw: { at: item.at } } });
    expect(decodePublic019Notice({ ...notice, class: 'rail.denied', resource: undefined, op: 'observe',
      occurredAt: 1791763201000,
      refs: { sessionKey, principal: `session:${sessionKey}`, railDenialId: 14, origin: 'chat' },
      payload: { verb: 'send', rule: 'owner-policy', detail: 'Refused' } }, sessionKey)).toMatchObject({
      operation: 'rail-denial', sessionKey, id: 'rail:14', principal: `session:${sessionKey}`,
      origin: 'chat', verb: 'send', rule: 'owner-policy', occurredAt: 1791763201000,
      payload: { verb: 'send', rule: 'owner-policy', detail: 'Refused' },
    });
    expect(decodePublic019Notice({ ...notice, class: 'rail.denied', resource: undefined, op: 'observe',
      refs: { sessionKey: 'other', principal: `session:${sessionKey}`, railDenialId: 14, origin: 'chat' },
      payload: { verb: 'send', rule: 'owner-policy' } }, sessionKey))
      .toEqual({ operation: 'unknown', sessionKey, resource: 'rail.denied' });
    expect(decodePublic019Notice({ ...notice, class: 'transition.recorded', resource: 'transcript messages',
      payload: { ...item, messageType: 'marker' } }, sessionKey))
      .toMatchObject({ operation: 'upsert', record: { kind: 'transition', transition: 'unknown', content: item.content } });
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

  it('keeps the conversation feed when an uncorrelated optional rail refusal arrives before readiness', async () => {
    const { transport, changes } = setup();
    const notices: string[] = [];
    const doubts: string[] = [];
    const pending = transport.openChanges(sessionKey, {
      onNotice: (notice) => notices.push(notice.operation), onDoubt: (reason) => doubts.push(reason),
    }, new AbortController().signal);
    await vi.waitFor(() => expect(changes.sent).toHaveLength(2));
    // The rail request is pending, but Gateway v2's invalid_request response
    // has no subscriptionId. Do not tear down the socket before the primary
    // readiness response can establish which feed was refused.
    changes.emit({ type: 'error', code: 'invalid_request', message: 'sessionKey must match selected session' });
    expect(changes.closed).toBe(false);
    expect(doubts).toEqual([]);
    changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
    const connection = await pending;
    changes.emit({ type: 'heartbeat', seq: 0 });
    changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 1,
      class: 'message.created', resource: 'messages', op: 'upsert',
      refs: { sessionKey, messageId: item.id }, payload: item });
    expect(notices).toEqual(['upsert']);
    expect(doubts).toEqual([]);
    connection.close();
  });

  it('keeps the conversation feed when an uncorrelated optional rail refusal arrives after readiness', async () => {
    const { transport, changes } = setup();
    const notices: string[] = [];
    const doubts: string[] = [];
    const pending = transport.openChanges(sessionKey, {
      onNotice: (notice) => notices.push(notice.operation), onDoubt: (reason) => doubts.push(reason),
    }, new AbortController().signal);
    await vi.waitFor(() => expect(changes.sent).toHaveLength(2));
    changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
    const connection = await pending;
    changes.emit({ type: 'error', code: 'invalid_request', message: 'optional rail refused' });
    expect(changes.closed).toBe(false);
    expect(doubts).toEqual([]);
    changes.emit({ type: 'heartbeat', seq: 0 });
    changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 1,
      class: 'message.created', resource: 'messages', op: 'upsert',
      refs: { sessionKey, messageId: item.id }, payload: item });
    expect(notices).toEqual(['upsert']);
    expect(doubts).toEqual([]);
    connection.close();
  });

  it('fails when the conversation subscription is refused and never becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const primaryRefusal = setup();
      const refusedPending = primaryRefusal.transport.openChanges(sessionKey, {
        onNotice: () => {}, onDoubt: () => {},
      }, new AbortController().signal);
      const rejected = expect(refusedPending).rejects.toThrow('did not become ready after an uncorrelated subscription refusal');
      await Promise.resolve();
      expect(primaryRefusal.changes.sent).toHaveLength(2);
      primaryRefusal.changes.emit({ type: 'error', code: 'invalid_request', message: 'primary subscription refused' });
      expect(primaryRefusal.changes.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await rejected;
      expect(primaryRefusal.changes.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('subscribes after host auth, waits for readiness, and fails closed on a sequence gap', async () => {
    const { transport, changes } = setup();
    const notices: string[] = [];
    const doubts: string[] = [];
    const pending = transport.openChanges(sessionKey, {
      onNotice: (notice) => notices.push(notice.operation), onDoubt: (reason) => doubts.push(reason),
    }, new AbortController().signal);
    await vi.waitFor(() => expect(changes.sent).toHaveLength(2));
    expect(changes.sent[0]).toEqual({ type: 'subscribe', protocolVersion: 2,
      subscriptionId: 'chat:s-public', filters: { sessionKey, classes: ['message.created', 'transition.recorded', 'session.', 'turn.started', 'turn.ended', 'session_record_event.created'] } });
    expect(changes.sent[1]).toEqual({ type: 'subscribe', protocolVersion: 2,
      subscriptionId: 'rail:s-public', filters: { sessionKey, classes: ['rail.denied'] } });
    changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
    const connection = await pending;
    changes.emit({ type: 'subscription_ready', subscriptionId: 'rail:s-public' });
    changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'rail:s-public', seq: 1,
      class: 'rail.denied', op: 'observe', refs: { principal: 'session:s-public', railDenialId: 8 },
      occurredAt: 120, payload: { verb: 'assign', rule: 'sample-rule' } });
    changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 2,
      class: 'message.created', resource: 'messages', op: 'upsert',
      refs: { sessionKey, messageId: 'm_1' }, payload: item });
    expect(notices).toEqual(['rail-denial', 'upsert']);
    changes.emit({ type: 'heartbeat', seq: 4 });
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
    const { transport } = createPublic019Transport({ baseUrl: 'https://host.example', host });
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
    const { transport } = createPublic019Transport({ baseUrl: 'https://host.example', host });
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
      .toMatchObject({ operation: 'upsert', record: { kind: 'transition', transition: 'compaction', content: item.content } });
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
    const { transport } = createPublic019Transport({ baseUrl: 'https://host.example', host });
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

it('decodes exact record-event notice coverage and reads the same live/history occurrence', async () => {
  const candidate = setup();
  const event = { eventId: 'assignment.opened:assignment-example', kind: 'assignment.opened', at: 100,
    record: { type: 'assignment', id: 'assignment-example', detail: '/api/assignments/assignment-example' },
    actorSessionKey: 'another-session', tiedAs: ['holder'], cause: null, noticeMessageIds: [] };
  const notice = decodePublic019Notice({ type: 'change', schemaVersion: 2, class: 'session_record_event.created', refs: { sessionKey },
    payload: event, resource: 'record events', op: 'upsert' }, sessionKey);
  expect(notice).toMatchObject({ operation: 'record-event', event: { ...event, sessionKey } });
  expect(decodePublic019Message({ ...item, recordEventIds: [event.eventId] }, sessionKey))
    .toMatchObject({ recordEventIds: [event.eventId] });
  const paths: string[] = [];
  candidate.host.fetch = async path => {
    paths.push(path);
    return new Response(JSON.stringify({ schemaVersion: 1, resource: 'record events', items: [event],
      page: { oldestCursor: 'event-cursor', hasMoreBefore: true } }));
  };
  const page = await candidate.transport.readRecordEvents!(sessionKey, undefined, new AbortController().signal);
  expect(page.items).toEqual(notice.operation === 'record-event' ? [notice.event] : []);
  await candidate.transport.readRecordEvents!(sessionKey, 'older event cursor', new AbortController().signal);
  expect(new URL(paths[0]).searchParams.has('before')).toBe(false);
  expect(new URL(paths[1]).searchParams.get('before')).toBe('older event cursor');
});
