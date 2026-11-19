// Real-browser checks for spec stage2-v5 T13/T13a that jsdom cannot make: the
// device cookie is unreadable from page script, the served CSP blocks injected
// inline script (reporting a violation), and the built app needs no CSP exception.
// Runs the built page (npm run build:chat-server) through the real Chat server
// against a fake Gateway. Run with: npm run test:browser
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createChatServer } from '../../server/chat-server.mjs';
import { startFakeDeviceGateway } from '../helpers/fakeDeviceGateway.mjs';

const SESSION = 'agent:main:george';
const COOKIE_NAME = '__Secure-tb-chat-device';
const publicDir = path.resolve(import.meta.dirname, '../../dist/chat-server/public');
const hostile = [
  'Hostile transcript: <script>window.__chatPwned = "script"</script>',
  '<img src="x" onerror="window.__chatPwned = \'onerror\'">',
  '<p style="position:fixed;inset:0;background:red">styled</p>',
  '[click me](javascript:window.__chatPwned=%22link%22)',
  '![remote](https://images.example/pixel.png)',
].join('\n\n');

let gateway;
let chat;
let chatOrigin;
let root;
let browser;
let context;
const serverOutput = [];
const restoreOutput = [];

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function captureServerOutput() {
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[method];
    console[method] = (...args) => { serverOutput.push(args.map(String).join(' ')); original(...args); };
    restoreOutput.push(() => { console[method] = original; });
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write;
    stream.write = function write(chunk, ...rest) { serverOutput.push(String(chunk)); return original.call(this, chunk, ...rest); };
    restoreOutput.push(() => { stream.write = original; });
  }
}

async function waitFor(check, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function openChat() {
  const page = await context.newPage();
  const response = await page.goto(`${chatOrigin}/`);
  return { page, response };
}

async function sendFromComposer(page, text) {
  const input = page.getByRole('textbox', { name: /message to/i });
  await input.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

function recorded(content) {
  return [...gateway.state.recorded.values()].filter((frame) => frame.content === content);
}

before(async () => {
  await fs.access(path.join(publicDir, 'index.html')).catch(() => {
    throw new Error('Build the page first: npm run build:chat-server');
  });
  captureServerOutput();
  gateway = await startFakeDeviceGateway({
    ackDelayMs: 20,
    history: { sessionKey: SESSION, userId: 'george', messages: [{
      id: 'm_hostile', seq: 1, sessionKey: SESSION, role: 'assistant', messageType: 'chat', content: hostile,
      at: Date.parse('2026-11-19T00:00:00Z'), rowVersion: 1, attachments: [],
    }, {
      id: 'm_command_line', seq: 2, sessionKey: SESSION, role: 'assistant', messageType: 'chat',
      content: '/tightbeam rule dr_x accept', at: Date.parse('2026-11-19T00:00:01Z'), rowVersion: 2, attachments: [],
    }] },
  });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-device-browser-'));
  await fs.mkdir(path.join(root, 'gateway-base'));
  await fs.writeFile(path.join(root, 'gateway-base', 'gateway.json'),
    JSON.stringify({ port: gateway.port, cliToken: 'fixture-organization-credential' }));
  const port = await unusedPort();
  chatOrigin = `http://127.0.0.1:${port}`;
  chat = createChatServer({ rootDir: root, publicDir, releaseInfo: { tag: 'v0.0.0', sourceCommit: '0'.repeat(40) },
    environment: {
      CHAT_PUBLIC_ORIGIN: chatOrigin,
      CHAT_DEFAULT_GATEWAY_ORIGIN: gateway.origin,
      CHAT_DEFAULT_SESSION_KEY: SESSION,
      CHAT_DEFAULT_PRINCIPAL_KEY: 'george',
      TIGHTBEAM_BASE_DIR: path.join(root, 'gateway-base'),
      HOME: root,
      CHAT_DEVICE_PAIRING: '1',
    } });
  await new Promise((resolve) => chat.listen(port, '127.0.0.1', resolve));
  browser = await chromium.launch();
  context = await browser.newContext();
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
    });
  });
});

after(async () => {
  await browser?.close();
  chat?.closeAllConnections?.();
  await new Promise((resolve) => (chat ? chat.close(() => resolve()) : resolve()));
  await gateway?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
  for (const restore of restoreOutput.splice(0)) restore();
});

test('T13: pairs by code, keeps the cookie from page script, and sends with the device', async () => {
  const { page, response } = await openChat();
  const policy = response.headers()['content-security-policy'];
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);

  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByLabel('Name for this browser').fill('Playwright Chromium');
  await page.getByLabel('Pairing code from Clawline').fill('TB-ABCD-EFGH-JKLM');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await page.getByText('This browser is paired as its own device').waitFor();

  const pairFrame = gateway.state.clientFrames.find((frame) => frame.type === 'pair_request');
  assert.match(pairFrame.deviceId, /^chat-web-[0-9a-f]{32}$/);
  assert.equal(pairFrame.claimedName, 'Playwright Chromium TB-ABCD-EFGH-JKLM');

  assert.equal(await page.evaluate(() => document.cookie), '');
  const cookies = await context.cookies();
  const device = cookies.find((cookie) => cookie.name === COOKIE_NAME);
  assert.ok(device, 'the device cookie is stored');
  assert.deepEqual({ httpOnly: device.httpOnly, secure: device.secure, sameSite: device.sameSite, path: device.path,
    domain: device.domain }, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/__chat/device', domain: '127.0.0.1' });
  assert.equal(device.value.split('.')[0], pairFrame.deviceId);

  await sendFromComposer(page, 'hello from a paired browser');
  await waitFor(() => recorded('hello from a paired browser').length === 1, 'device message recorded');
  await sendFromComposer(page, '/tightbeam rule dr_y accept');
  await waitFor(() => recorded('/tightbeam rule dr_y accept').length === 1, 'device command recorded');
  for (const frame of [...recorded('hello from a paired browser'), ...recorded('/tightbeam rule dr_y accept')]) {
    assert.equal(frame.deviceId, pairFrame.deviceId);
  }
  // No human socket authenticated with the organization credential, and no REST post.
  assert.deepEqual(gateway.state.clientFrames.filter((frame) => frame.type === 'auth' &&
    (frame.asUser !== undefined || frame.token === 'fixture-organization-credential')), []);
  assert.equal(gateway.state.httpRequests.some((request) => request.method === 'POST'), false);
  await page.close();
});

test('T13a: a fresh page load (reload) and two concurrent tabs send commands with no re-pairing', async () => {
  const first = (await openChat()).page;
  await first.getByText('This browser is paired as its own device').waitFor();
  const second = (await openChat()).page;
  await second.getByText('This browser is paired as its own device').waitFor();
  await Promise.all([
    sendFromComposer(first, '/tightbeam rule dr_tab_a accept'),
    sendFromComposer(second, '/tightbeam rule dr_tab_b accept'),
  ]);
  await waitFor(() => recorded('/tightbeam rule dr_tab_a accept').length === 1 &&
    recorded('/tightbeam rule dr_tab_b accept').length === 1, 'both tabs recorded once');
  assert.equal(gateway.state.clientFrames.filter((frame) => frame.type === 'pair_request').length, 1);
  await first.close();
  await second.close();
});

test('T13a: hostile transcript stays inert, injected script is blocked by CSP and sends nothing', async () => {
  const { page } = await openChat();
  await page.getByText('This browser is paired as its own device').waitFor();
  await page.getByText('Hostile transcript:').waitFor();
  await page.getByText('click me').click().catch(() => {});
  await page.waitForTimeout(300);

  assert.equal(await page.evaluate(() => window.__chatPwned), undefined);
  const before = await page.evaluate(() => window.__cspViolations);
  // The app itself needs no exception; only the remote Markdown image is refused (intended).
  assert.deepEqual(before.filter((violation) => violation.directive !== 'img-src'), []);
  assert.ok(before.some((violation) => violation.blocked.startsWith('https://images.example/')),
    'remote Markdown image blocked by img-src');

  await page.evaluate((sessionKey) => {
    const script = document.createElement('script');
    script.textContent = `window.__injected = 'script'; fetch('/__chat/device/send', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tightbeam-chat': '1' },
      body: JSON.stringify({ sessionKey: ${JSON.stringify(sessionKey)}, id: 'c_injected', content: '/tightbeam rule dr_x accept' }) });`;
    document.body.append(script);
    const handler = document.createElement('button');
    handler.setAttribute('onclick', "window.__injected = 'handler'");
    document.body.append(handler);
    handler.click();
  }, SESSION);
  await page.waitForTimeout(300);

  assert.equal(await page.evaluate(() => window.__injected), undefined);
  const violations = (await page.evaluate(() => window.__cspViolations)).map((violation) => violation.directive);
  assert.ok(violations.includes('script-src-elem'), `inline script reported: ${violations}`);
  assert.ok(violations.includes('script-src-attr'), `inline handler reported: ${violations}`);
  assert.equal(gateway.state.recorded.has('c_injected'), false);
  assert.equal(recorded('/tightbeam rule dr_x accept').length, 0, 'the transcript command line sent nothing');
  await page.close();
});

test('T13: no device token on the server disk, logs or environment after use', async () => {
  const tokens = [...gateway.state.devices.keys()];
  assert.ok(tokens.length > 0);
  const files = await fs.readdir(root, { recursive: true });
  for (const file of files) {
    const filename = path.join(root, file);
    if (!(await fs.stat(filename)).isFile()) continue;
    const content = await fs.readFile(filename, 'utf8');
    for (const token of tokens) assert.equal(content.includes(token), false, `${file} holds a token`);
  }
  for (const token of tokens) {
    assert.equal(serverOutput.some((line) => line.includes(token)), false, 'token in server output');
    assert.equal(Object.values(process.env).some((value) => value?.includes(token)), false, 'token in environment');
  }
});
