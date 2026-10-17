import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
  it('shows the configured conversation and opens the service without a login or pairing form', () => {
    const fetchSpy = vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture'));
    const socketSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', socketSpy);

    render(<HostPage defaultTarget={defaultTarget} />);

    expect(screen.getByRole('heading', { name: 'Selected conversation' })).toBeTruthy();
    expect(screen.getByText(defaultTarget.gateway)).toBeTruthy();
    expect(screen.getByText(defaultTarget.sessionKey)).toBeTruthy();
    expect(screen.getByText('Using the configured conversation.')).toBeTruthy();
    expect(screen.queryByLabelText(/device id|device token/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /sign in|pair/i })).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(request.pathname).toBe('/__chat/gateway/version');
    expect(request.searchParams.get('gateway')).toBe(defaultTarget.gateway);
    expect(socketSpy).not.toHaveBeenCalled();
  });

  it('selects a linked conversation on the provisioned Gateway instead of replacing it with the root default', () => {
    const linkedSession = 'agent:example/linked-chat';
    const search = new URLSearchParams({ gateway: defaultTarget.gateway, session: linkedSession }).toString();
    window.history.replaceState({}, '', `/?${search}`);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('fixture')));

    render(<HostPage defaultTarget={defaultTarget} />);

    expect(screen.getByText('Opened from its private link.')).toBeTruthy();
    expect(screen.getByText(linkedSession)).toBeTruthy();
    expect(screen.queryByText(defaultTarget.sessionKey)).toBeNull();
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

    expect(screen.getByText('https://other.example')).toBeTruthy();
    expect(screen.getByText('agent:other/chat')).toBeTruthy();
    expect(screen.getByText('Opened from its private link.')).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No Gateway access is provisioned for the selected conversation.');
    expect(alert.textContent).toContain('selected target was not changed');
    expect(screen.getByRole('link', { name: 'Open the configured conversation' }).getAttribute('href')).toBe('/');
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
