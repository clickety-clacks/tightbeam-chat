import { describe, expect, it } from 'vitest';
import { projectMessages } from '../src/messageVisibility';
import type { CanonicalMessage } from '../src/types';

const message = (id: string, extra: Partial<CanonicalMessage> = {}): CanonicalMessage => Object.freeze({
  kind: 'message', id, sessionKey: 'conversation', seq: 1, rowVersion: 1,
  role: 'user', sender: 'user:person', content: id, raw: Object.freeze({ id }), ...extra,
});
const reply = (id: string, parent?: string, extra: Partial<CanonicalMessage> = {}) => message(id, {
  role: 'assistant', sender: 'assistant-service', replyToMessageId: parent, ...extra,
});
const project = (rows: CanonicalMessage[], principal = 'person', owner: string | undefined = 'person') =>
  projectMessages(rows, principal, owner).messages.map((row) => row.key);

describe('principal-scoped message projection', () => {
  it('requires exact principal and user role, independently of channel and send correlation', () => {
    const rows = [message('cli'), message('other-device', { deviceId: 'other', clientMessageId: 'client' }),
      message('other-user', { sender: 'user:someone-else' }), message('prefix', { sender: 'user:person-extra' }),
      message('missing', { sender: undefined, deviceId: 'device', clientMessageId: 'client', raw: { sender: null } }),
      message('wrong-role', { role: 'system' }), message('channel', { raw: { channel: 'terminal' } })];
    expect(project(rows)).toEqual(['cli', 'other-device', 'channel']);
    expect(project(rows, 'someone-else')).toEqual(['other-user']);
    expect(projectMessages(rows).messages).toEqual([]);
  });

  it('preserves canonical batch members and uses owner-scoped reply flags without parsing carrier text', () => {
    const carrier = message('carrier', { sender: 'process:notifications', isBatchCarrier: true, turnSeq: 10,
      content: '[batched notices: 1]\n[1] source=example sender=user:person cause=notice class=fyi\nHidden wrapper' });
    const rows = [carrier, message('member-one', { turnSeq: 10 }), message('member-two', { turnSeq: 10 }),
      message('agent-member', { sender: 'agent:helper', turnSeq: 10 }),
      reply('mixed-answer', carrier.id, { turnSeq: 10, turnIncludesHuman: true }),
      reply('nonhuman-answer', 'unloaded', { turnSeq: 11, turnIncludesHuman: false }),
      reply('incomplete-batch', carrier.id, { turnSeq: 10 })];
    const saved = JSON.stringify(rows);
    expect(project(rows)).toEqual(['member-one', 'member-two', 'mixed-answer', 'incomplete-batch']);
    expect(JSON.stringify(rows)).toBe(saved);
    expect(projectMessages(rows, 'person', 'person').messages.slice(0, 2).map((row) => row.side)).toEqual(['human', 'human']);
    // A session-owner flag cannot classify a different authenticated principal.
    expect(project(rows, 'visitor')).toEqual(['mixed-answer', 'nonhuman-answer', 'incomplete-batch']);
  });

  it('requires the complete direct turn relation and reclassifies when older parents arrive', () => {
    const human = message('human', { turnSeq: 1 });
    const agent = message('agent', { sender: 'agent:helper', turnSeq: 2 });
    const other = message('other', { sender: 'user:someone-else', turnSeq: 3 });
    const answers = [reply('human-reply', human.id, { turnSeq: 1 }), reply('agent-reply', agent.id, { turnSeq: 2 }),
      reply('other-reply', other.id, { turnSeq: 3 }), reply('missing-turn', agent.id),
      reply('different-turn', agent.id, { turnSeq: 4 }), reply('missing-parent')];
    expect(project(answers)).toHaveLength(6);
    expect(project([human, agent, other, ...answers])).toEqual(['human', 'human-reply', 'missing-turn', 'different-turn', 'missing-parent']);
    const conflict = projectMessages([human, reply('answer', human.id, { turnSeq: 1, turnIncludesHuman: false })], 'person', 'person');
    expect(conflict.messages.map((row) => row.key)).toEqual(['human', 'answer']);
    expect(conflict.issues).toHaveLength(1);
  });

  it('does not turn arbitrary origins, wake text, incomplete flags, or assistant markers into human proof', () => {
    const rows = [message('marker', { role: 'assistant', sender: 'process:events', messageType: 'substrate' }),
      message('wake', { sender: 'agent:helper', content: 'sender=user:person' }),
      message('carrier', { sender: 'process:events', content: '[batched notices: 1]\nuser:person says hello' }),
      reply('no-turn-flag', undefined, { turnIncludesHuman: false, raw: { origin: 'user:someone-else' } }),
      reply('unknown-owner', undefined, { turnSeq: 10, turnIncludesHuman: false })];
    expect(projectMessages(rows, 'person').messages.map((row) => row.key)).toEqual(['no-turn-flag', 'unknown-owner']);
    const quote = message('quote', { content: rows[2].content });
    expect(projectMessages([quote], 'person').messages[0].source).toBe(quote);
  });
});
