import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
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

function loadRuntimeConfig(environment) {
  const publicOrigin = canonicalOrigin(environment.CHAT_PUBLIC_ORIGIN);
  const gateway = canonicalOrigin(environment.CHAT_DEFAULT_GATEWAY_ORIGIN);
  const sessionKey = typeof environment.CHAT_DEFAULT_SESSION_KEY === 'string'
    ? environment.CHAT_DEFAULT_SESSION_KEY
    : '';
  const configuredTarget = gateway && sessionKey.trim()
    ? { gateway, sessionKey }
    : {};

  return { publicOrigin, configuredTarget };
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
