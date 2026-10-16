import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HostPage } from '../examples/HostPage';

const defaultTarget = { gateway: 'https://gateway.example:8443', sessionKey: 'agent:default/chat' };

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
});

describe('browser entry page', () => {
  it('shows the configured target before sign-in without connecting or creating credentials', () => {
    const fetchSpy = vi.fn();
    const socketSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', socketSpy);

    render(<HostPage defaultTarget={defaultTarget} />);

    expect(screen.getByRole('heading', { name: 'Selected target' })).toBeTruthy();
    expect(screen.getByText('https://gateway.example:8443')).toBeTruthy();
    expect(screen.getByText('agent:default/chat')).toBeTruthy();
    expect(screen.getByText('Using the configured target.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('button', { name: /pair/i })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
  });

  it('identifies the exact linked session and does not replace it with the configured default', () => {
    const gateway = 'https://alternate.example:9443';
    const sessionKey = 'agent:alternate/chat?tab=1';
    const search = new URLSearchParams({ gateway, session: sessionKey }).toString();
    window.history.replaceState({}, '', `/?${search}`);

    render(<HostPage defaultTarget={defaultTarget} />);

    expect(screen.getByText(gateway)).toBeTruthy();
    expect(screen.getByText(sessionKey)).toBeTruthy();
    expect(screen.getByText('Selected from this link.')).toBeTruthy();
    expect(screen.queryByText('agent:default/chat')).toBeNull();
  });

  it('shows a safe recovery route for invalid input without echoing rejected values or selecting the default', () => {
    window.history.replaceState({}, '', '/?gateway=bad%3A%2F%2Fsecret-host&session=private-session&token=private-token');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<HostPage defaultTarget={defaultTarget} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('requested target was not selected');
    expect(alert.textContent).not.toMatch(/secret-host|private-session|private-token/);
    expect(screen.getByRole('link', { name: 'Use configured default target' }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the real sign-in action separate and disabled outside a secure context', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<HostPage defaultTarget={defaultTarget} />);

    expect(screen.getByRole('alert').textContent).toContain('private HTTPS');
    expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports a missing configured root instead of rendering placeholder selection instructions', () => {
    render(<HostPage defaultTarget={{}} />);
    expect(screen.getByRole('alert').textContent).toContain('no valid default target configured');
    expect(screen.queryByText(/SESSION_KEY|gateway\.example/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });
});
