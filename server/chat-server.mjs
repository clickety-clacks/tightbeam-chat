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
        value.includes('?') || value.includes('#') ||
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

function readGatewayDescriptor(baseDirectory) {
  try {
    const filename = path.join(baseDirectory, 'gateway.json');
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
    return undefined;
  }
}

function loadGatewayMap(environment, configuredGateway) {
  const gateways = new Map();
  if (environment.CHAT_GATEWAY_MAP_FILE === undefined) {
    const provisioned = readGatewayDescriptor(gatewayBaseDirectory(environment));
    if (configuredGateway && provisioned?.base === configuredGateway) {
      gateways.set(configuredGateway, { ...provisioned, available: Boolean(provisioned.token) });
    }
    return { valid: true, gateways };
  }

  let value;
  try {
    value = JSON.parse(fs.readFileSync(environment.CHAT_GATEWAY_MAP_FILE, 'utf8'));
  } catch {
    console.warn('CHAT_GATEWAY_MAP_FILE could not be read; mapped Gateway routing is unavailable.');
    return { valid: false, gateways: new Map() };
  }
  if (!value || value.version !== 1 || !Array.isArray(value.gateways)) {
    console.warn('CHAT_GATEWAY_MAP_FILE has an invalid root structure; mapped Gateway routing is unavailable.');
    return { valid: false, gateways: new Map() };
  }

  const configuredKeys = new Set();
  for (const [index, item] of value.gateways.entries()) {
    let keys;
    let reason;
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.baseDir !== 'string' || !path.isAbsolute(item.baseDir)) {
      reason = 'invalid entry fields';
    } else {
      const origin = canonicalOrigin(item.origin);
      const aliases = item.aliases === undefined ? [] : item.aliases;
      if (!origin) reason = 'invalid origin';
      else if (!Array.isArray(aliases)) reason = 'aliases must be an array';
      else {
        keys = [origin];
        for (const alias of aliases) {
          const canonicalAlias = canonicalOrigin(alias);
          if (!canonicalAlias) {
            reason = 'invalid alias';
            break;
          }
          keys.push(canonicalAlias);
        }
        if (!reason && new Set(keys).size !== keys.length) reason = 'duplicate origin or alias';
        if (!reason && keys.some((key) => configuredKeys.has(key))) reason = 'origin or alias is already mapped';
      }
    }
    if (reason || !keys) {
      console.warn(`Skipping CHAT_GATEWAY_MAP_FILE entry ${index + 1}: ${reason ?? 'invalid entry'}.`);
      continue;
    }

    for (const key of keys) configuredKeys.add(key);
    const descriptor = readGatewayDescriptor(item.baseDir);
    const descriptorMatches = descriptor && keys.includes(descriptor.base);
    const entry = {
      base: descriptorMatches && descriptor.token ? descriptor.base : undefined,
      token: descriptorMatches && descriptor.token ? descriptor.token : '',
      available: Boolean(descriptorMatches && descriptor.token),
    };
    for (const key of keys) gateways.set(key, entry);
  }
  return { valid: true, gateways };
}

function loadRuntimeConfig(environment) {
  const publicOrigin = canonicalOrigin(environment.CHAT_PUBLIC_ORIGIN);
  const configuredGateway = canonicalOrigin(environment.CHAT_DEFAULT_GATEWAY_ORIGIN);
  const gatewayMap = loadGatewayMap(environment, configuredGateway);
  const gatewayOrigin = gatewayMap.valid && configuredGateway && gatewayMap.gateways.has(configuredGateway)
    ? configuredGateway
    : undefined;
  const sessionKey = typeof environment.CHAT_DEFAULT_SESSION_KEY === 'string'
    ? environment.CHAT_DEFAULT_SESSION_KEY
    : '';
  const principalKey = typeof environment.CHAT_DEFAULT_PRINCIPAL_KEY === 'string'
    ? environment.CHAT_DEFAULT_PRINCIPAL_KEY.trim()
    : '';
  const deviceId = gatewayOrigin && principalKey && sessionKey.trim()
    ? `chat_${crypto.createHash('sha256').update(`${gatewayOrigin}\0${principalKey}\0${sessionKey}`).digest('hex').slice(0, 24)}`
    : '';
  const configuredTarget = gatewayOrigin && sessionKey.trim()
    ? {
      gateway: gatewayOrigin,
      sessionKey,
      ...(principalKey ? { principalKey, deviceId } : {}),
    }
    : {};

  return {
    publicOrigin,
    configuredTarget,
    gatewayOrigin,
    gatewayMapValid: gatewayMap.valid,
    gateways: gatewayMap.gateways,
    sessionKey,
    principalKey,
    deviceId,
  };
}

function serviceReady(runtime) {
  return Boolean(runtime.gatewayMapValid && runtime.gatewayOrigin && runtime.gateways.has(runtime.gatewayOrigin) &&
    runtime.sessionKey.trim() && runtime.principalKey && runtime.deviceId);
}

function decodeSessionPath(value) {
  try {
    const sessionKey = decodeURIComponent(value);
    return sessionKey.trim() ? sessionKey : undefined;
  } catch {
    return undefined;
  }
}

function selectedGatewayOrigin(searchParams, defaultGatewayOrigin) {
  const values = searchParams.getAll('gateway');
  if (values.length > 1) return undefined;
  return values.length === 0 ? defaultGatewayOrigin : canonicalOrigin(values[0]);
}

export function parseServiceHttpTarget(rawUrl, runtime) {
  try {
    const request = new URL(rawUrl, 'http://chat-service.invalid');
    if (request.origin !== 'http://chat-service.invalid') return undefined;
    const gatewayOrigin = selectedGatewayOrigin(request.searchParams, runtime.gatewayOrigin);
    if (!gatewayOrigin) return undefined;
    const routeParams = [...request.searchParams.entries()].filter(([name]) => name !== 'gateway');
    if (request.pathname === '/__chat/gateway/version' && routeParams.length === 0) {
      return { kind: 'version', gatewayOrigin, path: '/version' };
    }

    const detail = /^\/__chat\/api\/sessions\/([^/]+)$/.exec(request.pathname);
    const detailSession = detail && decodeSessionPath(detail[1]);
    if (detailSession && routeParams.length === 0) {
      return {
        kind: 'detail',
        gatewayOrigin,
        sessionKey: detailSession,
        path: `/api/sessions/${encodeURIComponent(detailSession)}?asUser=${encodeURIComponent(runtime.principalKey)}`,
      };
    }

    const toolDetail = /^\/__chat\/api\/sessions\/([^/]+)\/tool-calls\/([^/]+)$/.exec(request.pathname);
    const toolSession = toolDetail && decodeSessionPath(toolDetail[1]);
    const toolId = toolDetail && decodeSessionPath(toolDetail[2]);
    if (toolSession && toolId && routeParams.length === 0) {
      return { kind: 'detail', gatewayOrigin, sessionKey: toolSession,
        path: `/api/sessions/${encodeURIComponent(toolSession)}/tool-calls/${encodeURIComponent(toolId)}?asUser=${encodeURIComponent(runtime.principalKey)}` };
    }
    const tools = /^\/__chat\/api\/sessions\/([^/]+)\/tool-calls$/.exec(request.pathname);
    const toolsSession = tools && decodeSessionPath(tools[1]);
    if (toolsSession) {
      const allowed = new Set(['limit', 'before', 'afterMessageSeqFromInclusive', 'afterMessageSeqToExclusive']);
      if (new Set(routeParams.map(([name]) => name)).size !== routeParams.length ||
          routeParams.some(([name]) => !allowed.has(name))) return undefined;
      for (const [name, value] of routeParams) {
        if (name === 'before') { if (!value) return undefined; continue; }
        if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) return undefined;
        if (name === 'limit' && (Number(value) < 1 || Number(value) > 500)) return undefined;
      }
      const query = new URLSearchParams([['asUser', runtime.principalKey], ...routeParams]);
      return { kind: 'transcript', gatewayOrigin, sessionKey: toolsSession,
        path: `/api/sessions/${encodeURIComponent(toolsSession)}/tool-calls?${query}` };
    }

    const trigger = /^\/__chat\/api\/sessions\/([^/]+)\/messages\/([^/]+)$/.exec(request.pathname);
    const triggerSession = trigger && decodeSessionPath(trigger[1]);
    const triggerMessage = trigger && decodeSessionPath(trigger[2]);
    if (triggerSession && triggerMessage && routeParams.length === 0) {
      return {
        kind: 'detail', gatewayOrigin, sessionKey: triggerSession,
        path: `/api/sessions/${encodeURIComponent(triggerSession)}/messages/${encodeURIComponent(triggerMessage)}?asUser=${encodeURIComponent(runtime.principalKey)}`,
      };
    }

    const sessionTurns = /^\/__chat\/api\/sessions\/([^/]+)\/turns$/.exec(request.pathname);
    const turnsSession = sessionTurns && decodeSessionPath(sessionTurns[1]);
    if (turnsSession && routeParams.length === 2 &&
        request.searchParams.get('limit') === '50' && request.searchParams.get('tail') === 'true' &&
        routeParams.some(([name]) => name === 'limit') && routeParams.some(([name]) => name === 'tail')) {
      return {
        kind: 'transcript', gatewayOrigin, sessionKey: turnsSession,
        path: `/api/sessions/${encodeURIComponent(turnsSession)}/turns?asUser=${encodeURIComponent(runtime.principalKey)}&limit=50&tail=true`,
      };
    }

    const turn = /^\/__chat\/api\/turns\/([1-9][0-9]*)$/.exec(request.pathname);
    if (turn && routeParams.length === 0 && Number.isSafeInteger(Number(turn[1]))) {
      return {
        kind: 'detail', gatewayOrigin,
        path: `/api/turns/${turn[1]}?asUser=${encodeURIComponent(runtime.principalKey)}`,
      };
    }

    const role = /^\/__chat\/api\/roles\/([^/]+)$/.exec(request.pathname);
    const roleName = role && decodeSessionPath(role[1]);
    if (roleName && routeParams.length === 0) {
      return {
        kind: 'detail', gatewayOrigin,
        path: `/api/roles/${encodeURIComponent(roleName)}?asUser=${encodeURIComponent(runtime.principalKey)}`,
      };
    }

    const messages = /^\/__chat\/api\/sessions\/([^/]+)\/messages$/.exec(request.pathname);
    const messageSession = messages && decodeSessionPath(messages[1]);
    if (!messageSession) return undefined;

    const params = routeParams;
    const names = params.map(([name]) => name);
    if (params.length !== 2 || new Set(names).size !== names.length || request.searchParams.get('limit') !== '50') {
      return undefined;
    }
    const upstreamQuery = new URLSearchParams([
      ['asUser', runtime.principalKey],
      ['limit', '50'],
    ]);
    if (request.searchParams.get('tail') === 'true' && !names.includes('before')) {
      upstreamQuery.set('tail', 'true');
      return {
        kind: 'transcript', gatewayOrigin,
        path: `/api/sessions/${encodeURIComponent(messageSession)}/messages?${upstreamQuery}`,
      };
    }
    const before = request.searchParams.get('before');
    if (before && names.includes('before') && !names.includes('tail')) {
      upstreamQuery.set('before', before);
      return {
        kind: 'transcript', gatewayOrigin,
        path: `/api/sessions/${encodeURIComponent(messageSession)}/messages?${upstreamQuery}`,
      };
    }
    const after = request.searchParams.get('after');
    if (after && names.includes('after') && !names.includes('tail') && !names.includes('before')) {
      upstreamQuery.set('after', after);
      return {
        kind: 'transcript', gatewayOrigin,
        path: `/api/sessions/${encodeURIComponent(messageSession)}/messages?${upstreamQuery}`,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseServiceWebSocketTarget(rawUrl, runtime) {
  try {
    const request = new URL(rawUrl, 'http://chat-service.invalid');
    if (request.origin !== 'http://chat-service.invalid') return undefined;
    const gatewayOrigin = selectedGatewayOrigin(request.searchParams, runtime.gatewayOrigin);
    if (!gatewayOrigin) return undefined;
    const sessionKeys = request.searchParams.getAll('sessionKey');
    if (sessionKeys.length !== 1 || !sessionKeys[0]?.trim()) return undefined;
    if ([...request.searchParams.keys()].some((key) => !['gateway', 'sessionKey', 'protocolVersion'].includes(key))) {
      return undefined;
    }

    if (request.pathname === '/__chat/ws/changes') {
      if (request.searchParams.getAll('protocolVersion').length !== 1 ||
          request.searchParams.get('protocolVersion') !== '2') {
        return undefined;
      }
      return { path: '/ws/changes?protocolVersion=2', kind: 'changes', gatewayOrigin, sessionKey: sessionKeys[0] };
    }
    if (request.pathname === '/__chat/ws' &&
        request.searchParams.getAll('protocolVersion').length === 0) {
      return { path: '/ws', kind: 'human', gatewayOrigin, sessionKey: sessionKeys[0] };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function jsonResponse(response, status, value) {
  writeJson(response, status, value);
}

function gatewayRequest(gateway, path, { method = 'GET', headers = {}, body, authorize = true } = {}) {
  return new Promise((resolve, reject) => {
    const protocol = gateway.base.startsWith('https:') ? https : http;
    const request = protocol.request(gateway.base, {
      method,
      path,
      headers: {
        ...(authorize ? { authorization: `Bearer ${gateway.token}` } : {}),
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
  const gateway = runtime.gateways.get(target.gatewayOrigin);
  if (!gateway?.available) {
    jsonResponse(response, 503, { error: { code: 'chat_gateway_unavailable' } });
    return;
  }

  try {
    if (target.kind === 'version' || target.kind === 'detail' || target.kind === 'transcript') {
      writeGatewayReply(response, await gatewayRequest(gateway, target.path, {
        authorize: target.kind !== 'version',
      }));
      return;
    }
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

function proxyServiceWebSocket(request, socket, head, target, runtime, gateway) {
  const protocol = gateway.base.startsWith('https:') ? https : http;
  const headers = {
    host: new URL(gateway.base).host,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-key': String(request.headers['sec-websocket-key'] ?? ''),
    'sec-websocket-version': String(request.headers['sec-websocket-version'] ?? ''),
  };
  if (typeof request.headers.origin === 'string') headers.origin = request.headers.origin;
  if (request.headers['sec-websocket-protocol']) {
    headers['sec-websocket-protocol'] = request.headers['sec-websocket-protocol'];
  }

  const upstream = protocol.request(gateway.base, { method: 'GET', path: target.path, headers });
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
      token: gateway.token,
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
      const target = parseServiceWebSocketTarget(request.url ?? '', runtime);
      if (!target) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      const gateway = runtime.gateways.get(target.gatewayOrigin);
      if (!gateway?.available) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      proxyServiceWebSocket(request, socket, head, target, runtime, gateway);
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
