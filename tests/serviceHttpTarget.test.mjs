import { describe, expect, it } from 'vitest';
import { parseServiceHttpTarget } from '../server/chat-server.mjs';

const runtime = { gatewayOrigin: 'https://gateway.example', principalKey: 'example-user' };
const sessionKey = 'agent:example:linked-chat';
const messagesPath = `/__chat/api/sessions/${encodeURIComponent(sessionKey)}/messages`;

function forwardedQuery(target) {
  expect(target).toMatchObject({ kind: 'transcript', gatewayOrigin: runtime.gatewayOrigin });
  const url = new URL(target.path, 'https://gateway.invalid');
  expect(url.pathname).toBe(`/api/sessions/${encodeURIComponent(sessionKey)}/messages`);
  return [...url.searchParams.entries()];
}

describe('Chat service message cursor forwarding', () => {
  it('forwards after cursors while preserving tail and before queries', () => {
    const afterCursor = 'opaque / cursor:m_1';
    const after = parseServiceHttpTarget(
      `${messagesPath}?limit=50&after=${encodeURIComponent(afterCursor)}`,
      runtime,
    );
    expect(forwardedQuery(after)).toEqual([
      ['asUser', runtime.principalKey], ['limit', '50'], ['after', afterCursor],
    ]);

    const tail = parseServiceHttpTarget(`${messagesPath}?limit=50&tail=true`, runtime);
    expect(forwardedQuery(tail)).toEqual([
      ['asUser', runtime.principalKey], ['limit', '50'], ['tail', 'true'],
    ]);

    const beforeCursor = 'cursor:m_2';
    const before = parseServiceHttpTarget(
      `${messagesPath}?limit=50&before=${encodeURIComponent(beforeCursor)}`,
      runtime,
    );
    expect(forwardedQuery(before)).toEqual([
      ['asUser', runtime.principalKey], ['limit', '50'], ['before', beforeCursor],
    ]);
  });

  it('rejects empty or ambiguous cursor queries', () => {
    expect(parseServiceHttpTarget(`${messagesPath}?limit=50&after=`, runtime)).toBeUndefined();
    expect(parseServiceHttpTarget(`${messagesPath}?limit=50&after=cursor&before=cursor`, runtime)).toBeUndefined();
    expect(parseServiceHttpTarget(`${messagesPath}?limit=50&after=cursor&after=cursor`, runtime)).toBeUndefined();
  });
});

it('forwards attest detail under the selected principal without widening other routes', () => {
  expect(parseServiceHttpTarget('/__chat/api/attests/att_example', runtime)).toEqual({
    kind: 'detail', gatewayOrigin: runtime.gatewayOrigin, path: '/api/attests/att_example?asUser=example-user',
  });
  expect(parseServiceHttpTarget('/__chat/api/attests', runtime)).toBeUndefined();
  expect(parseServiceHttpTarget('/__chat/api/attests/att_example?asUser=someone-else', runtime)).toBeUndefined();
});

it('forwards selected-session record-event history and its opaque older cursor through existing authorization', () => {
  const path = `/__chat/api/sessions/${encodeURIComponent(sessionKey)}/record-events`;
  for (const before of [undefined, 'opaque + / older']) {
    const query = new URLSearchParams({ limit: '50' });
    if (before) query.set('before', before);
    const target = parseServiceHttpTarget(`${path}?${query}`, runtime);
    expect(target.kind).toBe('detail');
    const url = new URL(target.path, runtime.gatewayOrigin);
    expect(url.pathname).toBe(`/api/sessions/${encodeURIComponent(sessionKey)}/record-events`);
    expect(url.searchParams.get('asUser')).toBe(runtime.principalKey);
    expect(url.searchParams.get('before')).toBe(before ?? null);
  }
});
