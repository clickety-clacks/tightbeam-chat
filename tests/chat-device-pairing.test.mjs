// @vitest-environment node
// Spec stage2-v5 §C1/§C1a, tests T13 and T13a (server side), both flag states.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatServer } from '../server/chat-server.mjs';
import { FAKE_ISSUED_CODE, FAKE_RECOVERY_SECRET, startFakeDeviceGateway } from './helpers/fakeDeviceGateway.mjs';

const PUBLIC_ORIGIN = 'https://chat.tailnet.example';
const SESSION = 'agent:main:george';
const PRINCIPAL = 'george';
const ORG_TOKEN = 'fixture-organization-credential';
const COOKIE_NAME = '__Secure-tb-chat-device';
const RELEASE = { tag: 'v0.1.2', sourceCommit: '1234567890abcdef1234567890abcdef12345678' };
const FAST_TIMINGS = { operationTimeoutMs: 2_000, syncGraceMs: 200, commandOutcomeTimeoutMs: 1_000, commandQuietMs: 150,
  retryDelayMs: () => 100 };

const cleanups = [];
const temporaryRoots = [];
let captured;

beforeEach(() => {
  // Everything the process writes during a test, to prove no token is ever logged.
  captured = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    vi.spyOn(console, method).mockImplementation((...args) => { captured.push(args.map(String).join(' ')); });
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation((chunk, ...rest) => {
      captured.push(String(chunk));
      return original(chunk, ...rest);
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function startChat({ gateway, flag = true, extraEnvironment = {}, root: existingRoot } = {}) {
  let root = existingRoot;
  if (!root) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-device-pairing-'));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, 'public'));
    await fs.writeFile(path.join(root, 'public', 'index.html'), '<!doctype html><main>Chat</main>');
    const baseDir = path.join(root, 'gateway-base');
    await fs.mkdir(baseDir);
    await fs.writeFile(path.join(baseDir, 'gateway.json'), JSON.stringify({ port: gateway.port, cliToken: ORG_TOKEN }));
  }
  const environment = {
    CHAT_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    CHAT_DEFAULT_GATEWAY_ORIGIN: gateway.origin,
    CHAT_DEFAULT_SESSION_KEY: SESSION,
    CHAT_DEFAULT_PRINCIPAL_KEY: PRINCIPAL,
    TIGHTBEAM_BASE_DIR: path.join(root, 'gateway-base'),
    HOME: root,
    ...(flag ? { CHAT_DEVICE_PAIRING: '1' } : {}),
    ...extraEnvironment,
  };
  const server = createChatServer({ rootDir: root, publicDir: path.join(root, 'public'), releaseInfo: RELEASE,
    environment, deviceTimings: FAST_TIMINGS });
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  };
  cleanups.push(stop);
  return { port: server.address().port, root, environment, stop };
}

async function startGateway(options) {
  const gateway = await startFakeDeviceGateway(options);
  cleanups.push(() => gateway.close());
  return gateway;
}

function call(port, method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const request = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      ...headers,
    } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

const browserHeaders = (extra = {}) => ({ origin: PUBLIC_ORIGIN, 'x-tightbeam-chat': '1', ...extra });

function pairRequest(code = 'TB-ABCD-EFGH-JKLM', deviceId = `chat-web-${crypto.randomBytes(16).toString('hex')}`) {
  return { type: 'pair_request', protocolVersion: 1, deviceId, claimedName: `George's browser ${code}`,
    deviceInfo: { platform: 'web', model: 'Chat' } };
}

function cookieFrom(response) {
  const header = response.headers['set-cookie'];
  expect(header).toHaveLength(1);
  return header[0];
}

async function pair(chat, request = pairRequest()) {
  const response = await call(chat.port, 'POST', '/__chat/device/pair', { headers: browserHeaders(), body: request });
  const setCookie = cookieFrom(response);
  return { response, setCookie, cookie: setCookie.split(';')[0], deviceId: request.deviceId };
}

function tokenOf(gateway) {
  return [...gateway.state.devices.keys()];
}

function expectNoTokenAnywhere(gateway, ...texts) {
  const tokens = tokenOf(gateway);
  expect(tokens.length).toBeGreaterThan(0);
  for (const token of tokens) {
    for (const text of texts) expect(text).not.toContain(token);
    for (const line of captured) expect(line).not.toContain(token);
  }
}

function sendBody(id, content = 'hello from the browser') {
  return { sessionKey: SESSION, id, content };
}

describe('Chat device pairing bridge, flag on (T13)', () => {
  it('pairs by code, forwards the pair_request bytes unchanged, signs in, and sets only the scoped host-only cookie', async () => {
    const gateway = await startGateway();
    const chat = await startChat({ gateway });
    const request = pairRequest();
    const rawBody = JSON.stringify(request);
    const response = await call(chat.port, 'POST', '/__chat/device/pair', { headers: browserHeaders(), body: rawBody });

    expect(response.status).toBe(200);
    // Stage 1 has no scopes; Chat neither requires nor assumes one.
    expect(response.json).toEqual({ success: true, userId: 'george', deviceId: request.deviceId, signedIn: true });
    expect(gateway.state.rawPairTexts).toEqual([rawBody]);
    // First sign-in happened at once (W2) with the new device credential.
    const auth = gateway.state.clientFrames.filter((frame) => frame.type === 'auth');
    expect(auth).toHaveLength(1);
    expect(auth[0]).toMatchObject({ type: 'auth', protocolVersion: 1, deviceId: request.deviceId, subscriptions: ['chat'] });
    expect(Object.keys(auth[0]).sort()).toEqual(['deviceId', 'protocolVersion', 'subscriptions', 'token', 'type']);

    const setCookie = cookieFrom(response);
    const [pairPart, ...attributes] = setCookie.split(';').map((part) => part.trim());
    const [token] = tokenOf(gateway);
    expect(pairPart).toBe(`${COOKIE_NAME}=${request.deviceId}.${token}`);
    expect(attributes).toEqual(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/__chat/device', 'Max-Age=34560000']);
    expect(setCookie.toLowerCase()).not.toContain('domain');
    expect(response.headers).not.toHaveProperty('access-control-allow-origin');
    expectNoTokenAnywhere(gateway, response.text);
  });

  it.each([
    [{ type: 'pair_result', success: false, reason: 'pairing_code_invalid', message: 'That code has expired.' },
      { success: false, reason: 'pairing_code_invalid', message: 'That code has expired.' }],
    [{ type: 'pair_result', success: false, reason: 'pairing_code_required' }, { success: false, reason: 'pairing_code_required' }],
    [{ type: 'pair_result', success: false, reason: 'already_paired' }, { success: false, reason: 'already_paired' }],
    [{ type: 'pair_result', success: false, reason: 'rate_limited' }, { success: false, reason: 'rate_limited' }],
    [{ type: 'error', code: 'rate_limited' }, { success: false, reason: 'rate_limited' }],
    [{ type: 'pair_result', success: false, reason: 'something_new' }, { success: false, reason: 'something_new' }],
  ])('relays pairing failure %j without a cookie', async (reply, expected) => {
    const gateway = await startGateway({ pairReply: () => reply });
    const chat = await startChat({ gateway });
    const response = await call(chat.port, 'POST', '/__chat/device/pair', { headers: browserHeaders(), body: pairRequest() });
    expect(response.status).toBe(200);
    expect(response.json).toEqual(expected);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(gateway.state.clientFrames.filter((frame) => frame.type === 'auth')).toHaveLength(0);
  });

  it('refuses a paired credential that fails first sign-in as dead, without a cookie', async () => {
    const gateway = await startGateway({ pairReply: (frame, state) => {
      const token = 'tbt_dead';
      state.devices.set(token, { deviceId: frame.deviceId, userId: 'george', dead: 'device_not_approved' });
      return { type: 'pair_result', success: true, token, userId: 'george' };
    } });
    const chat = await startChat({ gateway });
    const response = await call(chat.port, 'POST', '/__chat/device/pair', { headers: browserHeaders(), body: pairRequest() });
    expect(response.json).toEqual({ success: false, reason: 'device_not_approved' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it.each([
    ['extra field', { ...pairRequest(), token: 'x' }],
    ['wrong type', { ...pairRequest(), type: 'auth' }],
    ['wrong protocol', { ...pairRequest(), protocolVersion: 2 }],
    ['foreign device id', { ...pairRequest(), deviceId: 'roci-0123456789abcdef0123456789abcdef' }],
    ['uppercase device id', { ...pairRequest(), deviceId: `chat-web-${'A'.repeat(32)}` }],
    ['long name', { ...pairRequest(), claimedName: 'x'.repeat(65) }],
    ['non-object device info', { ...pairRequest(), deviceInfo: ['web'] }],
  ])('rejects a malformed pair request (%s) and contacts no Gateway', async (_name, body) => {
    const gateway = await startGateway();
    const chat = await startChat({ gateway });
    const response = await call(chat.port, 'POST', '/__chat/device/pair', { headers: browserHeaders(), body });
    expect(response.status).toBe(400);
    expect(gateway.state.upgrades).toHaveLength(0);
  });

  it('reports status from the cookie and sends messages and commands on the device connection', async () => {
    const replayed = { type: 'message', sessionKey: SESSION, role: 'user', content: 'replayed history' };
    const gateway = await startGateway({ replay: [replayed, replayed] });
    const chat = await startChat({ gateway });

    expect((await call(chat.port, 'POST', '/__chat/device/status', { headers: browserHeaders() })).json)
      .toEqual({ paired: false });
    // Every bridge route is a POST; a GET is refused before anything else (no Origin from a browser GET).
    expect((await call(chat.port, 'GET', '/__chat/device/status', { headers: { origin: PUBLIC_ORIGIN } })).status).toBe(405);

    const paired = await pair(chat);
    const status = await call(chat.port, 'POST', '/__chat/device/status', { headers: browserHeaders({ cookie: paired.cookie }) });
    expect(status.json).toEqual({ paired: true, deviceId: paired.deviceId, verified: true, userId: 'george' });

    const message = await call(chat.port, 'POST', '/__chat/device/send', {
      headers: browserHeaders({ cookie: paired.cookie }), body: sendBody('c_message_1') });
    expect(message.status).toBe(200);
    expect(message.json).toEqual({ outcome: 'accepted', ack: { type: 'ack', id: 'c_message_1', messageId: 'm_1' } });

    const command = await call(chat.port, 'POST', '/__chat/device/send', {
      headers: browserHeaders({ cookie: paired.cookie }), body: sendBody('c_command_1', '/tightbeam rule dr_x accept') });
    expect(command.status).toBe(200);
    expect(command.json).toEqual({
      outcome: 'accepted', ack: { type: 'ack', id: 'c_command_1', messageId: 'm_2' }, complete: true,
      messages: [
        { type: 'message', sessionKey: SESSION, role: 'user', content: '/tightbeam rule dr_x accept' },
        { type: 'message', sessionKey: SESSION, role: 'system', content: 'outcome for /tightbeam rule dr_x accept' },
      ],
    });

    // Both were sent with this browser's device credential and no organization credential or asUser.
    const recorded = [...gateway.state.recorded.values()];
    expect(recorded.map((frame) => [frame.id, frame.deviceId])).toEqual([
      ['c_message_1', paired.deviceId], ['c_command_1', paired.deviceId]]);
    for (const frame of gateway.state.clientFrames) {
      expect(JSON.stringify(frame)).not.toContain(ORG_TOKEN);
      expect(frame).not.toHaveProperty('asUser');
    }
    expect(gateway.state.clientFrames.filter((frame) => frame.type === 'message'))
      .toEqual([
        { type: 'message', id: 'c_message_1', sessionKey: SESSION, content: 'hello from the browser' },
        { type: 'message', id: 'c_command_1', sessionKey: SESSION, content: '/tightbeam rule dr_x accept' },
      ]);
    expect(gateway.state.httpRequests).toEqual([]);
    expectNoTokenAnywhere(gateway, status.text, message.text, command.text);
  });

  it('passes a scope through for display only when the Gateway reports one', async () => {
    const gateway = await startGateway({ pairReply: (frame, state) => {
      state.devices.set('tbt_full', { deviceId: frame.deviceId, userId: 'george', scope: 'full' });
      return { type: 'pair_result', success: true, token: 'tbt_full', userId: 'george', scope: 'full' };
    } });
    const chat = await startChat({ gateway });
    const paired = await pair(chat);
    expect(paired.response.json).toMatchObject({ success: true, scope: 'full', signedIn: true });
    const status = await call(chat.port, 'POST', '/__chat/device/status', { headers: browserHeaders({ cookie: paired.cookie }) });
    expect(status.json).toMatchObject({ paired: true, scope: 'full' });
  });

  it.each([
    ['/tightbeam recovery-enroll', FAKE_RECOVERY_SECRET],
    ['/tightbeam approve-device', FAKE_ISSUED_CODE],
  ])('returns every reply to %s, including the ephemeral one, and never records it', async (content, secret) => {
    // The ephemeral frame arrives after the echo and outcome; the quiet window still catches it.
    const gateway = await startGateway({ ephemeralDelayMs: 100 });
    const chat = await startChat({ gateway });
    const paired = await pair(chat);
    const response = await call(chat.port, 'POST', '/__chat/device/send', {
      headers: browserHeaders({ cookie: paired.cookie }), body: sendBody('c_enroll', content) });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ outcome: 'accepted', complete: true, ack: { id: 'c_enroll' } });
    expect(response.json.messages).toHaveLength(3);
    expect(response.json.messages.slice(0, 2).map((frame) => frame.ephemeral)).toEqual([undefined, undefined]);
    expect(response.json.messages[2]).toEqual({ type: 'message', ephemeral: true, role: 'assistant', sessionKey: SESSION,
      replyToClientMessageId: 'c_enroll', content: expect.stringContaining(secret) });
    expect(response.headers['set-cookie']).toBeUndefined();
    for (const line of captured) expect(line).not.toContain(secret);
    const files = await fs.readdir(chat.root, { recursive: true });
    for (const file of files) {
      const filename = path.join(chat.root, file);
      if ((await fs.stat(filename)).isFile()) expect(await fs.readFile(filename, 'utf8')).not.toContain(secret);
    }
    expectNoTokenAnywhere(gateway, response.text);
  });

  it('relays a Gateway refusal for the message id', async () => {
    const gateway = await startGateway({ messageError: (frame) => ({ type: 'error', messageId: frame.id,
      code: 'device_scope_insufficient', message: 'this device is approved for decisions only' }) });
    const chat = await startChat({ gateway });
    const paired = await pair(chat);
    const response = await call(chat.port, 'POST', '/__chat/device/send', {
      headers: browserHeaders({ cookie: paired.cookie }), body: sendBody('c_refused') });
    expect(response.json).toEqual({ outcome: 'refused',
      error: { code: 'device_scope_insufficient', message: 'this device is approved for decisions only' } });
  });

  it('keeps working after a page reload, a Chat-server restart, and with two concurrent tabs (T13a)', async () => {
    const gateway = await startGateway({ ackDelayMs: 20 });
    const first = await startChat({ gateway });
    const paired = await pair(first);
    // Reload: the same cookie with a fresh request, nothing in page memory.
    expect((await call(first.port, 'POST', '/__chat/device/send', {
      headers: browserHeaders({ cookie: paired.cookie }), body: sendBody('c_before_restart') })).json.outcome).toBe('accepted');

    await first.stop();
    const restarted = await startChat({ gateway, root: first.root });
    expect((await call(restarted.port, 'POST', '/__chat/device/send', {
      headers: browserHeaders({ cookie: paired.cookie }), body: sendBody('c_after_restart', '/tightbeam status') })).json)
      .toMatchObject({ outcome: 'accepted', complete: true });

    const takeoversBefore = gateway.state.takeovers;
    const [tabA, tabB] = await Promise.all([
      call(restarted.port, 'POST', '/__chat/device/send', {
        headers: browserHeaders({ cookie: paired.cookie }), body: sendBody('c_tab_a', '/tightbeam rule dr_a accept') }),
      call(restarted.port, 'POST', '/__chat/device/send', {
        headers: browserHeaders({ cookie: paired.cookie }), body: sendBody('c_tab_b', '/tightbeam rule dr_b accept') }),
    ]);
    expect(tabA.json).toMatchObject({ outcome: 'accepted', ack: { id: 'c_tab_a' } });
    expect(tabB.json).toMatchObject({ outcome: 'accepted', ack: { id: 'c_tab_b' } });
    expect(gateway.state.takeovers).toBeGreaterThan(takeoversBefore);
    // The retried send reused its id, so each command is recorded once.
    expect([...gateway.state.recorded.keys()]).toEqual(['c_before_restart', 'c_after_restart', 'c_tab_a', 'c_tab_b']);
    expect(gateway.state.clientFrames.filter((frame) => frame.type === 'pair_request')).toHaveLength(1);
  });

  it('clears the cookie and reports token_revoked when the credential is dead', async () => {
    const gateway = await startGateway();
    const chat = await startChat({ gateway });
    const paired = await pair(chat);
    gateway.kill(paired.deviceId, 'token_revoked');

    const send = await call(chat.port, 'POST', '/__chat/device/send', {
      headers: browserHeaders({ cookie: paired.cookie }), body: sendBody('c_after_revoke') });
    expect(send.status).toBe(401);
    expect(send.json.error).toMatchObject({ code: 'token_revoked', reason: 'token_revoked' });
    expect(cookieFrom(send)).toBe(`${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/__chat/device; Max-Age=0`);
    expect(gateway.state.recorded.size).toBe(0);

    for (const reason of ['auth_failed', 'device_not_approved', 'user_removed']) {
      gateway.kill(paired.deviceId, reason);
      const status = await call(chat.port, 'POST', '/__chat/device/status', { headers: browserHeaders({ cookie: paired.cookie }) });
      expect(status.json).toEqual({ paired: false, reason });
      expect(cookieFrom(status)).toContain('Max-Age=0');
    }
  });

  it('reports a paired but unverified device when the Gateway is unreachable, and forget clears only the cookie', async () => {
    const gateway = await startGateway();
    const chat = await startChat({ gateway });
    const paired = await pair(chat);
    await gateway.close();
    const status = await call(chat.port, 'POST', '/__chat/device/status', { headers: browserHeaders({ cookie: paired.cookie }) });
    expect(status.json).toEqual({ paired: true, deviceId: paired.deviceId, verified: false });
    expect(status.headers['set-cookie']).toBeUndefined();
    const send = await call(chat.port, 'POST', '/__chat/device/send', {
      headers: browserHeaders({ cookie: paired.cookie }), body: sendBody('c_unreachable') });
    expect(send.status).toBe(503);
    expect(send.json).toEqual({ error: { code: 'gateway_unavailable', sent: false } });

    const forget = await call(chat.port, 'POST', '/__chat/device/forget', { headers: browserHeaders({ cookie: paired.cookie }) });
    expect(forget.json).toEqual({ paired: false });
    expect(cookieFrom(forget)).toBe(`${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/__chat/device; Max-Age=0`);
  });

  it('refuses a send without a cookie and treats duplicate device cookies as a conflict', async () => {
    const gateway = await startGateway();
    const chat = await startChat({ gateway });
    const paired = await pair(chat);
    const upgrades = gateway.state.upgrades.length;
    const none = await call(chat.port, 'POST', '/__chat/device/send', { headers: browserHeaders(), body: sendBody('c_none') });
    expect(none.status).toBe(401);
    expect(none.json).toEqual({ error: { code: 'not_paired' } });
    const tossed = `${COOKIE_NAME}=chat-web-${'0'.repeat(32)}.tbt_tossed`;
    const conflict = await call(chat.port, 'POST', '/__chat/device/send', {
      headers: browserHeaders({ cookie: `${paired.cookie}; ${tossed}` }), body: sendBody('c_conflict') });
    expect(conflict.status).toBe(409);
    expect(gateway.state.upgrades.length).toBe(upgrades);
  });

  it('serves the configuration flag and a strict CSP on pages and assets', async () => {
    const gateway = await startGateway();
    const chat = await startChat({ gateway });
    const config = await call(chat.port, 'GET', '/chat-config.json');
    expect(config.json).toMatchObject({ devicePairingEnabled: true });
    for (const pathname of ['/', '/index.html', '/missing.js']) {
      const response = await call(chat.port, 'GET', pathname);
      const policy = response.headers['content-security-policy'];
      expect(policy).toBeTypeOf('string');
      const directives = Object.fromEntries(policy.split(';').map((part) => part.trim().split(/\s+/))
        .map(([name, ...values]) => [name, values]));
      expect(directives['default-src']).toEqual(["'self'"]);
      expect(directives['script-src']).toEqual(["'self'"]);
      expect(directives['object-src']).toEqual(["'none'"]);
      expect(directives['base-uri']).toEqual(["'none'"]);
      expect(directives['frame-ancestors']).toEqual(["'none'"]);
      expect(directives['connect-src']).toEqual(["'self'", 'wss://chat.tailnet.example']);
      expect(policy).not.toContain('unsafe-inline');
      expect(policy).not.toContain('unsafe-eval');
    }
  });
});

describe('Chat device bridge forgery refusals, flag on (T13a)', () => {
  async function pairedChat() {
    const gateway = await startGateway();
    const chat = await startChat({ gateway });
    const paired = await pair(chat);
    // Everything after pairing must reach the Gateway only through an allowed request.
    gateway.state.upgrades.length = 0;
    gateway.state.clientFrames.length = 0;
    return { gateway, chat, paired };
  }

  const forged = [
    ['a cross-site form POST', 'POST', '/__chat/device/send', { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }],
    ['a cross-site fetch with the header', 'POST', '/__chat/device/send', { origin: 'https://evil.example', 'x-tightbeam-chat': '1' }],
    ['a sibling host on the same site', 'POST', '/__chat/device/send', { origin: 'https://other.tailnet.example', 'x-tightbeam-chat': '1' }],
    ['the Chat host on another port', 'POST', '/__chat/device/send', { origin: 'https://chat.tailnet.example:8443', 'x-tightbeam-chat': '1' }],
    ['the Chat host over http', 'POST', '/__chat/device/send', { origin: 'http://chat.tailnet.example', 'x-tightbeam-chat': '1' }],
    ['an opaque origin', 'POST', '/__chat/device/send', { origin: 'null', 'x-tightbeam-chat': '1' }],
    ['no Origin header', 'POST', '/__chat/device/send', { 'x-tightbeam-chat': '1' }],
    ['no anti-forgery header', 'POST', '/__chat/device/send', { origin: PUBLIC_ORIGIN }],
    ['a wrong anti-forgery header value', 'POST', '/__chat/device/send', { origin: PUBLIC_ORIGIN, 'x-tightbeam-chat': 'true' }],
    ['a cross-site fetch-metadata request', 'POST', '/__chat/device/send', { origin: PUBLIC_ORIGIN, 'x-tightbeam-chat': '1', 'sec-fetch-site': 'same-site' }],
    ['a pairing POST without the header', 'POST', '/__chat/device/pair', { origin: PUBLIC_ORIGIN }],
    ['a forget POST without the header', 'POST', '/__chat/device/forget', { origin: PUBLIC_ORIGIN }],
    ['a cross-site status read', 'POST', '/__chat/device/status', { origin: 'https://evil.example', 'x-tightbeam-chat': '1' }],
    ['a status read with no Origin', 'POST', '/__chat/device/status', { 'x-tightbeam-chat': '1' }],
    ['a status read without the header', 'POST', '/__chat/device/status', { origin: PUBLIC_ORIGIN }],
    ['a same-origin GET without Origin, as browsers send it', 'GET', '/__chat/device/status', {}],
    ['a cross-origin preflight', 'OPTIONS', '/__chat/device/send', { origin: 'https://evil.example',
      'access-control-request-method': 'POST', 'access-control-request-headers': 'x-tightbeam-chat' }],
    ['a same-origin preflight', 'OPTIONS', '/__chat/device/send', { origin: PUBLIC_ORIGIN,
      'access-control-request-method': 'POST', 'access-control-request-headers': 'x-tightbeam-chat' }],
  ];

  it.each(forged)('refuses %s with 403 and forwards nothing', async (_name, method, pathname, headers) => {
    const { gateway, chat, paired } = await pairedChat();
    const body = pathname === '/__chat/device/send' ? sendBody('c_forged', '/tightbeam rule dr_x accept')
      : pathname === '/__chat/device/pair' ? pairRequest() : undefined;
    const response = await call(chat.port, method, pathname, { headers: { ...headers, cookie: paired.cookie }, body });
    expect(response.status).toBe(403);
    expect(response.text).toBe('');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(Object.keys(response.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    expect(gateway.state.upgrades).toEqual([]);
    expect(gateway.state.clientFrames).toEqual([]);
    expect(gateway.state.recorded.has('c_forged')).toBe(false);
  });

  it.each([
    ['cross-site', 'https://evil.example'],
    ['same-origin', PUBLIC_ORIGIN],
    ['originless', undefined],
  ])('refuses a %s WebSocket upgrade under /__chat/device', async (_name, origin) => {
    const { gateway, chat, paired } = await pairedChat();
    const result = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: chat.port, path: '/__chat/device/send', headers: {
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'), cookie: paired.cookie,
        ...(origin ? { origin } : {}),
      } });
      request.on('upgrade', () => resolve('upgraded'));
      request.on('response', (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.end();
    });
    expect(result).toBe(403);
    expect(gateway.state.upgrades).toEqual([]);
  });
});

describe('Chat device bridge, flag off', () => {
  it('keeps /__chat/device/* as the existing unknown-route behaviour with no cookie, CSP or Gateway contact', async () => {
    const gateway = await startGateway();
    const chat = await startChat({ gateway, flag: false });
    const unknown = await call(chat.port, 'GET', '/__chat/not-a-route', { headers: { origin: PUBLIC_ORIGIN } });
    for (const [method, pathname, headers, body] of [
      ['GET', '/__chat/device/status', { origin: PUBLIC_ORIGIN }],
      ['GET', '/__chat/device/status', {}],
      ['POST', '/__chat/device/status', browserHeaders()],
      ['POST', '/__chat/device/pair', browserHeaders(), pairRequest()],
      ['POST', '/__chat/device/send', browserHeaders(), sendBody('c_off')],
      ['POST', '/__chat/device/forget', browserHeaders()],
    ]) {
      const response = await call(chat.port, method, pathname, { headers, body });
      expect(response.status).toBe(unknown.status);
      expect(response.text).toBe(unknown.text);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    const crossSite = await call(chat.port, 'GET', '/__chat/device/status', { headers: { origin: 'https://evil.example' } });
    expect(crossSite.status).toBe(403);
    expect(gateway.state.upgrades).toEqual([]);

    const config = await call(chat.port, 'GET', '/chat-config.json');
    expect(config.json).not.toHaveProperty('devicePairingEnabled');
    const page = await call(chat.port, 'GET', '/');
    expect(page.headers).not.toHaveProperty('content-security-policy');
    expect(page.text).toBe('<!doctype html><main>Chat</main>');
  });

  it('treats any value other than 1 as off', async () => {
    const gateway = await startGateway();
    const chat = await startChat({ gateway, flag: false, extraEnvironment: { CHAT_DEVICE_PAIRING: 'true' } });
    expect((await call(chat.port, 'GET', '/chat-config.json')).json).not.toHaveProperty('devicePairingEnabled');
    expect((await call(chat.port, 'GET', '/')).headers).not.toHaveProperty('content-security-policy');
  });
});
