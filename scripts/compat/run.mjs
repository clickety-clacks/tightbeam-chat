// Runs the built Chat against one published Tightbeam package on an isolated scratch base, with a
// stand-in model and headless Chrome: sign in and load, send and receive, reconnect across a Gateway
// restart, and page back through older history. No secrets and no network model.
// Usage: node scripts/compat/run.mjs <tightbeam package dir> <chat app dir> <out dir> <version>
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

// Never synchronous: the stand-in model is served by this process, and the Gateway calls it during these.
const run = promisify(execFile);

const [packageDir, chatDir, outDir, version] = process.argv.slice(2).map((value, index) =>
  index < 3 ? path.resolve(value) : value);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-compat-'));
const [base, home, chatHome] = ['base', 'home', 'chat-home'].map(name => path.join(root, name));
for (const dir of [base, home, chatHome, outDir]) fs.mkdirSync(dir, { recursive: true });
const GATEWAY = 'http://127.0.0.1:25501';
const MODEL = 'compat-fixture';
const REPLY = 'compatibility fixture reply';
const CHAT = 'http://127.0.0.1:4178';
const USER = 'compat-owner';
const DEVICE = 'compat-device';
const children = [];
const steps = [];
const log = name => fs.openSync(path.join(outDir, name), 'a');
const start = (command, args, options, logName) => {
  const out = log(logName);
  const child = spawn(command, args, { ...options, stdio: ['ignore', out, out] });
  children.push(child);
  return child;
};
async function until(check, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    try { const value = await check(); if (value) return value; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await delay(250);
  }
}

// Stand-in OpenAI-compatible model: one fixed reply.
const provider = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({ object: 'list',
      data: [{ object: 'model', id: MODEL, owned_by: 'scratch', context_window: 32768 }] }));
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return response.writeHead(404).end();
  for await (const chunk of request) void chunk;
  const envelope = { id: 'fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: MODEL };
  const send = body => response.write(`data: ${JSON.stringify({ ...envelope, ...body })}\n\n`);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  send({ choices: [{ index: 0, delta: { role: 'assistant', content: REPLY }, finish_reason: null }] });
  send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  return response.end('data: [DONE]\n\n');
});

const gatewayEnv = { HOME: home, LANG: 'C.UTF-8', TIGHTBEAM_BASE_DIR: base, TIGHTBEAM_PORT: '25501',
  PATH: [process.env.COMPAT_TOOLS_BIN, path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin']
    .filter(Boolean).join(':') };
const gatewayBin = path.join(packageDir, 'tightbeam/bin/tightbeam-gateway');
const startGateway = async () => {
  start(gatewayBin, ['start'], { env: gatewayEnv, detached: true }, 'gateway.log');
  return until(async () => (await fetch(`${GATEWAY}/version`)).json(), 90_000, 'Gateway start');
};
const stopGateway = () => run(gatewayBin, ['stop'], { env: gatewayEnv, timeout: 60_000 });
const cli = async (...args) => (await run(path.join(packageDir, 'tightbeam/bin/tightbeam'), [...args, '--as-user', USER],
  { env: gatewayEnv, encoding: 'utf8', timeout: 120_000 })).stdout;

// The first device of an empty scratch org becomes its admin user.
async function pair() {
  const socket = new WebSocket(`${GATEWAY.replace('http', 'ws')}/ws`);
  const result = await new Promise((resolve, reject) => {
    socket.onopen = () => socket.send(JSON.stringify({ type: 'pair_request', protocolVersion: 1, deviceId: DEVICE,
      claimedName: USER, deviceInfo: { platform: 'test', model: 'compat' } }));
    socket.onmessage = event => { const frame = JSON.parse(event.data); if (frame.type === 'pair_result') resolve(frame); };
    setTimeout(() => reject(new Error('pairing timed out')), 20_000).unref();
  });
  socket.close();
  if (!result.success) throw new Error(`pairing failed: ${result.reason}`);
}

// Headless Chrome over the DevTools protocol.
const profile = path.join(root, 'chrome');
let devtools;
let sequence = 0;
const waiting = new Map();
const call = (method, params = {}) => new Promise(resolve => {
  const id = ++sequence;
  waiting.set(id, resolve);
  devtools.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const reply = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (reply.error || reply.result?.exceptionDetails) throw new Error('page evaluation failed');
  return reply.result.result.value;
}
async function openBrowser() {
  start(process.env.CHROME_BIN ?? 'google-chrome', ['--headless=new', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=420,900',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', 'about:blank'], {}, 'chrome.log');
  const port = await until(() => fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0],
    30_000, 'Chrome');
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .find(item => item.type === 'page'), 10_000, 'Chrome page');
  devtools = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { devtools.onopen = resolve; devtools.onerror = reject; });
  devtools.onmessage = event => {
    const message = JSON.parse(event.data);
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  };
  await call('Page.enable');
}
const state = () => evaluate(`(() => {
  const articles = [...document.querySelectorAll('[role=log] article')];
  return { status: document.querySelector('.tb-chat-status-control')?.getAttribute('aria-label') ?? '',
    replies: articles.filter(a => a.textContent.includes(${JSON.stringify(REPLY)})).length,
    articles: articles.length, text: articles.map(a => a.textContent).join('\\n') };
})()`);
const connected = async () => /Connected/.test((await state()).status);
async function load() {
  await call('Page.navigate', { url: `${CHAT}/` });
  await until(() => evaluate(`!!document.querySelector('textarea')`), 30_000, 'message box');
  await until(connected, 30_000, 'Connected');
  await delay(1000);
  await evaluate(`[...document.querySelectorAll('[role=dialog] button')]
    .find(b => /close/i.test(b.getAttribute('aria-label') ?? ''))?.click()`);
}
async function sendAndReceive(text) {
  const before = (await state()).replies;
  await evaluate(`document.querySelector('textarea').focus()`);
  await call('Input.insertText', { text });
  await delay(200);
  for (const type of ['rawKeyDown', 'char', 'keyUp']) {
    await call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  }
  await until(async () => { const now = await state(); return now.replies > before && now.text.includes(text); },
    60_000, `a reply to "${text}"`);
}
async function step(name, run) {
  try {
    await run();
    steps.push({ name, passed: true });
  } catch (error) {
    steps.push({ name, passed: false, error: String(error?.message ?? error) });
    try {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
    } catch { /* no page to capture */ }
    throw error;
  } finally {
    process.stdout.write(`${JSON.stringify(steps.at(-1) ?? { name })}\n`);
  }
}

let passed = false;
try {
  await new Promise(resolve => provider.listen(25502, '127.0.0.1', resolve));
  let sessionKey;
  await step('start', async () => {
    const reported = await startGateway();
    if (reported.version !== version) throw new Error(`package reports ${reported.version}, expected ${version}`);
    await pair();
    await cli('onboard', 'local-openai', '--name', 'compat-local', '--endpoint', 'http://127.0.0.1:25502/v1');
    // The model catalog takes a moment, and the first session installs the adapters.
    sessionKey = await until(async () => JSON.parse(await cli('spawn', '--display', 'Compat agent', '--name', 'test:compat',
      '--archetype', 'default', '--host', os.hostname(), '--harness', 'pi', '--model', `compat-local/${MODEL}`,
      '--effort', 'off', '--key', 'compat-spawn')).sessionKey, 300_000, 'session');
  });
  // More than one history page (50 rows) before Chat first loads.
  await step('seed', async () => {
    for (let i = 1; i <= 30; i++) {
      await cli('wake', '--session', sessionKey, '--prompt', `history seed ${i} end`, '--key', `compat-seed-${i}`);
      await delay(700);
    }
    await delay(20_000);
  });
  fs.writeFileSync(path.join(root, 'map.json'),
    JSON.stringify({ version: 1, gateways: [{ origin: GATEWAY, baseDir: base }] }));
  start(process.execPath, ['server/chat-server.mjs'], { cwd: chatDir, env: { HOME: chatHome, PATH: gatewayEnv.PATH,
    CHAT_PUBLIC_ORIGIN: CHAT, CHAT_GATEWAY_MAP_FILE: path.join(root, 'map.json'), CHAT_DEFAULT_GATEWAY_ORIGIN: GATEWAY,
    CHAT_DEFAULT_SESSION_KEY: sessionKey, CHAT_DEFAULT_PRINCIPAL_KEY: USER } }, 'chat.log');
  await until(async () => (await fetch(`${CHAT}/__chat/version`)).ok, 30_000, 'Chat server');
  await openBrowser();
  await step('sign-in-and-load', load);
  await step('send-and-receive', () => sendAndReceive('compatibility send one'));
  await step('reconnect', async () => {
    await stopGateway();
    await until(async () => !(await connected()), 90_000, 'Chat notices the outage');
    await startGateway();
    await until(connected, 120_000, 'Chat connects again');
    await sendAndReceive('compatibility send two');
  });
  await step('history', async () => {
    await load();
    if ((await state()).text.includes('history seed 1 end')) throw new Error('the first page already held everything');
    await until(async () => {
      await evaluate(`(() => { const log = document.querySelector('[role=log]');
        for (let node = log; node; node = node.parentElement) if (node.scrollHeight > node.clientHeight + 20) {
          node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); break; } })()`);
      await delay(1200);
      return (await state()).text.includes('history seed 1 end');
    }, 60_000, 'the oldest message');
  });
  passed = true;
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
} finally {
  fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify({ version, passed, steps }, null, 2)}\n`);
  try { await stopGateway(); } catch { /* already stopped */ }
  for (const child of children) child.kill('SIGKILL');
  provider.close();
  process.exit(passed ? 0 : 1);
}
