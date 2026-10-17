import { describe, expect, it } from 'vitest';
import {
  gatewayBridgeUrl, parseGatewayBridgeTarget, resolveEntrySelection,
  sameOriginBridgeOrigin,
} from '../examples/entry';

const configured = {
  gateway: 'https://default.example:8443',
  sessionKey: 'agent:default/chat',
  principalKey: 'example-user',
  deviceId: 'chat_abc123',
};

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
});
