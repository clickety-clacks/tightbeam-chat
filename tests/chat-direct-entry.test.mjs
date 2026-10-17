import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatServer } from '../server/chat-server.mjs';

const TOKEN = 'fixture-operator-credential';
const SESSION = 'agent:example:chat?tab=1';
const LINKED_SESSION = 'agent:example:linked-chat';
const PRINCIPAL = 'example-user';
const createdServers = [];
const temporaryRoots = [];

async function listen(server, port = 0) {
  const sockets = new Set();
  server._connectionsSet = sockets;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  createdServers.push(server);
  return server.address().port;
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function closeServer(server) {
  const index = createdServers.indexOf(server);
  if (index >= 0) createdServers.splice(index, 1);
  for (const socket of server._connectionsSet ?? []) socket.destroy();
  await new Promise((resolve) => server.close(() => resolve()));
}

async function temporaryDirectory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-direct-entry-'));
  temporaryRoots.push(root);
  const publicDir = path.join(root, 'public');
  await fs.mkdir(publicDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<main>Chat</main>');
  return { root, publicDir };
}

async function writeGatewayDescriptor(baseDir, gatewayOrigin, token, { advertisedUrl = false } = {}) {
  await fs.mkdir(baseDir, { recursive: true });
  const gateway = new URL(gatewayOrigin);
  const descriptor = advertisedUrl
    ? { url: gatewayOrigin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:'), cliToken: token }
    : { port: Number(gateway.port), cliToken: token };
  await fs.writeFile(path.join(baseDir, 'gateway.json'), JSON.stringify(descriptor), { mode: 0o600 });
  return baseDir;
}

async function writeGatewayMap(root, gateways) {
  const filename = path.join(root, 'gateway-map.json');
  await fs.writeFile(filename, JSON.stringify({ version: 1, gateways }), { mode: 0o600 });
  return filename;
}

function serverTextFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function takeFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const first = buffer[0];
  const second = buffer[1];
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    const largeLength = buffer.readBigUInt64BE(2);
    if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Frame too large.');
    length = Number(largeLength);
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  if ((first & 0x0f) !== 1) throw new Error('Expected a text frame.');
  return { value: JSON.parse(payload.toString('utf8')), masked, rest: buffer.subarray(offset + length) };
}

const pendingSocketBytes = new WeakMap();

function nextFrame(socket, initial = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.concat([pendingSocketBytes.get(socket) ?? Buffer.alloc(0), Buffer.from(initial)]);
    const timer = setTimeout(() => finish(new Error('Timed out waiting for a WebSocket frame.')), 5000);
    const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); };
    const finish = (error, frame) => {
      cleanup();
      if (error) reject(error);
      else resolve(frame);
    };
    const parse = () => {
      try {
        const frame = takeFrame(bytes);
        if (!frame) return false;
        bytes = frame.rest;
        pendingSocketBytes.set(socket, bytes);
        finish(undefined, frame);
        return true;
      } catch (error) { finish(error); return true; }
    };
    const onData = (chunk) => { bytes = Buffer.concat([bytes, chunk]); parse(); };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error('Socket closed before a WebSocket frame arrived.'));
    if (!parse()) {
      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
      if (bytes.length && parse()) return;
    }
  });
}

function websocketHandshakeAccept(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

afterEach(async () => {
  for (const server of [...createdServers].reverse()) await closeServer(server);
  for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('private direct-entry Chat service bridge', () => {
  it('keeps the credential server-side and maps linked-session REST to detail and transcript operations', async () => {
    const seen = [];
    const gateway = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization,
        cliVersion: request.headers['x-tightbeam-cli-version'], body });
      if (request.url === '/version') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ version: '0.1.9', build: 2845, sha: 'b469cd27' }));
      } else if ([SESSION, LINKED_SESSION].some((sessionKey) =>
        request.url === `/api/sessions/${encodeURIComponent(sessionKey)}?asUser=${encodeURIComponent(PRINCIPAL)}`)) {
        response.writeHead(200, { 'content-type': 'application/json' });
        const sessionKey = request.url.includes(encodeURIComponent(LINKED_SESSION)) ? LINKED_SESSION : SESSION;
        response.end(JSON.stringify({ schemaVersion: 1, resource: 'sessions', item: { sessionKey } }));
      } else if (request.url === '/agent/dispatch') {
        response.writeHead(200, { 'content-type': 'application/json' });
        const sessionKey = JSON.parse(body).params.session_key;
        response.end(JSON.stringify({ result: { sessionKey, displayName: 'Example', messages: [
          { id: 'm_1', sessionKey, seq: 1, rowVersion: 1, role: 'assistant', messageType: 'chat', content: 'hello' },
        ], oldestId: 'm_1', hasMoreBefore: true, hasMoreAfter: false } }));
      } else {
        response.writeHead(404).end();
      }
    });
    const gatewayPort = await listen(gateway);
    const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
    const chatPort = await unusedPort();
    const chatOrigin = `http://127.0.0.1:${chatPort}`;
    const { root, publicDir } = await temporaryDirectory();
    const gatewayBaseDir = await writeGatewayDescriptor(path.join(root, 'gateway-base'), gatewayOrigin, TOKEN, { advertisedUrl: true });
    const alternateBaseDir = await writeGatewayDescriptor(path.join(root, 'alternate-base'), gatewayOrigin, 'wrong-fixture-token');
    const chat = createChatServer({
      rootDir: root,
      publicDir,
      releaseInfo: { tag: 'v0.1.2', sourceCommit: '1234567890abcdef1234567890abcdef12345678' },
      environment: {
        CHAT_PUBLIC_ORIGIN: chatOrigin,
        CHAT_DEFAULT_GATEWAY_ORIGIN: gatewayOrigin,
        CHAT_DEFAULT_SESSION_KEY: SESSION,
        CHAT_DEFAULT_PRINCIPAL_KEY: PRINCIPAL,
        TIGHTBEAM_BASE_DIR: gatewayBaseDir,
        TIGHTBEAM_HOME: alternateBaseDir,
      },
    });
    await listen(chat, chatPort);

    const configResponse = await fetch(`${chatOrigin}/chat-config.json`);
    const config = await configResponse.json();
    expect(config).toMatchObject({ gateway: gatewayOrigin, sessionKey: SESSION, principalKey: PRINCIPAL });
    expect(config.deviceId).toMatch(/^chat_[a-f0-9]{24}$/);
    expect(JSON.stringify(config)).not.toContain(TOKEN);

    const selectedGateway = `?gateway=${encodeURIComponent(gatewayOrigin)}`;
    const versionResponse = await fetch(`${chatOrigin}/__chat/gateway/version`, { headers: { origin: chatOrigin } });
    expect((await versionResponse.json()).sha).toBe('b469cd27');
    const detailResponse = await fetch(`${chatOrigin}/__chat/api/sessions/${encodeURIComponent(LINKED_SESSION)}${selectedGateway}`, {
      headers: { origin: chatOrigin, authorization: 'Bearer browser-supplied-value' },
    });
    const detailText = await detailResponse.text();
    expect(detailResponse.status, detailText).toBe(200);
    expect(JSON.parse(detailText).item.sessionKey).toBe(LINKED_SESSION);
    const transcriptResponse = await fetch(
      `${chatOrigin}/__chat/api/sessions/${encodeURIComponent(LINKED_SESSION)}/messages?gateway=${encodeURIComponent(gatewayOrigin)}&limit=50&tail=true`,
      { headers: { origin: chatOrigin } },
    );
    expect(await transcriptResponse.json()).toEqual({
      schemaVersion: 1,
      resource: 'transcript messages',
      items: [{ id: 'm_1', sessionKey: LINKED_SESSION, seq: 1, rowVersion: 1, role: 'assistant', messageType: 'chat', content: 'hello' }],
      page: { oldestCursor: 'm_1', hasMoreBefore: true },
    });

    expect(seen).toHaveLength(4);
    expect(seen.map((row) => row.url)).toEqual([
      '/version',
      `/api/sessions/${encodeURIComponent(LINKED_SESSION)}?asUser=${encodeURIComponent(PRINCIPAL)}`,
      '/version',
      '/agent/dispatch',
    ]);
    expect(seen.map((row) => row.authorization)).toEqual([
      undefined, `Bearer ${TOKEN}`, undefined, `Bearer ${TOKEN}`,
    ]);
    expect(seen[3].cliVersion).toBe('0.1.9');
    expect(JSON.parse(seen[3].body)).toEqual({
      verb: 'transcript', asUser: PRINCIPAL, params: { session_key: LINKED_SESSION, limit: 50 },
    });

    const wrongSession = await fetch(`${chatOrigin}/__chat/api/sessions/agent%3Aother${selectedGateway}`, { headers: { origin: chatOrigin } });
    expect(wrongSession.status).toBe(404);
    const wrongOrigin = await fetch(`${chatOrigin}/__chat/gateway/version`, { headers: { origin: 'https://elsewhere.example' } });
    expect(wrongOrigin.status).toBe(403);
    expect(seen).toHaveLength(5);
  });

  it('routes mapped aliases only to their explicitly provisioned Gateway and keeps unavailable selections exact', async () => {
    function fixtureGateway(name) {
      const seen = [];
      const gateway = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
        if (request.url === '/version') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ version: '0.1.9', build: 2845, sha: name }));
        } else if (request.url.startsWith('/api/sessions/')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ schemaVersion: 1, resource: 'sessions', item: { sessionKey: LINKED_SESSION } }));
        } else if (request.url === '/agent/dispatch') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ result: { sessionKey: LINKED_SESSION, messages: [], oldestId: null,
            hasMoreBefore: false, hasMoreAfter: false } }));
        } else response.writeHead(404).end();
      });
      return { gateway, seen };
    }

    const defaultFixture = fixtureGateway('default-gateway');
    const selectedFixture = fixtureGateway('selected-gateway');
    const unavailableFixture = fixtureGateway('unavailable-gateway');
    const defaultPort = await listen(defaultFixture.gateway);
    const selectedPort = await listen(selectedFixture.gateway);
    const unavailablePort = await listen(unavailableFixture.gateway);
    const defaultDescriptorOrigin = `http://127.0.0.1:${defaultPort}`;
    const selectedDescriptorOrigin = `http://127.0.0.1:${selectedPort}`;
    const unavailableDescriptorOrigin = `http://127.0.0.1:${unavailablePort}`;
    const defaultOrigin = 'https://default.example';
    const selectedOrigin = 'https://selected.example';
    const selectedAlias = 'https://selected-link.example';
    const unavailableOrigin = 'https://unavailable.example';
    const chatPort = await unusedPort();
    const chatOrigin = `http://127.0.0.1:${chatPort}`;
    const { root, publicDir } = await temporaryDirectory();
    const defaultBase = await writeGatewayDescriptor(path.join(root, 'default-base'), defaultDescriptorOrigin, 'default-token');
    const selectedBase = await writeGatewayDescriptor(path.join(root, 'selected-base'), selectedDescriptorOrigin, 'selected-token');
    const unavailableBase = await writeGatewayDescriptor(path.join(root, 'unavailable-base'), unavailableDescriptorOrigin, 'unavailable-token');
    const mapFile = await writeGatewayMap(root, [
      { origin: defaultOrigin, baseDir: defaultBase, aliases: [defaultDescriptorOrigin] },
      { origin: selectedOrigin, baseDir: selectedBase, aliases: [selectedAlias, selectedDescriptorOrigin] },
      // Its descriptor endpoint is deliberately not associated with this entry.
      { origin: unavailableOrigin, baseDir: unavailableBase },
    ]);
    const chat = createChatServer({
      rootDir: root,
      publicDir,
      releaseInfo: { tag: 'v0.1.2', sourceCommit: '1234567890abcdef1234567890abcdef12345678' },
      environment: {
        CHAT_PUBLIC_ORIGIN: chatOrigin,
        CHAT_DEFAULT_GATEWAY_ORIGIN: `${defaultOrigin}/`,
        CHAT_DEFAULT_SESSION_KEY: SESSION,
        CHAT_DEFAULT_PRINCIPAL_KEY: PRINCIPAL,
        CHAT_GATEWAY_MAP_FILE: mapFile,
      },
    });
    await listen(chat, chatPort);

    const configResponse = await fetch(`${chatOrigin}/chat-config.json`);
    const configText = await configResponse.text();
    expect(JSON.parse(configText)).toMatchObject({ gateway: defaultOrigin, sessionKey: SESSION, principalKey: PRINCIPAL });
    for (const privateValue of [mapFile, defaultBase, selectedBase, unavailableBase,
      defaultDescriptorOrigin, selectedDescriptorOrigin, selectedOrigin, selectedAlias, unavailableOrigin,
      'default-token', 'selected-token', 'unavailable-token']) {
      expect(configText).not.toContain(privateValue);
    }

    const selectedQuery = `gateway=${encodeURIComponent(selectedAlias)}`;
    const version = await fetch(`${chatOrigin}/__chat/gateway/version?${selectedQuery}`, { headers: { origin: chatOrigin } });
    expect((await version.json()).sha).toBe('selected-gateway');
    const detail = await fetch(`${chatOrigin}/__chat/api/sessions/${encodeURIComponent(LINKED_SESSION)}?${selectedQuery}`, {
      headers: { origin: chatOrigin },
    });
    expect(detail.status).toBe(200);
    expect((await detail.json()).item.sessionKey).toBe(LINKED_SESSION);
    const transcript = await fetch(
      `${chatOrigin}/__chat/api/sessions/${encodeURIComponent(LINKED_SESSION)}/messages?${selectedQuery}&limit=50&tail=true`,
      { headers: { origin: chatOrigin } },
    );
    expect(transcript.status).toBe(200);
    expect((await transcript.json()).items).toEqual([]);
    expect(selectedFixture.seen.map((row) => row.url)).toEqual([
      '/version',
      `/api/sessions/${encodeURIComponent(LINKED_SESSION)}?asUser=${encodeURIComponent(PRINCIPAL)}`,
      '/version',
      '/agent/dispatch',
    ]);
    expect(selectedFixture.seen.map((row) => row.authorization)).toEqual([
      undefined, `Bearer selected-token`, undefined, `Bearer selected-token`,
    ]);
    expect(JSON.parse(selectedFixture.seen[3].body)).toMatchObject({
      verb: 'transcript', asUser: PRINCIPAL, params: { session_key: LINKED_SESSION, limit: 50 },
    });
    expect(defaultFixture.seen).toEqual([]);

    for (const query of [
      `gateway=${encodeURIComponent(selectedAlias)}&gateway=${encodeURIComponent(defaultOrigin)}`,
      `gateway=${encodeURIComponent(`${selectedAlias}/?`)}`,
    ]) {
      const invalid = await fetch(`${chatOrigin}/__chat/gateway/version?${query}`, { headers: { origin: chatOrigin } });
      expect(invalid.status).toBe(404);
    }
    expect(selectedFixture.seen).toHaveLength(4);

    for (const gateway of [unavailableOrigin, 'https://unmapped.example']) {
      const unavailable = await fetch(
        `${chatOrigin}/__chat/gateway/version?gateway=${encodeURIComponent(gateway)}`,
        { headers: { origin: chatOrigin } },
      );
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ error: { code: 'chat_gateway_unavailable' } });
    }
    expect(defaultFixture.seen).toEqual([]);
    expect(unavailableFixture.seen).toEqual([]);
  });

  it('fails closed on invalid or canonically duplicated maps instead of using the legacy descriptor', async () => {
    const observed = [];
    const gateway = http.createServer((request, response) => {
      observed.push(request.url);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '0.1.9', build: 2845, sha: 'legacy' }));
    });
    const gatewayPort = await listen(gateway);
    const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
    const chatPort = await unusedPort();
    const chatOrigin = `http://127.0.0.1:${chatPort}`;
    const { root, publicDir } = await temporaryDirectory();
    const legacyBase = await writeGatewayDescriptor(path.join(root, 'legacy-base'), gatewayOrigin, TOKEN);
    const mapFile = path.join(root, 'gateway-map.json');
    const invalidMaps = [
      [{ origin: 'ftp://gateway.example', baseDir: legacyBase }],
      [{ origin: 'https://user:secret@gateway.example', baseDir: legacyBase }],
      [{ origin: 'https://gateway.example/path', baseDir: legacyBase }],
      [{ origin: 'https://gateway.example/?', baseDir: legacyBase }],
      [{ origin: 'https://gateway.example/#', baseDir: legacyBase }],
      [{ origin: 'https://gateway.example', baseDir: legacyBase, aliases: ['https://alias.example/?'] }],
      [{ origin: 'https://gateway.example', baseDir: 'relative/base' }],
      [{ origin: 'https://duplicate.example', baseDir: legacyBase, aliases: ['https://DUPLICATE.example:443/'] }],
      [
        { origin: 'https://first.example', baseDir: legacyBase, aliases: ['https://second.example'] },
        { origin: 'https://second.example', baseDir: legacyBase },
      ],
    ];

    for (const gateways of invalidMaps) {
      await fs.writeFile(mapFile, JSON.stringify({ version: 1, gateways }), { mode: 0o600 });
      const chat = createChatServer({
        rootDir: root,
        publicDir,
        releaseInfo: { tag: 'v0.1.2', sourceCommit: '1234567890abcdef1234567890abcdef12345678' },
        environment: {
          CHAT_PUBLIC_ORIGIN: chatOrigin,
          CHAT_DEFAULT_GATEWAY_ORIGIN: gatewayOrigin,
          CHAT_DEFAULT_SESSION_KEY: SESSION,
          CHAT_DEFAULT_PRINCIPAL_KEY: PRINCIPAL,
          CHAT_GATEWAY_MAP_FILE: mapFile,
          TIGHTBEAM_BASE_DIR: legacyBase,
        },
      });
      await listen(chat, chatPort);
      const response = await fetch(`${chatOrigin}/__chat/gateway/version?gateway=${encodeURIComponent(gatewayOrigin)}`,
        { headers: { origin: chatOrigin } },
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'chat_service_unconfigured' } });
      await closeServer(chat);
    }
    expect(observed).toEqual([]);
  });

  it('injects masked service auth for the linked session before forwarding Firehose and human sockets', async () => {
    const observed = [];
    const gateway = http.createServer();
    gateway.on('upgrade', (request, socket) => {
      const kind = request.url.startsWith('/ws/changes') ? 'changes' : 'human';
      observed.push({ kind, path: request.url, origin: request.headers.origin });
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${websocketHandshakeAccept(request.headers['sec-websocket-key'])}\r\n\r\n`);
      void nextFrame(socket).then(({ value, masked }) => {
        observed.push({ kind, path: request.url, origin: request.headers.origin, auth: value, masked });
        if (kind === 'changes') {
          socket.write(serverTextFrame({ type: 'auth_result', success: true, userId: PRINCIPAL, sessionKey: value.sessionKey }));
        } else {
          socket.write(serverTextFrame({ type: 'auth_result', success: true, userId: PRINCIPAL,
            sessionId: `conn_${value.deviceId}`, sessionKeys: [value.sessionKey] }));
          socket.write(serverTextFrame({ type: 'sync_complete' }));
        }
      }).catch(() => socket.destroy());
    });
    const gatewayPort = await listen(gateway);
    const descriptorOrigin = `http://127.0.0.1:${gatewayPort}`;
    const gatewayOrigin = 'https://mapped-gateway.example';
    const linkedAlias = 'https://mapped-link.example';
    const chatPort = await unusedPort();
    const chatOrigin = `http://127.0.0.1:${chatPort}`;
    const { root, publicDir } = await temporaryDirectory();
    const gatewayBaseDir = await writeGatewayDescriptor(path.join(root, 'gateway-base'), descriptorOrigin, TOKEN);
    const mapFile = await writeGatewayMap(root, [
      { origin: gatewayOrigin, baseDir: gatewayBaseDir, aliases: [linkedAlias, descriptorOrigin] },
    ]);
    const chat = createChatServer({
      rootDir: root,
      publicDir,
      releaseInfo: { tag: 'v0.1.2', sourceCommit: '1234567890abcdef1234567890abcdef12345678' },
      environment: {
        CHAT_PUBLIC_ORIGIN: chatOrigin,
        CHAT_DEFAULT_GATEWAY_ORIGIN: gatewayOrigin,
        CHAT_DEFAULT_SESSION_KEY: SESSION,
        CHAT_DEFAULT_PRINCIPAL_KEY: PRINCIPAL,
        CHAT_GATEWAY_MAP_FILE: mapFile,
      },
    });
    await listen(chat, chatPort);

    async function connect(pathname) {
      const key = crypto.randomBytes(16).toString('base64');
      return new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: chatPort, path: pathname, headers: {
          connection: 'Upgrade', upgrade: 'websocket', origin: chatOrigin,
          'sec-websocket-key': key, 'sec-websocket-version': '13',
        } });
        const timer = setTimeout(() => { request.destroy(); reject(new Error('Chat WebSocket handshake timed out.')); }, 5000);
        request.once('upgrade', (response, socket, head) => {
          clearTimeout(timer);
          resolve({ response, socket, head });
        });
        request.once('error', (error) => { clearTimeout(timer); reject(error); });
        request.end();
      });
    }

    const changes = await connect(`/__chat/ws/changes?protocolVersion=2&sessionKey=${encodeURIComponent(LINKED_SESSION)}&gateway=${encodeURIComponent(linkedAlias)}`);
    expect(changes.response.statusCode).toBe(101);
    expect((await nextFrame(changes.socket, changes.head)).value).toMatchObject({
      type: 'auth_result', success: true, userId: PRINCIPAL, sessionKey: LINKED_SESSION,
    });
    changes.socket.destroy();

    const human = await connect(`/__chat/ws?sessionKey=${encodeURIComponent(LINKED_SESSION)}&gateway=${encodeURIComponent(linkedAlias)}`);
    expect(human.response.statusCode).toBe(101);
    const humanAuth = (await nextFrame(human.socket, human.head)).value;
    const humanAuthRecord = observed.find((row) => row.kind === 'human' && row.auth);
    expect(humanAuth).toMatchObject({ type: 'auth_result', success: true, userId: PRINCIPAL,
      sessionId: `conn_${humanAuthRecord.auth.deviceId}` });
    expect((await nextFrame(human.socket)).value).toEqual({ type: 'sync_complete' });
    human.socket.destroy();

    const changeAuth = observed.find((row) => row.kind === 'changes' && row.auth);
    expect(observed.filter((row) => row.auth).every((row) => row.masked)).toBe(true);
    expect(changeAuth.path).toBe('/ws/changes?protocolVersion=2');
    expect(changeAuth.origin).toBe(chatOrigin);
    expect(changeAuth.auth).toEqual({ type: 'auth', token: TOKEN, asUser: PRINCIPAL, sessionKey: LINKED_SESSION });
    expect(humanAuthRecord.path).toBe('/ws');
    expect(humanAuthRecord.auth).toMatchObject({
      type: 'auth', token: TOKEN, asUser: PRINCIPAL, sessionKey: LINKED_SESSION, subscriptions: ['chat'],
    });
    expect(humanAuthRecord.auth.deviceId).toMatch(/^chat_[a-f0-9]{24}$/);
  });

  it('does not accept an environment token when the provisioned descriptor is missing or mismatched', async () => {
    const observed = [];
    const gateway = http.createServer((request, response) => {
      observed.push(request.url);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '0.1.9', build: 2845, sha: 'b469cd27' }));
    });
    const gatewayPort = await listen(gateway);
    const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
    const mismatchedPort = await unusedPort();
    const chatPort = await unusedPort();
    const chatOrigin = `http://127.0.0.1:${chatPort}`;
    const { root, publicDir } = await temporaryDirectory();
    const mismatchedBaseDir = await writeGatewayDescriptor(
      path.join(root, 'mismatched-base'),
      `http://127.0.0.1:${mismatchedPort}`,
      TOKEN,
    );
    const chat = createChatServer({
      rootDir: root,
      publicDir,
      releaseInfo: { tag: 'v0.1.2', sourceCommit: '1234567890abcdef1234567890abcdef12345678' },
      environment: {
        CHAT_PUBLIC_ORIGIN: chatOrigin,
        CHAT_DEFAULT_GATEWAY_ORIGIN: gatewayOrigin,
        CHAT_DEFAULT_SESSION_KEY: SESSION,
        CHAT_DEFAULT_PRINCIPAL_KEY: PRINCIPAL,
        CHAT_GATEWAY_OPERATOR_TOKEN: TOKEN,
        TIGHTBEAM_BASE_DIR: mismatchedBaseDir,
      },
    });
    await listen(chat, chatPort);

    const response = await fetch(`${chatOrigin}/__chat/gateway/version`, { headers: { origin: chatOrigin } });
    expect(response.status).toBe(503);
    expect(observed).toEqual([]);
  });
});
