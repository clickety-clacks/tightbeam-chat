import { describe, expect, it } from 'vitest';
import { parseServiceWebSocketTarget } from '../server/chat-server.mjs';

const gatewayOrigin = 'https://gateway.example';
const sessionKey = 'agent:example:linked-chat';
const runtime = { gatewayOrigin, restHumanSendEnabled: false };
const humanSendPath = `/__chat/ws?sessionKey=${encodeURIComponent(sessionKey)}`;

describe('Chat service human-send compatibility route', () => {
  it('keeps the authenticated WebSocket path available by default', () => {
    expect(parseServiceWebSocketTarget(humanSendPath, runtime)).toEqual({
      path: '/ws', kind: 'human', gatewayOrigin, sessionKey,
    });
  });

  it('disables the old route only for the configured Gateway when REST sending is enabled', () => {
    expect(parseServiceWebSocketTarget(humanSendPath, { ...runtime, restHumanSendEnabled: true })).toBeUndefined();
    const otherGatewayPath = `/__chat/ws?gateway=${encodeURIComponent('https://other.example')}` +
      `&sessionKey=${encodeURIComponent(sessionKey)}`;
    expect(parseServiceWebSocketTarget(otherGatewayPath, { ...runtime, restHumanSendEnabled: true })).toEqual({
      path: '/ws', kind: 'human', gatewayOrigin: 'https://other.example', sessionKey,
    });
  });

  it('keeps the versioned changes socket available when REST sending is enabled', () => {
    expect(parseServiceWebSocketTarget(
      `/__chat/ws/changes?sessionKey=${encodeURIComponent(sessionKey)}&protocolVersion=2`,
      { ...runtime, restHumanSendEnabled: true },
    )).toEqual({ path: '/ws/changes?protocolVersion=2', kind: 'changes', gatewayOrigin, sessionKey });
  });
});
