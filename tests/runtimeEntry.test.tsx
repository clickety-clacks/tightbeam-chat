import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { RuntimeEntry } from '../examples/RuntimeEntry';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

function jsonResponse(value: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => value } as Response;
}

const target = {
  gateway: 'https://gateway.example:8443',
  sessionKey: 'agent:example/chat?tab=1',
  principalKey: 'example-user',
  deviceId: 'chat_abc123',
};

describe('runtime-configured browser entry', () => {
  it('loads the nonsecret target from same origin and starts without a credential form', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(target))
      .mockResolvedValueOnce(jsonResponse({}, false));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', vi.fn());

    render(<RuntimeEntry />);

    expect(await screen.findByRole('heading', { name: 'Selected conversation' })).toBeTruthy();
    expect(screen.getByText(target.gateway)).toBeTruthy();
    expect(screen.getByText(target.sessionKey)).toBeTruthy();
    expect(screen.getByText('Using the configured conversation.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sign in|pair/i })).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('/chat-config.json');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = new URL(String(fetchMock.mock.calls[1][0]));
    expect(request.pathname).toBe('/__chat/gateway/version');
    expect(request.searchParams.get('gateway')).toBe(target.gateway);
  });

  it('routes a different-Gateway link exactly and offers recovery when no mapping exists', async () => {
    window.history.replaceState({}, '', '/?gateway=https%3A%2F%2Fother.example&session=agent%3Aother%2Fchat');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(target))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'chat_gateway_unavailable' } }, false, 503));
    vi.stubGlobal('fetch', fetchMock);

    render(<RuntimeEntry />);

    const link = await screen.findByRole('link', { name: 'Open the configured conversation' });
    expect(link.getAttribute('href')).toBe('/');
    expect(screen.getByRole('alert').textContent).toContain('No Gateway access is provisioned for the selected conversation.');
    expect(screen.getByText('https://other.example')).toBeTruthy();
    expect(screen.getByText('agent:other/chat')).toBeTruthy();
    expect(screen.getByText('Opened from its private link.')).toBeTruthy();
    expect(screen.queryByText(target.gateway)).toBeNull();
    expect(screen.queryByRole('button', { name: /sign in|pair/i })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('/chat-config.json');
    const request = new URL(String(fetchMock.mock.calls[1][0]));
    expect(request.searchParams.get('gateway')).toBe('https://other.example');
  });

  it('selects a linked session on the configured Gateway after loading service configuration', async () => {
    const linkedSession = 'agent:example/linked-chat';
    window.history.replaceState({}, '', `/?gateway=${encodeURIComponent(target.gateway)}&session=${encodeURIComponent(linkedSession)}`);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(target))
      .mockResolvedValueOnce(jsonResponse({}, false));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', vi.fn());

    render(<RuntimeEntry />);

    expect(await screen.findByRole('heading', { name: 'Selected conversation' })).toBeTruthy();
    expect(screen.getByText('Opened from its private link.')).toBeTruthy();
    expect(screen.getByText(linkedSession)).toBeTruthy();
    expect(screen.queryByText(target.sessionKey)).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe('/chat-config.json');
  });

  it('identifies a complete link even when the service configuration cannot load', async () => {
    const linkedGateway = 'https://other.example:9443';
    const linkedSession = 'agent:other/chat';
    window.history.replaceState({}, '', `/?gateway=${encodeURIComponent(linkedGateway)}&session=${encodeURIComponent(linkedSession)}`);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));

    render(<RuntimeEntry />);

    expect(await screen.findByText(linkedGateway)).toBeTruthy();
    expect(screen.getByText(linkedSession)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('no configured identity');
  });

  it('fails closed with a readable error when runtime configuration is invalid', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ gateway: 'file:///tmp' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<RuntimeEntry />);

    expect((await screen.findByRole('alert')).textContent).toBe('The Chat server returned an invalid default target.');
    expect(screen.queryByRole('button', { name: /sign in|pair/i })).toBeNull();
  });
});
