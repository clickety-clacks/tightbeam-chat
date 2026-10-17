import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function canonicalOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname ||
        parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function gatewayBaseDirectory(environment) {
  if (environment.TIGHTBEAM_BASE_DIR !== undefined) return environment.TIGHTBEAM_BASE_DIR;
  if (environment.TIGHTBEAM_HOME !== undefined) return environment.TIGHTBEAM_HOME;
  return path.join(environment.HOME || os.homedir(), '.tightbeam');
}

function provisionedGateway(environment) {
  try {
    const filename = path.join(gatewayBaseDirectory(environment), 'gateway.json');
    const descriptor = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const token = typeof descriptor.cliToken === 'string' && descriptor.cliToken.length > 0
      ? descriptor.cliToken
      : '';
    let base;
    if (typeof descriptor.url === 'string' && descriptor.url.length > 0) {
      const normalized = descriptor.url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
      base = canonicalOrigin(normalized);
    } else if (Number.isInteger(descriptor.port) && descriptor.port > 0 && descriptor.port <= 65535) {
      base = `http://127.0.0.1:${descriptor.port}`;
    }
    return { base, token };
  } catch {
    return { base: undefined, token: '' };
  }
}

function loadRuntimeConfig(environment) {
  const publicOrigin = canonicalOrigin(environment.CHAT_PUBLIC_ORIGIN);
  const provisioned = provisionedGateway(environment);
  const configuredGateway = canonicalOrigin(environment.CHAT_DEFAULT_GATEWAY_ORIGIN);
  const gateway = configuredGateway && configuredGateway === provisioned.base
    ? configuredGateway
    : undefined;
  const sessionKey = typeof environment.CHAT_DEFAULT_SESSION_KEY === 'string'
    ? environment.CHAT_DEFAULT_SESSION_KEY
    : '';
  const principalKey = typeof environment.CHAT_DEFAULT_PRINCIPAL_KEY === 'string'
    ? environment.CHAT_DEFAULT_PRINCIPAL_KEY.trim()
    : '';
  const deviceId = gateway && principalKey && sessionKey.trim()
    ? `chat_${crypto.createHash('sha256').update(`${gateway}\0${principalKey}\0${sessionKey}`).digest('hex').slice(0, 24)}`
    : '';
  const configuredTarget = gateway && sessionKey.trim()
    ? {
      gateway,
      sessionKey,
      ...(principalKey ? { principalKey, deviceId } : {}),
    }
    : {};

  return {
    publicOrigin,
    configuredTarget,
    gateway,
    sessionKey,
    principalKey,
    deviceId,
    operatorToken: gateway ? provisioned.token : '',
  };
}

function serviceReady(runtime) {
  return Boolean(runtime.gateway && runtime.sessionKey.trim() && runtime.principalKey &&
    runtime.deviceId && runtime.operatorToken);
}

function decodeSessionPath(value) {
  try {
    const sessionKey = decodeURIComponent(value);
    return sessionKey.trim() ? sessionKey : undefined;
  } catch {
    return undefined;
  }
}

function parseServiceHttpTarget(rawUrl, runtime) {
  try {
    const request = new URL(rawUrl, 'http://chat-service.invalid');
    if (request.origin !== 'http://chat-service.invalid') return undefined;
    if (request.pathname === '/__chat/gateway/version' && request.search === '') {
      return { kind: 'version', path: '/version' };
    }

    const detail = /^\/__chat\/api\/sessions\/([^/]+)$/.exec(request.pathname);
    const detailSession = detail && decodeSessionPath(detail[1]);
    if (detailSession && request.search === '') {
      return {
        kind: 'detail',
        sessionKey: detailSession,
        path: `/api/sessions/${encodeURIComponent(detailSession)}?asUser=${encodeURIComponent(runtime.principalKey)}`,
      };
    }

    const messages = /^\/__chat\/api\/sessions\/([^/]+)\/messages$/.exec(request.pathname);
    const messageSession = messages && decodeSessionPath(messages[1]);
    if (!messageSession) return undefined;

    const params = [...request.searchParams.entries()];
    const names = params.map(([name]) => name);
    if (params.length !== 2 || new Set(names).size !== names.length || request.searchParams.get('limit') !== '50') {
      return undefined;
    }
    if (request.searchParams.get('tail') === 'true' && !names.includes('before')) {
      return { kind: 'transcript', sessionKey: messageSession, before: undefined };
    }
    const before = request.searchParams.get('before');
    if (before && names.includes('before') && !names.includes('tail')) {
      return { kind: 'transcript', sessionKey: messageSession, before };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseServiceWebSocketTarget(rawUrl) {
  try {
    const request = new URL(rawUrl, 'http://chat-service.invalid');
    if (request.origin !== 'http://chat-service.invalid') return undefined;
    const sessionKeys = request.searchParams.getAll('sessionKey');
    if (sessionKeys.length !== 1 || !sessionKeys[0]?.trim()) return undefined;

    if (request.pathname === '/__chat/ws/changes') {
      if (request.searchParams.getAll('protocolVersion').length !== 1 ||
          request.searchParams.get('protocolVersion') !== '2' ||
          [...request.searchParams.keys()].some((key) => !['sessionKey', 'protocolVersion'].includes(key))) {
        return undefined;
      }
      return { path: '/ws/changes?protocolVersion=2', kind: 'changes', sessionKey: sessionKeys[0] };
    }
    if (request.pathname === '/__chat/ws' &&
        [...request.searchParams.keys()].every((key) => key === 'sessionKey')) {
      return { path: '/ws', kind: 'human', sessionKey: sessionKeys[0] };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function jsonResponse(response, status, value) {
  writeJson(response, status, value);
}

function gatewayRequest(runtime, path, { method = 'GET', headers = {}, body, authorize = true } = {}) {
  return new Promise((resolve, reject) => {
    const protocol = runtime.gateway.startsWith('https:') ? https : http;
    const request = protocol.request(runtime.gateway, {
      method,
      path,
      headers: {
        ...(authorize ? { authorization: `Bearer ${runtime.operatorToken}` } : {}),
        accept: 'application/json',
        ...headers,
      },
    }, (reply) => {
      const chunks = [];
      reply.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      reply.on('end', () => resolve({
        status: reply.statusCode ?? 502,
        contentType: reply.headers['content-type'] ?? 'application/json; charset=utf-8',
        body: Buffer.concat(chunks),
      }));
    });
    request.setTimeout(15000, () => request.destroy(new Error('Gateway request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

function writeGatewayReply(response, reply) {
  response.writeHead(reply.status, {
    'content-type': reply.contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': reply.body.length,
  });
  response.end(reply.body);
}

function cliVersionFrom(reply) {
  try {
    const value = JSON.parse(reply.body.toString('utf8'));
    return typeof value.version === 'string' && value.version ? value.version : undefined;
  } catch {
    return undefined;
  }
}

async function serviceHttp(request, response, runtime) {
  if (request.method !== 'GET') {
    response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' }).end();
    return;
  }
  if (!serviceReady(runtime)) {
    jsonResponse(response, 503, { error: { code: 'chat_service_unconfigured' } });
    return;
  }
  const target = parseServiceHttpTarget(request.url ?? '', runtime);
  if (!target) {
    jsonResponse(response, 404, { error: { code: 'not_found' } });
    return;
  }

  try {
    if (target.kind === 'version' || target.kind === 'detail') {
      writeGatewayReply(response, await gatewayRequest(runtime, target.path, {
        authorize: target.kind !== 'version',
      }));
      return;
    }

    const versionReply = await gatewayRequest(runtime, '/version', { authorize: false });
    if (versionReply.status < 200 || versionReply.status >= 300) {
      writeGatewayReply(response, versionReply);
      return;
    }
    const cliVersion = cliVersionFrom(versionReply);
    if (!cliVersion) {
      jsonResponse(response, 502, { error: { code: 'gateway_version_unavailable' } });
      return;
    }
    const params = { session_key: target.sessionKey, limit: 50 };
    if (target.before) params.before = target.before;
    const body = Buffer.from(JSON.stringify({
      verb: 'transcript',
      asUser: runtime.principalKey,
      params,
    }));
    const reply = await gatewayRequest(runtime, '/agent/dispatch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        'x-tightbeam-cli-version': cliVersion,
      },
      body,
    });
    if (reply.status < 200 || reply.status >= 300) {
      writeGatewayReply(response, reply);
      return;
    }
    let envelope;
    try {
      const payload = JSON.parse(reply.body.toString('utf8'));
      const result = payload?.result;
      if (!Array.isArray(result?.messages) || typeof result.hasMoreBefore !== 'boolean') throw new Error();
      envelope = {
        schemaVersion: 1,
        resource: 'transcript messages',
        items: result.messages,
        page: { oldestCursor: result.oldestId ?? null, hasMoreBefore: result.hasMoreBefore },
      };
    } catch {
      jsonResponse(response, 502, { error: { code: 'transcript_response_unavailable' } });
      return;
    }
    jsonResponse(response, 200, envelope);
  } catch {
    jsonResponse(response, 502, { error: { code: 'gateway_unavailable' } });
  }
}

function websocketClientTextFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function proxyServiceWebSocket(request, socket, head, target, runtime) {
  const protocol = runtime.gateway.startsWith('https:') ? https : http;
  const headers = {
    host: new URL(runtime.gateway).host,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-key': String(request.headers['sec-websocket-key'] ?? ''),
    'sec-websocket-version': String(request.headers['sec-websocket-version'] ?? ''),
  };
  if (typeof request.headers.origin === 'string') headers.origin = request.headers.origin;
  if (request.headers['sec-websocket-protocol']) {
    headers['sec-websocket-protocol'] = request.headers['sec-websocket-protocol'];
  }

  const upstream = protocol.request(runtime.gateway, { method: 'GET', path: target.path, headers });
  upstream.on('upgrade', (reply, remote, remoteHead) => {
    const statusText = reply.statusMessage || 'Switching Protocols';
    const headerLines = [];
    for (const [name, value] of Object.entries(reply.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined) headerLines.push(`${name}: ${item}`);
      }
    }
    socket.write(`HTTP/1.1 ${reply.statusCode} ${statusText}\r\n${headerLines.join('\r\n')}\r\n\r\n`);
    if (remoteHead.length) socket.write(remoteHead);
    const auth = {
      type: 'auth',
      token: runtime.operatorToken,
      asUser: runtime.principalKey,
      sessionKey: target.sessionKey,
    };
    if (target.kind === 'human') {
      auth.deviceId = runtime.deviceId;
      auth.subscriptions = ['chat'];
    }
    remote.write(websocketClientTextFrame(auth));
    if (head.length) remote.write(head);
    socket.pipe(remote).pipe(socket);
    socket.on('error', () => remote.destroy());
    remote.on('error', () => socket.destroy());
    socket.on('close', () => remote.destroy());
    remote.on('close', () => socket.destroy());
  });
  upstream.on('response', (reply) => {
    socket.end(`HTTP/1.1 ${reply.statusCode ?? 502} Gateway Refused\r\nConnection: close\r\n\r\n`);
    upstream.destroy();
  });
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
}

function parseBridgeTarget(rawUrl) {
  try {
    const request = new URL(rawUrl, 'http://chat-bridge.invalid');
    if (request.origin !== 'http://chat-bridge.invalid') return undefined;
    const match = /^\/gateway\/([^/]+)(\/.*)$/.exec(request.pathname);
    if (!match) return undefined;

    const gateway = canonicalOrigin(decodeURIComponent(match[1]));
    if (!gateway) return undefined;
    const forwarded = new URL(`${match[2]}${request.search}`, gateway);
    if (forwarded.origin !== gateway || forwarded.username || forwarded.password || forwarded.hash) return undefined;

    const pathname = forwarded.pathname;
    const websocket = pathname === '/ws' || pathname === '/ws/changes';
    const rest = pathname === '/version' || pathname === '/api/sessions' ||
      /^\/api\/sessions\/[^/]+(?:\/messages)?$/.test(pathname);
    if (!websocket && !rest) return undefined;
    return { gateway, path: `${pathname}${forwarded.search}`, websocket };
  } catch {
    return undefined;
  }
}

function writeJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sameBrowserOrigin(origin, expected) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.origin === expected && parsed.username === '' && parsed.password === '' &&
      parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
}

function allowedPublicOrigin(runtime, request) {
  if (!runtime.publicOrigin) return false;
  const origin = request.headers.origin;
  return sameBrowserOrigin(origin, runtime.publicOrigin);
}

function respondText(response, status, text) {
  const body = Buffer.from(text);
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function serveAsset(request, response, publicDir) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://chat.invalid').pathname);
  } catch {
    respondText(response, 400, 'Invalid asset path.');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const root = path.resolve(publicDir);
  const filename = path.resolve(root, `.${pathname}`);
  if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) {
    respondText(response, 404, 'Not found.');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filename);
  } catch {
    respondText(response, 404, 'Not found.');
    return;
  }
  if (!stat.isFile()) {
    respondText(response, 404, 'Not found.');
    return;
  }

  const cacheControl = pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  response.writeHead(200, {
    'content-type': MIME_TYPES.get(path.extname(filename).toLowerCase()) ?? 'application/octet-stream',
    'cache-control': cacheControl,
    'content-length': stat.size,
    'x-content-type-options': 'nosniff',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(filename).on('error', () => response.destroy()).pipe(response);
}

function proxyHttp(request, response, target) {
  const protocol = target.gateway.startsWith('https:') ? https : http;
  const upstream = protocol.request(target.gateway, {
    method: 'GET',
    path: target.path,
    headers: request.headers.authorization
      ? { authorization: request.headers.authorization, accept: request.headers.accept ?? '*/*' }
      : { accept: request.headers.accept ?? '*/*' },
  }, (reply) => {
    response.writeHead(reply.statusCode ?? 502, {
      'content-type': reply.headers['content-type'] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    reply.pipe(response);
  });

  upstream.setTimeout(15000, () => upstream.destroy(new Error('Gateway request timed out')));
  upstream.on('error', () => {
    if (!response.headersSent) respondText(response, 502, 'Gateway unavailable.');
    else response.destroy();
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => upstream.destroy());
  upstream.end();
}

function proxyWebSocket(request, socket, head, target) {
  const protocol = target.gateway.startsWith('https:') ? https : http;
  const headers = {
    host: new URL(target.gateway).host,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-key': String(request.headers['sec-websocket-key'] ?? ''),
    'sec-websocket-version': String(request.headers['sec-websocket-version'] ?? ''),
  };
  if (typeof request.headers.origin === 'string') headers.origin = request.headers.origin;
  if (request.headers['sec-websocket-protocol']) {
    headers['sec-websocket-protocol'] = request.headers['sec-websocket-protocol'];
  }

  const upstream = protocol.request(target.gateway, { method: 'GET', path: target.path, headers });
  upstream.on('upgrade', (reply, remote, remoteHead) => {
    const statusText = reply.statusMessage || 'Switching Protocols';
    const headerLines = [];
    for (const [name, value] of Object.entries(reply.headers)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined) headerLines.push(`${name}: ${item}`);
      }
    }
    socket.write(`HTTP/1.1 ${reply.statusCode} ${statusText}\r\n${headerLines.join('\r\n')}\r\n\r\n`);
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    socket.pipe(remote).pipe(socket);
    socket.on('error', () => remote.destroy());
    remote.on('error', () => socket.destroy());
    socket.on('close', () => remote.destroy());
    remote.on('close', () => socket.destroy());
  });
  upstream.on('response', (reply) => {
    socket.end(`HTTP/1.1 ${reply.statusCode ?? 502} Gateway Refused\r\nConnection: close\r\n\r\n`);
    upstream.destroy();
  });
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.end();
}

export function createChatServer({
  rootDir = process.cwd(),
  publicDir = path.resolve(rootDir, 'public'),
  releaseInfo,
  environment = process.env,
} = {}) {
  const runtime = loadRuntimeConfig(environment);
  const manifest = releaseInfo ?? JSON.parse(fs.readFileSync(path.resolve(rootDir, 'release.json'), 'utf8'));

  return http.createServer((request, response) => {
    const parsedRequest = new URL(request.url ?? '/', 'http://chat.invalid');
    if (parsedRequest.pathname === '/chat-config.json') {
      writeJson(response, 200, runtime.configuredTarget);
      return;
    }
    if (parsedRequest.pathname === '/__chat/version') {
      writeJson(response, 200, {
        product: 'tightbeam-chat',
        tag: manifest.tag,
        sourceCommit: manifest.sourceCommit,
      });
      return;
    }
    if (parsedRequest.pathname.startsWith('/__chat/')) {
      if (!allowedPublicOrigin(runtime, request)) {
        response.writeHead(403, { 'cache-control': 'no-store' }).end();
        return;
      }
      void serviceHttp(request, response, runtime);
      return;
    }
    if (parsedRequest.pathname.startsWith('/gateway/')) {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' }).end();
        return;
      }
      if (!allowedPublicOrigin(runtime, request)) {
        response.writeHead(403, { 'cache-control': 'no-store' }).end();
        return;
      }
      const target = parseBridgeTarget(request.url ?? '');
      if (!target || target.websocket) {
        response.writeHead(404, { 'cache-control': 'no-store' }).end();
        return;
      }
      proxyHttp(request, response, target);
      return;
    }
    serveAsset(request, response, publicDir);
  }).on('upgrade', (request, socket, head) => {
    const parsedRequest = new URL(request.url ?? '/', 'http://chat.invalid');
    if (parsedRequest.pathname.startsWith('/__chat/')) {
      if (!allowedPublicOrigin(runtime, request) || request.method !== 'GET' ||
          request.headers.upgrade?.toLowerCase() !== 'websocket' ||
          request.headers['sec-websocket-version'] !== '13' ||
          typeof request.headers['sec-websocket-key'] !== 'string') {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      if (!serviceReady(runtime)) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      const target = parseServiceWebSocketTarget(request.url ?? '');
      if (!target) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      proxyServiceWebSocket(request, socket, head, target, runtime);
      return;
    }
    if (!parsedRequest.pathname.startsWith('/gateway/')) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!allowedPublicOrigin(runtime, request) || request.method !== 'GET' ||
        request.headers.upgrade?.toLowerCase() !== 'websocket' ||
        request.headers['sec-websocket-version'] !== '13' ||
        typeof request.headers['sec-websocket-key'] !== 'string') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = parseBridgeTarget(request.url ?? '');
    if (!target?.websocket) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    proxyWebSocket(request, socket, head, target);
  });
}

export function startChatServer({ environment = process.env, rootDir = process.cwd() } = {}) {
  const server = createChatServer({ rootDir, environment });
  server.listen(4178, '127.0.0.1');
  return server;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    startChatServer();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Chat server failed to start.'}\n`);
    process.exitCode = 1;
  }
}
