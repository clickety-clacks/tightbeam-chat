// Browser-held Tightbeam device bridge (CHAT_DEVICE_PAIRING).
//
// The browser pairs itself as its own Gateway device with a one-time code. The
// returned device token lives only in an HttpOnly, host-only cookie scoped to
// /__chat/device. This server parses it from the request, uses it for that
// request's short Gateway socket(s), and never stores, logs or caches it.

export const DEVICE_COOKIE_NAME = '__Secure-tb-chat-device';
export const DEVICE_COOKIE_PATH = '/__chat/device';
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 34_560_000;
export const DEVICE_ROUTE_PREFIX = '/__chat/device';

const DEVICE_ID_PATTERN = /^chat-web-[0-9a-f]{32}$/;
const CLIENT_MESSAGE_ID_PATTERN = /^c_[A-Za-z0-9_-]{1,128}$/;
// RFC 6265 cookie-octet, so the token can be stored without quoting or encoding.
const COOKIE_OCTETS_PATTERN = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,2048}$/;
const DEAD_CREDENTIAL_REASONS = new Set(['token_revoked', 'auth_failed', 'device_not_approved', 'user_removed']);
const PAIR_BODY_LIMIT_BYTES = 16 * 1024;
const SEND_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 15_000;
const SYNC_GRACE_MS = 3_000;
const COMMAND_OUTCOME_TIMEOUT_MS = 10_000;
const COMMAND_QUIET_MS = 1_000;

const defaultTimings = Object.freeze({
  operationTimeoutMs: OPERATION_TIMEOUT_MS,
  syncGraceMs: SYNC_GRACE_MS,
  commandOutcomeTimeoutMs: COMMAND_OUTCOME_TIMEOUT_MS,
  commandQuietMs: COMMAND_QUIET_MS,
  retryDelayMs: () => 50 + Math.floor(Math.random() * 100),
});

function canonicalRequestOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname ||
        value.includes('?') || value.includes('#') ||
        parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/** True when the request path is under the device bridge. */
export function isDeviceRoute(pathname) {
  return pathname === DEVICE_ROUTE_PREFIX || pathname.startsWith(`${DEVICE_ROUTE_PREFIX}/`);
}

/**
 * C1a guard. Exact Chat origin (a missing Origin is refused), the anti-forgery
 * header on every state-changing request, no preflight, no CORS headers.
 */
export function deviceRequestAllowed(request, publicOrigin) {
  if (!publicOrigin) return false;
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || canonicalRequestOrigin(origin) !== publicOrigin) return false;
  // Browsers that send Fetch Metadata must also call this same-origin.
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false;
  const method = request.method ?? 'GET';
  if (method === 'OPTIONS') return false;
  if (method !== 'GET' && method !== 'HEAD' && request.headers['x-tightbeam-chat'] !== '1') return false;
  return true;
}

function cookieAttributes(maxAge) {
  return `HttpOnly; Secure; SameSite=Strict; Path=${DEVICE_COOKIE_PATH}; Max-Age=${maxAge}`;
}

function setDeviceCookie(deviceId, token) {
  return `${DEVICE_COOKIE_NAME}=${deviceId}.${token}; ${cookieAttributes(DEVICE_COOKIE_MAX_AGE_SECONDS)}`;
}

function clearDeviceCookie() {
  return `${DEVICE_COOKIE_NAME}=; ${cookieAttributes(0)}`;
}

/**
 * Reads this request's device credential. More than one cookie with the name
 * (for example one tossed in by a sibling host) is a conflict, never a choice.
 */
function readDeviceCookie(request) {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || !header) return { kind: 'absent' };
  const values = [];
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === DEVICE_COOKIE_NAME) values.push(part.slice(index + 1).trim());
  }
  if (values.length === 0) return { kind: 'absent' };
  if (values.length > 1) return { kind: 'conflict' };
  const value = values[0];
  const dot = value.indexOf('.');
  const deviceId = dot > 0 ? value.slice(0, dot) : '';
  const token = dot > 0 ? value.slice(dot + 1) : '';
  if (!DEVICE_ID_PATTERN.test(deviceId) || !COOKIE_OCTETS_PATTERN.test(token)) return { kind: 'malformed' };
  return { kind: 'present', deviceId, token };
}

function writeJson(response, status, value, cookie) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
    'x-content-type-options': 'nosniff',
    ...(cookie ? { 'set-cookie': cookie } : {}),
  });
  response.end(body);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) return { error: 'payload_too_large' };
    chunks.push(Buffer.from(chunk));
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
  catch { return { error: 'invalid_request' }; }
  let value;
  try { value = JSON.parse(text); }
  catch { return { error: 'invalid_request' }; }
  return { text, value };
}

function validPairRequest(value) {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'claimedName,deviceId,deviceInfo,protocolVersion,type') return false;
  if (value.type !== 'pair_request' || value.protocolVersion !== 1) return false;
  if (typeof value.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(value.deviceId)) return false;
  if (typeof value.claimedName !== 'string' || !value.claimedName.trim() || value.claimedName.length > 64) return false;
  if (!plainObject(value.deviceInfo)) return false;
  const info = Object.entries(value.deviceInfo);
  return info.length <= 8 && info.every(([, item]) => typeof item === 'string' && item.length <= 256);
}

function validSendRequest(value) {
  if (!plainObject(value)) return false;
  if (Object.keys(value).some((key) => !['sessionKey', 'id', 'content', 'attachments'].includes(key))) return false;
  if (typeof value.sessionKey !== 'string' || !value.sessionKey.trim()) return false;
  if (typeof value.id !== 'string' || !CLIENT_MESSAGE_ID_PATTERN.test(value.id)) return false;
  if (typeof value.content !== 'string') return false;
  if (value.attachments !== undefined && !Array.isArray(value.attachments)) return false;
  return true;
}

function gatewaySocketUrl(base) {
  const url = new URL('/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/**
 * One short Gateway socket. Frames are delivered to `onFrame`; `onEnd` runs once
 * when the socket closes or fails. Nothing about the credential is retained.
 */
function openGatewaySocket(gatewayBase, publicOrigin, { onOpen, onFrame, onEnd }) {
  const WebSocketImpl = globalThis.WebSocket;
  let ended = false;
  const end = (reason) => {
    if (ended) return;
    ended = true;
    onEnd(reason);
  };
  let socket;
  try {
    socket = new WebSocketImpl(gatewaySocketUrl(gatewayBase), { headers: { origin: publicOrigin } });
  } catch {
    queueMicrotask(() => end('unreachable'));
    return { send() {}, close() {} };
  }
  socket.onopen = () => { if (!ended) onOpen(); };
  socket.onmessage = (event) => {
    if (ended || typeof event.data !== 'string') return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (plainObject(frame)) onFrame(frame);
  };
  socket.onerror = () => end('unreachable');
  socket.onclose = () => end('closed');
  return {
    send(text) { if (!ended) socket.send(text); },
    close() {
      ended = true;
      try { socket.close(); } catch { /* already closing */ }
    },
  };
}

/** Sends the browser's exact pair_request bytes and returns the single reply. */
function exchangePairRequest(gatewayBase, publicOrigin, text, timings) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timings.operationTimeoutMs);
    const socket = openGatewaySocket(gatewayBase, publicOrigin, {
      onOpen: () => socket.send(text),
      onFrame: (frame) => {
        if (frame.type === 'pair_result' || frame.type === 'error') finish({ kind: 'frame', frame });
      },
      onEnd: (reason) => finish({ kind: reason }),
    });
  });
}

function authFrame(deviceId, token) {
  return JSON.stringify({ type: 'auth', protocolVersion: 1, token, deviceId, subscriptions: ['chat'] });
}

function authFailureReason(frame) {
  for (const value of [frame.reason, frame.code, frame.error?.code]) {
    if (typeof value === 'string' && value) return value;
  }
  return 'auth_failed';
}

/** W2 auth on a short socket, closed as soon as auth_result arrives. */
function verifyDeviceAuth(gatewayBase, publicOrigin, credential, timings) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timings.operationTimeoutMs);
    const socket = openGatewaySocket(gatewayBase, publicOrigin, {
      onOpen: () => socket.send(authFrame(credential.deviceId, credential.token)),
      onFrame: (frame) => {
        if (frame.type === 'auth_result') {
          finish(frame.success === true ? { kind: 'success', frame } : { kind: 'refused', reason: authFailureReason(frame) });
        } else if (frame.type === 'error' && !frame.messageId && !frame.id) {
          finish({ kind: 'refused', reason: authFailureReason(frame) });
        }
      },
      onEnd: (reason) => finish({ kind: reason }),
    });
  });
}

function isTakeover(frame) {
  return frame.type === 'session_replaced' || frame.code === 'session_replaced' || frame.reason === 'session_replaced';
}

function isCommand(content) {
  return /^\/tightbeam(?:\s|$)/.test(content);
}

/**
 * One per-send attempt (W5): auth, wait out replay, send the message frame with
 * the browser's id, wait for its ack or error, and for a /tightbeam command
 * collect every following message frame for the session (echo, outcome, and any
 * ephemeral secret or code) until the socket is quiet.
 */
function sendAttempt(gatewayBase, publicOrigin, credential, message, timings) {
  return new Promise((resolve) => {
    let settled = false;
    let sent = false;
    let ack;
    const messages = [];
    let graceTimer;
    let outcomeTimer;
    let quietTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(outcomeTimer);
      clearTimeout(quietTimer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish(ack ? { kind: 'accepted', ack, messages, complete: false }
      : { kind: sent ? 'unconfirmed' : 'timeout', sent }), timings.operationTimeoutMs);
    const sendMessage = () => {
      if (sent || settled) return;
      clearTimeout(graceTimer);
      sent = true;
      socket.send(JSON.stringify({
        type: 'message', id: message.id, sessionKey: message.sessionKey, content: message.content,
        ...(message.attachments ? { attachments: message.attachments } : {}),
      }));
    };
    const command = isCommand(message.content);
    // A command's replies are complete once the socket has been quiet for commandQuietMs.
    const endCommandReplies = () => finish({ kind: 'accepted', ack, messages, complete: true });
    const socket = openGatewaySocket(gatewayBase, publicOrigin, {
      onOpen: () => socket.send(authFrame(credential.deviceId, credential.token)),
      onFrame: (frame) => {
        if (isTakeover(frame)) { if (!ack) finish({ kind: 'replaced', sent }); else finish({ kind: 'accepted', ack, messages, complete: false }); return; }
        if (frame.type === 'auth_result') {
          if (frame.success !== true) { finish({ kind: 'refused-auth', reason: authFailureReason(frame) }); return; }
          // Replay arrives before sync_complete; the grace covers a Gateway that omits it.
          graceTimer = setTimeout(sendMessage, timings.syncGraceMs);
          return;
        }
        if (frame.type === 'sync_complete') { sendMessage(); return; }
        if (!sent) {
          if (frame.type === 'error' && !frame.messageId && !frame.id) {
            finish({ kind: 'refused-auth', reason: authFailureReason(frame) });
          }
          return;
        }
        if (!ack) {
          if (frame.type === 'ack' && frame.id === message.id) {
            ack = frame;
            if (!command) { finish({ kind: 'accepted', ack, messages, complete: true }); return; }
            outcomeTimer = setTimeout(() => finish({ kind: 'accepted', ack, messages, complete: false }),
              timings.commandOutcomeTimeoutMs);
            quietTimer = setTimeout(endCommandReplies, timings.commandQuietMs);
          } else if (frame.type === 'error' && (frame.messageId === message.id || frame.id === message.id)) {
            finish({ kind: 'refused', error: { code: typeof frame.code === 'string' && frame.code ? frame.code : 'refused',
              ...(typeof frame.message === 'string' ? { message: frame.message } : {}) } });
          }
          return;
        }
        if (frame.type === 'message' && (frame.sessionKey === undefined || frame.sessionKey === message.sessionKey)) {
          // Echo, outcome, and any ephemeral reply (a recovery secret or pairing code) for
          // this device only. They pass through to this response and are never recorded.
          messages.push(frame);
          clearTimeout(quietTimer);
          quietTimer = setTimeout(endCommandReplies, timings.commandQuietMs);
        }
      },
      onEnd: (reason) => {
        if (ack) finish({ kind: 'accepted', ack, messages, complete: false });
        else finish({ kind: reason === 'closed' ? 'replaced' : 'unreachable', sent });
      },
    });
  });
}

/**
 * Creates the request handler for /__chat/device/*. `resolveGateway(url)`
 * returns the configured Gateway base for this request, or a refusal code.
 */
export function createDeviceBridge({ publicOrigin, resolveGateway, timings: timingOverrides } = {}) {
  const timings = { ...defaultTimings, ...timingOverrides };

  async function pair(request, response, gatewayBase) {
    const body = await readBody(request, PAIR_BODY_LIMIT_BYTES);
    if (body.error) { writeJson(response, body.error === 'payload_too_large' ? 413 : 400, { error: { code: body.error } }); return; }
    if (!validPairRequest(body.value)) { writeJson(response, 400, { error: { code: 'invalid_pair_request' } }); return; }
    const deviceId = body.value.deviceId;
    const reply = await exchangePairRequest(gatewayBase, publicOrigin, body.text, timings);
    if (reply.kind !== 'frame') {
      writeJson(response, reply.kind === 'timeout' ? 504 : 502,
        { success: false, reason: reply.kind === 'timeout' ? 'gateway_timeout' : 'gateway_unavailable' });
      return;
    }
    const frame = reply.frame;
    if (frame.type === 'error') {
      const reason = typeof frame.code === 'string' && frame.code ? frame.code : 'error';
      writeJson(response, 200, { success: false, reason,
        ...(typeof frame.message === 'string' ? { message: frame.message } : {}) });
      return;
    }
    if (frame.success !== true) {
      writeJson(response, 200, { success: false,
        reason: typeof frame.reason === 'string' && frame.reason ? frame.reason : 'pairing_failed',
        ...(typeof frame.message === 'string' ? { message: frame.message } : {}) });
      return;
    }
    const token = frame.token;
    if (typeof token !== 'string' || !COOKIE_OCTETS_PATTERN.test(token) || typeof frame.userId !== 'string') {
      writeJson(response, 502, { success: false, reason: 'invalid_pair_result' });
      return;
    }
    const scope = typeof frame.scope === 'string' ? frame.scope : undefined;
    // First sign-in at once (W2): it completes delivery of the paired credential.
    const signIn = await verifyDeviceAuth(gatewayBase, publicOrigin, { deviceId, token }, timings);
    if (signIn.kind === 'refused' && DEAD_CREDENTIAL_REASONS.has(signIn.reason)) {
      writeJson(response, 200, { success: false, reason: signIn.reason });
      return;
    }
    const signedInScope = signIn.kind === 'success' && typeof signIn.frame.scope === 'string' ? signIn.frame.scope : scope;
    writeJson(response, 200, {
      success: true,
      userId: frame.userId,
      deviceId,
      ...(signedInScope ? { scope: signedInScope } : {}),
      signedIn: signIn.kind === 'success',
    }, setDeviceCookie(deviceId, token));
  }

  async function status(request, response, gatewayBase) {
    const cookie = readDeviceCookie(request);
    if (cookie.kind === 'absent') { writeJson(response, 200, { paired: false }); return; }
    if (cookie.kind === 'conflict') { writeJson(response, 409, { error: { code: 'device_cookie_conflict' } }); return; }
    if (cookie.kind === 'malformed') {
      writeJson(response, 200, { paired: false, reason: 'invalid_device_cookie' }, clearDeviceCookie());
      return;
    }
    const result = await verifyDeviceAuth(gatewayBase, publicOrigin, cookie, timings);
    if (result.kind === 'success') {
      writeJson(response, 200, { paired: true, deviceId: cookie.deviceId, verified: true,
        ...(typeof result.frame.userId === 'string' ? { userId: result.frame.userId } : {}),
        ...(typeof result.frame.scope === 'string' ? { scope: result.frame.scope } : {}) });
      return;
    }
    if (result.kind === 'refused' && DEAD_CREDENTIAL_REASONS.has(result.reason)) {
      writeJson(response, 200, { paired: false, reason: result.reason }, clearDeviceCookie());
      return;
    }
    // The Gateway is unreachable or did not answer: the cookie still names a paired device.
    writeJson(response, 200, { paired: true, deviceId: cookie.deviceId, verified: false });
  }

  async function send(request, response, gatewayBase) {
    const cookie = readDeviceCookie(request);
    if (cookie.kind === 'conflict') { writeJson(response, 409, { error: { code: 'device_cookie_conflict' } }); return; }
    if (cookie.kind !== 'present') {
      writeJson(response, 401, { error: { code: 'not_paired' } }, cookie.kind === 'malformed' ? clearDeviceCookie() : undefined);
      return;
    }
    const body = await readBody(request, SEND_BODY_LIMIT_BYTES);
    if (body.error) { writeJson(response, body.error === 'payload_too_large' ? 413 : 400, { error: { code: body.error } }); return; }
    if (!validSendRequest(body.value)) { writeJson(response, 400, { error: { code: 'invalid_request' } }); return; }
    const message = body.value;
    let result = await sendAttempt(gatewayBase, publicOrigin, cookie, message, timings);
    if (result.kind === 'replaced') {
      // Another tab's short socket took over this device's connection. The same
      // client message id makes the single retry safe (Gateway dedupe).
      await new Promise((resolve) => setTimeout(resolve, timings.retryDelayMs()));
      const retry = await sendAttempt(gatewayBase, publicOrigin, cookie, message, timings);
      result = retry.kind === 'replaced' ? { ...retry, sent: retry.sent || result.sent } : retry;
    }
    switch (result.kind) {
      case 'accepted':
        writeJson(response, 200, { outcome: 'accepted', ack: result.ack,
          ...(isCommand(message.content) ? { messages: result.messages, complete: result.complete } : {}) });
        return;
      case 'refused':
        writeJson(response, 200, { outcome: 'refused', error: result.error });
        return;
      case 'refused-auth':
        if (DEAD_CREDENTIAL_REASONS.has(result.reason)) {
          writeJson(response, 401, { error: { code: 'token_revoked', reason: result.reason,
            message: "This browser's device credential is no longer accepted. Pair this browser again with a new code." } },
          clearDeviceCookie());
        } else {
          writeJson(response, 503, { error: { code: result.reason, sent: false } });
        }
        return;
      default:
        if (result.sent) writeJson(response, 504, { error: { code: 'send_unconfirmed', sent: true } });
        else writeJson(response, 503, { error: { code: 'gateway_unavailable', sent: false } });
    }
  }

  return async function handleDeviceRequest(request, response) {
    if (!deviceRequestAllowed(request, publicOrigin)) {
      response.writeHead(403, { 'cache-control': 'no-store' }).end();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://chat.invalid');
    const route = url.pathname.slice(DEVICE_ROUTE_PREFIX.length);
    // Every route is a POST: browsers omit Origin on same-origin GETs, and status signs in with the credential.
    const method = ['/pair', '/status', '/send', '/forget'].includes(route) ? 'POST' : undefined;
    if (!method) { writeJson(response, 404, { error: { code: 'not_found' } }); return; }
    if (request.method !== method) {
      response.writeHead(405, { allow: method, 'cache-control': 'no-store' }).end();
      return;
    }
    if (route === '/forget') {
      // Forgetting clears this browser's cookie only; revoking the device is a separate act.
      writeJson(response, 200, { paired: false }, clearDeviceCookie());
      return;
    }
    const gateway = resolveGateway(url);
    if (!gateway.base) { writeJson(response, gateway.status ?? 503, { error: { code: gateway.code } }); return; }
    try {
      if (route === '/pair') await pair(request, response, gateway.base);
      else if (route === '/status') await status(request, response, gateway.base);
      else await send(request, response, gateway.base);
    } catch {
      if (!response.headersSent) writeJson(response, 502, { error: { code: 'gateway_unavailable' } });
      else response.destroy();
    }
  };
}

/** Content-Security-Policy for every page and asset while the device flag is on. */
export function contentSecurityPolicy(publicOrigin) {
  let sockets = '';
  try {
    const origin = new URL(publicOrigin);
    sockets = ` ${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}`;
  } catch { /* connect-src 'self' alone */ }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${sockets}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
