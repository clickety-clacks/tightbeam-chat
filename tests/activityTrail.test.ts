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

  it('projects agent members from a canonical carrier with a different first-line heading', () => {
    const prompt = message('prompt', 1, 'user:person', 'A question', { role: 'user' });
    const carrier = message('carrier', 2, 'process:notifications', [
      'Canonical notification envelope',
      '[1] source=agent:helper sender=agent:helper cause=notice class=fyi', 'First helper update', '',
      '[2] source=agent:helper sender=agent:helper cause=notice class=fyi', 'Latest helper update', '',
      'coalesced by notices',
    ].join('\n'), { isBatchCarrier: true, messageType: 'substrate' });
    const reply = message('reply', 3, 'assistant-service', 'Answer', { role: 'assistant' });

    const plan = build({ records: [carrier], bubbles: [bubble(prompt, 'human'), bubble(reply, 'agent')] });

    expect(plan.messageItems).toHaveLength(1);
    const fold = plan.messageItems[0] as ActivityFold;
    expect(fold).toMatchObject({ kind: 'fold', activityKind: 'agent', summary: {
      kind: 'agent', gist: 'Another agent — Latest helper update',
    } });
    expect(fold.lines.map(line => line.gist)).toEqual([
      'Another agent — First helper update', 'Another agent — Latest helper update',
    ]);
    expect(fold.lines.every(line => line.presentation !== undefined)).toBe(true);
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
