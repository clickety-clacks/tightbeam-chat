import { describe, expect, it } from 'vitest';
import { buildActivityTrail, type ActivityBubble, type ActivityFold, type ActivityLine, type MessageActivityItem } from '../src/activityTrail';
import type { CanonicalMessage, CanonicalTransition, LiveRailDenial, ToolCallRecord } from '../src/types';

const message = (id: string, seq: number, sender: string, content = id,
  extra: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  kind: 'message', id, sessionKey: 'session', seq, rowVersion: 1, role: 'user', sender, content,
  raw: {}, ...extra,
});

const bubble = (record: CanonicalMessage, side: ActivityBubble['side']): ActivityBubble => ({
  key: record.id, record, side,
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
  liveActivityIds?: ReadonlySet<string>;
  liveActivityEligibleIds?: ReadonlySet<string>;
  railDenials?: readonly LiveRailDenial[];
  shownRuns?: ReadonlyMap<string, string>;
  expandedRuns?: ReadonlySet<string>;
}) {
  return buildActivityTrail({
    sessionKey: 'session', records: input.records ?? [], bubbles: input.bubbles ?? [], transitions: input.transitions ?? [],
    localSendTimes: input.localSendTimes,
    tools: input.tools ?? [], toolsEnabled: input.toolsEnabled ?? true,
    turnStateAvailable: input.turnStateAvailable ?? true, activeTurnRunning: input.activeTurnRunning ?? true,
    liveActivityIds: input.liveActivityIds ?? new Set(), railDenials: input.railDenials ?? [],
    liveActivityEligibleIds: input.liveActivityEligibleIds ?? new Set(),
    shownRuns: input.shownRuns ?? new Map(), expandedRuns: input.expandedRuns ?? new Set(),
  });
}

const combined = (items: readonly MessageActivityItem[], tools: ReadonlyMap<string, MessageActivityItem>) =>
  [...new Map([...items, ...tools.values()].map(item => [item.id, item])).values()].sort((left, right) => left.position.sequence - right.position.sequence ||
    left.position.phase - right.position.phase || left.position.order - right.position.order);

describe('activity trail projection', () => {
  it('folds consecutive substrate reminders and agent messages to the newest line, with bubbles ending each run', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const reminder1 = message('reminder-1', 2, 'process:events', '', { messageType: 'substrate' });
    const reminder2 = message('reminder-2', 3, 'process:events', '  \n ', { messageType: 'substrate' });
    const wake1 = message('wake-1', 4, 'agent:helper', 'Helper woke', { messageType: 'agent' });
    const wake2 = message('wake-2', 5, 'agent:helper', 'Helper is working', { messageType: 'agent' });
    const reply = message('reply', 6, 'assistant-service', 'Answer', { role: 'assistant' });
    const laterReminder1 = message('later-reminder-1', 7, 'process:events', '', { messageType: 'substrate' });
    const laterReminder2 = message('later-reminder-2', 8, 'process:events', '', { messageType: 'substrate' });
    const plan = build({ records: [reminder1, reminder2, wake1, wake2, laterReminder1, laterReminder2],
      bubbles: [bubble(prompt, 'human'), bubble(reply, 'agent')] });

    const folds = plan.messageItems.filter((item): item is ActivityFold => item.kind === 'fold');
    expect(folds).toHaveLength(3);
    expect(folds.map(fold => fold.lines.map(line => line.id))).toEqual([
      ['message:reminder-1', 'message:reminder-2'],
      ['message:wake-1', 'message:wake-2'],
      ['message:later-reminder-1', 'message:later-reminder-2'],
    ]);
    expect(folds.map(fold => fold.summary.gist)).toEqual([
      'Substrate activity', 'Another agent — Helper is working', 'Substrate activity',
    ]);
    expect(folds[0].runKey).not.toBe(folds[2].runKey);
  });

  it('leaves same-kind activity lines separate when a transition falls between them', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const before = message('before-transition', 2, 'process:events', 'Before reset', { messageType: 'substrate' });
    const after = message('after-transition', 4, 'process:events', 'After reset', { messageType: 'substrate' });
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
    const before = message('before-send', 2, 'process:events', 'Before local message', {
      messageType: 'substrate', createdAt: new Date(1_000).toISOString(),
    });
    const after = message('after-send', 3, 'process:events', 'After local message', {
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
      'process:events', `Reminder ${index + 1}`, { messageType: 'substrate' }));
    const bubbles = [bubble(prompt, 'human'), bubble(reply, 'agent')];
    const first = build({ records: reminders, bubbles });
    const firstFold = first.messageItems.find((item): item is ActivityFold => item.kind === 'fold')!;
    expect(firstFold.id).toBe('message:reminder-1');
    expect(firstFold.lines).toHaveLength(6);
    expect(firstFold.summary.gist).toBe('Reminder 6');
    expect(first.messageItems.some(item => item.kind === 'overflow')).toBe(false);

    const later = message('reminder-7', 9, 'process:events', 'Reminder 7', { messageType: 'substrate' });
    const next = build({ records: [...reminders, later], bubbles, shownRuns: first.membership });
    const nextFold = next.messageItems.find((item): item is ActivityFold => item.kind === 'fold')!;
    expect(nextFold.id).toBe(firstFold.id);
    expect(nextFold.summary.gist).toBe('Reminder 7');
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

  it('caps displayed groups per gap and keeps an expanded run expanded when a later entry arrives', () => {
    const prompt = message('prompt', 1, 'user:person');
    const firstReply = message('reply-one', 4, 'assistant-service', 'First answer', { role: 'assistant' });
    const secondReply = message('reply-two', 14, 'assistant-service', 'Second answer', { role: 'assistant' });
    const initial = Array.from({ length: 10 }, (_, index) => message(`activity-${index + 1}`, index + 2,
      'process:work', `Activity ${index + 1}`, { messageType: 'substrate' }));
    const bubbles = [bubble(prompt, 'human'), bubble(firstReply, 'agent'), bubble(secondReply, 'agent')];
    const firstPlan = build({ records: initial, bubbles });
    const firstRun = 'run:prompt';
    const secondRun = 'run:reply-one';
    const runItems = (runKey: string) => firstPlan.messageItems.filter(item => item.runKey === runKey);
    expect(runItems(firstRun).map(item => item.kind)).toEqual(['fold']);
    expect((runItems(firstRun)[0] as ActivityFold).lines).toHaveLength(2);
    expect(runItems(secondRun).filter(item => item.kind === 'overflow')).toHaveLength(0);
    const secondFold = runItems(secondRun).find((item): item is ActivityFold => item.kind === 'fold')!;
    expect(secondFold.lines.map(item => item.gist)).toEqual([
      'Activity 3', 'Activity 4', 'Activity 5', 'Activity 6', 'Activity 7', 'Activity 8', 'Activity 9', 'Activity 10',
    ]);

    const expanded = build({ records: initial, bubbles, shownRuns: firstPlan.membership,
      expandedRuns: new Set([secondRun]) });
    expect(expanded.messageItems.filter(item => item.runKey === firstRun)).toHaveLength(1);
    expect((expanded.messageItems.find(item => item.runKey === firstRun) as ActivityFold).lines).toHaveLength(2);
    expect((expanded.messageItems.find(item => item.runKey === secondRun) as ActivityFold).lines).toHaveLength(8);
    expect(expanded.messageItems.some(item => item.kind === 'overflow' && item.runKey === secondRun)).toBe(false);

    const later = [...initial, message('activity-11', 12, 'process:work', 'Activity 11', { messageType: 'substrate' })];
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

  it('rebuilds every tail gap with tools and earlier-in-gap activity across reload', () => {
    const firstPrompt = message('first-prompt', 1, 'user:person');
    const firstReply = message('first-reply', 3, 'assistant-service', 'First answer', { role: 'assistant' });
    const nextPrompt = message('next-prompt', 8, 'user:person', 'Another question');
    const beforeTool = message('before-tool', 4, 'process:work', 'Prepared tool work', { messageType: 'substrate' });
    const afterTool = message('after-tool', 6, 'agent:helper', 'Later notice', { messageType: 'agent' });
    const call = { ...tool('middle-tool', 5, 'completed'), afterMessageSeq: 5 };
    const plan = build({ records: [beforeTool, afterTool], bubbles: [bubble(firstPrompt, 'human'),
      bubble(firstReply, 'agent'), bubble(nextPrompt, 'human')], tools: [call], activeTurnRunning: false,
      liveActivityIds: new Set(), liveActivityEligibleIds: new Set() });

    expect(plan.messageItems).toMatchObject([{ id: 'message:before-tool', runKey: 'run:first-reply' }]);
    expect(plan.messageItems.some(item => item.id === 'message:after-tool')).toBe(false);
    expect(plan.toolItems.get(call.id)).toMatchObject({ id: `tool:${call.id}`, runKey: 'run:first-reply' });
  });

  it('keeps reconstructed activity before a tool in the newest tail without turn state', () => {
    const prompt = message('prompt', 1, 'user:person');
    const beforeTool = message('before-tool', 2, 'process:work', 'Before tool', { messageType: 'substrate' });
    const afterTool = message('after-tool', 4, 'agent:helper', 'After tool', { messageType: 'agent' });
    const call = { ...tool('tool', 3, 'completed'), afterMessageSeq: 3 };
    const plan = build({ records: [beforeTool, afterTool], bubbles: [bubble(prompt, 'human')], tools: [call],
      turnStateAvailable: false, activeTurnRunning: false, liveActivityIds: new Set(), liveActivityEligibleIds: new Set() });

    expect(plan.messageItems.map(item => item.id)).toEqual(['message:before-tool']);
    expect(plan.toolItems.has(call.id)).toBe(true);
  });

  it('uses the live entry eligibility captured at arrival, not the later turn state', () => {
    const prompt = message('prompt', 1, 'user:person');
    const idleMessage = message('idle-message', 2, 'agent:helper', 'Arrived after the reply', { messageType: 'agent' });
    const liveActivityIds = new Set([idleMessage.id]);
    const idleArrival = build({ records: [idleMessage], bubbles: [bubble(prompt, 'human')],
      turnStateAvailable: true, activeTurnRunning: false, liveActivityIds, liveActivityEligibleIds: new Set() });
    expect(idleArrival.messageItems).toHaveLength(0);

    const turnStartedLater = build({ records: [idleMessage], bubbles: [bubble(prompt, 'human')],
      turnStateAvailable: true, activeTurnRunning: true, liveActivityIds, liveActivityEligibleIds: new Set() });
    expect(turnStartedLater.messageItems).toHaveLength(0);

    const laterTool = { ...tool('later-tool', 3, 'completed'), afterMessageSeq: 3 };
    const turnStartedWithTool = build({ records: [idleMessage], bubbles: [bubble(prompt, 'human')],
      tools: [laterTool], turnStateAvailable: true, activeTurnRunning: true, liveActivityIds,
      liveActivityEligibleIds: new Set() });
    expect(turnStartedWithTool.messageItems).toHaveLength(0);
    expect(turnStartedWithTool.toolItems.has(laterTool.id)).toBe(true);

    const arrivedDuringTurn = build({ records: [idleMessage], bubbles: [bubble(prompt, 'human')],
      turnStateAvailable: true, activeTurnRunning: false, liveActivityIds,
      liveActivityEligibleIds: new Set([idleMessage.id]) });
    expect(arrivedDuringTurn.messageItems).toMatchObject([{ id: 'message:idle-message', kind: 'agent' }]);
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

  it('shows a live session-addressed agent message when turn records are unavailable', () => {
    const prompt = message('prompt', 1, 'user:person');
    const activity = message('session-message', 2, 'session:helper', 'Helper is working');
    const plan = build({ records: [activity], bubbles: [bubble(prompt, 'human')], turnStateAvailable: false,
      activeTurnRunning: false, liveActivityIds: new Set([activity.id]) });
    expect(plan.messageItems).toMatchObject([{ kind: 'agent', gist: 'Another agent — Helper is working' }]);
  });
});
