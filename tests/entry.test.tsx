import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  it('keeps entry private while selected-target service verification is unavailable', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture'));
    const socketSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', socketSpy);

    render(<HostPage defaultTarget={defaultTarget} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByText(defaultTarget.gateway)).toBeNull();
    expect(screen.queryByText(defaultTarget.sessionKey)).toBeNull();
    expect(screen.queryByLabelText(/device id|device token/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /sign in|pair/i })).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(request.pathname).toBe('/__chat/gateway/version');
    expect(request.searchParams.get('gateway')).toBe(defaultTarget.gateway);
    expect(socketSpy).not.toHaveBeenCalled();
  });

  it('accepts a newer Gateway release that exposes API protocol 1', async () => {
    const sockets: { url: string; close: () => void; send: (data: string) => void }[] = [];
    class WebSocketStub {
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor(readonly url: string) { sockets.push(this); }
      close() {}
      send(_data: string) {}
    }
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      server: 'tightbeam', version: '0.1.11', build: 3390, sha: '306f423d', protocolVersion: 1,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', WebSocketStub);

    render(<HostPage defaultTarget={defaultTarget} />);

    await waitFor(() => expect(sockets).toHaveLength(1));
    const socketUrl = new URL(sockets[0].url);
    expect(socketUrl.pathname).toBe('/__chat/ws/changes');
    expect(socketUrl.searchParams.get('protocolVersion')).toBe('2');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not expose target identity while a linked conversation is unavailable', async () => {
    const linkedSession = 'agent:example/linked-chat';
    const search = new URLSearchParams({ gateway: defaultTarget.gateway, session: linkedSession }).toString();
    window.history.replaceState({}, '', `/?${search}`);
    const fetchSpy = vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture'));
    vi.stubGlobal('fetch', fetchSpy);

    render(<HostPage defaultTarget={defaultTarget} />);

    expect(await screen.findByRole('alert')).toBeTruthy();
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

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No Gateway access is provisioned for the selected conversation.');
    expect(alert.textContent).toContain('selected target was not changed');
    expect(screen.queryByText('https://other.example')).toBeNull();
    expect(screen.queryByText('agent:other/chat')).toBeNull();
    const recoveryLink = screen.getByRole('link', { name: 'Open the configured conversation' });
    expect(recoveryLink.getAttribute('href')).toBe('/');
    expect(recoveryLink.closest('main.chat-entry-state')).not.toBeNull();
    const siteStyles = readFileSync(resolve(process.cwd(), 'examples/site.css'), 'utf8');
    expect(siteStyles).toMatch(/\.chat-entry-state\s+a\s*\{[^}]*color:\s*var\(--tb-chat-fjord\)/);
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
