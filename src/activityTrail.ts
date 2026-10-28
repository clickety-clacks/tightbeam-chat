import type { CanonicalMessage, LiveRailDenial, ToolCallRecord } from './types';
import { parseBatchMembers, type HumanMember } from './messageVisibility';

export type ActivityKind = 'tool' | 'agent' | 'substrate' | 'rail';

export interface ActivityBubble {
  readonly key: string;
  readonly record: CanonicalMessage;
  readonly side: 'human' | 'agent';
  readonly member?: HumanMember;
}

interface Position {
  readonly sequence: number;
  readonly phase: number;
  readonly order: number;
}

export interface ActivityLine {
  readonly kind: ActivityKind;
  readonly id: string;
  readonly runKey: string;
  readonly anchorSeq: number;
  readonly position: Position;
  readonly gist: string;
  readonly accessibleText: string;
  readonly sortTime?: number;
  readonly call?: ToolCallRecord;
}

export interface ActivityOverflow {
  readonly kind: 'overflow';
  readonly id: string;
  readonly runKey: string;
  readonly anchorSeq: number;
  readonly position: Position;
  readonly sortTime?: number;
}

export type MessageActivityItem = ActivityLine | ActivityOverflow;
export type ToolActivityItem = ActivityLine | ActivityOverflow;

export interface ActivityTrailPlan {
  readonly messageItems: readonly MessageActivityItem[];
  readonly toolItems: ReadonlyMap<string, ToolActivityItem>;
  /** Candidates that have appeared, including lines currently behind an ellipsis. */
  readonly membership: ReadonlyMap<string, string>;
}

interface Candidate extends ActivityLine {
  readonly live: boolean;
  readonly liveTailEligibleAtArrival: boolean;
}

interface BubbleEvent extends Position {
  readonly kind: 'bubble';
  readonly bubble: ActivityBubble;
  readonly spanKey?: string;
}

interface CandidateEvent extends Position {
  readonly kind: 'candidate';
  readonly candidate: Candidate;
}

type TrailEvent = BubbleEvent | CandidateEvent;

const bodyGist = (body: string): string => body.split(/\r?\n/)
  .map((line) => line.replace(/\s+/g, ' ').trim())
  .find(Boolean) ?? '';

const rawDisplayName = (message: CanonicalMessage): string | undefined => {
  const value = message.raw.senderDisplayName;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

function messageCandidate(message: CanonicalMessage, live: boolean, liveTailEligibleAtArrival: boolean): Candidate | undefined {
  const sender = message.sender ?? '';
  if (message.isBatchCarrier || /^\[batched notices:/i.test(message.content)) return undefined;
  const id = `message:${message.id}`;
  const parsedTime = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
  const sortTime = Number.isFinite(parsedTime) ? parsedTime : undefined;
  if (sender.startsWith('remedy:')) {
    const statute = sender.slice('remedy:'.length).trim();
    const lines = message.content.split(/\r?\n/);
    while (lines.length && (!lines[0].trim() || /^\s*\[from [^\]]+\]\s*$/i.test(lines[0]))) lines.shift();
    const detail = bodyGist(lines.join('\n'));
    const gist = `Remedy ${statute || 'sent'} sent${detail ? ` — ${detail}` : ''}`;
    return { id, kind: 'rail', runKey: '', anchorSeq: message.seq,
      position: { sequence: message.seq, phase: 1, order: 0 }, gist,
      accessibleText: `Rail: ${gist}`, sortTime, live, liveTailEligibleAtArrival };
  }
  if (message.messageType === 'substrate' || message.messageType === 'process' || sender.startsWith('process:')) {
    const gist = bodyGist(message.content) || 'Substrate activity';
    return { id, kind: 'substrate', runKey: '', anchorSeq: message.seq,
      position: { sequence: message.seq, phase: 1, order: 0 }, gist,
      accessibleText: `Substrate: ${gist}`, sortTime, live, liveTailEligibleAtArrival };
  }
  if (message.messageType === 'agent' || sender.startsWith('agent:') || sender.startsWith('session:')) {
    const name = rawDisplayName(message) ?? 'Another agent';
    const detail = bodyGist(message.content);
    const gist = detail ? `${name} — ${detail}` : name;
    return { id, kind: 'agent', runKey: '', anchorSeq: message.seq,
      position: { sequence: message.seq, phase: 1, order: 0 }, gist,
      accessibleText: `Other agent: ${gist}`, sortTime, live, liveTailEligibleAtArrival };
  }
  return undefined;
}

function memberCandidate(carrier: CanonicalMessage, member: HumanMember, live: boolean,
  liveTailEligibleAtArrival: boolean): Candidate | undefined {
  if (member.sender.startsWith('user:')) return undefined;
  const id = `member:${member.sourceId}`;
  const position = { sequence: carrier.seq, phase: 1, order: member.index };
  const parsedTime = carrier.createdAt ? Date.parse(carrier.createdAt) : Number.NaN;
  const sortTime = Number.isFinite(parsedTime) ? parsedTime : undefined;
  const detail = bodyGist(member.content);
  if (member.sender.startsWith('remedy:')) {
    const statute = member.sender.slice('remedy:'.length).trim();
    const gist = `Remedy ${statute || 'sent'} sent${detail ? ` — ${detail}` : ''}`;
    return { id, kind: 'rail', runKey: '', anchorSeq: carrier.seq, position, gist,
      accessibleText: `Rail: ${gist}`, sortTime, live, liveTailEligibleAtArrival };
  }
  if (member.sender.startsWith('process:')) {
    const gist = detail || 'Substrate activity';
    return { id, kind: 'substrate', runKey: '', anchorSeq: carrier.seq, position, gist,
      accessibleText: `Substrate: ${gist}`, sortTime, live, liveTailEligibleAtArrival };
  }
  if (member.sender.startsWith('agent:') || member.sender.startsWith('session:')) {
    const gist = detail ? `Another agent — ${detail}` : 'Another agent';
    return { id, kind: 'agent', runKey: '', anchorSeq: carrier.seq, position, gist,
      accessibleText: `Other agent: ${gist}`, sortTime, live, liveTailEligibleAtArrival };
  }
  return undefined;
}

function toolCandidate(call: ToolCallRecord): Candidate {
  return { id: `tool:${call.id}`, kind: 'tool', runKey: '', anchorSeq: call.afterMessageSeq,
    position: { sequence: call.afterMessageSeq, phase: 2, order: call.seq }, gist: '', accessibleText: '',
    sortTime: call.startedAt, call, live: false, liveTailEligibleAtArrival: false };
}

function railCandidate(denial: LiveRailDenial): Candidate {
  const gist = `${denial.verb} refused by ${denial.rule}`;
  return { id: `rail:${denial.id}`, kind: 'rail', runKey: '',
    anchorSeq: denial.afterMessageSeq,
    position: { sequence: denial.afterMessageSeq, phase: 3, order: denial.arrivalOrder },
    gist, accessibleText: `Rail: ${gist}`, sortTime: denial.occurredAt, live: true,
    liveTailEligibleAtArrival: denial.tailEligibleAtArrival };
}

const comparePosition = (left: Position, right: Position): number =>
  left.sequence - right.sequence || left.phase - right.phase || left.order - right.order;

function bubbleEvents(bubbles: readonly ActivityBubble[]): BubbleEvent[] {
  const ordered = [...bubbles].sort((left, right) => left.record.seq - right.record.seq ||
    (left.record.id === right.record.id ? (left.member?.index ?? 0) - (right.member?.index ?? 0) : 0) ||
    left.key.localeCompare(right.key));
  const events: BubbleEvent[] = [];
  let spanKey: string | undefined;
  let hasReply = false;
  for (let order = 0; order < ordered.length; order++) {
    const bubble = ordered[order];
    if (bubble.side === 'human') {
      if (!spanKey || hasReply) spanKey = `prompt:${bubble.key}`;
      hasReply = false;
    } else if (spanKey) {
      hasReply = true;
    }
    events.push({ kind: 'bubble', bubble, spanKey,
      sequence: bubble.record.seq, phase: 0, order });
  }
  return events;
}

function lineWithRun(candidate: Candidate, runKey: string): ActivityLine {
  const { live: _live, liveTailEligibleAtArrival: _eligibleAtArrival, ...line } = candidate;
  if (candidate.kind === 'tool' && candidate.call) {
    const call = candidate.call;
    const title = call.title.trim() || call.toolName?.trim() || call.kind;
    const status = call.status === 'pending' || call.status === 'in_progress' ? 'running'
      : call.status === 'completed' ? 'done' : 'failed';
    const gist = `${title} · ${status}`;
    return { ...line, runKey, gist, accessibleText: `Tool call: ${gist}` };
  }
  return { ...line, runKey };
}

/**
 * Builds the display-only activity projection from records already held by Chat.
 * It never changes message visibility or asks the transport for another read.
 */
export function buildActivityTrail(input: {
  readonly sessionKey: string;
  readonly records: readonly { readonly kind: 'message'; readonly id: string; readonly seq: number;
    readonly sender?: string; readonly messageType?: string; readonly role: string; readonly content: string;
    readonly isBatchCarrier?: boolean; readonly raw: Readonly<Record<string, unknown>> }[];
  readonly bubbles: readonly ActivityBubble[];
  readonly tools: readonly ToolCallRecord[];
  readonly toolsEnabled: boolean;
  readonly turnStateAvailable: boolean;
  readonly activeTurnRunning: boolean;
  readonly liveActivityIds: ReadonlySet<string>;
  readonly liveActivityEligibleIds: ReadonlySet<string>;
  readonly railDenials: readonly LiveRailDenial[];
  readonly shownRuns: ReadonlyMap<string, string>;
  readonly expandedRuns: ReadonlySet<string>;
}): ActivityTrailPlan {
  const visibleIds = new Set(input.bubbles.filter((bubble) => !bubble.member).map((bubble) => bubble.record.id));
  const candidates: Candidate[] = [];
  for (const message of input.records) {
    if (visibleIds.has(message.id)) continue;
    const batchMembers = parseBatchMembers(message as CanonicalMessage);
    if (batchMembers) {
      for (const member of batchMembers) {
        const candidate = memberCandidate(message as CanonicalMessage, member, input.liveActivityIds.has(message.id),
          input.liveActivityEligibleIds.has(message.id));
        if (candidate) candidates.push(candidate);
      }
      continue;
    }
    const candidate = messageCandidate(message as CanonicalMessage, input.liveActivityIds.has(message.id),
      input.liveActivityEligibleIds.has(message.id));
    if (candidate) candidates.push(candidate);
    else if (message.role === 'assistant') continue;
  }
  for (const denial of input.railDenials) {
    if (denial.principal === `session:${input.sessionKey}`) candidates.push(railCandidate(denial));
  }
  if (input.toolsEnabled) candidates.push(...input.tools.map(toolCandidate));

  const events: TrailEvent[] = [
    ...bubbleEvents(input.bubbles),
    ...candidates.map((candidate): CandidateEvent => ({
      kind: 'candidate', candidate, ...candidate.position,
    })),
  ].sort(comparePosition);

  const eligible = new Map<string, { candidate: Candidate; runKey: string }[]>();
  const membership = new Map<string, string>();
  const add = (candidate: Candidate, runKey: string) => {
    const priorRun = input.shownRuns.get(candidate.id);
    const chosenRun = priorRun ?? runKey;
    const rows = eligible.get(chosenRun) ?? [];
    rows.push({ candidate, runKey: chosenRun });
    eligible.set(chosenRun, rows);
    membership.set(candidate.id, chosenRun);
  };

  let previousBubble: BubbleEvent | undefined;
  let pending: CandidateEvent[] = [];
  const closeGap = (nextBubble?: BubbleEvent) => {
    if (!previousBubble?.spanKey) { pending = []; return; }
    const runKey = `run:${previousBubble.bubble.key}`;
    const closedByReply = !!nextBubble && nextBubble.bubble.side === 'agent' &&
      nextBubble.spanKey === previousBubble.spanKey;
    const tail = pending.map((event) => event.candidate);
    const beforeOrAtTool = new Set<string>();
    let foundTool = false;
    for (let index = tail.length - 1; index >= 0; index--) {
      const candidate = tail[index];
      if (candidate.kind === 'tool') foundTool = true;
      if (foundTool) beforeOrAtTool.add(candidate.id);
    }
    if (closedByReply) {
      for (const event of pending) add(event.candidate, runKey);
    } else if (!nextBubble) {
      for (const candidate of tail) {
        let allowed = beforeOrAtTool.has(candidate.id);
        if (input.turnStateAvailable) {
          allowed ||= candidate.live
            ? candidate.liveTailEligibleAtArrival
            : input.activeTurnRunning;
        } else {
          allowed ||= candidate.live;
        }
        if (allowed || input.shownRuns.has(candidate.id)) add(candidate, runKey);
      }
    } else {
      for (const candidate of tail) {
        const oldRun = input.shownRuns.get(candidate.id);
        if (beforeOrAtTool.has(candidate.id) || candidate.liveTailEligibleAtArrival || oldRun) {
          add(candidate, oldRun ?? runKey);
        }
      }
    }
    pending = [];
  };

  for (const event of events) {
    if (event.kind === 'candidate') pending.push(event);
    else {
      closeGap(event);
      previousBubble = event;
    }
  }
  closeGap();

  const messageItems: MessageActivityItem[] = [];
  const toolItems = new Map<string, ToolActivityItem>();
  for (const [runKey, rows] of eligible) {
    rows.sort((left, right) => comparePosition(left.candidate.position, right.candidate.position));
    const expanded = input.expandedRuns.has(runKey);
    const hiddenCount = expanded ? 0 : Math.max(0, rows.length - 5);
    const visibleRows = hiddenCount ? rows.slice(hiddenCount) : rows;
    for (const { candidate } of visibleRows) {
      const line = lineWithRun(candidate, runKey);
      if (candidate.kind === 'tool') toolItems.set(candidate.call!.id, line);
      else messageItems.push(line);
    }
    if (hiddenCount) {
      const hidden = rows[0].candidate;
      const overflow: ActivityOverflow = { kind: 'overflow', id: `overflow:${runKey}`,
        runKey, anchorSeq: hidden.anchorSeq, position: hidden.position, sortTime: hidden.sortTime };
      if (hidden.kind === 'tool') toolItems.set(hidden.call!.id, overflow);
      else messageItems.push(overflow);
    }
  }
  messageItems.sort((left, right) => left.anchorSeq - right.anchorSeq ||
    comparePosition(left.position, right.position) || left.id.localeCompare(right.id));
  return { messageItems, toolItems, membership };
}
