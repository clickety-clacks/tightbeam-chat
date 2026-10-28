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
