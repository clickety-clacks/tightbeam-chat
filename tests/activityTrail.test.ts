import { describe, expect, it } from 'vitest';
import { buildActivityTrail, type ActivityBubble, type ActivityFold, type ActivityLine,
  type MessageActivityItem } from '../src/activityTrail';
import { decodePublic019Message } from '../src/public019';
import type { CanonicalMessage, CanonicalTransition, LiveRailDenial, ToolCallRecord } from '../src/types';

const message = (id: string, seq: number, sender: string, content = id,
  extra: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  kind: 'message', id, sessionKey: 'session', seq, rowVersion: 1, role: 'user', sender, content,
  raw: {}, ...extra,
});

const bubble = (record: CanonicalMessage, side: ActivityBubble['side']): ActivityBubble => ({
  key: record.id, record, side, ownerScoped: side === 'agent' || record.sender === 'user:person',
});

const tool = (id: string, seq: number, status: ToolCallRecord['status'], toolName = 'read_file'): ToolCallRecord => ({
  id, seq, sessionKey: 'session', turnSeq: 1, afterMessageSeq: 1, harnessToolCallId: id,
  title: `Tool ${id}`, kind: 'read', toolName, status, rawInput: null,
  rawOutput: null, content: null, truncated: [], startedAt: seq, endedAt: status === 'completed' || status === 'failed' ? seq + 1 : null,
  rowVersion: 1,
});

function build(input: {
  records?: readonly CanonicalMessage[];
  bubbles?: readonly ActivityBubble[];
  transitions?: readonly CanonicalTransition[];
  localSendTimes?: readonly number[];
  tools?: readonly ToolCallRecord[];
  toolsEnabled?: boolean;
  turnStateAvailable?: boolean;
  activeTurnRunning?: boolean;
  activeOwnerTurnRunning?: boolean;
  railDenials?: readonly LiveRailDenial[];
  shownRuns?: ReadonlyMap<string, string>;
  expandedRuns?: ReadonlySet<string>;
}) {
  return buildActivityTrail({
    sessionKey: 'session', records: input.records ?? [], bubbles: input.bubbles ?? [], transitions: input.transitions ?? [],
    localSendTimes: input.localSendTimes,
    tools: input.tools ?? [], toolsEnabled: input.toolsEnabled ?? true,
    turnStateAvailable: input.turnStateAvailable ?? true, activeTurnRunning: input.activeTurnRunning ?? true,
    activeOwnerTurnRunning: input.activeOwnerTurnRunning ?? input.activeTurnRunning ?? true,
    railDenials: input.railDenials ?? [],
    shownRuns: input.shownRuns ?? new Map(), expandedRuns: input.expandedRuns ?? new Set(),
  });
}

const combined = (items: readonly MessageActivityItem[], tools: ReadonlyMap<string, MessageActivityItem>) =>
  [...new Map([...items, ...tools.values()].map(item => [item.id, item])).values()].sort((left, right) => left.position.sequence - right.position.sequence ||
    left.position.phase - right.position.phase || left.position.order - right.position.order);

describe('activity trail projection', () => {
  it('folds only clear same-kind reminders and wakes while leaving other notices unfolded', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const reminder1 = message('reminder-1', 2, 'process:events',
      'Quiet for 3 h · Assignment Alpha', { messageType: 'substrate' });
    const reminder2 = message('reminder-2', 3, 'process:events',
      'Assignment Beta has had no recorded activity since this morning', { messageType: 'substrate' });
    const wake1 = message('wake-1', 4, 'process:events',
      '[woke: wait wake-one; assignment alpha; path after-turn]\n\nReview the first result', { messageType: 'substrate' });
    const wake2 = message('wake-2', 5, 'process:events',
      '[woke: fact wake-two; assignment beta; path success]\n\nReview the latest result', { messageType: 'substrate' });
    const reply = message('reply', 6, 'assistant-service', 'Answer', { role: 'assistant' });
    const plan = build({ records: [reminder1, reminder2, wake1, wake2],
      bubbles: [bubble(prompt, 'human'), bubble(reply, 'agent')] });

    const folds = plan.messageItems.filter((item): item is ActivityFold => item.kind === 'fold');
    expect(folds).toHaveLength(2);
    expect(folds.map(fold => fold.lines.map(line => line.id))).toEqual([
      ['message:reminder-1', 'message:reminder-2'],
      ['message:wake-1', 'message:wake-2'],
    ]);
    expect(folds[0].summary.gist).toBe(reminder2.content);
    expect(folds[1].summary.id).toBe('message:wake-2');

    const specialNotices = [
      message('attest', 3, 'process:events', 'Attest filed on the assignment', { messageType: 'substrate' }),
      message('remedy', 3, 'remedy:review', 'Review requested changes'),
      message('decision', 3, 'process:events', 'Decision needs a response', { messageType: 'substrate' }),
      message('refused', 3, 'process:events', 'Completion needs a recorded verification first',
        { messageType: 'substrate' }),
    ];
    const recognizedKinds = [
      message('wake', 2, 'process:events',
        '[woke: fallback deadline]\n\nReview the result', { messageType: 'substrate' }),
      message('reminder', 2, 'process:events',
        'Assignment Delta has had no recorded activity since this morning', { messageType: 'substrate' }),
    ];
    for (const notice of specialNotices) {
      for (const recognized of recognizedKinds) {
        const distinct = build({ records: [recognized, notice], bubbles: [
          bubble(prompt, 'human'), bubble(message('pair-reply', 4, 'assistant-service', 'Answer',
            { role: 'assistant' }), 'agent'),
        ] });
        expect(distinct.messageItems.some(item => item.kind === 'fold')).toBe(false);
        expect(distinct.messageItems.filter(item => item.kind === 'substrate' || item.kind === 'rail')).toHaveLength(2);
      }
    }

    const uncertain = build({ records: [
      message('uncertain-1', 2, 'process:events',
        'Status changed for requested work\nAssignment Beta has had no recorded activity since this morning',
        { messageType: 'substrate' }),
      message('uncertain-2', 3, 'process:events', 'A helper is now available', { messageType: 'substrate' }),
    ], bubbles: [bubble(prompt, 'human'), bubble(message('uncertain-reply', 4, 'assistant-service', 'Answer',
      { role: 'assistant' }), 'agent')] });
    expect(uncertain.messageItems.some(item => item.kind === 'fold')).toBe(false);
    expect(uncertain.messageItems.filter(item => item.kind === 'substrate')).toHaveLength(2);

    const agents = build({ records: [
      message('agent-1', 2, 'agent:helper', 'Helper started', { messageType: 'agent' }),
      message('agent-2', 3, 'agent:helper', 'Helper finished', { messageType: 'agent' }),
    ], bubbles: [bubble(prompt, 'human'), bubble(message('agent-reply', 4, 'assistant-service', 'Answer',
      { role: 'assistant' }), 'agent')] });
    const agentFold = agents.messageItems.find((item): item is ActivityFold => item.kind === 'fold');
    expect(agentFold?.lines.map(line => line.id)).toEqual(['message:agent-1', 'message:agent-2']);
    expect(agentFold?.summary.gist).toBe('Another agent — Helper finished');
  });

  it('leaves same-kind activity lines separate when a transition falls between them', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const before = message('before-transition', 2, 'process:events',
      'Assignment Alpha has had no recorded activity since this morning', { messageType: 'substrate' });
    const after = message('after-transition', 4, 'process:events',
      'Assignment Beta has had no recorded activity since this morning', { messageType: 'substrate' });
    const reply = message('reply', 5, 'assistant-service', 'Answer', { role: 'assistant' });
    const transition: CanonicalTransition = { kind: 'transition', id: 'reset', sessionKey: 'session', seq: 3,
      rowVersion: 1, transition: 'restart', content: 'Context reset', raw: {} };
    const plan = build({ records: [before, after], bubbles: [bubble(prompt, 'human'), bubble(reply, 'agent')],
      transitions: [transition] });

    expect(plan.messageItems.map(item => item.kind)).toEqual(['substrate', 'substrate']);
    expect(plan.messageItems.map(item => item.id)).toEqual(['message:before-transition', 'message:after-transition']);
  });

  it('ends a same-kind run at an unmatched local message bubble', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const before = message('before-send', 2, 'process:events', 'Assignment Alpha has had no recorded activity since now', {
      messageType: 'substrate', createdAt: new Date(1_000).toISOString(),
    });
    const after = message('after-send', 3, 'process:events', 'Assignment Beta has had no recorded activity since now', {
      messageType: 'substrate', createdAt: new Date(3_000).toISOString(),
    });
    const reply = message('reply', 4, 'assistant-service', 'Answer', { role: 'assistant' });
    const plan = build({ records: [before, after], bubbles: [bubble(prompt, 'human'), bubble(reply, 'agent')],
      localSendTimes: [2_000] });

    expect(plan.messageItems.map(item => item.kind)).toEqual(['substrate', 'substrate']);
    expect(plan.messageItems.map(item => item.id)).toEqual(['message:before-send', 'message:after-send']);
  });

  it('does not fold tool activity across an unmatched local message bubble', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const plan = build({ bubbles: [bubble(prompt, 'human')], tools: [tool('before-send', 2_000, 'in_progress'),
      tool('after-send', 4_000, 'in_progress')], localSendTimes: [3_000] });

    expect(plan.toolItems.get('before-send')?.kind).toBe('tool');
    expect(plan.toolItems.get('after-send')?.kind).toBe('tool');
  });

  it('keeps different tool names in separate activity entries', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const plan = build({ bubbles: [bubble(prompt, 'human')], tools: [
      tool('read-one', 1, 'completed', 'Read'), tool('read-two', 2, 'failed', 'Read'),
      tool('bash', 3, 'completed', 'Bash'), tool('grep', 4, 'completed', 'Grep'),
    ] });

    const readFold = plan.toolItems.get('read-one');
    expect(readFold?.kind).toBe('fold');
    expect(plan.toolItems.get('read-two')).toBe(readFold);
    expect((readFold as ActivityFold).lines.map(line => line.call?.toolName)).toEqual(['Read', 'Read']);
    expect(plan.toolItems.get('bash')?.kind).toBe('tool');
    expect(plan.toolItems.get('grep')?.kind).toBe('tool');
  });

  it('folds an entire long homogeneous run before applying the display history cap', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const reply = message('reply', 20, 'assistant-service', 'Answer', { role: 'assistant' });
    const reminders = Array.from({ length: 6 }, (_, index) => message(`reminder-${index + 1}`, index + 2,
      'process:events', `Assignment ${index + 1} has had no recorded activity since now`, { messageType: 'substrate' }));
    const bubbles = [bubble(prompt, 'human'), bubble(reply, 'agent')];
    const first = build({ records: reminders, bubbles });
    const firstFold = first.messageItems.find((item): item is ActivityFold => item.kind === 'fold')!;
    expect(firstFold.id).toBe('message:reminder-1');
    expect(firstFold.lines).toHaveLength(6);
    expect(firstFold.summary.gist).toBe('Assignment 6 has had no recorded activity since now');
    expect(first.messageItems.some(item => item.kind === 'overflow')).toBe(false);

    const later = message('reminder-7', 9, 'process:events',
      'Assignment 7 has had no recorded activity since now', { messageType: 'substrate' });
    const next = build({ records: [...reminders, later], bubbles, shownRuns: first.membership });
    const nextFold = next.messageItems.find((item): item is ActivityFold => item.kind === 'fold')!;
    expect(nextFold.id).toBe(firstFold.id);
    expect(nextFold.summary.gist).toBe('Assignment 7 has had no recorded activity since now');
    expect(nextFold.lines).toHaveLength(7);
    expect(next.messageItems.some(item => item.kind === 'overflow')).toBe(false);
  });

  it('places tool, substrate, and other-agent lines in canonical order between prompt and reply', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const assignment = message('assignment', 2, 'process:assignments', 'Assigned a task', {
      role: 'assistant', messageType: 'substrate', attentionTier: -1,
    });
    const wake = message('wake', 3, 'agent:helper', 'Started a helper task', { messageType: 'agent' });
    const reply = message('reply', 4, 'assistant-service', 'Answer', { role: 'assistant' });
    const plan = build({ records: [assignment, wake], bubbles: [bubble(prompt, 'human'), bubble(reply, 'agent')],
      tools: [tool('done', 1, 'completed'), tool('failed', 2, 'failed'), tool('running', 3, 'in_progress')] });

    const ordered = combined(plan.messageItems, plan.toolItems as ReadonlyMap<string, MessageActivityItem>);
    expect(ordered.map(item => item.kind)).toEqual(['fold', 'substrate', 'agent']);
    const toolFold = ordered[0] as ActivityFold;
    expect(toolFold.activityKind).toBe('tool');
    expect(toolFold.lines.map(item => item.call?.id)).toEqual(['done', 'failed', 'running']);
    expect(toolFold.summary.gist).toBe('Tool running · running');
    const lines = ordered.slice(1) as ActivityLine[];
    expect(lines[0].accessibleText).toBe('Substrate: Assigned a task');
    expect(lines[1].accessibleText).toBe('Other agent: Another agent — Started a helper task');

    const hiddenReply = message('hidden-reply', 2, 'assistant-service', 'Must not become activity', {
      role: 'assistant', messageType: 'assistant', turnIncludesHuman: false,
    });
    expect(build({ records: [hiddenReply], bubbles: [bubble(prompt, 'human')] }).messageItems).toEqual([]);
  });

  it('projects running-index batch members with spaced senders and extends their fold across batches', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const carrier = (id: string, seq: number, members: Array<{ index: number; detail: string }>) => message(id, seq,
      'process:notifications', [
        '[from process:notifications]', '', `[batched notices: ${members.length}]`, `batchId=${id}`, 'release=example',
        ...members.flatMap(({ index, detail }) => [
          `[${index}] source=agent:helper sender=agent:helper:main session cause=notice class=fyi`, detail, '',
        ]),
        'coalesced by notices',
      ].join('\n'), { isBatchCarrier: true, messageType: 'substrate' });
    const first = carrier('carrier-first', 2, [
      { index: 7, detail: 'First helper update' },
      { index: 9, detail: 'Second helper update' },
    ]);
    const second = carrier('carrier-second', 3, [{ index: 12, detail: 'Latest helper update' }]);
    const reply = message('reply', 4, 'assistant-service', 'Answer', { role: 'assistant' });

    const plan = build({ records: [first, second], bubbles: [bubble(prompt, 'human'), bubble(reply, 'agent')] });

    expect(plan.messageItems).toHaveLength(1);
    const fold = plan.messageItems[0] as ActivityFold;
    expect(fold).toMatchObject({ kind: 'fold', activityKind: 'agent', summary: {
      kind: 'agent', gist: 'Another agent — Latest helper update',
    } });
    expect(fold.lines.map(line => line.gist)).toEqual([
      'Another agent — First helper update', 'Another agent — Second helper update',
      'Another agent — Latest helper update',
    ]);
    expect(fold.lines.map(line => line.id)).toEqual([
      'member:carrier-first:member:7', 'member:carrier-first:member:9', 'member:carrier-second:member:12',
    ]);
    expect(fold.lines.every(line => line.presentation !== undefined)).toBe(true);
  });

  it('rebuilds the same activity pills and fold from retained history after reload', () => {
    const prompt = message('history-prompt', 1, 'user:person', 'A question', {
      role: 'user', messageType: 'chat', turnSeq: 1,
    });
    const carrier = (id: string, seq: number, index: number, task: string, assignment: string) => message(id, seq,
      'process:notifications', [
        '[from process:notifications]', '', '[batched notices: 1]', `batchId=${id}`, 'release=example',
        `[${index}] source=process:events sender=process:events cause=notice class=fyi`,
        `Assignment ${assignment} (Background ${task}) has had no recorded activity since 12`, '',
        'coalesced by notices',
      ].join('\n'), { isBatchCarrier: true, messageType: 'substrate' });
    const first = carrier('history-carrier-first', 2, 7, 'review', 'asg_12345678-1111-4111-8111-123456789abc');
    const second = carrier('history-carrier-second', 3, 5567, 'build', 'asg_abcdef12-1111-4111-8111-123456789abc');
    const reply = message('history-reply', 4, 'assistant-service', 'The answer', {
      role: 'assistant', messageType: 'assistant', turnSeq: 1, replyToMessageId: prompt.id,
    });
    const storedRows = [prompt, first, second, reply].map(record => ({
      id: record.id, sessionKey: record.sessionKey, seq: record.seq, rowVersion: record.rowVersion,
      role: record.role, sender: record.sender, content: record.content, messageType: record.messageType,
      isBatchCarrier: record.isBatchCarrier, turnSeq: record.turnSeq, replyToMessageId: record.replyToMessageId,
      at: record.seq * 1_000, attachments: [],
    }));
    const readHistory = () => storedRows.map(row => {
      const decoded = decodePublic019Message(row, 'session');
      if (decoded.kind !== 'message') throw new Error('Expected retained message row');
      return decoded;
    });
    const delivered = readHistory();
    const liveBubbles = [bubble(delivered[0], 'human'), bubble(delivered[3], 'agent')];
    const whenDelivered = build({ records: [delivered[1], delivered[2]], bubbles: liveBubbles,
      activeTurnRunning: false,
    });
    // A new Chat lifetime decodes retained history again from the same canonical rows.
    const reloaded = readHistory();
    const afterReload = build({ records: [reloaded[1], reloaded[2]],
      bubbles: [bubble(reloaded[0], 'human'), bubble(reloaded[3], 'agent')], activeTurnRunning: false });

    expect(afterReload.messageItems).toEqual(whenDelivered.messageItems);
    const fold = afterReload.messageItems.find((item): item is ActivityFold => item.kind === 'fold');
    expect(fold).toMatchObject({ id: 'member:history-carrier-first:member:7', activityKind: 'substrate',
      summary: { presentation: { label: 'Assignment', text: 'No recent activity · Background build', metadata: 'asg_abcd' } },
    });
    expect(fold?.lines).toHaveLength(2);
    expect(fold?.lines.map(line => line.id)).toEqual([
      'member:history-carrier-first:member:7', 'member:history-carrier-second:member:5567',
    ]);
  });

  it('rebuilds a retained activity fold when a later owner reply closes the history gap', () => {
    const prompt = message('tail-history-prompt', 1, 'user:person', 'A question', {
      role: 'user', messageType: 'chat', turnSeq: 9,
    });
    const first = message('tail-reminder-first', 2, 'process:events',
      'Assignment asg_12345678-1111-4111-8111-123456789abc (Background review) has had no recorded activity since 12', {
        messageType: 'substrate', turnSeq: 9,
      });
    const second = message('tail-reminder-second', 3, 'process:events',
      'Assignment asg_abcdef12-1111-4111-8111-123456789abc (Background build) has had no recorded activity since 12', {
        messageType: 'substrate', turnSeq: 9,
      });
    const reply = message('tail-history-reply', 4, 'assistant-service', 'The answer', {
      role: 'assistant', messageType: 'assistant', turnSeq: 9, replyToMessageId: prompt.id,
    });
    const storedRows = [prompt, first, second, reply].map(record => ({
      id: record.id, sessionKey: record.sessionKey, seq: record.seq, rowVersion: record.rowVersion,
      role: record.role, sender: record.sender, content: record.content, messageType: record.messageType,
      turnSeq: record.turnSeq, replyToMessageId: record.replyToMessageId, at: record.seq * 1_000, attachments: [],
    }));
    const readHistory = () => storedRows.map(row => {
      const decoded = decodePublic019Message(row, 'session');
      if (decoded.kind !== 'message') throw new Error('Expected retained message row');
      return decoded;
    });
    const delivered = readHistory();
    const whenDelivered = build({ records: [delivered[1], delivered[2]],
      bubbles: [bubble(delivered[0], 'human'), bubble(delivered[3], 'agent')], activeTurnRunning: false });
    const reloaded = readHistory();
    const afterReload = build({ records: [reloaded[1], reloaded[2]],
      bubbles: [bubble(reloaded[0], 'human'), bubble(reloaded[3], 'agent')], activeTurnRunning: false,
    });

    expect(afterReload.messageItems).toEqual(whenDelivered.messageItems);
    expect(afterReload.messageItems).toMatchObject([{
      kind: 'fold', lines: [{ id: 'message:tail-reminder-first' }, { id: 'message:tail-reminder-second' }],
      summary: { presentation: { text: 'No recent activity · Background build', metadata: 'asg_abcd' } },
    }]);
  });

  it('matches live and reloaded pills while excluding non-owner activity on every page', () => {
    const storeRow = (id: string, seq: number, role: string, sender: string, content: string,
      messageType: string, extra: Record<string, unknown> = {}) => ({
      id, sessionKey: 'session', seq, rowVersion: 1, role, sender, content, messageType,
      at: seq * 1_000, attachments: [], ...extra,
    });
    const carrier = (id: string, seq: number, memberIndex: number, assignment: string, task: string) =>
      storeRow(id, seq, 'user', 'process:notifications', [
        '[from process:notifications]', '', '[batched notices: 1]', `batchId=${id}`, 'release=example',
        `[${memberIndex}] source=process:events sender=process:events cause=notice class=fyi`,
        `Assignment ${assignment} (Background ${task}) has had no recorded activity since 12`, '',
        'coalesced by notices',
      ].join('\n'), 'substrate', { isBatchCarrier: true, turnSeq: 77 });
    const laterOwnerActivity = storeRow('history-owner-gap', 5, 'user', 'process:events',
      'Owner-turn activity in a later gap', 'substrate', { turnSeq: 1 });
    const storedRows = [
      storeRow('history-older-page-process', 1, 'user', 'process:events', 'Older process notice', 'process', { turnSeq: 77 }),
      storeRow('history-prompt-one', 2, 'user', 'user:person', 'First question', 'chat', { turnSeq: 1 }),
      carrier('history-gap-first', 3, 3, 'asg_12345678', 'review'),
      carrier('history-gap-second', 4, 5567, 'asg_abcdef12', 'build'),
      storeRow('history-reply-one', 5, 'assistant', 'assistant-service', 'First answer', 'assistant', { turnSeq: 1 }),
      laterOwnerActivity,
      carrier('history-older-non-owner', 7, 5568, 'asg_23456789', 'test'),
      storeRow('history-other-agent-wake', 8, 'user', 'agent:helper', '[woke: fallback deadline]\nWake outside owner turn',
        'agent', { turnSeq: 77 }),
      storeRow('history-process-notice', 9, 'user', 'process:events', 'Direct process notice outside owner turn',
        'process', { turnSeq: 77 }),
      storeRow('history-external-reply', 10, 'assistant', 'agent:external', 'Unproven external reply',
        'assistant', { turnSeq: 77 }),
      storeRow('history-prompt-two', 11, 'user', 'user:person', 'Second question', 'chat', { turnSeq: 2 }),
      carrier('history-tail-first', 12, 5569, 'asg_bcdef123', 'review'),
      carrier('history-tail-second', 13, 5570, 'asg_aaaa1234', 'build'),
      storeRow('history-reply-two', 14, 'assistant', 'assistant-service', 'Second answer', 'assistant', { turnSeq: 2 }),
      storeRow('history-unrelated-marker', 15, 'assistant', 'process:notifications', 'Unrelated process marker',
        'substrate', { turnSeq: 77 }),
    ];
    const readHistory = () => storedRows.map(row => {
      const decoded = decodePublic019Message(row, 'session');
      if (decoded.kind !== 'message') throw new Error('Expected retained message row');
      return decoded;
    });
    const project = (records: readonly CanonicalMessage[]) => {
      const byId = new Map(records.map(record => [record.id, record]));
      const activity = records.filter(record => record.isBatchCarrier === true ||
        record.id.startsWith('history-older-page') || record.id === 'history-owner-gap' ||
        record.id.startsWith('history-other-agent') || record.id === 'history-process-notice' ||
        record.id === 'history-external-reply' || record.id === 'history-unrelated-marker');
      return build({ records: activity, bubbles: [
        bubble(byId.get('history-prompt-one')!, 'human'), bubble(byId.get('history-reply-one')!, 'agent'),
        bubble(byId.get('history-prompt-two')!, 'human'), bubble(byId.get('history-reply-two')!, 'agent'),
      ], activeTurnRunning: false });
    };
    const history = readHistory();
    expect(history.filter(record => record.isBatchCarrier).map(record => record.turnSeq)).toEqual([77, 77, 77, 77, 77]);
    expect(history.filter(record => record.id.startsWith('history-prompt') || record.id.startsWith('history-reply'))
      .map(record => record.turnSeq)).toEqual([1, 1, 2, 2]);
    const beforeLeave = project(history);
    const afterReturn = project(readHistory());
    const afterReload = project(readHistory());

    expect(beforeLeave.messageItems).toEqual(afterReturn.messageItems);
    expect(afterReload.messageItems).toEqual(beforeLeave.messageItems);
    expect(beforeLeave.messageItems.some(item => item.id.includes('member:history-older-non-owner'))).toBe(false);
    const renderedIds = beforeLeave.messageItems.flatMap(item => item.kind === 'fold' ? item.lines.map(line => line.id) : [item.id]);
    for (const hiddenId of ['history-older-page-process', 'history-older-non-owner', 'history-other-agent-wake',
      'history-process-notice', 'history-external-reply', 'history-unrelated-marker', 'history-owner-gap']) {
      expect(renderedIds.some(id => id.includes(hiddenId))).toBe(false);
    }
    expect(afterReturn.messageItems).toMatchObject([
      { kind: 'fold', id: 'member:history-gap-first:member:3', runKey: 'run:history-prompt-one',
        lines: [{ id: 'member:history-gap-first:member:3' }, { id: 'member:history-gap-second:member:5567' }],
        summary: { presentation: { text: 'No recent activity · Background build', metadata: 'asg_abcd' } } },
      { kind: 'fold', id: 'member:history-tail-first:member:5569', runKey: 'run:history-prompt-two',
        lines: [{ id: 'member:history-tail-first:member:5569' }, { id: 'member:history-tail-second:member:5570' }],
        summary: { presentation: { text: 'No recent activity · Background build', metadata: 'asg_aaaa' } } },
    ]);
    expect(afterReturn.messageItems.some(item => item.id.startsWith('member:history-older-non-owner'))).toBe(false);
  });

  it('uses a retained batch member source kind when its carrier type is substrate', () => {
    const prompt = message('source-prompt', 1, 'user:person', 'Question', { role: 'user' });
    const carrier = message('source-carrier', 2, 'process:notifications', [
      '[from process:notifications]', '', '[batched notices: 1]', 'batchId=source-carrier', 'release=example',
      '[5567] source=agent:helper sender=process:events cause=notice class=fyi',
      'A sourced helper update', '', 'coalesced by notices',
    ].join('\n'), { isBatchCarrier: true, messageType: 'substrate' });
    const reply = message('source-reply', 3, 'assistant-service', 'Answer', { role: 'assistant' });
    const plan = build({ records: [carrier], bubbles: [bubble(prompt, 'human'), bubble(reply, 'agent')],
      activeTurnRunning: false });

    expect(plan.messageItems).toHaveLength(1);
    expect(plan.messageItems[0]).toMatchObject({
      kind: 'substrate', presentation: { label: 'Message', tone: 'indigo', icon: 'message',
        text: 'A sourced helper update' },
    });
  });

  it('caps displayed groups per gap and keeps an expanded run expanded when a later entry arrives', () => {
    const prompt = message('prompt', 1, 'user:person');
    const firstReply = message('reply-one', 4, 'assistant-service', 'First answer', { role: 'assistant' });
    const secondReply = message('reply-two', 14, 'assistant-service', 'Second answer', { role: 'assistant' });
    const initial = Array.from({ length: 10 }, (_, index) => message(`activity-${index + 1}`, index + 2,
      'process:work', `Assignment ${index + 1} has had no recorded activity since now`, { messageType: 'substrate' }));
    const bubbles = [bubble(prompt, 'human'), bubble(firstReply, 'agent'), bubble(secondReply, 'agent')];
    const firstPlan = build({ records: initial, bubbles });
    const firstRun = 'run:prompt';
    const secondRun = 'run:reply-one';
    const runItems = (runKey: string) => firstPlan.messageItems.filter(item => item.runKey === runKey);
    expect(runItems(firstRun).map(item => item.kind)).toEqual(['fold']);
    expect((runItems(firstRun)[0] as ActivityFold).lines).toHaveLength(2);
    expect(runItems(secondRun).filter(item => item.kind === 'overflow')).toHaveLength(0);
    const secondFold = runItems(secondRun).find((item): item is ActivityFold => item.kind === 'fold')!;
    expect(secondFold.lines.map(item => item.gist)).toEqual(Array.from({ length: 8 }, (_, index) =>
      `Assignment ${index + 3} has had no recorded activity since now`));

    const expanded = build({ records: initial, bubbles, shownRuns: firstPlan.membership,
      expandedRuns: new Set([secondRun]) });
    expect(expanded.messageItems.filter(item => item.runKey === firstRun)).toHaveLength(1);
    expect((expanded.messageItems.find(item => item.runKey === firstRun) as ActivityFold).lines).toHaveLength(2);
    expect((expanded.messageItems.find(item => item.runKey === secondRun) as ActivityFold).lines).toHaveLength(8);
    expect(expanded.messageItems.some(item => item.kind === 'overflow' && item.runKey === secondRun)).toBe(false);

    const later = [...initial, message('activity-11', 12, 'process:work',
      'Assignment 11 has had no recorded activity since now', { messageType: 'substrate' })];
    const withLater = build({ records: later, bubbles, shownRuns: expanded.membership,
      expandedRuns: new Set([secondRun]) });
    expect((withLater.messageItems.find(item => item.runKey === secondRun) as ActivityFold).lines).toHaveLength(9);
    expect(withLater.messageItems.some(item => item.kind === 'overflow' && item.runKey === secondRun)).toBe(false);
  });

  it('keeps the five-entry cap when a gap contains more than five distinct display groups', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const reply = message('reply', 10, 'assistant-service', 'Answer', { role: 'assistant' });
    const records = Array.from({ length: 6 }, (_, index) => {
      const agent = index % 2 === 1;
      return message(`activity-${index + 1}`, index + 2, agent ? 'agent:helper' : 'process:events',
        `Activity ${index + 1}`, { messageType: agent ? 'agent' : 'substrate' });
    });
    const plan = build({ records, bubbles: [bubble(prompt, 'human'), bubble(reply, 'agent')] });

    expect(plan.messageItems.map(item => item.kind)).toEqual(['overflow', 'agent', 'substrate', 'agent', 'substrate', 'agent']);
    expect(plan.messageItems[0].id).toBe('overflow:run:prompt');
    expect(plan.messageItems.map(item => item.id).slice(1)).toEqual([
      'message:activity-2', 'message:activity-3', 'message:activity-4', 'message:activity-5', 'message:activity-6',
    ]);
  });

  it('rebuilds a batch member from its ordered owner prompt/reply boundary despite carrier turnSeq', () => {
    const firstPrompt = message('first-prompt', 1, 'user:person');
    const firstReply = message('first-reply', 3, 'assistant-service', 'First answer', { role: 'assistant', turnSeq: 1 });
    const carrier = message('owner-turn-carrier', 2, 'process:notifications', [
      '[from process:notifications]', '', '[batched notices: 1]', 'batchId=owner-turn-carrier', 'release=example',
      '[5567] source=process:events sender=process:events cause=notice class=fyi',
      'A notice inside the owner turn', '', 'coalesced by notices',
    ].join('\n'), { isBatchCarrier: true, messageType: 'substrate', turnSeq: 77 });
    const live = build({ records: [carrier], bubbles: [bubble(firstPrompt, 'human'), bubble(firstReply, 'agent')],
      activeTurnRunning: false });
    const afterReload = build({ records: [carrier], bubbles: [bubble(firstPrompt, 'human'), bubble(firstReply, 'agent')],
      activeTurnRunning: false });

    expect(afterReload.messageItems).toEqual(live.messageItems);
    expect(afterReload.messageItems).toMatchObject([{ id: 'member:owner-turn-carrier:member:5567',
      runKey: 'run:first-prompt', kind: 'substrate' }]);
    expect(afterReload.messageItems[0].position).toEqual({ sequence: 2, phase: 1, order: 5567 });
  });

  it('drops later-gap activity after the owner turn ends without a later reply', () => {
    const prompt = message('prompt', 1, 'user:person');
    const reply = message('reply', 2, 'assistant-service', 'Answer', { role: 'assistant', turnSeq: 1 });
    const beforeTool = message('before-tool', 3, 'process:work', 'Before tool', { messageType: 'substrate', turnSeq: 1 });
    const plan = build({ records: [beforeTool], bubbles: [bubble(prompt, 'human'), bubble(reply, 'agent')],
      turnStateAvailable: false, activeTurnRunning: false });

    expect(plan.messageItems).toEqual([]);
  });

  it('excludes an unproven external assistant reply from live and reloaded pills', () => {
    const prompt = message('external-reply-prompt', 1, 'user:person', 'Question', { role: 'user', turnSeq: 1 });
    const externalReply = message('external-reply', 2, 'agent:external', 'Unproven external response', {
      role: 'assistant', messageType: 'assistant', turnSeq: 77,
    });
    const reply = message('external-reply-owner-answer', 3, 'assistant-service', 'Owner answer', {
      role: 'assistant', turnSeq: 1, replyToMessageId: prompt.id,
    });
    const bubbles = [bubble(prompt, 'human'), bubble(reply, 'agent')];
    const live = build({ records: [externalReply], bubbles, turnStateAvailable: true, activeTurnRunning: false });
    const afterReload = build({ records: [externalReply], bubbles, turnStateAvailable: true, activeTurnRunning: false });

    expect(live.messageItems).toEqual([]);
    expect(afterReload.messageItems).toEqual(live.messageItems);
  });

  it('uses the same owner-turn evidence for live, returned and reloaded history', () => {
    const prompt = message('prompt', 1, 'user:person', 'Question', { role: 'user', turnSeq: 1 });
    const reply = message('reply', 3, 'assistant-service', 'Answer', { role: 'assistant', turnSeq: 1 });
    const activity = message('activity', 2, 'agent:helper', 'Activity during the owner turn', {
      messageType: 'agent', turnSeq: 77,
    });
    const bubbles = [bubble(prompt, 'human'), bubble(reply, 'agent')];
    const live = build({ records: [activity], bubbles, turnStateAvailable: true, activeTurnRunning: false });
    const afterReturn = build({ records: [activity], bubbles, turnStateAvailable: true, activeTurnRunning: false });
    expect(afterReturn.messageItems).toEqual(live.messageItems);
    expect(afterReturn.messageItems).toMatchObject([{ id: 'message:activity', kind: 'agent' }]);

    const unmatched = message('unmatched', 4, 'process:events', 'Outside the owner turn', {
      messageType: 'substrate', turnSeq: 77,
    });
    const nextPrompt = message('next-prompt', 5, 'user:person', 'Next question', { role: 'user', turnSeq: 2 });
    const outsideBubbles = [...bubbles, bubble(nextPrompt, 'human')];
    const liveOlderPage = build({ records: [unmatched], bubbles: outsideBubbles, turnStateAvailable: true,
      activeTurnRunning: false });
    const reloadedOlderPage = build({ records: [unmatched], bubbles: outsideBubbles, turnStateAvailable: true,
      activeTurnRunning: false });
    expect(liveOlderPage.messageItems).toEqual([]);
    expect(reloadedOlderPage.messageItems).toEqual(liveOlderPage.messageItems);
  });

  it('shows activity after an interim reply during a running owner turn and applies the no-later-reply limit consistently', () => {
    const prompt = message('prompt', 1, 'user:person', 'Question', { role: 'user', turnSeq: 1 });
    const interimReply = message('interim-reply', 2, 'assistant-service', 'First part of the answer', {
      role: 'assistant', turnSeq: 1, replyToMessageId: prompt.id,
    });
    const activity = message('after-interim', 3, 'process:work', 'A notice during the running owner turn', {
      messageType: 'substrate', turnSeq: 1,
    });
    const bubbles = [bubble(prompt, 'human'), bubble(interimReply, 'agent')];
    const liveWhileRunning = build({ records: [activity], bubbles, turnStateAvailable: true,
      activeTurnRunning: true, activeOwnerTurnRunning: true });
    const reloadedWhileRunning = build({ records: [activity], bubbles, turnStateAvailable: true,
      activeTurnRunning: true, activeOwnerTurnRunning: true });

    expect(liveWhileRunning.messageItems).toEqual(reloadedWhileRunning.messageItems);
    expect(reloadedWhileRunning.messageItems).toMatchObject([{ id: 'message:after-interim', kind: 'substrate' }]);

    // A matching turnSeq is not an ordered turn-end row; without a later reply,
    // this activity stops appearing once the owner turn has completed.
    const liveAfterTurnEnds = build({ records: [activity], bubbles, turnStateAvailable: true,
      activeTurnRunning: false, activeOwnerTurnRunning: false });
    const reloadedAfterTurnEnds = build({ records: [activity], bubbles, turnStateAvailable: true,
      activeTurnRunning: false, activeOwnerTurnRunning: false });
    expect(liveAfterTurnEnds.messageItems).toEqual(reloadedAfterTurnEnds.messageItems);
    expect(reloadedAfterTurnEnds.messageItems).toEqual([]);

    const finalReply = message('final-reply', 4, 'assistant-service', 'The answer is complete', {
      role: 'assistant', turnSeq: 1, replyToMessageId: prompt.id,
    });
    const closedByReply = build({ records: [activity], bubbles: [...bubbles, bubble(finalReply, 'agent')],
      turnStateAvailable: true, activeTurnRunning: false, activeOwnerTurnRunning: false });
    expect(closedByReply.messageItems).toMatchObject([{ id: 'message:after-interim', kind: 'substrate' }]);
  });

  it('does not admit unrelated activity just because another turn is running', () => {
    const prompt = message('prompt', 1, 'user:person', 'Question', { role: 'user', turnSeq: 1 });
    const unrelated = [
      message('other-agent-wake', 2, 'agent:helper', '[woke: fallback deadline]\nUnrelated wake', {
        messageType: 'agent', turnSeq: 77,
      }),
      message('direct-process-notice', 3, 'process:events', 'Process notice outside the owner turn', {
        messageType: 'substrate', turnSeq: 77,
      }),
      message('non-owner-marker', 4, 'process:notifications', 'Marker outside the owner turn', {
        messageType: 'substrate', turnSeq: 77,
      }),
    ];
    const bubbles = [bubble(prompt, 'human')];

    const whileOtherTurnRuns = build({ records: unrelated, bubbles, turnStateAvailable: true,
      activeTurnRunning: true, activeOwnerTurnRunning: false });
    const afterReturn = build({ records: unrelated, bubbles, turnStateAvailable: true,
      activeTurnRunning: false, activeOwnerTurnRunning: false });

    expect(whileOtherTurnRuns.messageItems).toEqual([]);
    expect(afterReturn.messageItems).toEqual(whileOtherTurnRuns.messageItems);
  });

  it('keeps rail denials scoped to the selected session and live tail eligibility', () => {
    const prompt = message('prompt', 1, 'user:person');
    const denial: LiveRailDenial = { id: 'denial', principal: 'session:session', verb: 'attest',
      rule: 'sample-rule', tailEligibleAtArrival: true, afterMessageSeq: 1, arrivalOrder: 1 };
    const other: LiveRailDenial = { ...denial, id: 'other', principal: 'session:other' };
    const plan = build({ bubbles: [bubble(prompt, 'human')], railDenials: [denial, other] });
    expect(plan.messageItems).toHaveLength(1);
    expect((plan.messageItems[0] as ActivityLine).accessibleText).toBe('Rail: attest refused by sample-rule');

    const ended = build({ bubbles: [bubble(prompt, 'human')],
      railDenials: [{ ...denial, tailEligibleAtArrival: false }], activeTurnRunning: false });
    expect(ended.messageItems).toHaveLength(0);
    const noTurnState = build({ bubbles: [bubble(prompt, 'human')], railDenials: [denial], turnStateAvailable: false,
      activeTurnRunning: false });
    expect(noTurnState.messageItems).toHaveLength(1);
  });

  it('excludes a session-addressed agent message without owner-turn evidence both live and after reload', () => {
    const prompt = message('prompt', 1, 'user:person');
    const activity = message('session-message', 2, 'session:helper', 'Helper is working');
    const live = build({ records: [activity], bubbles: [bubble(prompt, 'human')], turnStateAvailable: false,
      activeTurnRunning: false });
    const afterReload = build({ records: [activity], bubbles: [bubble(prompt, 'human')], turnStateAvailable: false,
      activeTurnRunning: false });
    expect(live.messageItems).toEqual([]);
    expect(afterReload.messageItems).toEqual(live.messageItems);
  });
});
