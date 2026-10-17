import { AuthorizationError, type HostIdentity } from '../src/types';
import type { Public019Channel, Public019Host } from '../src/public019';
import type { ChatTarget } from './entry';

function chatSocketUrl(path: '/ws' | '/ws/changes', target: ChatTarget): URL {
  const url = new URL(`/__chat${path}`, window.location.origin);
  if (path === '/ws/changes') url.searchParams.set('protocolVersion', '2');
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
      let closeListener: (() => void) | undefined;
      const timer = setTimeout(() => fail(new Error('Chat connection timed out.')), 15000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const fail = (error: Error) => { cleanup(); socket.close(); reject(error); };
      const abort = () => { cleanup(); socket.close(); if (!ready) reject(new Error('Connection aborted.')); };
      const complete = () => {
        ready = true;
        clearTimeout(timer);
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
          } else if (frame.type === 'error' || frame.type === 'auth_result') {
            fail(new AuthorizationError('The configured Chat connection was refused.'));
          }
        } catch {
          if (!ready) fail(new Error('Invalid Chat connection response.'));
          else socket.close();
        }
      };
      socket.onerror = () => { if (!ready) fail(new Error('Could not connect to the Chat service.')); };
      socket.onclose = () => {
        cleanup();
        if (ready) closeListener?.();
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
