import { describe, expect, it } from 'vitest';
import { buildActivityTrail, type ActivityBubble, type ActivityLine, type MessageActivityItem } from '../src/activityTrail';
import type { CanonicalMessage, LiveRailDenial, ToolCallRecord } from '../src/types';

const message = (id: string, seq: number, sender: string, content = id,
  extra: Partial<CanonicalMessage> = {}): CanonicalMessage => ({
  kind: 'message', id, sessionKey: 'session', seq, rowVersion: 1, role: 'user', sender, content,
  raw: {}, ...extra,
});

const bubble = (record: CanonicalMessage, side: ActivityBubble['side']): ActivityBubble => ({
  key: record.id, record, side,
});

const tool = (id: string, seq: number, status: ToolCallRecord['status']): ToolCallRecord => ({
  id, seq, sessionKey: 'session', turnSeq: 1, afterMessageSeq: 1, harnessToolCallId: id,
  title: `Tool ${id}`, kind: 'read', toolName: 'read_file', status, rawInput: null,
  rawOutput: null, content: null, truncated: [], startedAt: seq, endedAt: status === 'completed' || status === 'failed' ? seq + 1 : null,
  rowVersion: 1,
});

function build(input: {
  records?: readonly CanonicalMessage[];
  bubbles?: readonly ActivityBubble[];
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
    sessionKey: 'session', records: input.records ?? [], bubbles: input.bubbles ?? [],
    tools: input.tools ?? [], toolsEnabled: input.toolsEnabled ?? true,
    turnStateAvailable: input.turnStateAvailable ?? true, activeTurnRunning: input.activeTurnRunning ?? true,
    liveActivityIds: input.liveActivityIds ?? new Set(), railDenials: input.railDenials ?? [],
    liveActivityEligibleIds: input.liveActivityEligibleIds ?? new Set(),
    shownRuns: input.shownRuns ?? new Map(), expandedRuns: input.expandedRuns ?? new Set(),
  });
}

const combined = (items: readonly MessageActivityItem[], tools: ReadonlyMap<string, MessageActivityItem>) =>
  [...items, ...tools.values()].sort((left, right) => left.position.sequence - right.position.sequence ||
    left.position.phase - right.position.phase || left.position.order - right.position.order);

describe('activity trail projection', () => {
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
    expect(ordered.map(item => item.kind)).toEqual(['tool', 'tool', 'tool', 'substrate', 'agent']);
    const lines = ordered.filter((item): item is ActivityLine => item.kind !== 'overflow');
    expect(lines.slice(0, 3).map(item => item.gist)).toEqual([
      'Tool done · done', 'Tool failed · failed', 'Tool running · running',
    ]);
    expect(lines[3].accessibleText).toBe('Substrate: Assigned a task');
    expect(lines[4].accessibleText).toBe('Other agent: Another agent — Started a helper task');

    const hiddenReply = message('hidden-reply', 2, 'assistant-service', 'Must not become activity', {
      role: 'assistant', messageType: 'assistant', turnIncludesHuman: false,
    });
    expect(build({ records: [hiddenReply], bubbles: [bubble(prompt, 'human')] }).messageItems).toEqual([]);
  });

  it('caps each gap independently and keeps an expanded run expanded when a later entry arrives', () => {
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
    expect(runItems(firstRun).map(item => item.kind)).toEqual(['substrate', 'substrate']);
    expect(runItems(secondRun).filter(item => item.kind === 'overflow')).toHaveLength(1);
    expect(runItems(secondRun).filter(item => item.kind === 'substrate')).toHaveLength(5);
    expect(runItems(secondRun).filter((item): item is ActivityLine => item.kind === 'substrate').map(item => item.gist))
      .toEqual(['Activity 6', 'Activity 7', 'Activity 8', 'Activity 9', 'Activity 10']);

    const expanded = build({ records: initial, bubbles, shownRuns: firstPlan.membership,
      expandedRuns: new Set([secondRun]) });
    expect(expanded.messageItems.filter(item => item.runKey === firstRun)).toHaveLength(2);
    expect(expanded.messageItems.filter(item => item.runKey === secondRun)).toHaveLength(8);
    expect(expanded.messageItems.some(item => item.kind === 'overflow' && item.runKey === secondRun)).toBe(false);

    const later = [...initial, message('activity-11', 12, 'process:work', 'Activity 11', { messageType: 'substrate' })];
    const withLater = build({ records: later, bubbles, shownRuns: expanded.membership,
      expandedRuns: new Set([secondRun]) });
    expect(withLater.messageItems.filter(item => item.runKey === secondRun)).toHaveLength(9);
    expect(withLater.messageItems.some(item => item.kind === 'overflow' && item.runKey === secondRun)).toBe(false);
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
