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
  it('keeps user rows visible while marking only an exact principal match', () => {
    const rows = [message('cli'), message('other-device', { deviceId: 'other', clientMessageId: 'client' }),
      message('other-user', { sender: 'user:someone-else' }), message('prefix', { sender: 'user:person-extra' }),
      message('missing', { sender: undefined, deviceId: 'device', clientMessageId: 'client', raw: { sender: null } }),
      message('wrong-role', { role: 'system' }), message('channel', { raw: { channel: 'terminal' } })];
    expect(project(rows)).toEqual(['cli', 'other-device', 'other-user', 'prefix', 'missing', 'channel']);
    const forPerson = projectMessages(rows, 'person').messages;
    expect(forPerson.map(row => row.key)).toEqual(['cli', 'other-device', 'other-user', 'prefix', 'missing', 'channel']);
    expect(forPerson.map(row => row.senderLabel)).toEqual(['You', 'You', 'User', 'User', 'User', 'You']);
    const forOther = projectMessages(rows, 'someone-else').messages;
    expect(forOther.map(row => row.key)).toEqual(['cli', 'other-device', 'other-user', 'prefix', 'missing', 'channel']);
    expect(forOther.find(row => row.key === 'other-user')?.senderLabel).toBe('You');
    expect(forOther.find(row => row.key === 'cli')?.senderLabel).toBe('User');
  });

  it('preserves canonical batch members without fabricating duplicate rows', () => {
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
    expect(project(rows, 'visitor')).toEqual(['member-one', 'member-two', 'mixed-answer', 'nonhuman-answer', 'incomplete-batch']);
  });

  it('extracts known human rows from an unmarked process batch without trusting its wrapper', () => {
    const batch = message('process-batch', { role: 'user', sender: 'process:notifications', messageType: 'substrate', turnSeq: 10,
      content: [
        '[batched notices: 2]', '',
        '[1] source=process sender=user:person cause=notice class=fyi', 'Question one', '',
        '[2] source=agent:helper sender=agent:helper cause=wake class=fyi', 'A helper started', '',
        'coalesced by notices',
      ].join('\n') });
    const answer = reply('answer-to-batch', batch.id, { turnSeq: 10, turnIncludesHuman: true });

    const forPerson = projectMessages([batch, answer], 'person', 'person').messages;
    expect(forPerson.map(row => row.key)).toEqual(['process-batch:member:1', 'answer-to-batch']);
    expect(forPerson[0]).toMatchObject({ side: 'human', senderLabel: 'You', member: {
      sender: 'user:person', content: 'Question one',
    } });

    const forVisitor = projectMessages([batch, answer], 'visitor', 'person').messages;
    expect(forVisitor.map(row => row.key)).toEqual(['process-batch:member:1']);
    expect(forVisitor[0].senderLabel).toBe('User');
    expect(forPerson[0].member?.content).toBe('Question one');
  });

  it('keeps explicitly marked batch carriers outside human message projection', () => {
    const carrier = message('headed-carrier', { sender: 'process:notifications', isBatchCarrier: true,
      content: [
        '[from process:notifications]', '', '[batched notices: 2]', 'batchId=example-batch', 'release=example',
        '[7] source=user:person sender=user:person cause=notice class=fyi', 'Question one', '',
        '[8] source=agent:helper sender=agent:helper:main session cause=notice class=fyi', 'A helper started', '',
        'coalesced by notices',
      ].join('\n') });

    expect(projectMessages([carrier], 'person', 'person').messages).toEqual([]);
    expect(projectMessages([carrier], 'visitor', 'person').messages).toEqual([]);

    const unmarked = { ...carrier, id: 'unmarked-carrier', isBatchCarrier: undefined };
    expect(projectMessages([unmarked], 'person', 'person').messages).toEqual([]);
  });

  it('requires the complete direct turn relation and reclassifies when older parents arrive', () => {
    const human = message('human', { turnSeq: 1 });
    const agent = message('agent', { sender: 'agent:helper', turnSeq: 2 });
    const other = message('other', { sender: 'user:someone-else', turnSeq: 3 });
    const answers = [reply('human-reply', human.id, { turnSeq: 1 }), reply('agent-reply', agent.id, { turnSeq: 2 }),
      reply('other-reply', other.id, { turnSeq: 3 }), reply('missing-turn', agent.id),
      reply('different-turn', agent.id, { turnSeq: 4 }), reply('missing-parent')];
    expect(project(answers)).toHaveLength(6);
    expect(project([human, agent, other, ...answers])).toEqual(['human', 'other', 'human-reply', 'missing-turn', 'different-turn', 'missing-parent']);
    const conflict = projectMessages([human, reply('answer', human.id, { turnSeq: 1, turnIncludesHuman: false })], 'person', 'person');
    expect(conflict.messages.map((row) => row.key)).toEqual(['human', 'answer']);
    expect(conflict.issues).toHaveLength(1);
    const pending = projectMessages([reply('pending', 'not-loaded', { turnSeq: 11 })], 'person', 'person');
    expect(pending.messages[0].provenancePending).toBe(true);
    expect(projectMessages([reply('unlinked')], 'person', 'person').messages[0].provenancePending).toBe(false);
    expect(conflict.messages.find(row => row.key === 'answer')?.provenancePending).toBe(false);
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
