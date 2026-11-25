import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createChatServer, parseServiceHttpTarget } from '../server/chat-server.mjs';

const sessionKey = 'agent:example:linked chat';
const route = `/__chat/api/sessions/${encodeURIComponent(sessionKey)}/filed-work-items`;
const runtime = { gatewayOrigin: 'https://gateway.example', principalKey: 'example-user' };
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

it('always narrows the list to one creator and a bounded page', () => {
  const query = raw => Object.fromEntries(new URL(parseServiceHttpTarget(`${route}?${raw}`, runtime).path, 'http://x').searchParams);
  expect(query('limit=7')).toEqual({ asUser: 'example-user', createdBySession: sessionKey, limit: '7', tail: 'true' });
  expect(query('limit=50&before=opaque')).toEqual({ asUser: 'example-user', createdBySession: sessionKey, limit: '50', before: 'opaque' });
  for (const raw of ['', 'limit=0', 'limit=51', 'limit=100', 'limit=5&limit=6', 'limit=5&before=', 'limit=5&state=open', 'limit=5&asUser=other']) {
    expect(parseServiceHttpTarget(`${route}?${raw}`, runtime)).toBeUndefined();
  }
});

it('makes one Gateway read and returns only the small fields', async () => {
  const requests = [];
  let reply = JSON.stringify({ schemaVersion: 1, resource: 'work items', page: { oldestCursor: 'older', hasMoreBefore: true },
    items: [{ id: 'wi_a', title: 'Example', state: 'open', started: true, holders: ['agent:one'], failReason: null,
      createdAt: 1, rowVersion: 2, body: 'x'.repeat(2000), landings: [{}], attestCounts: {}, ownerUserId: 'someone' }] });
  let status = 200;
  const gatewayOrigin = await listen(http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/version') { response.end('{"version":"0.1.16"}'); return; }
    requests.push(request.url);
    response.writeHead(status).end(reply);
  }));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-filed-'));
  cleanup.push(() => fs.rmSync(directory, { recursive: true }));
  fs.writeFileSync(path.join(directory, 'gateway.json'), JSON.stringify({ url: gatewayOrigin, cliToken: 'fixture' }));
  const origin = await listen(createChatServer({ rootDir: directory, releaseInfo: { tag: 'v1.0.0', sourceCommit: 'example' },
    environment: { HOME: directory, TIGHTBEAM_BASE_DIR: directory, CHAT_DEFAULT_GATEWAY_ORIGIN: gatewayOrigin,
      CHAT_DEFAULT_SESSION_KEY: sessionKey, CHAT_DEFAULT_PRINCIPAL_KEY: 'example-user', CHAT_PUBLIC_ORIGIN: 'http://chat.example' } }));
  const get = () => fetch(`${origin}${route}?limit=5`);
  expect(await (await get()).json()).toEqual({ oldestCursor: 'older', hasOlder: true, items: [{ id: 'wi_a', title: 'Example',
    state: 'open', started: true, holders: ['agent:one'], failReason: null, createdAt: 1, rowVersion: 2 }] });
  expect(requests).toHaveLength(1);
  status = 404;
  expect((await get()).status).toBe(404);
  status = 200;
  reply = '{"unexpected":true}';
  expect((await get()).status).toBe(502);
});
