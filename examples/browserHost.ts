import { AuthorizationError, type HostIdentity } from '../src/types';
import type { Public019Channel, Public019Host } from '../src/public019';

/** Only nonsecret gateway/session selection is accepted from the link. */
export function selection(search: string) {
  const params = new URLSearchParams(search);
  if ([...params.keys()].some((key) => !['gateway', 'session'].includes(key))) {
    throw new Error('Only gateway and session parameters are allowed. Never put credentials in a link.');
  }
  const gateway = new URL(params.get('gateway') ?? '');
  if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password ||
      gateway.search || gateway.hash || gateway.pathname !== '/') throw new Error('Supply an HTTP(S) gateway origin without credentials.');
  const sessionKey = params.get('session');
  if (!sessionKey?.trim()) throw new Error('Supply the session key in the link.');
  return { gateway: gateway.origin, sessionKey };
}

// Tokens stay in this closure. No persistence, URL auth, or console logging.
export function browserHost(gateway: string, token: string, deviceId: string): Public019Host {
  let identity: HostIdentity = { principalKey: 'pending', deviceId };
  const base = `/gateway/${encodeURIComponent(gateway)}`;
  async function open(path: string, human: boolean, signal: AbortSignal): Promise<Public019Channel> {
    const url = new URL(`${base}${path}`, window.location.origin);
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      let ready = false;
      let authenticated = false;
      let frameListener: ((frame: unknown) => void) | undefined;
      let closeListener: (() => void) | undefined;
      const timer = setTimeout(() => fail(new Error('Gateway authentication timed out.')), 15000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      const fail = (error: Error) => { cleanup(); socket.close(); reject(error); };
      const abort = () => { cleanup(); socket.close(); if (!ready) reject(new Error('Connection aborted.')); };
      const complete = () => {
        ready = true;
        clearTimeout(timer);
        resolve({
          send: (frame) => socket.send(JSON.stringify(frame)),
          listen: (onFrame, onClose) => { frameListener = onFrame; closeListener = onClose;
            return () => { frameListener = undefined; closeListener = undefined; }; },
          close: () => { cleanup(); socket.close(); },
        });
      };
      signal.addEventListener('abort', abort, { once: true });
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', protocolVersion: 1,
        token, deviceId, subscriptions: ['chat'] }));
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data));
          if (ready) { frameListener?.(frame); return; }
          if (frame.type === 'auth_result') {
            if (!frame.success) { fail(new AuthorizationError(`Sign-in refused: ${frame.reason ?? 'unauthorized'}`)); return; }
            // Session credentials can read changes but cannot authenticate human /ws.
            if (frame.sessionKey) { fail(new AuthorizationError('Use a paired device token for chat sending.')); return; }
            if (typeof frame.userId !== 'string' || (human && frame.sessionId !== `conn_${deviceId}`)) {
              fail(new AuthorizationError('Device ID does not match the supplied token.')); return;
            }
            if (identity.principalKey !== 'pending' && identity.principalKey !== frame.userId) {
              fail(new AuthorizationError('Gateway principal changed. Sign in again.')); return;
            }
            identity = { principalKey: frame.userId, deviceId };
            authenticated = true;
            if (!human) complete();
          } else if (frame.type === 'sync_complete' && authenticated) complete();
        } catch { if (!ready) fail(new Error('Invalid gateway authentication response.')); else socket.close(); }
      };
      socket.onerror = () => { if (!ready) fail(new Error('Could not connect to gateway.')); };
      socket.onclose = () => { cleanup(); if (ready) closeListener?.(); else reject(new Error('Gateway closed during sign-in.')); };
      if (signal.aborted) abort();
    });
  }
  return {
    currentIdentity: () => identity,
    fetch: (input, init) => fetch(`${base}${new URL(input).pathname}${new URL(input).search}`, {
      ...init, redirect: 'error', headers: { Authorization: `Bearer ${token}` },
    }),
    openAuthenticatedChanges: (signal) => open('/ws/changes?protocolVersion=2', false, signal),
    openAuthenticatedHuman: (signal) => open('/ws', true, signal),
  };
}

/** Explicit user action creates a separate browser device through normal pairing. */
export function pairDevice(gateway: string, deviceId: string): Promise<string> {
  const url = new URL(`/gateway/${encodeURIComponent(gateway)}/ws`, window.location.origin);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const finish = (error?: Error, token?: string) => {
      clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve(token!);
    };
    const timer = setTimeout(() => finish(new Error('Pairing timed out.')), 15000);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'pair_request', protocolVersion: 1,
      deviceId, claimedName: 'Tightbeam Chat browser', deviceInfo: { platform: 'web', model: 'chat-example' } }));
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type !== 'pair_result') return;
        if (frame.success && typeof frame.token === 'string') finish(undefined, frame.token);
        else finish(new Error(frame.reason === 'pair_pending'
          ? `Ask the gateway administrator to approve device ${deviceId}, then click Pair device again.`
          : `Pairing refused: ${frame.reason ?? 'unknown reason'}`));
      } catch { finish(new Error('Invalid pairing response.')); }
    };
    socket.onerror = () => finish(new Error('Could not connect for pairing.'));
    socket.onclose = () => finish(new Error('Pairing connection closed.'));
  });
}
