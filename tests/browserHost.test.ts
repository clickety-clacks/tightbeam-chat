import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  gatewayBridgeUrl, parseGatewayBridgeTarget, resolveEntrySelection,
  sameOriginBridgeOrigin,
} from '../examples/entry';
import { browserHost } from '../examples/browserHost';
import { AuthorizationError } from '../src/types';

const configured = {
  gateway: 'https://default.example:8443',
  sessionKey: 'agent:default/chat',
  principalKey: 'example-user',
  deviceId: 'chat_abc123',
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  open() { this.onopen?.(new Event('open')); }
  frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent); }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe('Chat entry selection', () => {
  it('uses the configured target at the root and shows valid linked selections without normalization loss', () => {
    expect(resolveEntrySelection('', configured)).toEqual({
      kind: 'selected',
      source: 'configured',
      target: configured,
    });

    const gateway = configured.gateway;
    const sessionKey = 'agent:example/chat?slot=one&kind=human';
    const search = `?gateway=${encodeURIComponent(gateway)}&session=${encodeURIComponent(sessionKey)}`;
    expect(resolveEntrySelection(search, configured)).toEqual({
      kind: 'selected', source: 'link', target: { ...configured, sessionKey },
    });
  });

  it('selects a complete link to another Gateway without substituting the configured default', () => {
    const gateway = 'https://other.example:9443';
    const sessionKey = 'agent:other/chat';
    const search = `?gateway=${encodeURIComponent(gateway)}&session=${encodeURIComponent(sessionKey)}`;
    expect(resolveEntrySelection(search, configured)).toEqual({
      kind: 'selected',
      source: 'link',
      target: { ...configured, gateway, sessionKey },
    });
  });

  it('rejects malformed, incomplete, duplicate, credential-bearing, and unrecognized query data safely', () => {
    const rejected = [
      '?gateway=ftp%3A%2F%2Fbad.example&session=private-session',
      '?gateway=https%3A%2F%2Fuser%3Asecret%40chat.example&session=private-session',
      '?gateway=https%3A%2F%2Fchat.example%2Fpath&session=private-session',
      '?gateway=https%3A%2F%2Fchat.example%2F%3F&session=private-session',
      '?gateway=https%3A%2F%2Fchat.example%2F%23&session=private-session',
      '?gateway=https%3A%2F%2Fchat.example',
      '?gateway=https%3A%2F%2Fchat.example&gateway=https%3A%2F%2Fother.example&session=private-session',
      '?gateway=https%3A%2F%2Fchat.example&session=private-session&token=private-token',
      '?gateway=%E0%A4%A&session=private-session',
    ];
    for (const search of rejected) {
      const result = resolveEntrySelection(search, configured);
      expect(result.kind).toBe('invalid-selection');
      if (result.kind === 'invalid-selection') {
        expect(result.canRecoverToConfigured).toBe(true);
        expect(result.message).not.toMatch(/private-session|private-token|secret|chat\.example/);
      }
    }
  });

  it('does not silently substitute a default for an invalid selection and reports absent root configuration', () => {
    const invalid = resolveEntrySelection('?gateway=bad&session=other', configured);
    expect(invalid.kind).toBe('invalid-selection');
    expect(resolveEntrySelection('', undefined)).toEqual({
      kind: 'configuration-error', message: 'This Chat entry has no valid default target configured.',
    });
    expect(resolveEntrySelection('', { gateway: 'not a URL', sessionKey: 'agent:example' }).kind)
      .toBe('configuration-error');
  });
});

describe('private browser entry and same-origin gateway bridge', () => {
  it('keeps HTTPS fetch and WebSocket traffic on the selected Chat origin', () => {
    const page = 'https://chat.private.example/';
    const gateway = 'https://gateway.example:8443';
    const fetchUrl = gatewayBridgeUrl(page, gateway, `${gateway}/api/sessions/current`, 'http');
    const socketUrl = gatewayBridgeUrl(page, gateway, '/ws/changes?protocolVersion=2', 'websocket');

    expect(fetchUrl.href).toBe('https://chat.private.example/gateway/https%3A%2F%2Fgateway.example%3A8443/api/sessions/current');
    expect(socketUrl.href).toBe('wss://chat.private.example/gateway/https%3A%2F%2Fgateway.example%3A8443/ws/changes?protocolVersion=2');
    expect(() => gatewayBridgeUrl(page, gateway, 'https://other.example/version', 'http')).toThrow();

    expect(parseGatewayBridgeTarget(`${socketUrl.pathname}${socketUrl.search}`)).toEqual({
      gateway,
      path: '/ws/changes?protocolVersion=2',
    });
    expect(parseGatewayBridgeTarget(`${fetchUrl.pathname}${fetchUrl.search}`)).toEqual({
      gateway,
      path: '/api/sessions/current',
    });
    expect(parseGatewayBridgeTarget('/gateway/https%3A%2F%2Fgateway.example%3A8443/admin')).toBeUndefined();
    expect(parseGatewayBridgeTarget('https://other.example/gateway/https%3A%2F%2Fgateway.example%3A8443/ws'))
      .toBeUndefined();
  });

  it('allows only matching browser origins at the bridge', () => {
    expect(sameOriginBridgeOrigin('https://chat.private.example', 'https://chat.private.example/')).toBe(true);
    expect(sameOriginBridgeOrigin('http://chat.private.example', 'https://chat.private.example/')).toBe(false);
    expect(sameOriginBridgeOrigin('https://other.example', 'https://chat.private.example/')).toBe(false);
    expect(sameOriginBridgeOrigin('not an origin', 'https://chat.private.example/')).toBe(false);
  });

  it('does not time out a human socket after it opens while auth and sync answers are delayed', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const host = browserHost({ ...configured, gateway: 'https://gateway.example' });
    const opening = host.openAuthenticatedHuman(new AbortController().signal);
    let settled = false;
    void opening.then(() => { settled = true; });
    const socket = FakeWebSocket.instances[0]!;

    socket.open();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(settled).toBe(false);
    expect(socket.closed).toBe(false);

    socket.frame({ type: 'auth_result', success: true, userId: configured.principalKey,
      sessionId: `conn_${configured.deviceId}`, sessionKeys: [configured.sessionKey] });
    await vi.advanceTimersByTimeAsync(16_000);
    expect(settled).toBe(false);

    socket.frame({ type: 'sync_complete' });
    const channel = await opening;
    expect(settled).toBe(true);
    channel.send({ type: 'message', id: 'c_send', sessionKey: configured.sessionKey, content: 'hello' });
    expect(socket.sent).toEqual([JSON.stringify({ type: 'message', id: 'c_send',
      sessionKey: configured.sessionKey, content: 'hello' })]);
    channel.close();
  });

  it('reports a human socket that never opens as unreachable through a connection timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const host = browserHost({ ...configured, gateway: 'https://gateway.example' });
    const opening = host.openAuthenticatedHuman(new AbortController().signal);
    const rejected = expect(opening).rejects.toThrow('Chat connection timed out.');
    const socket = FakeWebSocket.instances[0]!;

    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(socket.closed).toBe(true);
  });

  it('treats a non-authentication socket error as a local feature failure', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const host = browserHost({ ...configured, gateway: 'https://gateway.example' });
    const opening = host.openAuthenticatedChanges(new AbortController().signal);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.frame({ type: 'error', code: 'gateway_unavailable' });
    await expect(opening).rejects.toThrow('The Chat connection could not be established.');
    await expect(opening).rejects.not.toBeInstanceOf(AuthorizationError);
    expect(socket.closed).toBe(true);
  });

  it('keeps explicit authentication refusal distinct from service unavailability', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const host = browserHost({ ...configured, gateway: 'https://gateway.example' });
    const opening = host.openAuthenticatedChanges(new AbortController().signal);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.frame({ type: 'error', code: 'unauthorized' });
    await expect(opening).rejects.toBeInstanceOf(AuthorizationError);
  });
});
