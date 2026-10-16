import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatServer } from '../server/chat-server.mjs';
import { packageChatRelease } from '../scripts/package-chat-release.mjs';
import { publishChatRelease } from '../scripts/publish-chat-release.mjs';
import {
  CHAT_RELEASE_REPOSITORY,
  CHAT_SERVICE_NAME,
  installChatRelease,
  rollbackChatRelease,
} from '../scripts/chat-release-updater.mjs';

const SOURCE_COMMIT = '1234567890abcdef1234567890abcdef12345678';
const createdServers = [];
const temporaryRoots = [];
const serverConnections = new WeakMap();

async function listen(server, port = 0) {
  const sockets = new Set();
  serverConnections.set(server, sockets);
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
  const probe = http.createServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

async function closeServer(server) {
  const index = createdServers.indexOf(server);
  if (index >= 0) createdServers.splice(index, 1);
  for (const socket of serverConnections.get(server) ?? []) socket.destroy();
  await new Promise((resolve) => server.close(() => resolve()));
}

async function temporaryDirectory(prefix = 'chat-release-test-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const server of [...createdServers].reverse()) await closeServer(server);
  for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('persistent Chat server', () => {
  it('serves runtime target configuration and verified Chat identity without caching', async () => {
    const rootDir = await temporaryDirectory();
    const publicDir = path.join(rootDir, 'public');
    await fs.mkdir(publicDir);
    await fs.writeFile(path.join(publicDir, 'index.html'), '<main>Chat</main>');
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const server = createChatServer({
      rootDir,
      publicDir,
      releaseInfo: { tag: 'v0.1.0', sourceCommit: SOURCE_COMMIT },
      environment: {
        CHAT_PUBLIC_ORIGIN: origin,
        CHAT_DEFAULT_GATEWAY_ORIGIN: 'https://gateway.example:8443',
        CHAT_DEFAULT_SESSION_KEY: 'agent:example/session',
      },
    });
    await listen(server, port);

    const config = await fetch(`${origin}/chat-config.json`);
    expect(config.status).toBe(200);
    expect(config.headers.get('cache-control')).toBe('no-store');
    expect(await config.json()).toEqual({
      gateway: 'https://gateway.example:8443',
      sessionKey: 'agent:example/session',
    });

    const identity = await fetch(`${origin}/__chat/version`);
    expect(await identity.json()).toEqual({
      product: 'tightbeam-chat', tag: 'v0.1.0', sourceCommit: SOURCE_COMMIT,
    });
    expect(await (await fetch(`${origin}/`)).text()).toBe('<main>Chat</main>');
  });

  it('forwards only selected same-origin authenticated GET routes to the gateway', async () => {
    const observed = [];
    const gateway = http.createServer((request, response) => {
      observed.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '0.1.9' }));
    });
    const gatewayPort = await listen(gateway);
    const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
    const chatPort = await unusedPort();
    const chatOrigin = `http://127.0.0.1:${chatPort}`;
    const rootDir = await temporaryDirectory();
    const publicDir = path.join(rootDir, 'public');
    await fs.mkdir(publicDir);
    await fs.writeFile(path.join(publicDir, 'index.html'), 'Chat');
    const server = createChatServer({
      rootDir,
      publicDir,
      releaseInfo: { tag: 'v0.1.0', sourceCommit: SOURCE_COMMIT },
      environment: { CHAT_PUBLIC_ORIGIN: chatOrigin },
    });
    await listen(server, chatPort);

    const route = `/gateway/${encodeURIComponent(gatewayOrigin)}/api/sessions/agent%3Aexample/messages?limit=50`;
    const response = await fetch(`${chatOrigin}${route}`, {
      headers: { origin: chatOrigin, authorization: 'Bearer fixture-token' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: '0.1.9' });
    expect(observed).toEqual([{
      method: 'GET', url: '/api/sessions/agent%3Aexample/messages?limit=50',
      authorization: 'Bearer fixture-token',
    }]);

    const wrongOrigin = await fetch(`${chatOrigin}/gateway/${encodeURIComponent(gatewayOrigin)}/version`, {
      headers: { origin: 'https://other.example' },
    });
    expect(wrongOrigin.status).toBe(403);
    const wrongRoute = await fetch(`${chatOrigin}/gateway/${encodeURIComponent(gatewayOrigin)}/admin`, {
      headers: { origin: chatOrigin },
    });
    expect(wrongRoute.status).toBe(404);
    const wrongMethod = await fetch(`${chatOrigin}/gateway/${encodeURIComponent(gatewayOrigin)}/version`, {
      method: 'POST', headers: { origin: chatOrigin },
    });
    expect(wrongMethod.status).toBe(405);
    expect(observed).toHaveLength(1);
  });

  it('proxies the protocol-2 Firehose WebSocket on the Chat origin', async () => {
    const key = crypto.randomBytes(16).toString('base64');
    const observed = [];
    const gateway = http.createServer();
    gateway.on('upgrade', (request, socket) => {
      observed.push({ url: request.url, host: request.headers.host, origin: request.headers.origin });
      const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.once('data', (frame) => {
        observed.push({ frame: frame.toString('hex') });
        socket.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
      });
    });
    const gatewayPort = await listen(gateway);
    const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
    const chatPort = await unusedPort();
    const chatOrigin = `http://127.0.0.1:${chatPort}`;
    const rootDir = await temporaryDirectory();
    const publicDir = path.join(rootDir, 'public');
    await fs.mkdir(publicDir);
    await fs.writeFile(path.join(publicDir, 'index.html'), 'Chat');
    const server = createChatServer({
      rootDir,
      publicDir,
      releaseInfo: { tag: 'v0.1.0', sourceCommit: SOURCE_COMMIT },
      environment: { CHAT_PUBLIC_ORIGIN: chatOrigin },
    });
    await listen(server, chatPort);

    const frameMask = Buffer.from([1, 2, 3, 4]);
    const message = Buffer.from('hi');
    const masked = Buffer.from(message.map((byte, index) => byte ^ frameMask[index % 4]));
    const clientFrame = Buffer.concat([Buffer.from([0x81, 0x82]), frameMask, masked]);
    const bridgePath = `/gateway/${encodeURIComponent(gatewayOrigin)}/ws/changes?protocolVersion=2`;
    const echoed = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1', port: chatPort, path: bridgePath,
        headers: {
          connection: 'Upgrade', upgrade: 'websocket', origin: chatOrigin,
          'sec-websocket-key': key, 'sec-websocket-version': '13',
        },
      });
      let clientSocket;
      const timer = setTimeout(() => {
        request.destroy();
        clientSocket?.destroy();
        reject(new Error('WebSocket bridge timed out.'));
      }, 3000);
      request.once('error', (error) => { clearTimeout(timer); reject(error); });
      request.once('upgrade', (response, socket) => {
        clientSocket = socket;
        if (response.statusCode !== 101) {
          clearTimeout(timer);
          reject(new Error(`Unexpected WebSocket status ${response.statusCode}.`));
          socket.destroy();
          return;
        }
        socket.once('data', (data) => {
          clearTimeout(timer);
          socket.destroy();
          resolve(data);
        });
        socket.write(clientFrame);
      });
      request.end();
    });

    expect(echoed).toEqual(Buffer.from([0x81, 0x02, 0x6f, 0x6b]));
    expect(observed[0]).toEqual({
      url: '/ws/changes?protocolVersion=2', host: `127.0.0.1:${gatewayPort}`,
      origin: chatOrigin,
    });
    expect(observed[1].frame).toBe(clientFrame.toString('hex'));
  });
});

async function createBundleFixture(tag, sourceCommit) {
  const root = await temporaryDirectory('chat-release-bundle-');
  const packageRoot = path.join(root, 'package');
  const files = [
    'public/index.html', 'server/chat-server.mjs', 'bin/update-chat-release.mjs',
    'bin/chat-release-updater.mjs', 'packaging/tightbeam-chat.service', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  ];
  for (const relative of files) {
    const filename = path.join(packageRoot, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const content = relative === 'packaging/tightbeam-chat.service'
      ? await fs.readFile(path.resolve('packaging/tightbeam-chat.service'))
      : Buffer.from(`fixture ${relative}\n`);
    await fs.writeFile(filename, content);
  }
  await fs.writeFile(path.join(packageRoot, 'release.json'), `${JSON.stringify({
    product: 'tightbeam-chat', tag, sourceCommit,
  })}\n`);
  const archivePath = path.join(root, `${tag}.tar.gz`);
  execFileSync('tar', ['-czf', archivePath, '-C', packageRoot, '.']);
  const archiveBytes = await fs.readFile(archivePath);
  const assetName = `tightbeam-chat-${tag}.tar.gz`;
  const hash = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  const provenance = {
    product: 'tightbeam-chat', schemaVersion: 1, tag, sourceCommit, asset: assetName, sha256: hash,
  };
  const assets = new Map([
    [assetName, archiveBytes],
    ['SHA256SUMS', Buffer.from(`${hash}  ${assetName}\n`)],
    ['release-provenance.json', Buffer.from(`${JSON.stringify(provenance)}\n`)],
  ]);
  const release = {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: '2026-01-01T00:00:00Z',
    assets: [...assets.entries()].map(([name, bytes]) => ({
      name,
      size: bytes.length,
      state: 'uploaded',
      browser_download_url: `https://github.com/${CHAT_RELEASE_REPOSITORY}/releases/download/${tag}/${name}`,
    })),
  };
  return { root, assets, archiveBytes, provenance, release };
}

function fixtureFetch(tag, sourceCommit, fixture, { corruptAsset, failAsset, absentRelease = false } = {}) {
  return async (request) => {
    const url = new URL(request);
    const releaseUrl = `https://api.github.com/repos/${CHAT_RELEASE_REPOSITORY}/releases/tags/${tag}`;
    const commitUrl = `https://api.github.com/repos/${CHAT_RELEASE_REPOSITORY}/commits/${tag}`;
    if (url.href === releaseUrl) {
      if (absentRelease) return new Response('', { status: 404 });
      return new Response(JSON.stringify(fixture.release), { headers: { 'content-type': 'application/json' } });
    }
    if (url.href === commitUrl) {
      return new Response(JSON.stringify({ sha: sourceCommit }), { headers: { 'content-type': 'application/json' } });
    }
    const assetName = decodeURIComponent(url.pathname.split('/').at(-1));
    if (fixture.assets.has(assetName)) {
      if (assetName === failAsset) return new Response('', { status: 503 });
      let bytes = fixture.assets.get(assetName);
      if (assetName === corruptAsset) bytes = Buffer.concat([bytes, Buffer.from('corrupt')]);
      return new Response(Uint8Array.from(bytes));
    }
    return new Response('', { status: 404 });
  };
}

function mockServiceManager({ enabled = true } = {}) {
  const calls = [];
  let currentEnabled = enabled;
  return {
    calls,
    async reload() { calls.push('reload'); },
    async isEnabled() { calls.push('is-enabled'); return currentEnabled; },
    async enable() { calls.push('enable'); currentEnabled = true; },
    async restart() { calls.push(`restart:${CHAT_SERVICE_NAME}`); },
    async stopAndDisable() { calls.push('stop-and-disable'); currentEnabled = false; },
  };
}

async function setupExistingChat(homeDir) {
  const root = path.join(homeDir, '.local/share/tightbeam-chat');
  const releases = path.join(root, 'releases');
  const oldVersion = path.join(releases, 'v0.1.0');
  await fs.mkdir(oldVersion, { recursive: true });
  await fs.writeFile(path.join(oldVersion, 'installed.json'), JSON.stringify({
    tag: 'v0.1.0', sourceCommit: SOURCE_COMMIT, assetSha256: 'a'.repeat(64),
  }));
  await fs.symlink(path.relative(root, oldVersion), path.join(root, 'current'));
  await fs.writeFile(path.join(oldVersion, 'public-index.fixture'), 'old release');
  const configPath = path.join(homeDir, '.config/tightbeam-chat/server.env');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, 'CHAT_PUBLIC_ORIGIN=https://chat.example\n');
  const unitPath = path.join(homeDir, '.config/systemd/user/tightbeam-chat.service');
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.copyFile(path.resolve('packaging/tightbeam-chat.service'), unitPath);
  return { root, releases, oldVersion, unitPath };
}

describe('Chat release packaging and updater', () => {
  it('packages a tagged server with a checksum and exact source provenance', async () => {
    const rootDir = await temporaryDirectory('chat-package-source-');
    const files = [
      'dist/chat-server/public/index.html', 'server/chat-server.mjs', 'scripts/update-chat-release.mjs',
      'scripts/chat-release-updater.mjs', 'packaging/tightbeam-chat.service', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
    ];
    for (const relative of files) {
      const filename = path.join(rootDir, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, relative === 'dist/chat-server/public/index.html' ? '<main>Chat</main>' : `source ${relative}`);
    }
    const outputDir = path.join(rootDir, 'release-output');
    const builtAt = '2026-10-16T00:00:00.000Z';
    const result = await packageChatRelease({
      rootDir, outputDir, tag: 'v1.2.3', sourceCommit: SOURCE_COMMIT,
      builtAt, nodeVersion: 'v24.7.0', npmVersion: '11.5.1',
    });
    const bytes = await fs.readFile(result.assetPath);
    const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
    expect(result.assetName).toBe('tightbeam-chat-v1.2.3.tar.gz');
    expect(result.assetSha256).toBe(actualHash);
    expect(await fs.readFile(path.join(outputDir, 'SHA256SUMS'), 'utf8'))
      .toBe(`${actualHash}  tightbeam-chat-v1.2.3.tar.gz\n`);
    expect(JSON.parse(await fs.readFile(path.join(outputDir, 'release-provenance.json'), 'utf8')))
      .toMatchObject({ tag: 'v1.2.3', sourceCommit: SOURCE_COMMIT, sha256: actualHash, nodeVersion: 'v24.7.0' });
    const members = execFileSync('tar', ['-tzf', result.assetPath], { encoding: 'utf8' });
    expect(members).toContain('./public/index.html');
    expect(members).toContain('./server/chat-server.mjs');
    expect(members).toContain('./release.json');
  });

  it('publishes the checksum-bound tag only after every release asset upload is confirmed', async () => {
    const tag = 'v1.2.3';
    const rootDir = await temporaryDirectory('chat-publisher-');
    const fixture = await createBundleFixture(tag, SOURCE_COMMIT);
    const outputDir = path.join(rootDir, 'dist/chat-release');
    await fs.mkdir(outputDir, { recursive: true });
    for (const [name, bytes] of fixture.assets) await fs.writeFile(path.join(outputDir, name), bytes);
    await fs.writeFile(path.join(outputDir, 'release-notes.md'), `Tightbeam Chat ${tag}\nSource commit: ${SOURCE_COMMIT}\n`);
    const environment = {
      GITHUB_REPOSITORY: CHAT_RELEASE_REPOSITORY,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF: `refs/tags/${tag}`,
      GITHUB_REF_NAME: tag,
      GITHUB_SHA: SOURCE_COMMIT,
      GITHUB_TOKEN: 'fixture-token',
    };
    const nonTagRequests = [];
    await expect(publishChatRelease({
      rootDir,
      environment: { ...environment, GITHUB_REF_TYPE: 'branch', GITHUB_REF: `refs/heads/${tag}` },
      fetchImpl: async (...args) => { nonTagRequests.push(args); return new Response('', { status: 500 }); },
    })).rejects.toThrow(/tag-triggered/);
    expect(nonTagRequests).toHaveLength(0);
    const operations = [];
    const fetchImpl = async (request, options = {}) => {
      const url = new URL(request);
      operations.push({ method: options.method ?? 'GET', url: url.href, body: options.body, authorization: options.headers?.authorization });
      if (url.href === 'https://api.github.com/repos/clickety-clacks/tightbeam-chat/releases' && options.method === 'POST') {
        return new Response(JSON.stringify({
          id: 17, tag_name: tag, draft: true,
          upload_url: 'https://uploads.github.com/repos/clickety-clacks/tightbeam-chat/releases/17/assets{?name,label}',
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.href.startsWith('https://uploads.github.com/repos/clickety-clacks/tightbeam-chat/releases/17/assets?')) {
        const name = url.searchParams.get('name');
        const body = Buffer.from(options.body);
        return new Response(JSON.stringify({ name, state: 'uploaded', size: body.length }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.href === 'https://api.github.com/repos/clickety-clacks/tightbeam-chat/releases/17' && options.method === 'PATCH') {
        return new Response(JSON.stringify({
          id: 17, tag_name: tag, draft: false, published_at: '2026-10-16T00:00:00Z',
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 404 });
    };

    const published = await publishChatRelease({ rootDir, environment, fetchImpl });
    expect(published).toMatchObject({ tag, sourceCommit: SOURCE_COMMIT, assetName: `tightbeam-chat-${tag}.tar.gz` });
    expect(operations.map((operation) => operation.method)).toEqual(['POST', 'POST', 'POST', 'POST', 'PATCH']);
    expect(operations.slice(1, 4).map((operation) => new URL(operation.url).searchParams.get('name')))
      .toEqual([`tightbeam-chat-${tag}.tar.gz`, 'SHA256SUMS', 'release-provenance.json']);
    expect(operations.every((operation) => operation.authorization === 'Bearer fixture-token')).toBe(true);
    expect(JSON.parse(operations[0].body)).toMatchObject({ tag_name: tag, draft: true, prerelease: false });
    expect(JSON.parse(operations.at(-1).body)).toEqual({ draft: false });

    const failedOperations = [];
    const failedFetch = async (request, options = {}) => {
      const url = new URL(request);
      failedOperations.push({ method: options.method ?? 'GET', url: url.href });
      if (url.href === 'https://api.github.com/repos/clickety-clacks/tightbeam-chat/releases' && options.method === 'POST') {
        return new Response(JSON.stringify({
          id: 18, tag_name: tag, draft: true,
          upload_url: 'https://uploads.github.com/repos/clickety-clacks/tightbeam-chat/releases/18/assets{?name,label}',
        }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.href.startsWith('https://uploads.github.com/repos/clickety-clacks/tightbeam-chat/releases/18/assets?')) {
        if (url.searchParams.get('name') === 'SHA256SUMS') return new Response('', { status: 503 });
        const name = url.searchParams.get('name');
        const body = Buffer.from(options.body);
        return new Response(JSON.stringify({ name, state: 'uploaded', size: body.length }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 404 });
    };
    await expect(publishChatRelease({ rootDir, environment, fetchImpl: failedFetch })).rejects.toThrow(/HTTP 503/);
    expect(failedOperations.some((operation) => operation.method === 'PATCH')).toBe(false);
  });

  it('stages only a published, checksum-verified tag and switches back on rollback', async () => {
    const homeDir = await temporaryDirectory('chat-updater-home-');
    const { root, oldVersion } = await setupExistingChat(homeDir);
    const tag = 'v1.2.3';
    const fixture = await createBundleFixture(tag, SOURCE_COMMIT);
    const serviceManager = mockServiceManager();
    const health = [];
    const healthCheck = async (expected) => { health.push(expected); return expected; };

    const installed = await installChatRelease(tag, {
      homeDir,
      fetchImpl: fixtureFetch(tag, SOURCE_COMMIT, fixture),
      serviceManager,
      healthCheck,
    });
    expect(installed).toMatchObject({ tag, sourceCommit: SOURCE_COMMIT, staged: true, unchanged: false });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(path.relative(root, path.join(root, 'releases', tag)));
    expect(await fs.readlink(path.join(root, 'previous'))).toBe(path.relative(root, oldVersion));
    expect(serviceManager.calls).toContain('restart:tightbeam-chat.service');
    expect(serviceManager.calls).not.toContain('restart:tightbeam-gateway.service');
    expect(health).toEqual([{ tag, sourceCommit: SOURCE_COMMIT }]);

    const rolledBack = await rollbackChatRelease({ homeDir, serviceManager, healthCheck });
    expect(rolledBack).toEqual({ tag: 'v0.1.0', sourceCommit: SOURCE_COMMIT });
    expect(await fs.readlink(path.join(root, 'current'))).toBe(path.relative(root, oldVersion));
    expect(await fs.readlink(path.join(root, 'previous'))).toBe(path.relative(root, path.join(root, 'releases', tag)));
  });

  it('preserves the serving version when the published asset is missing, corrupt, or transferred incompletely', async () => {
    const tag = 'v1.2.3';
    const cases = [
      { label: 'unpublished', options: { absentRelease: true }, message: /HTTP 404/ },
      { label: 'corrupt', options: { corruptAsset: `tightbeam-chat-${tag}.tar.gz` }, message: /size does not match/ },
      { label: 'failed transfer', options: { failAsset: 'SHA256SUMS' }, message: /HTTP 503/ },
    ];
    for (const scenario of cases) {
      const homeDir = await temporaryDirectory(`chat-updater-${scenario.label.replaceAll(' ', '-')}-`);
      const { root, oldVersion } = await setupExistingChat(homeDir);
      const fixture = await createBundleFixture(tag, SOURCE_COMMIT);
      const serviceManager = mockServiceManager();
      await expect(installChatRelease(tag, {
        homeDir,
        fetchImpl: fixtureFetch(tag, SOURCE_COMMIT, fixture, scenario.options),
        serviceManager,
        healthCheck: async () => { throw new Error('must not be reached'); },
      })).rejects.toThrow(scenario.message);
      expect(await fs.readlink(path.join(root, 'current'))).toBe(path.relative(root, oldVersion));
      expect(serviceManager.calls).toEqual([]);
    }
  });

  it('restores the previous Chat pointer and service when the new version fails its served-version check', async () => {
    const homeDir = await temporaryDirectory('chat-updater-health-');
    const { root, oldVersion } = await setupExistingChat(homeDir);
    const tag = 'v1.2.3';
    const fixture = await createBundleFixture(tag, SOURCE_COMMIT);
    const serviceManager = mockServiceManager();
    const health = [];
    await expect(installChatRelease(tag, {
      homeDir,
      fetchImpl: fixtureFetch(tag, SOURCE_COMMIT, fixture),
      serviceManager,
      healthCheck: async (expected) => {
        health.push(expected.tag);
        if (expected.tag === tag) throw new Error('Served release identity did not match.');
        return expected;
      },
    })).rejects.toThrow(/prior Chat version was restored/);
    expect(health).toEqual([tag, 'v0.1.0']);
    expect(await fs.readlink(path.join(root, 'current'))).toBe(path.relative(root, oldVersion));
    expect(await fs.lstat(path.join(root, 'previous')).then(() => true, () => false)).toBe(false);
    expect(serviceManager.calls).toEqual([
      'is-enabled', 'reload', 'restart:tightbeam-chat.service', 'reload', 'restart:tightbeam-chat.service',
    ]);
  });
});
