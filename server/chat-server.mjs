import crypto from 'node:crypto';
import { ActivitySummaryStore, summaryConfiguration, serveSummaries } from '../bin/activity-summaries.mjs';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';

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

const CHANGE_FEED_KEEPALIVE_INTERVAL_MS = 30_000;

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

function decodeQEncodedWord(payload) {
  const bytes = [];
  for (let index = 0; index < payload.length; index++) {
    const character = payload[index];
    if (character === '_') {
      bytes.push(0x20);
    } else if (character === '=' && /^[0-9a-f]{2}$/i.test(payload.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(payload.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      const byte = payload.charCodeAt(index);
      if (byte > 0x7f) throw new Error('Invalid encoded header value.');
      bytes.push(byte);
    }
  }
  return Uint8Array.from(bytes);
}

function decodeHeaderEncodedWords(value) {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (encoded, charset, encoding, payload) => {
    try {
      const bytes = encoding.toLowerCase() === 'b'
        ? Buffer.from(payload, 'base64')
        : decodeQEncodedWord(payload);
      return new TextDecoder(charset, { fatal: true }).decode(bytes);
    } catch {
      return encoded;
    }
  });
}

function suppliedTailnetText(headers, headerName) {
  const header = headers[headerName];
  if (typeof header !== 'string') return undefined;
  const value = decodeHeaderEncodedWords(header).trim();
  return value || undefined;
}

function tailnetSubmitter(headers) {
  const identity = suppliedTailnetText(headers, 'tailscale-user-login');
  const displayName = suppliedTailnetText(headers, 'tailscale-user-name');
  if (!identity && !displayName) return undefined;
  return { identity: identity ?? null, displayName: displayName ?? null };
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
  const restHumanSendEnabled = environment.CHAT_REST_HUMAN_SEND === '1';
  const workItemPillsEnabled = environment.CHAT_WORK_ITEM_PILLS === '1';
  const scrollPinnedPromptsEnabled = environment.CHAT_SCROLL_PINNED_PROMPTS === '1';
  let markerDeviceToken = '';
  if (!restHumanSendEnabled && typeof environment.CHAT_READ_MARKER_DEVICE_CREDENTIAL_FILE === 'string' &&
      environment.CHAT_READ_MARKER_DEVICE_CREDENTIAL_FILE) {
    try {
      markerDeviceToken = fs.readFileSync(environment.CHAT_READ_MARKER_DEVICE_CREDENTIAL_FILE, 'utf8').trim();
    } catch {}
  }
  const gatewayOrigin = gatewayMap.valid && configuredGateway && gatewayMap.gateways.has(configuredGateway)
    ? configuredGateway
    : undefined;
  const sessionKey = typeof environment.CHAT_DEFAULT_SESSION_KEY === 'string'
    ? environment.CHAT_DEFAULT_SESSION_KEY
    : '';
  const principalKey = typeof environment.CHAT_DEFAULT_PRINCIPAL_KEY === 'string'
    ? environment.CHAT_DEFAULT_PRINCIPAL_KEY.trim()
    : '';
  const operatorPrincipalKey = principalKey;
  const deviceId = gatewayOrigin && principalKey && sessionKey.trim()
    ? `chat_${crypto.createHash('sha256').update(`${gatewayOrigin}\0${principalKey}\0${sessionKey}`).digest('hex').slice(0, 24)}`
    : '';
  const readMarkerRoute = !operatorPrincipalKey ? undefined
    : restHumanSendEnabled ? 'gateway-configured-user'
      : markerDeviceToken ? 'gateway-user-device' : undefined;
  const configuredTarget = gatewayOrigin && sessionKey.trim()
    ? {
      gateway: gatewayOrigin,
      sessionKey,
      ...(principalKey ? { principalKey, deviceId } : {}),
      ...(readMarkerRoute ? { readMarkerRoute } : {}),
      ...(restHumanSendEnabled ? { restHumanSendEnabled: true } : {}),
      ...(workItemPillsEnabled && principalKey ? { workItemPillsEnabled: true } : {}),
      ...(scrollPinnedPromptsEnabled ? { scrollPinnedPromptsEnabled: true } : {}),
    }
    : {};

  return {
    publicOrigin,
    configuredTarget,
    operatorPrincipalKey,
    gatewayOrigin,
    gatewayMapValid: gatewayMap.valid,
    gateways: gatewayMap.gateways,
    restHumanSendEnabled,
    workItemPillsEnabled,
    markerDeviceToken,
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

const numberOrNull = (value) => Number.isFinite(value) ? value : null;
const textOrNull = (value) => typeof value === 'string' && value ? value : null;
const textList = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];

function pillWorkItem(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.title !== 'string') return undefined;
  return {
    id: value.id, title: value.title, state: textOrNull(value.state), started: value.started === true,
    holders: textList(value.holders), failReason: textOrNull(value.failReason),
    createdAt: numberOrNull(value.createdAt), rowVersion: numberOrNull(value.rowVersion),
  };
}

// Each read keeps only the fields a pill or its sheet shows. Prompts, bodies and
// histories that the Gateway sends with them never reach the browser.
const WORK_ITEM_PILL_PROJECTIONS = {
  'work-item': (body) => {
    const item = pillWorkItem(body.item);
    return item && { item };
  },
  cards: (body) => {
    const item = pillWorkItem(body.result?.workItem);
    return item && Array.isArray(body.result.assignments) ? { item,
      cards: body.result.assignments.filter((card) => card && typeof card.id === 'string').map((card) => ({
        id: card.id, state: textOrNull(card.state), holderKey: textOrNull(card.holderKey),
      })) } : undefined;
  },
  breathing: (body) => {
    const result = body.result;
    if (!result || typeof result !== 'object' || typeof result.reason !== 'string') return undefined;
    // A work item answers through the one open card that is doing something.
    const card = result.reason === 'open_assignment_lively' ? result.evidence?.assignment : undefined;
    const evidence = card?.evidence ?? result.evidence ?? {};
    const held = [evidence.assignment, ...(Array.isArray(evidence.openAssignments)
      ? evidence.openAssignments.map((row) => row?.evidence?.assignment) : [])];
    const turn = evidence.turn && { seq: numberOrNull(evidence.turn.seq), sessionKey: textOrNull(evidence.turn.sessionKey),
      assignmentId: textOrNull(evidence.turn.assignmentId), workItemId: textOrNull(evidence.turn.jobRef),
      startedAt: numberOrNull(evidence.turn.startedAt), endedAt: numberOrNull(evidence.turn.endedAt) };
    const wake = evidence.wake && { wakeId: textOrNull(evidence.wake.wakeId), sessionKey: textOrNull(evidence.wake.sessionKey),
      dueAt: numberOrNull(evidence.wake.dueAt), createdAt: numberOrNull(evidence.wake.createdAt) };
    return { reason: card?.reason ?? result.reason, holders: textList([...new Set(held.map((row) => row?.holderKey))]),
      ...(turn ? { turn } : {}), ...(wake ? { wake } : {}) };
  },
  wake: (body) => {
    const wake = body.item;
    return wake && typeof wake.wakeId === 'string' ? { wake: {
      wakeId: wake.wakeId, sessionKey: textOrNull(wake.sessionKey), state: textOrNull(wake.state),
      consumer: textOrNull(wake.consumer), creatorSessionKey: textOrNull(wake.creatorSessionKey),
      assignmentId: textOrNull(wake.assignmentId), workItemId: textOrNull(wake.workItemId),
      conditionKind: textOrNull(wake.conditionKind), conditionScope: textOrNull(wake.conditionScope),
      dueAt: numberOrNull(wake.dueAt), createdAt: numberOrNull(wake.createdAt), reason: textOrNull(wake.waitReason),
    } } : undefined;
  },
  turn: (body) => {
    const turn = body.item;
    return turn && Number.isSafeInteger(turn.seq) ? { turn: {
      seq: turn.seq, sessionKey: textOrNull(turn.sessionKey), status: textOrNull(turn.status),
      workItemId: textOrNull(turn.jobRef),
    } } : undefined;
  },
  'open-questions': (body, principalKey) => Array.isArray(body.result?.decisionRequests) ? {
    // The list is the reader's own; agent-to-agent questions in it are not theirs to answer.
    questions: body.result.decisionRequests.filter((row) => row && typeof row.id === 'string' &&
      (row.kind === 'operator' || row.kind === 'statute' ||
        (!textOrNull(row.expecterSessionKey) && row.expecterUserId === principalKey))).map((row) => ({
      id: row.id, question: textOrNull(row.question), assignmentId: textOrNull(row.assignmentId),
      raiserId: textOrNull(row.raiserId), raisedAt: numberOrNull(row.raisedAt), deadlineAt: numberOrNull(row.deadlineAt),
      options: (Array.isArray(row.options) ? row.options : [])
        .map((option) => typeof option === 'string' ? option : option?.label).filter((label) => typeof label === 'string'),
    })) } : undefined,
  'agent-questions': (body) => Array.isArray(body.items) ? {
    questions: body.items.filter((row) => row && typeof row.id === 'string').map((row) => ({
      id: row.id, question: textOrNull(row.question), assignmentId: textOrNull(row.assignmentId),
      raiserSessionKey: textOrNull(row.raiserSessionKey), expecterSessionKey: textOrNull(row.expecterSessionKey),
      raisedAt: numberOrNull(row.raisedAt),
    })) } : undefined,
};

// Every route makes exactly one Gateway read, for one item, agent, turn or wait,
// or for the reader's own questions. None lists the org.
function parseWorkItemPillsTarget(pathname, routeParams, principalKey) {
  const asUser = `asUser=${encodeURIComponent(principalKey)}`;
  const dispatch = (verb, params) => ({ dispatch: { verb, asUser: principalKey, params } });
  const route = /^\/__chat\/api\/pills\/([a-z-]+)(?:\/(.+))?$/.exec(pathname);
  if (!route) return undefined;
  const [, projection, rest] = route;
  if (projection === 'agent-questions' && rest === undefined) {
    const raisers = routeParams.map(([, value]) => value);
    if (!raisers.length || raisers.length > 20 || routeParams.some(([name, value]) => name !== 'raiser' || !value.trim())) return undefined;
    const query = new URLSearchParams([['asUser', principalKey], ['kind', 'agent'], ['status', 'open'], ['limit', '50'],
      ...raisers.map((raiser) => ['raiserSessionKey', raiser])]);
    return { projection, path: `/api/decision-requests?${query}` };
  }
  if (routeParams.length) return undefined;
  if (projection === 'open-questions' && rest === undefined) return { projection, ...dispatch('decision-requests', { status: 'open' }) };
  if (rest === undefined) return undefined;
  if (projection === 'breathing') {
    const [, targetKind, encodedId] = /^(work-item|assignment|session)\/([^/]+)$/.exec(rest) ?? [];
    const targetId = encodedId && decodeSessionPath(encodedId);
    return targetId ? { projection, ...dispatch('breathing', { targetKind, targetId }) } : undefined;
  }
  if (rest.includes('/')) return undefined;
  const id = decodeSessionPath(rest);
  if (!id) return undefined;
  if (projection === 'work-item') return { projection, path: `/api/work-items/${encodeURIComponent(id)}?${asUser}` };
  if (projection === 'wake') return { projection, path: `/api/wakes/${encodeURIComponent(id)}?${asUser}` };
  if (projection === 'cards') return { projection, ...dispatch('work-item-get', { workItemId: id }) };
  if (projection === 'turn' && /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id))) {
    return { projection, path: `/api/turns/${id}?${asUser}` };
  }
  return undefined;
}

async function serveWorkItemPills(response, gateway, target, principalKey) {
  const reply = target.dispatch
    ? await gatewayRequest(gateway, '/agent/dispatch', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(target.dispatch)) })
    : await gatewayRequest(gateway, target.path);
  if (reply.status !== 200) {
    jsonResponse(response, reply.status === 404 ? 404 : 502, { error: { code: reply.status === 404 ? 'not_found' : 'gateway_refused' } });
    return;
  }
  let projected;
  try { projected = WORK_ITEM_PILL_PROJECTIONS[target.projection](JSON.parse(reply.body.toString('utf8')), principalKey); }
  catch { /* Answered below as unusable Gateway data. */ }
  if (projected) jsonResponse(response, 200, projected);
  else jsonResponse(response, 502, { error: { code: 'gateway_unusable' } });
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

    const pills = runtime.workItemPillsEnabled === true && runtime.principalKey
      ? parseWorkItemPillsTarget(request.pathname, routeParams, runtime.principalKey) : undefined;
    if (pills) return { kind: 'work-item-pills', gatewayOrigin, ...pills };

    const attest = /^\/__chat\/api\/attests\/([^/]+)$/.exec(request.pathname);
    const attestId = attest && decodeSessionPath(attest[1]);
    if (attestId && routeParams.length === 0) {
      return { kind: 'detail', gatewayOrigin,
        path: `/api/attests/${encodeURIComponent(attestId)}?asUser=${encodeURIComponent(runtime.principalKey)}` };
    }
    if (request.pathname === '/__chat/upload' && routeParams.length === 0) {
      return { kind: 'upload', gatewayOrigin, path: `/upload?asUser=${encodeURIComponent(runtime.principalKey)}` };
    }
    const download = /^\/__chat\/download\/([^/]+)$/.exec(request.pathname);
    const assetId = download && decodeSessionPath(download[1]);
    if (assetId && routeParams.length === 0) {
      return { kind: 'download', gatewayOrigin,
        path: `/download/${encodeURIComponent(assetId)}?asUser=${encodeURIComponent(runtime.principalKey)}` };
    }

    const readMarker = /^\/__chat\/api\/read-markers\/([^/]+)$/.exec(request.pathname);
    const readMarkerScope = readMarker && decodeSessionPath(readMarker[1]);
    if (runtime.operatorPrincipalKey && readMarkerScope && routeParams.length === 0) {
      return {
        kind: 'read-marker',
        gatewayOrigin,
        path: `/api/read-markers/${encodeURIComponent(readMarkerScope)}?asUser=${encodeURIComponent(runtime.operatorPrincipalKey)}`,
      };
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

    const turnEvents = /^\/__chat\/api\/sessions\/([^/]+)\/turn-events$/.exec(request.pathname);
    const turnEventsSession = turnEvents && decodeSessionPath(turnEvents[1]);
    if (turnEventsSession) {
      const allowed = new Set(['limit', 'turnSeq', 'before']);
      const names = routeParams.map(([name]) => name);
      if (new Set(names).size !== names.length || names.some((name) => !allowed.has(name)) ||
          !names.includes('limit') || !names.includes('turnSeq')) return undefined;
      for (const [name, value] of routeParams) {
        if (name === 'before') { if (!value) return undefined; continue; }
        if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) return undefined;
        const number = Number(value);
        if (number < 1 || (name === 'limit' && number > 500)) return undefined;
      }
      const query = new URLSearchParams([['asUser', runtime.principalKey], ...routeParams]);
      return { kind: 'transcript', gatewayOrigin, sessionKey: turnEventsSession,
        path: `/api/sessions/${encodeURIComponent(turnEventsSession)}/turn-events?${query}` };
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

    const recordEvents = /^\/__chat\/api\/sessions\/([^/]+)\/record-events$/.exec(request.pathname);
    if (recordEvents) {
      const selected = decodeSessionPath(recordEvents[1]);
      if (!selected || request.searchParams.get('limit') !== '50' ||
          routeParams.some(([name]) => !['limit', 'before'].includes(name)) ||
          new Set(routeParams.map(([name]) => name)).size !== routeParams.length) return undefined;
      const query = new URLSearchParams({ asUser: runtime.principalKey, limit: '50' });
      const before = request.searchParams.get('before');
      if (before) query.set('before', before);
      return { kind: 'detail', gatewayOrigin,
        path: `/api/sessions/${encodeURIComponent(selected)}/record-events?${query}` };
    }

    const filedWorkItems = /^\/__chat\/api\/sessions\/([^/]+)\/filed-work-items$/.exec(request.pathname);
    if (filedWorkItems) {
      const selected = decodeSessionPath(filedWorkItems[1]);
      const limit = request.searchParams.get('limit') ?? '';
      const before = request.searchParams.get('before');
      if (!selected || !/^[1-9][0-9]?$/.test(limit) || Number(limit) > 50 || before === '' ||
          routeParams.some(([name]) => !['limit', 'before'].includes(name)) ||
          new Set(routeParams.map(([name]) => name)).size !== routeParams.length) return undefined;
      const query = new URLSearchParams({ asUser: runtime.principalKey, createdBySession: selected, limit });
      if (before) query.set('before', before);
      else query.set('tail', 'true');
      return { kind: 'filed-work-items', gatewayOrigin, path: `/api/work-items?${query}` };
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

export function parseServiceWebSocketTarget(rawUrl, runtime) {
  try {
    const request = new URL(rawUrl, 'http://chat-service.invalid');
    if (request.origin !== 'http://chat-service.invalid') return undefined;
    const gatewayOrigin = selectedGatewayOrigin(request.searchParams, runtime.gatewayOrigin);
    if (!gatewayOrigin) return undefined;
    if (request.pathname === '/__chat/ws/work-changes') {
      const names = [...request.searchParams.keys()];
      if (runtime.workItemPillsEnabled !== true || !runtime.principalKey ||
          names.some((name) => name !== 'gateway' && name !== 'protocolVersion') ||
          request.searchParams.getAll('protocolVersion').join() !== '2') return undefined;
      // No selected session: the browser subscribes to each work item it shows.
      return { path: '/ws/changes?protocolVersion=2', kind: 'work-changes', gatewayOrigin };
    }
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
        request.searchParams.getAll('protocolVersion').length === 0 &&
        !(runtime.restHumanSendEnabled && gatewayOrigin === runtime.gatewayOrigin)) {
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

// A Gateway that refuses a large body and resets the connection while it is still being written makes the socket emit
// an error after its request has finished; with no listener that is an unhandled 'error' event and ends the whole process.
// Keep-alive reuses sockets, so each socket gets exactly one listener, however many requests it carries.
const guardedSockets = new WeakSet();
function guardSocketErrors(socket) {
  if (!socket || guardedSockets.has(socket)) return;
  guardedSockets.add(socket);
  socket.on('error', () => {});
}
function gatewayHttpRequest(protocol, ...args) {
  const request = protocol.request(...args);
  request.on('socket', guardSocketErrors);
  return request;
}

function gatewayCliVersionFromReply(reply) {
  if (reply.status !== 200) throw new Error('Gateway version is unavailable.');
  let version;
  try { version = JSON.parse(reply.body.toString('utf8')).version; }
  catch { throw new Error('Gateway version is unavailable.'); }
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('Gateway version is unavailable.');
  }
  return version;
}

function gatewayCliVersion(gateway) {
  if (typeof gateway.cliVersion === 'string' && gateway.cliVersion.trim()) {
    return Promise.resolve(gateway.cliVersion);
  }
  if (!gateway.cliVersionPromise) {
    const pending = gatewayRequest(gateway, '/version', { authorize: false })
      .then(gatewayCliVersionFromReply)
      .then((version) => {
        gateway.cliVersion = version;
        return version;
      })
      .finally(() => {
        if (gateway.cliVersionPromise === pending) gateway.cliVersionPromise = undefined;
      });
    gateway.cliVersionPromise = pending;
  }
  return gateway.cliVersionPromise;
}

function isIncompatibleCliReply(reply) {
  if (reply.status !== 426) return false;
  try { return JSON.parse(reply.body.toString('utf8')).error?.code === 'incompatible_cli'; }
  catch { return false; }
}

async function gatewayRequest(
  gateway,
  path,
  { method = 'GET', headers = {}, body, authorize = true } = {},
  retriedAfterVersionRefresh = false,
) {
  const cliVersion = authorize ? await gatewayCliVersion(gateway) : undefined;
  const reply = await new Promise((resolve, reject) => {
    // Set once the Gateway's reply head is in; returns true when it settled the request with the 413 refusal.
    let settleEarlyRefusal = () => false;
    const protocol = gateway.base.startsWith('https:') ? https : http;
    const request = gatewayHttpRequest(protocol, gateway.base, {
      method,
      path,
      headers: {
        ...(authorize ? { authorization: `Bearer ${gateway.token}` } : {}),
        accept: 'application/json',
        ...headers,
        ...(authorize ? { 'x-tightbeam-cli-version': cliVersion } : {}),
      },
    }, (reply) => {
      const chunks = [];
      // A gateway may refuse a large body early (HTTP 413) and then close or reset the connection before the
      // body is fully written. When that 413 head has arrived it is the answer, whatever happens to the socket after.
      let settled = false;
      const refusedTooLarge = () => reply.statusCode === 413;
      const settleRefusal = () => {
        if (settled || !refusedTooLarge()) return false;
        settled = true;
        let partial = Buffer.concat(chunks);
        try { JSON.parse(partial.toString('utf8')); }
        catch { partial = Buffer.from(JSON.stringify({ error: { code: 'invalid_message', message: 'request body too large' } })); }
        resolve({ status: 413, contentType: reply.headers['content-type'] ?? 'application/json; charset=utf-8', body: partial });
        return true;
      };
      settleEarlyRefusal = settleRefusal;
      reply.on('error', (error) => { if (!settleRefusal() && !settled) { settled = true; reject(error); } });
      reply.on('close', () => { if (!reply.complete && !settleRefusal() && !settled) { settled = true; reject(new Error('Gateway response was cut off')); } });
      reply.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      reply.on('end', () => {
        if (settled) return;
        settled = true;
        const result = {
          status: reply.statusCode ?? 502,
          contentType: reply.headers['content-type'] ?? 'application/json; charset=utf-8',
          body: Buffer.concat(chunks),
        };
        if (path === '/version' && result.status === 200) {
          try { gateway.cliVersion = gatewayCliVersionFromReply(result); }
          catch { /* The next authenticated request will retry the version lookup. */ }
        }
        resolve(result);
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('Gateway request timed out')));
    // The request error can arrive before or after the reply head: a 413 that already arrived wins.
    request.on('error', (error) => { if (!settleEarlyRefusal()) reject(error); });
    request.end(body);
  });

  // Callers fix the dispatched verb: serviceAgentDispatch's post, read-marker-set or assess_attachments, or one pill read.
  if (!retriedAfterVersionRefresh && authorize && path === '/agent/dispatch' &&
      isIncompatibleCliReply(reply)) {
    if (gateway.cliVersion === cliVersion) gateway.cliVersion = undefined;
    let refreshedVersion;
    try { refreshedVersion = await gatewayCliVersion(gateway); }
    catch { return reply; }
    if (refreshedVersion !== cliVersion) {
      return gatewayRequest(gateway, path, { method, headers, body, authorize }, true);
    }
  }

  return reply;
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

// Gateway rows are large; the browser needs only these fields.
function filedWorkItemsReply(reply) {
  if (reply.status !== 200) return reply;
  const value = JSON.parse(reply.body.toString('utf8'));
  const items = value.items.map(pillWorkItem).filter(Boolean);
  return { ...reply, body: Buffer.from(JSON.stringify({ items,
    oldestCursor: value.page?.oldestCursor ?? null, hasOlder: value.page?.hasMoreBefore === true })) };
}

async function serviceHttp(request, response, runtime) {
  if (request.method === 'POST' && request.url?.startsWith('/__chat/agent/dispatch')) {
    await serviceAgentDispatch(request, response, runtime);
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
  const method = target.kind === 'upload' ? 'POST' : 'GET';
  if (request.method !== method) {
    response.writeHead(405, { allow: method, 'cache-control': 'no-store' }).end();
    return;
  }
  const gateway = runtime.gateways.get(target.gatewayOrigin);
  if (!gateway?.available) {
    jsonResponse(response, 503, { error: { code: 'chat_gateway_unavailable' } });
    return;
  }

  if (target.kind === 'upload' || target.kind === 'download') {
    // Forward original multipart bytes and streamed downloads under the existing
    // service identity. The Gateway owns file/type/body limits and their errors.
    const protocol = gateway.base.startsWith('https:') ? https : http;
    const remote = gatewayHttpRequest(protocol, gateway.base, { method, path: target.path,
      headers: { authorization: `Bearer ${gateway.token}`,
        ...(request.headers['content-type'] ? { 'content-type': request.headers['content-type'] } : {}),
        ...(request.headers['content-length'] ? { 'content-length': request.headers['content-length'] } : {}) },
    }, reply => {
      response.writeHead(reply.statusCode ?? 502, {
        'content-type': reply.headers['content-type'] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        ...(reply.headers['content-length'] ? { 'content-length': reply.headers['content-length'] } : {}),
      });
      reply.on('error', () => response.destroy());
      reply.pipe(response);
    });
    remote.on('error', () => {
      if (!response.headersSent) jsonResponse(response, 502, { error: { code: 'gateway_unavailable' } });
      else response.destroy();
    });
    request.on('aborted', () => remote.destroy());
    response.on('close', () => remote.destroy());
    request.pipe(remote);
    return;
  }
  try {
    if (target.kind === 'work-item-pills') {
      await serveWorkItemPills(response, gateway, target, runtime.principalKey);
      return;
    }
    if (target.kind === 'filed-work-items') {
      writeGatewayReply(response, filedWorkItemsReply(await gatewayRequest(gateway, target.path)));
      return;
    }
    if (target.kind === 'version' || target.kind === 'detail' || target.kind === 'transcript' || target.kind === 'read-marker') {
      writeGatewayReply(response, await gatewayRequest(gateway, target.path, {
        authorize: target.kind !== 'version',
      }));
      return;
    }
  } catch {
    jsonResponse(response, 502, { error: { code: 'gateway_unavailable' } });
  }
}

function parseServiceAgentDispatchTarget(rawUrl, runtime) {
  try {
    const request = new URL(rawUrl, 'http://chat-service.invalid');
    if (request.origin !== 'http://chat-service.invalid' || request.pathname !== '/__chat/agent/dispatch' ||
        [...request.searchParams.keys()].some((name) => name !== 'gateway')) return undefined;
    const gatewayOrigin = selectedGatewayOrigin(request.searchParams, runtime.gatewayOrigin);
    if (!gatewayOrigin) return undefined;
    const gateway = runtime.gateways.get(gatewayOrigin);
    const configuredGateway = runtime.gateways.get(runtime.gatewayOrigin);
    if (!gateway || gateway !== configuredGateway) return undefined;
    return { gatewayOrigin, path: '/agent/dispatch' };
  } catch {
    return undefined;
  }
}

async function serviceAgentDispatch(request, response, runtime) {
  if (!serviceReady(runtime)) {
    jsonResponse(response, 503, { error: { code: 'chat_service_unconfigured' } });
    return;
  }
  const target = parseServiceAgentDispatchTarget(request.url ?? '', runtime);
  if (!target) {
    jsonResponse(response, 404, { error: { code: 'not_found' } });
    return;
  }
  const gateway = runtime.gateways.get(target.gatewayOrigin);
  if (!gateway?.available) {
    jsonResponse(response, 503, { error: { code: 'chat_gateway_unavailable' } });
    return;
  }

  const chunks = [];
  try {
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
  } catch {
    jsonResponse(response, 400, { error: { code: 'invalid_request' } });
    return;
  }
  const body = Buffer.concat(chunks);
  let value;
  try { value = JSON.parse(body.toString('utf8')); }
  catch {
    jsonResponse(response, 400, { error: { code: 'invalid_request' } });
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['post', 'read-marker-set', 'assess_attachments'].includes(value.verb)) {
    jsonResponse(response, 404, { error: { code: 'not_found' } });
    return;
  }
  const useDeviceMarkerCredential = value.verb === 'read-marker-set' && !runtime.restHumanSendEnabled;
  if (useDeviceMarkerCredential && (!runtime.markerDeviceToken || !runtime.operatorPrincipalKey)) {
    jsonResponse(response, 404, { error: { code: 'not_found' } });
    return;
  }
  const forwardedBody = useDeviceMarkerCredential
    ? body
    : Buffer.from(JSON.stringify({ ...value, asUser: runtime.principalKey }));

  try {
    writeGatewayReply(response, await gatewayRequest(gateway, target.path, {
      method: 'POST',
      headers: {
        ...(useDeviceMarkerCredential ? { authorization: `Bearer ${runtime.markerDeviceToken}` } : {}),
        'content-type': request.headers['content-type'] ?? 'application/json',
        'content-length': String(forwardedBody.length),
      },
      body: forwardedBody,
      ...(useDeviceMarkerCredential ? { authorize: false } : {}),
    }));
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

function websocketClientPingFrame() {
  const mask = crypto.randomBytes(4);
  return Buffer.from([0x89, 0x80, ...mask]);
}

export function startChangesFeedKeepalive(target, remote) {
  if (target.kind !== 'changes' && target.kind !== 'work-changes') return () => {};

  const keepalive = setInterval(() => {
    if (!remote.destroyed && remote.writable) remote.write(websocketClientPingFrame());
  }, CHANGE_FEED_KEEPALIVE_INTERVAL_MS);
  keepalive.unref?.();
  return () => clearInterval(keepalive);
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

  const upstream = gatewayHttpRequest(protocol, gateway.base, { method: 'GET', path: target.path, headers });
  upstream.on('upgrade', (reply, remote, remoteHead) => {
    const stopKeepalive = startChangesFeedKeepalive(target, remote);
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
      ...(target.sessionKey === undefined ? {} : { sessionKey: target.sessionKey }),
    };
    if (target.kind === 'human') {
      auth.deviceId = runtime.deviceId;
      auth.subscriptions = ['chat'];
    }
    remote.write(websocketClientTextFrame(auth));
    if (head.length) remote.write(head);
    socket.pipe(remote).pipe(socket);
    socket.on('error', () => { stopKeepalive(); remote.destroy(); });
    remote.on('error', () => { stopKeepalive(); socket.destroy(); });
    socket.on('close', () => { stopKeepalive(); remote.destroy(); });
    remote.on('close', () => { stopKeepalive(); socket.destroy(); });
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
  const upstream = gatewayHttpRequest(protocol, target.gateway, {
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

  const upstream = gatewayHttpRequest(protocol, target.gateway, { method: 'GET', path: target.path, headers });
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

  let summaries;
  try { summaries = new ActivitySummaryStore(summaryConfiguration(environment)); }
  catch { console.warn('Activity summary storage is unavailable; original text remains available.'); }

  return http.createServer((request, response) => {
    const parsedRequest = new URL(request.url ?? '/', 'http://chat.invalid');
    if (parsedRequest.pathname === '/chat-config.json') {
      const submitter = runtime.configuredTarget.restHumanSendEnabled === true
        ? tailnetSubmitter(request.headers) : undefined;
      writeJson(response, 200, {
        ...runtime.configuredTarget,
        ...(submitter ? { submitter } : {}),
      });
      return;
    }
    if (parsedRequest.pathname === '/__chat/version') {
      writeJson(response, 200, {
        product: 'tightbeam-chat',
        tag: manifest.tag,
        sourceCommit: manifest.sourceCommit,
        gatewayCompatibility: {
          supportedVersions: manifest.gatewayCompatibility?.supportedVersions ?? [],
          chatRestHumanSendEnabled: runtime.restHumanSendEnabled,
        },
      });
      return;
    }
    if (parsedRequest.pathname.startsWith('/__chat/')) {
      if (!allowedPublicOrigin(runtime, request)) {
        response.writeHead(403, { 'cache-control': 'no-store' }).end();
        return;
      }
      if (parsedRequest.pathname === '/__chat/summaries') {
        if (!summaries) { response.writeHead(503).end(); return; }
        void serveSummaries(request, response, summaries);
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
  }).on('close', () => summaries?.close()).on('upgrade', (request, socket, head) => {
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
