// @vitest-environment node
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatServer, parseServiceHttpTarget, parseServiceWebSocketTarget } from '../server/chat-server.mjs';

const gatewayOrigin = 'https://gateway.example';
const on = { gatewayOrigin, principalKey: 'example-user', workItemPillsEnabled: true };
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  cleanups.push(() => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }));
  resolve(server.address().port);
}));

async function service(respond, environment = {}) {
  const seen = [];
  const gateway = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/version') { response.end(JSON.stringify({ version: '0.1.16' })); return; }
    seen.push({ method: request.method, url: request.url, body });
    const reply = respond(request, body);
    response.writeHead(reply.status ?? 200).end(JSON.stringify(reply.body));
  });
  const gatewayPort = await listen(gateway);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-pills-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'gateway.json'), JSON.stringify({ port: gatewayPort, cliToken: 'fixture-token' }));
  const chat = createChatServer({ rootDir: root, publicDir: root, releaseInfo: { tag: 'v0.0.0', sourceCommit: 'x' },
    environment: { TIGHTBEAM_BASE_DIR: root, CHAT_PUBLIC_ORIGIN: 'http://chat.example',
      CHAT_DEFAULT_GATEWAY_ORIGIN: `http://127.0.0.1:${gatewayPort}`, CHAT_DEFAULT_SESSION_KEY: 'agent:example',
      CHAT_DEFAULT_PRINCIPAL_KEY: 'example-user', ...environment } });
  const port = await listen(chat);
  return { seen, port, gateway, get: async (route) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { origin: 'http://chat.example' } });
    return { status: response.status, body: await response.json() };
  } };
}

const item = { id: 'wi_1', title: 'Title', state: 'open', started: true, holders: ['agent:a'], failReason: null,
  createdAt: 5, rowVersion: 9, attestCounts: { progress: 3 }, landings: [{}], body: 'not for the browser' };
const projected = { id: 'wi_1', title: 'Title', state: 'open', started: true, holders: ['agent:a'], failReason: null,
  createdAt: 5, rowVersion: 9 };

describe('work item pill routes', () => {
  it('has no routes, connection or configuration when the flag is exactly 0', async () => {
    const paths = ['work-item/wi_1', 'cards/wi_1', 'breathing/session/a', 'wake/w_1', 'turn/4', 'open-questions', 'agent-questions?raiser=a'];
    for (const suffix of paths) {
      expect(parseServiceHttpTarget(`/__chat/api/pills/${suffix}`, { ...on, workItemPillsEnabled: false })).toBeUndefined();
      expect(parseServiceHttpTarget(`/__chat/api/pills/${suffix}`, on)).toMatchObject({ kind: 'work-item-pills' });
    }
    const socket = '/__chat/ws/work-changes?protocolVersion=2';
    expect(parseServiceWebSocketTarget(socket, { ...on, workItemPillsEnabled: false })).toBeUndefined();
    expect(parseServiceWebSocketTarget(socket, on)).toEqual({ path: '/ws/changes?protocolVersion=2', kind: 'work-changes', gatewayOrigin });
    for (const [value, expected] of [[undefined, true], ['1', true], ['0', undefined]]) {
      const chat = await service(() => ({ body: {} }), value ? { CHAT_WORK_ITEM_PILLS: value } : {});
      const { body } = await chat.get('/chat-config.json');
      expect(body.workItemPillsEnabled).toBe(expected);
    }
  });

  it('makes one Gateway read per request and returns only what the pills show', async () => {
    const chat = await service((request, body) => {
      if (body?.verb === 'work-item-get') return { body: { result: { workItem: item, assignments: [
        { id: 'asg_1', state: 'open', holderKey: 'agent:a', subject: 'private brief' }, { nope: true }] } } };
      if (body?.verb === 'breathing') return { body: { result: { reason: 'pending_wake', evidence: {
        assignment: { holderKey: 'agent:a' }, wake: { wakeId: 'w_1', sessionKey: 'agent:a', dueAt: 8, createdAt: 2 } } } } };
      if (body?.verb === 'decision-requests') return { body: { result: { decisionRequests: [
        { id: 'dr_1', kind: 'operator', question: 'Q', options: [{ label: 'Yes' }, 'No', 4], assignmentId: 'asg_1', raiserId: 'agent:a', raisedAt: 1, deadlineAt: 2, context: { note: 'x' } },
        { id: 'dr_2', kind: 'agent', question: 'Agents only', expecterSessionKey: 'agent:b', expecterUserId: 'example-user' }] } } };
      if (request.url.startsWith('/api/work-items/')) return { body: { item } };
      if (request.url.startsWith('/api/wakes/')) return { body: { item: { wakeId: 'w_1', sessionKey: 'agent:a', prompt: 'secret',
        state: 'pending', dueAt: 8, createdAt: 2, conditionKind: 'ready', conditionScope: 'wi_2' } } };
      if (request.url.startsWith('/api/turns/')) return { body: { item: { seq: 4, sessionKey: 'agent:a', status: 'running', jobRef: 'wi_1', prompt: 'secret' } } };
      return { body: { items: [{ id: 'dr_3', question: 'Help', raiserSessionKey: 'agent:a', expecterSessionKey: 'agent:b', assignmentId: 'asg_1', raisedAt: 3 }] } };
    }, { CHAT_WORK_ITEM_PILLS: '1' });
    expect((await chat.get('/__chat/api/pills/work-item/wi_1')).body).toEqual({ item: projected });
    expect((await chat.get('/__chat/api/pills/cards/wi_1')).body).toEqual({ item: projected,
      cards: [{ id: 'asg_1', state: 'open', holderKey: 'agent:a' }] });
    expect((await chat.get('/__chat/api/pills/breathing/assignment/asg_1')).body).toEqual({ reason: 'pending_wake', holders: ['agent:a'],
      wake: { wakeId: 'w_1', sessionKey: 'agent:a', dueAt: 8, createdAt: 2 } });
    expect((await chat.get('/__chat/api/pills/wake/w_1')).body.wake).toMatchObject({ conditionKind: 'ready', conditionScope: 'wi_2', reason: null });
    expect((await chat.get('/__chat/api/pills/turn/4')).body).toEqual({ turn: { seq: 4, sessionKey: 'agent:a', status: 'running', workItemId: 'wi_1' } });
    expect((await chat.get('/__chat/api/pills/open-questions')).body).toEqual({ questions: [{ id: 'dr_1', question: 'Q',
      assignmentId: 'asg_1', raiserId: 'agent:a', raisedAt: 1, deadlineAt: 2, options: ['Yes', 'No'] }] });
    expect((await chat.get('/__chat/api/pills/agent-questions?raiser=agent%3Aa&raiser=agent%3Ab')).body.questions).toHaveLength(1);
    expect(chat.seen).toEqual([
      { method: 'GET', url: '/api/work-items/wi_1?asUser=example-user', body: undefined },
      { method: 'POST', url: '/agent/dispatch', body: { verb: 'work-item-get', asUser: 'example-user', params: { workItemId: 'wi_1' } } },
      { method: 'POST', url: '/agent/dispatch', body: { verb: 'breathing', asUser: 'example-user', params: { targetKind: 'assignment', targetId: 'asg_1' } } },
      { method: 'GET', url: '/api/wakes/w_1?asUser=example-user', body: undefined },
      { method: 'GET', url: '/api/turns/4?asUser=example-user', body: undefined },
      { method: 'POST', url: '/agent/dispatch', body: { verb: 'decision-requests', asUser: 'example-user', params: { status: 'open' } } },
      { method: 'GET', url: '/api/decision-requests?asUser=example-user&kind=agent&status=open&limit=50&raiserSessionKey=agent%3Aa&raiserSessionKey=agent%3Ab', body: undefined },
    ]);
    expect(JSON.stringify(chat.seen)).not.toContain('secret');
  });

  it('reads a work item through the open card that is doing something, or names every idle holder', async () => {
    let result = { reason: 'open_assignment_lively', evidence: { assignment: { id: 'asg_1', reason: 'running_turn', evidence: {
      assignment: { holderKey: 'agent:a' }, turn: { seq: 7, sessionKey: 'agent:a', assignmentId: 'asg_1', jobRef: 'wi_1', startedAt: 3 } } } } };
    const chat = await service(() => ({ body: { result } }), { CHAT_WORK_ITEM_PILLS: '1' });
    expect((await chat.get('/__chat/api/pills/breathing/work-item/wi_1')).body).toEqual({ reason: 'running_turn', holders: ['agent:a'],
      turn: { seq: 7, sessionKey: 'agent:a', assignmentId: 'asg_1', workItemId: 'wi_1', startedAt: 3, endedAt: null } });
    result = { reason: 'all_open_assignments_not_lively', evidence: { openAssignments: [
      { evidence: { assignment: { holderKey: 'agent:a' } } }, { evidence: { assignment: { holderKey: 'agent:b' } } }] } };
    expect((await chat.get('/__chat/api/pills/breathing/work-item/wi_1')).body).toEqual({
      reason: 'all_open_assignments_not_lively', holders: ['agent:a', 'agent:b'] });
  });

  it('refuses anything wider than one target and reports unusable answers', async () => {
    for (const suffix of ['work-item', 'work-item/a/b', 'work-item/wi_1?x=1', 'breathing/org/a', 'breathing/session', 'turn/0', 'turn/x',
      'agent-questions', 'agent-questions?raiser=', 'agent-questions?kind=operator', 'open-questions/all', 'wakes', 'other/x']) {
      expect(parseServiceHttpTarget(`/__chat/api/pills/${suffix}`, on), suffix).toBeUndefined();
    }
    const many = Array.from({ length: 21 }, () => 'raiser=a').join('&');
    expect(parseServiceHttpTarget(`/__chat/api/pills/agent-questions?${many}`, on)).toBeUndefined();
    let reply = { status: 404, body: { error: { code: 'not_found' } } };
    const chat = await service(() => reply, { CHAT_WORK_ITEM_PILLS: '1' });
    expect((await chat.get('/__chat/api/pills/wake/w_1')).status).toBe(404);
    reply = { status: 500, body: {} };
    expect((await chat.get('/__chat/api/pills/wake/w_1')).status).toBe(502);
    reply = { body: { item: { id: 'wi_1' } } };
    expect((await chat.get('/__chat/api/pills/work-item/wi_1')).status).toBe(502);
  });

  it('opens the change connection as the user without selecting a session', async () => {
    const chat = await service(() => ({ body: {} }), { CHAT_WORK_ITEM_PILLS: '1' });
    const auth = new Promise((resolve) => chat.gateway.on('upgrade', (request, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      socket.on('error', () => {});
      socket.once('data', (frame) => {
        const extended = (frame[1] & 0x7f) === 126;
        const start = extended ? 4 : 2;
        const payload = Buffer.from(frame.subarray(start + 4));
        for (let index = 0; index < payload.length; index++) payload[index] ^= frame[start + (index % 4)];
        resolve({ url: request.url, value: JSON.parse(payload.toString('utf8')) });
        socket.destroy();
      });
    }));
    const socket = net.connect(chat.port, '127.0.0.1');
    socket.on('error', () => {});
    cleanups.push(() => socket.destroy());
    socket.write('GET /__chat/ws/work-changes?protocolVersion=2 HTTP/1.1\r\nHost: chat.example\r\nOrigin: http://chat.example\r\n' +
      'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n');
    expect(await auth).toEqual({ url: '/ws/changes?protocolVersion=2',
      value: { type: 'auth', token: 'fixture-token', asUser: 'example-user' } });
  });
});
