import { describe, expect, it } from 'vitest';
import { classifyMessage, projectMessages } from '../src/messageVisibility';
import type { CanonicalMessage } from '../src/types';

const message = (id: string, content: string, extra: Partial<CanonicalMessage> = {}): CanonicalMessage => Object.freeze({
  kind: 'message', id, sessionKey: 'conversation', seq: 1, rowVersion: 1,
  role: 'user', sender: 'process:notifications', messageType: 'substrate', content,
  raw: Object.freeze({ id, content }), ...extra,
});
const batch = (members: Array<[number, string, string]>) => [
  '[from process:notifications]', '', `[batched notices: ${members.length}]`,
  'batchId=batch-a wake batch-wake token=batch-token rule=batch-format',
  'release=idle provenanceSha256=example', '',
  ...members.flatMap(([index, sender, body]) => [`[${index}] source=source-${index} sender=${sender} cause=notice class=fyi`, body, '']),
  `coalesced by batch-format (${members.length} notices)`,
].join('\n');
const reply = (id: string, parent: string, extra: Partial<CanonicalMessage> = {}) => message(id, `Reply ${id}`, {
  role: 'assistant', sender: 'assistant-service', messageType: 'assistant', replyToMessageId: parent, ...extra,
});

describe('message-local conversation projection', () => {
  it('extracts full human bodies in source order with publication indices and space-containing senders', () => {
    const first = '**Keep this**\n\n> [999] source=quoted sender=agent:helper cause=notice class=fyi\n\n```text\n[1000] source=example sender=process:example cause=notice class=fyi\n```';
    const last = 'Second human message\nwith another line';
    const carrier = message('carrier', batch([
      [428, 'process:notifications', 'Hidden process content'],
      [430, 'user:person', first],
      [431, 'session:agent:example session-key', 'Hidden agent content'],
      [434, 'user:person', last],
    ]));
    const saved = JSON.stringify(carrier);
    const projection = projectMessages([carrier, reply('answer', carrier.id)]);
    expect(projection.issues).toEqual([]);
    expect(projection.messages.map((m) => m.member?.content ?? m.source.content)).toEqual([first, last, 'Reply answer']);
    expect(projection.messages.map((m) => m.side)).toEqual(['human', 'human', 'agent']);
    expect(projection.messages[0].source).toBe(carrier);
    expect(JSON.stringify(carrier)).toBe(saved);
    const rebuilt = { ...carrier, rowVersion: 2 };
    expect(projectMessages([rebuilt]).messages.map((m) => m.key)).toEqual(projection.messages.slice(0, 2).map((m) => m.key));
  });

  it('hides process and agent batches and their replies, while preserving a single human member', () => {
    const process = message('process', batch([[459, 'process:notifications', 'Process body']]));
    const agent = message('agent', batch([[2189, 'agent:example session-key', 'Agent body']]));
    const human = message('human', batch([[2176, 'user:person', 'Human body']]));
    const marker = message('marker', '[event opened]', { role: 'assistant' });
    const wake = message('wake', 'Agent wake', { sender: 'agent:helper', messageType: 'agent' });
    const result = projectMessages([process, reply('p', process.id), agent, reply('a', agent.id),
      marker, wake, reply('w', wake.id), human, reply('h', human.id)]);
    expect(result.messages.map((m) => m.member?.content ?? m.source.content)).toEqual(['Human body', 'Reply h']);
    expect(result.issues).toEqual([]);
  });

  it('preserves distinct identical human records, hides marked carriers, and honors delivered reply flags', () => {
    const human = (id: string) => message(id, 'Same words', { sender: 'user:person', messageType: undefined });
    const marked = message('carrier', batch([[1, 'user:person', 'Same words']]), { isBatchCarrier: true });
    const rows = [human('one'), human('two'), marked, reply('yes', 'unloaded', { turnIncludesHuman: true }),
      reply('no', 'unloaded', { turnIncludesHuman: false })];
    expect(projectMessages(rows).messages.map((m) => m.key)).toEqual(['one', 'two', 'yes']);
    expect(projectMessages([...rows.slice(0, 2), { ...marked, rowVersion: 2 }, ...rows.slice(3)]).messages.map((m) => m.key))
      .toEqual(['one', 'two', 'yes']);
  });

  it('reclassifies loaded parents without treating missing links as exclusion proof', () => {
    const answer = reply('answer', 'older');
    const noLink = reply('no-link', '', { replyToMessageId: undefined });
    expect(projectMessages([answer, noLink]).messages.map((m) => m.key)).toEqual(['answer', 'no-link']);
    const unclassified = message('older', 'Missing source fields', { sender: undefined, messageType: undefined, raw: {} });
    expect(projectMessages([unclassified, answer]).messages.map((m) => m.key)).toEqual(['answer']);
    const parent = message('older', batch([[8, 'agent:helper', 'Hidden body']]));
    expect(projectMessages([parent, answer, noLink]).messages.map((m) => m.key)).toEqual(['no-link']);
    const mixed = { ...parent, rowVersion: 2, content: batch([[8, 'agent:helper', 'Hidden body'], [9, 'user:person', 'Human body']]) };
    expect(projectMessages([mixed, answer]).messages.map((m) => m.member?.content ?? m.source.content)).toEqual(['Human body', 'Reply answer']);
  });

  it('does not accept malformed member framing or a conflicting reply flag as proof to hide human content', () => {
    const carrier = message('bad', batch([[20, 'user:person', 'Human body']]).replace('[20] source=', '[member] source='));
    expect(classifyMessage(carrier).kind).toBe('invalid');
    expect(projectMessages([carrier, reply('answer', carrier.id)]).issues.length).toBe(1);
    const human = message('human', 'Human body', { sender: 'user:person', messageType: undefined });
    const result = projectMessages([human, reply('answer', human.id, { turnIncludesHuman: false })]);
    expect(result.messages.map((m) => m.key)).toEqual(['human', 'answer']);
    expect(result.issues).toHaveLength(1);
  });

  it('leaves a human message quoting a carrier intact and reuses unchanged record classification', () => {
    const human = message('human', batch([[1, 'process:notifications', 'A quoted example']]), {
      sender: undefined, messageType: 'future-kind', raw: { sender: null },
    });
    const first = classifyMessage(human);
    expect(first.kind).toBe('human');
    expect(classifyMessage(human)).toBe(first);
    expect(projectMessages([human]).messages[0].source.content).toBe(human.content);
  });
});
