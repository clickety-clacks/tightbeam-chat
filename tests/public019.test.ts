import { describe, expect, it, vi } from 'vitest';
import { createTightbeamAdapter } from '../src/runtime';
import {
  PUBLIC_019_BUILD, PUBLIC_019_GATEWAY_SHA, createPublic019Transport, decodePublic019Message,
  decodePublic019Notice, type Public019Channel, type Public019Host,
} from '../src/public019';
import { AuthorizationError, UnsupportedTargetError } from '../src/types';

const sessionKey = 's-public';
const identity = { principalKey: 'person-1', deviceId: 'device-1' };
const version = { server: 'tightbeam', version: '0.1.9', build: PUBLIC_019_BUILD, sha: PUBLIC_019_GATEWAY_SHA, protocolVersion: 1 };
const item = {
  id: 'm_1', seq: 9, sessionKey, role: 'user', content: 'hello', at: Date.parse('2026-10-12T00:00:00Z'),
  sender: 'person-1', deviceId: 'device-1', clientMessageId: 'c_1', attachments: [],
  rowVersion: 9, model: 'source-supplied-model', unknownMetadata: { preserved: true },
};
const session = { sessionKey, rowVersion: 4, state: 'active', clearedThroughSeq: 7 };

class Channel implements Public019Channel {
  sent: Readonly<Record<string, unknown>>[] = [];
  closed = false;
  private frame?: (value: unknown) => void;
  private disconnected?: () => void;
  send(frame: Readonly<Record<string, unknown>>) { this.sent.push(frame); }
  listen(onFrame: (frame: unknown) => void, onClose: () => void) {
    this.frame = onFrame;
    this.disconnected = onClose;
    return () => { this.frame = undefined; this.disconnected = undefined; };
  }
  close() { this.closed = true; }
  emit(value: unknown) { this.frame?.(value); }
  disconnect() { this.disconnected?.(); }
}

function setup(heartbeatTimeoutMs?: number, observedVersion = version) {
  const changes = new Channel();
  const human = new Channel();
  const paths: string[] = [];
  const host: Public019Host = {
    currentIdentity: () => identity,
    fetch: async (path) => {
      paths.push(path);
      const body = path.endsWith('/version') ? observedVersion : path.includes('/messages?')
        ? { schemaVersion: 1, resource: 'transcript messages', items: [item],
          page: { oldestCursor: 'older-cursor', hasMoreBefore: true } }
        : { schemaVersion: 1, resource: 'sessions', item: session };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    openAuthenticatedChanges: async () => changes,
    openAuthenticatedHuman: async () => human,
  };
  const { transport, profile } = createPublic019Transport({
    baseUrl: 'https://host.example', build: observedVersion.build, sha: observedVersion.sha, host,
    responseTimeoutMs: 1000, heartbeatTimeoutMs,
  });
  return { transport, profile, paths, changes, human };
}

describe('public 0.1.9 released wire mapping and capability gates', () => {
  it('keeps unexamined 0.1.9 build and source identities unsupported while the released build opens', async () => {
    for (const observed of [{ ...version, build: version.build + 1 },
      { ...version, sha: '00000000' }]) {
      const other = setup(undefined, observed);
      const runtime = createTightbeamAdapter(other.transport, other.profile).open(sessionKey);
      await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('unsupported'));
      expect(runtime.getSnapshot().statusDetail).toContain('capability');
      expect(other.changes.sent).toHaveLength(0);
      expect(runtime.send('must not post')).toBeNull();
      expect(other.human.sent).toHaveLength(0);
      runtime.dispose();
    }

    const supported = setup();
    const ready = createTightbeamAdapter(supported.transport, supported.profile).open(sessionKey);
    await vi.waitFor(() => expect(supported.changes.sent).toHaveLength(1));
    supported.changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
    await vi.waitFor(() => expect(ready.getSnapshot().status).toBe('ready'));
    ready.dispose();
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
        } else {
          sessionReads++;
          body = { schemaVersion: 1, resource: 'sessions', item: {
            ...session, rowVersion: sessionReads === 1 ? 4 : 5,
            mechanicalStatus: sessionReads === 1 ? 'idle' : 'running',
          } };
        }
        return new Response(JSON.stringify(body), { status: 200 });
      },
      openAuthenticatedChanges: async () => changes,
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
      payload: { turnSeq: 10, sessionKey, status: 'running' } });
    changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 2,
      class: 'session.updated', resource: 'sessions', op: 'upsert', refs: { sessionKey },
      payload: { ...session, rowVersion: 5, mechanicalStatus: 'running' } });
    releaseTail();
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('ready'));
    expect(sessionReads).toBe(2);
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

  it('refuses an unknown selected-session state notice during a history read', async () => {
    const base = setup();
    let releaseTail!: () => void;
    const tailGate = new Promise<void>((resolve) => { releaseTail = resolve; });
    let readingTail = false;
    const transport = { ...base.transport, readTail: async (...args: Parameters<typeof base.transport.readTail>) => {
      readingTail = true;
      await tailGate;
      return base.transport.readTail(...args);
    } };
    const runtime = createTightbeamAdapter(transport, base.profile).open(sessionKey);
    await vi.waitFor(() => expect(base.changes.sent).toHaveLength(1));
    base.changes.emit({ type: 'subscription_ready', subscriptionId: 'chat:s-public' });
    await vi.waitFor(() => expect(readingTail).toBe(true));
    base.changes.emit({ type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 1,
      class: 'unrecognized.state', resource: 'turns', op: 'upsert', refs: { sessionKey }, payload: {} });
    releaseTail();
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('unsupported'));
    expect(runtime.getSnapshot().records).toHaveLength(0);
    expect(runtime.send('must not post')).toBeNull();
    expect(base.changes.closed).toBe(true);
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
      clientMessageId: 'c_1', raw: { at: item.at, unknownMetadata: { preserved: true } },
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
    expect(transport.proveCoverage({ sessionKey, rowVersion: 4, raw: {} }, page, [])).toBe(true);
    runtime.dispose();
    expect(transport.proveCoverage({ sessionKey, rowVersion: 4, raw: {} }, page, [])).toBe(false);
  });

  it('decodes all released stored marker kinds without guessing from message text', () => {
    for (const [kind, transition] of [['harness-switch', 'harness'], ['model-retune', 'model'], ['session-restart', 'restart']]) {
      expect(decodePublic019Message({ ...item, messageType: 'marker',
        marker: { kind, from: 'old', to: 'new' } }, sessionKey)).toMatchObject({ kind: 'transition', transition, from: 'old', to: 'new' });
    }
    expect(() => decodePublic019Message({ ...item, messageType: 'marker' }, sessionKey)).toThrow(UnsupportedTargetError);
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
    expect(decodePublic019Notice({ ...notice, class: 'turn.started', resource: 'turns' }, sessionKey))
      .toEqual({ operation: 'observe', sessionKey, resource: 'turn.started' });
    expect(decodePublic019Notice({ ...notice, class: 'wake.fired', resource: 'wakes' }, sessionKey))
      .toEqual({ operation: 'observe', sessionKey, resource: 'wake.fired' });
    for (const observationalClass of ['verb.accepted', 'verb.denied', 'rail.denied',
      'lifecycle.boot', 'prod.fired']) {
      expect(decodePublic019Notice({ ...notice, class: observationalClass,
        op: 'observe', resource: undefined }, sessionKey))
        .toEqual({ operation: 'ignore', sessionKey, resource: observationalClass });
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
      subscriptionId: 'chat:s-public', filters: { sessionKey } });
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

  it('sends human /ws frames with the same client ID and distinguishes ack, refusal, uncertainty', async () => {
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
    expect(await third).toMatchObject({ outcome: 'uncertain' });
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
