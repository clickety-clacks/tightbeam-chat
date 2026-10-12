import { describe, expect, it, vi } from 'vitest';
import { createTightbeamAdapter } from '../src/runtime';
import {
  PUBLIC_019_SOURCE, createPublic019Transport, decodePublic019Message,
  decodePublic019Notice, type Public019Channel, type Public019Host,
} from '../src/public019';
import { UnsupportedTargetError } from '../src/types';

const sessionKey = 's-public';
const identity = { principalKey: 'person-1', deviceId: 'device-1' };
const version = { server: 'tightbeam', version: '0.1.9', build: 2334, sha: PUBLIC_019_SOURCE.slice(0, 8), protocolVersion: 1 };
const item = {
  id: 'm_1', seq: 9, sessionKey, role: 'user', content: 'hello', at: '2026-10-12T00:00:00Z',
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

function setup() {
  const changes = new Channel();
  const human = new Channel();
  const paths: string[] = [];
  const host: Public019Host = {
    currentIdentity: () => identity,
    fetch: async (path) => {
      paths.push(path);
      const body = path.endsWith('/version') ? version :
        { schemaVersion: 1, resource: 'sessions', item: session };
      return new Response(JSON.stringify(body), { status: 200 });
    },
    openAuthenticatedChanges: async () => changes,
    openAuthenticatedHuman: async () => human,
  };
  const { transport, profile } = createPublic019Transport({
    baseUrl: 'https://host.example', build: 2334, sha: version.sha, host, responseTimeoutMs: 1000,
  });
  return { transport, profile, paths, changes, human };
}

describe('public 0.1.9 source mapping and unsupported gates', () => {
  it('pins the exact observed build, retains raw metadata, and reads session detail', async () => {
    const { transport, profile, paths } = setup();
    const signal = new AbortController().signal;
    expect(await transport.inspectTarget(signal)).toEqual({ identity: profile.identity, capabilities: profile.capabilities });
    expect(await transport.readSession(sessionKey, signal)).toMatchObject({ sessionKey, rowVersion: 4, raw: { clearedThroughSeq: 7 } });
    expect(paths).toEqual(['https://host.example/version', 'https://host.example/api/sessions/s-public']);
    expect(decodePublic019Message(item, sessionKey)).toMatchObject({
      id: 'm_1', seq: 9, clientMessageId: 'c_1', raw: { unknownMetadata: { preserved: true } },
    });
  });

  it('rejects a fabricated source SHA and refuses a different observed build', async () => {
    const host: Public019Host = {
      currentIdentity: () => identity,
      fetch: async () => new Response(JSON.stringify({ ...version, build: 2335 }), { status: 200 }),
      openAuthenticatedChanges: async () => new Channel(),
      openAuthenticatedHuman: async () => new Channel(),
    };
    expect(() => createPublic019Transport({ baseUrl: 'https://host.example', build: 2334,
      sha: 'd33c510fnot-the-source', host })).toThrow();
    const { transport, profile } = createPublic019Transport({ baseUrl: 'https://host.example',
      build: 2334, sha: version.sha, host });
    const observed = await transport.inspectTarget(new AbortController().signal);
    expect(observed.identity).not.toBe(profile.identity);
    expect(Object.values(observed.capabilities).every((capability) => !capability)).toBe(true);
  });

  it('does not turn the oldest-first REST collection into tail, older, markers, or coverage', async () => {
    const { transport, profile, paths, changes } = setup();
    const signal = new AbortController().signal;
    await expect(transport.readTail(sessionKey, signal)).rejects.toThrow(UnsupportedTargetError);
    await expect(transport.readOlder(sessionKey, 'opaque', signal)).rejects.toThrow(UnsupportedTargetError);
    expect(transport.proveCoverage({ sessionKey, rowVersion: 4, raw: session },
      { records: [], oldestCursor: null, hasOlder: false, coverage: null }, [])).toBe(false);
    expect(() => decodePublic019Message({ ...item, messageType: 'marker' }, sessionKey)).toThrow(UnsupportedTargetError);
    const runtime = createTightbeamAdapter(transport, profile).open(sessionKey);
    await vi.waitFor(() => expect(runtime.getSnapshot().status).toBe('unsupported'));
    expect(paths).toEqual(['https://host.example/version']);
    expect(changes.sent).toEqual([]);
    runtime.dispose();
  });

  it('decodes protocol-2 selected-session notices and refuses fabricated marker data', () => {
    const notice = {
      type: 'change', schemaVersion: 2, subscriptionId: 'chat:s-public', seq: 1,
      class: 'message.created', resource: 'messages', op: 'upsert',
      refs: { sessionKey, messageId: 'm_1' }, payload: item,
    };
    expect(decodePublic019Notice(notice, sessionKey)).toMatchObject({ operation: 'upsert', record: { id: 'm_1' } });
    expect(() => decodePublic019Notice({ ...notice, payload: { ...item, messageType: 'marker' } }, sessionKey))
      .toThrow(UnsupportedTargetError);
    expect(decodePublic019Notice({ ...notice, class: 'turn.started', resource: 'turns' }, sessionKey))
      .toEqual({ operation: 'unknown', sessionKey, resource: 'turn.started' });
    expect(() => decodePublic019Notice({ ...notice, refs: { sessionKey: 'other' } }, sessionKey))
      .toThrow(UnsupportedTargetError);
  });

  it('subscribes after host auth, waits for readiness, and flags sequence gaps and disconnect', async () => {
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
    changes.disconnect();
    expect(doubts).toHaveLength(2);
    connection.close();
    expect(changes.closed).toBe(true);
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
      build: 2334, sha: version.sha, host });
    expect(await transport.sendHuman({ sessionKey, deviceId: 'device-1',
      clientMessageId: 'c_1', content: 'hello' }, new AbortController().signal))
      .toMatchObject({ outcome: 'refused' });
    expect(channel.sent).toEqual([]);
    expect(channel.closed).toBe(true);
  });
});
