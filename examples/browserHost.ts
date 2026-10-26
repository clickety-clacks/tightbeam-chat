import { AuthorizationError, type HostIdentity } from '../src/types';
import type { Public019Channel, Public019Host } from '../src/public019';
import type { ChatTarget } from './entry';

function isAuthorizationFailureCode(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return ['unauthorized', 'forbidden', 'not_authorized', 'not_authenticated',
    'authentication_failed', 'auth_failed'].includes(value.toLowerCase());
}

function chatSocketUrl(path: '/ws' | '/ws/changes', target: ChatTarget): URL {
  const url = new URL(`/__chat${path}`, window.location.origin);
  if (path === '/ws/changes') url.searchParams.set('protocolVersion', '2');
  url.searchParams.set('gateway', target.gateway);
  url.searchParams.set('sessionKey', target.sessionKey);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

/** The Chat service owns its provisioned Gateway credential and auth frames. */
export function browserHost(target: ChatTarget): Public019Host {
  const identity: HostIdentity = { principalKey: target.principalKey, deviceId: target.deviceId };

  function open(path: '/ws' | '/ws/changes', signal: AbortSignal): Promise<Public019Channel> {
    const human = path === '/ws';
    const socket = new WebSocket(chatSocketUrl(path, target));
    return new Promise((resolve, reject) => {
      let ready = false;
      let authenticated = false;
      let frameListener: ((frame: unknown) => void) | undefined;
      let closeListener: ((event?: { code?: number }) => void) | undefined;
      let connectionTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
        () => fail(new Error('Chat connection timed out.')), 15000);
      const clearConnectionTimer = () => {
        if (connectionTimer !== undefined) clearTimeout(connectionTimer);
        connectionTimer = undefined;
      };
      const cleanup = () => { clearConnectionTimer(); signal.removeEventListener('abort', abort); };
      const fail = (error: Error) => { cleanup(); socket.close(); reject(error); };
      const abort = () => { cleanup(); socket.close(); if (!ready) reject(new Error('Connection aborted.')); };
      const complete = () => {
        ready = true;
        clearConnectionTimer();
        resolve({
          send: (frame) => socket.send(JSON.stringify(frame)),
          listen: (onFrame, onClose) => {
            frameListener = onFrame;
            closeListener = onClose;
            return () => { frameListener = undefined; closeListener = undefined; };
          },
          close: () => { cleanup(); socket.close(); },
        });
      };
      signal.addEventListener('abort', abort, { once: true });
      socket.onopen = () => {
        // For a human send, the connection may wait indefinitely for auth and
        // sync frames. Only failure to open the socket is a connect timeout.
        if (human) clearConnectionTimer();
      };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data));
          if (ready) { frameListener?.(frame); return; }
          if (frame.type === 'auth_result') {
            if (!frame.success || frame.userId !== identity.principalKey) {
              fail(new AuthorizationError('The configured Chat identity was refused.'));
              return;
            }
            if (human) {
              const sessionKeys = Array.isArray(frame.sessionKeys) ? frame.sessionKeys : [];
              if (frame.sessionId !== `conn_${identity.deviceId}` || !sessionKeys.includes(target.sessionKey)) {
                fail(new AuthorizationError('The configured Chat conversation was refused.'));
                return;
              }
              authenticated = true;
            } else {
              if (frame.sessionKey !== target.sessionKey) {
                fail(new AuthorizationError('The configured Chat conversation was refused.'));
                return;
              }
              complete();
            }
          } else if (human && frame.type === 'sync_complete' && authenticated) {
            complete();
          } else if (frame.type === 'error') {
            fail(isAuthorizationFailureCode(frame.code)
              ? new AuthorizationError('The configured Chat connection was refused.')
              : new Error('The Chat connection could not be established.'));
          } else if (frame.type === 'auth_result') {
            fail(new Error('Invalid Chat authentication response.'));
          }
        } catch {
          if (!ready) fail(new Error('Invalid Chat connection response.'));
          else socket.close();
        }
      };
      socket.onerror = () => { if (!ready) fail(new Error('Could not connect to the Chat service.')); };
      socket.onclose = (event) => {
        cleanup();
        if (ready) closeListener?.({ code: event.code });
        else reject(new Error('Chat service closed before connection readiness.'));
      };
      if (signal.aborted) abort();
    });
  }

  return {
    currentIdentity: () => identity,
    fetch: (input, init) => {
      let url: URL;
      try { url = new URL(input, window.location.origin); }
      catch { return Promise.reject(new Error('Invalid Chat service request.')); }
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/__chat/')) {
        return Promise.reject(new Error('Chat requests must remain on the configured service origin.'));
      }
      const gateways = url.searchParams.getAll('gateway');
      if (gateways.length > 1 || (gateways.length === 1 && gateways[0] !== target.gateway)) {
        return Promise.reject(new Error('Chat requests must use the selected Gateway.'));
      }
      url.searchParams.set('gateway', target.gateway);
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      return fetch(url, {
        ...init,
        headers,
        credentials: 'same-origin',
        redirect: 'error',
      });
    },
    openAuthenticatedChanges: (signal) => open('/ws/changes', signal),
    openAuthenticatedHuman: (signal) => open('/ws', signal),
  };
}
