import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RuntimeEntry } from '../examples/RuntimeEntry';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

function jsonResponse(value: unknown, ok = true): Response {
  return { ok, json: async () => value } as Response;
}

describe('runtime-configured browser entry', () => {
  it('loads the nonsecret root target from the same-origin runtime endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      gateway: 'https://gateway.example:8443',
      sessionKey: 'agent:main/chat?tab=1',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const socketMock = vi.fn();
    vi.stubGlobal('WebSocket', socketMock);

    render(<RuntimeEntry />);

    expect(await screen.findByRole('heading', { name: 'Selected target' })).toBeTruthy();
    expect(screen.getByText('https://gateway.example:8443')).toBeTruthy();
    expect(screen.getByText('agent:main/chat?tab=1')).toBeTruthy();
    expect(screen.getByText('Using the configured target.')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe('/chat-config.json');
    expect(socketMock).not.toHaveBeenCalled();
  });

  it('recovers an invalid target link through the configured entry without selecting its rejected values', async () => {
    window.history.replaceState({}, '', '/?gateway=bad%3A%2F%2Fprivate-host&session=private-session&token=secret');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      gateway: 'https://gateway.example', sessionKey: 'agent:main/chat',
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<RuntimeEntry />);

    const link = await screen.findByRole('link', { name: 'Use configured default target' });
    expect(link.getAttribute('href')).toBe('/');
    expect(screen.getByRole('alert').textContent).not.toMatch(/private-host|private-session|secret/);
    expect(screen.queryByText('https://gateway.example')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/chat-config.json');
  });

  it('uses a complete named-target link without waiting for or replacing it with root configuration', () => {
    window.history.replaceState({}, '', '/?gateway=https%3A%2F%2Flinked.example&session=agent%3Alinked%2Fchat');
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    render(<RuntimeEntry />);

    expect(screen.getByText('https://linked.example')).toBeTruthy();
    expect(screen.getByText('agent:linked/chat')).toBeTruthy();
    expect(screen.getByText('Selected from this link.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed with a readable error when runtime configuration is invalid', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ gateway: 'file:///tmp' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<RuntimeEntry />);

    expect((await screen.findByRole('alert')).textContent).toBe('The Chat server returned an invalid default target.');
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
});
