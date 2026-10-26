import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { HostPage } from '../examples/HostPage';

const defaultTarget = {
  gateway: 'https://gateway.example:8443',
  sessionKey: 'agent:example/chat',
  principalKey: 'example-user',
  deviceId: 'chat_abc123',
};

beforeEach(() => window.history.replaceState({}, '', '/'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('direct browser entry', () => {
  it('keeps Chat and sending available when conversation endpoints are unavailable', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'chat_gateway_unavailable' },
    }), { status: 503, headers: { 'content-type': 'application/json' } }));
    class IdleWebSocket {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(readonly url: string) {}
      close() {}
      send(_data: string) {}
    }
    const socketSpy = vi.fn(function (url: string) { return new IdleWebSocket(url); });
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', socketSpy);

    render(<HostPage defaultTarget={defaultTarget} />);

    expect(await screen.findByRole('textbox', { name: /message to/i })).toBeTruthy();
    expect(screen.getByText(/Conversation history could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(defaultTarget.gateway)).toBeNull();
    expect(screen.queryByText(defaultTarget.sessionKey)).toBeNull();
    expect(screen.queryByLabelText(/device id|device token/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /sign in|pair/i })).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const request = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(request.pathname).toBe(`/__chat/api/sessions/${encodeURIComponent(defaultTarget.sessionKey)}`);
    expect(request.searchParams.get('gateway')).toBe(defaultTarget.gateway);
    expect(new URL(socketSpy.mock.calls[0][0]).pathname).toBe('/__chat/ws/changes');
  });

  it('opens Chat without querying Gateway release metadata', async () => {
    const sockets: { url: string; close: () => void; send: (data: string) => void }[] = [];
    class WebSocketStub {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(readonly url: string) {
        sockets.push(this);
        queueMicrotask(() => {
          this.onopen?.(new Event('open'));
          this.onmessage?.({ data: JSON.stringify({ type: 'auth_result', success: true,
            userId: defaultTarget.principalKey, sessionKey: defaultTarget.sessionKey }) } as MessageEvent);
        });
      }
      close() {}
      send(data: string) {
        const frame = JSON.parse(data);
        if (frame.type === 'subscribe') {
          this.onmessage?.({ data: JSON.stringify({ type: 'subscription_ready',
            subscriptionId: frame.subscriptionId }) } as MessageEvent);
        }
      }
    }
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      const body = path.includes('/tool-calls')
        ? { schemaVersion: 1, resource: 'tool calls', items: [], page: { hasMoreBefore: false } }
        : path.endsWith('/messages')
        ? { schemaVersion: 1, resource: 'transcript messages', items: [],
          page: { oldestCursor: null, hasMoreBefore: false } }
        : { schemaVersion: 1, resource: 'sessions', item: {
          sessionKey: defaultTarget.sessionKey, rowVersion: 1, displayName: 'Example agent',
        } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', WebSocketStub);

    render(<HostPage defaultTarget={defaultTarget} />);

    await waitFor(() => expect(sockets).toHaveLength(1));
    const socketUrl = new URL(sockets[0].url);
    expect(socketUrl.pathname).toBe('/__chat/ws/changes');
    expect(socketUrl.searchParams.get('protocolVersion')).toBe('2');
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3));
    const paths = fetchSpy.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths.slice(0, 2)).toEqual([
      `/__chat/api/sessions/${encodeURIComponent(defaultTarget.sessionKey)}`,
      `/__chat/api/sessions/${encodeURIComponent(defaultTarget.sessionKey)}/messages`,
    ]);
    expect(paths[2]).toMatch(new RegExp(`/__chat/api/sessions/${encodeURIComponent(defaultTarget.sessionKey)}/tool-calls`));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a linked target selected and reports its local history failure', async () => {
    const linkedSession = 'agent:example/linked-chat';
    const search = new URLSearchParams({ gateway: defaultTarget.gateway, session: linkedSession }).toString();
    window.history.replaceState({}, '', `/?${search}`);
    const fetchSpy = vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture'));
    vi.stubGlobal('fetch', fetchSpy);

    render(<HostPage defaultTarget={defaultTarget} />);

    expect(await screen.findByRole('textbox', { name: /message to/i })).toBeTruthy();
    expect(screen.getByText('Conversation history could not be loaded.')).toBeTruthy();
    expect(screen.queryByText(linkedSession)).toBeNull();
    expect(screen.queryByText(defaultTarget.sessionKey)).toBeNull();
    const request = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(request.searchParams.get('gateway')).toBe(defaultTarget.gateway);
  });

  it('keeps a different-Gateway link selected and reports unavailable mapping without default substitution', async () => {
    window.history.replaceState({}, '', '/?gateway=https%3A%2F%2Fother.example&session=agent%3Aother%2Fchat');
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: 'chat_gateway_unavailable' } }),
    } as Response);
    vi.stubGlobal('fetch', fetchSpy);

    render(<HostPage defaultTarget={defaultTarget} />);

    expect(await screen.findByRole('textbox', { name: /message to/i })).toBeTruthy();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Conversation history could not be loaded/)).toBeTruthy();
    expect(screen.queryByText('https://other.example')).toBeNull();
    expect(screen.queryByText('agent:other/chat')).toBeNull();
    const request = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(request.searchParams.get('gateway')).toBe('https://other.example');
    expect(screen.queryByText(defaultTarget.sessionKey)).toBeNull();
  });

  it('reports missing service configuration without placeholder setup instructions', () => {
    render(<HostPage defaultTarget={{}} />);
    expect(screen.getByRole('alert').textContent).toContain('no valid default target configured');
    expect(screen.queryByText(/SESSION_KEY|gateway\.example/)).toBeNull();
    expect(screen.queryByRole('button', { name: /sign in|pair/i })).toBeNull();
  });
});
