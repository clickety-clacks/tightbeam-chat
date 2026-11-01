import type { CanonicalMessage, CanonicalTransition, HistoryRailDenial, LiveRailDenial, ToolCallRecord } from './types';
import { parseBatchMembers, type HumanMember, type ParsedBatchMember } from './messageVisibility';
import { activityPillPresentation, type ActivityPillPresentation } from './activityPresentation';
import { stripProvenanceMarkup } from './displayText';
import { sameRailDenial } from './railDenials';

export type ActivityKind = 'tool' | 'agent' | 'substrate' | 'rail';

export interface ActivityBubble {
  readonly key: string;
  readonly record: CanonicalMessage;
  readonly side: 'human' | 'agent';
  /** Whether message visibility already placed this bubble in the owner's conversation. */
  readonly ownerScoped: boolean;
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
  /** Original retained content is exposed through the pill's detail view and hover title. */
  readonly originalContent?: string;
  readonly presentation?: ActivityPillPresentation;
  readonly sortTime?: number;
  readonly call?: ToolCallRecord;
}

export interface ActivityOverflow {
  readonly kind: 'overflow';
  readonly id: string;
  readonly runKey: string;
  /** Stable item identities that become visible when this cap is expanded. */
  readonly hiddenItemIds: readonly string[];
  readonly anchorSeq: number;
  readonly position: Position;
  readonly sortTime?: number;
}

export interface ActivityFold {
  readonly kind: 'fold';
  /** Stable as a run grows at its tail: the first row in its activity segment. */
  readonly id: string;
  readonly runKey: string;
  readonly activityKind: ActivityKind;
  readonly lines: readonly ActivityLine[];
  readonly summary: ActivityLine;
  readonly anchorSeq: number;
  readonly position: Position;
  readonly sortTime?: number;
}

export type MessageActivityItem = ActivityLine | ActivityOverflow | ActivityFold;
export type ToolActivityItem = ActivityLine | ActivityOverflow | ActivityFold;

export interface ActivityTrailPlan {
  readonly messageItems: readonly MessageActivityItem[];
  readonly toolItems: ReadonlyMap<string, ToolActivityItem>;
  /** Candidates that have appeared, including lines currently behind an ellipsis. */
  readonly membership: ReadonlyMap<string, string>;
}

interface Candidate extends ActivityLine {
  readonly liveTailEligibleAtArrival?: boolean;
  /** Message activity is backed by the canonical conversation history. */
  readonly historyBacked: boolean;
  /** Refused actions can also be persisted by the selected-session history endpoint. */
  readonly persistedRailDenial?: boolean;
  readonly recordEventNotice?: boolean;
  /** Present only when the source text identifies a stable foldable notice kind. */
  readonly semanticFoldKind?: string;
}

interface BubbleEvent extends Position {
  readonly kind: 'bubble';
  readonly bubble: ActivityBubble;
  readonly spanKey?: string;
  readonly spanRootMessageId?: string;
  readonly ownerTurnSeq?: number;
  /** True only when this bubble belongs to a span opened by the selected user's prompt. */
  readonly ownerTurnScoped: boolean;
}

interface CandidateEvent extends Position {
  readonly kind: 'candidate';
  readonly candidate: Candidate;
}

interface EligibleCandidate {
  readonly candidate: Candidate;
  /** The current bubble gap, even when membership retains an older gap key. */
  readonly segmentKey: string;
}

type TrailEvent = BubbleEvent | CandidateEvent;

const bodyGist = (body: string): string => body.split(/\r?\n/)
  .map((line) => line.replace(/\s+/g, ' ').trim())
  .find(Boolean) ?? '';

function gatewayNoticeFoldKind(content: string): string | undefined {
  const text = content.trimStart();
  if (/^\[woke:\s*(?:wait|fact|fallback)\b/i.test(text) ||
    /^Wait finished on its assignment\b/i.test(text)) return 'wake';
  if (/^Assignment\b[^\r\n]*\bhas had no recorded activity since\b/i.test(text) ||
    /^Quiet for \d+\s+(?:s(?:ec(?:ond)?s?)?|min(?:ute)?s?|h(?:r|our)?s?|d(?:ay)?s?)\s*[·•]/i.test(text)) {
    return 'reminder';
  }
  return undefined;
}

const rawDisplayName = (message: CanonicalMessage): string | undefined => {
  const value = message.raw.senderDisplayName;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const rawSource = (message: CanonicalMessage): string | undefined =>
  typeof message.raw.source === 'string' ? message.raw.source : undefined;

function knownSenderDisplayNames(records: readonly {
  readonly seq: number;
  readonly sender?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}[]): ReadonlyMap<string, string> {
  const latest = new Map<string, { seq: number; displayName: string }>();
  for (const record of records) {
    const sender = record.sender ?? '';
    if (!/^(?:agent|session):/.test(sender)) continue;
    const displayName = typeof record.raw.senderDisplayName === 'string' ? record.raw.senderDisplayName.trim() : '';
    if (!displayName) continue;
    const previous = latest.get(sender);
    if (!previous || record.seq >= previous.seq) latest.set(sender, { seq: record.seq, displayName });
  }
  return new Map([...latest].map(([sender, value]) => [sender, value.displayName]));
}

function messageCandidate(message: CanonicalMessage): Candidate | undefined {
  const sender = message.sender ?? '';
  if (message.recordEventIds?.length) {
    const gist = bodyGist(message.content) || 'Record notice';
    return { id: `message:${message.id}`, kind: 'substrate', runKey: '', anchorSeq: message.seq,
      position: { sequence: message.seq, phase: 1, order: 0 }, gist,
      accessibleText: `Notice: ${gist}`, originalContent: message.content,
      presentation: activityPillPresentation({ kind: 'substrate', gist, content: message.content,
        sender, messageType: 'substrate' }), historyBacked: true, recordEventNotice: true };
  }
  if (message.isBatchCarrier || /^\[batched notices:/i.test(message.content)) return undefined;
  // An assistant-role reply from another session has no owner-visible parent
  // relation. Keep it out of activity pills just as the bubble projection does.
  if (message.role === 'assistant' && /^(?:agent|session):/.test(sender)) return undefined;
  const id = `message:${message.id}`;
  const parsedTime = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
  const sortTime = Number.isFinite(parsedTime) ? parsedTime : undefined;
  if (sender.startsWith('remedy:')) {
    const statute = sender.slice('remedy:'.length).trim();
    const lines = message.content.split(/\r?\n/);
    while (lines.length && (!lines[0].trim() || /^\s*\[from [^\]]+\]\s*$/i.test(lines[0]))) lines.shift();
    const detail = bodyGist(stripProvenanceMarkup(lines.join('\n')));
    const gist = `Remedy ${statute || 'sent'} sent${detail ? ` — ${detail}` : ''}`;
    return { id, kind: 'rail', runKey: '', anchorSeq: message.seq,
      position: { sequence: message.seq, phase: 1, order: 0 }, gist,
      accessibleText: `Rail: ${gist}`,
      originalContent: message.content,
      presentation: activityPillPresentation({ kind: 'rail', gist, content: message.content, sender }),
      sortTime, historyBacked: true };
  }
  if (message.messageType === 'substrate' || message.messageType === 'process' || sender.startsWith('process:')) {
    const gist = bodyGist(stripProvenanceMarkup(message.content)) || 'Substrate activity';
    const presentation = activityPillPresentation({ kind: 'substrate', gist, content: message.content, sender,
      source: rawSource(message), messageType: message.messageType, turnSeq: message.turnSeq });
    return { id, kind: 'substrate', runKey: '', anchorSeq: message.seq,
      position: { sequence: message.seq, phase: 1, order: 0 }, gist,
      accessibleText: `Substrate: ${gist}`,
      originalContent: message.content,
      presentation, sortTime,
      historyBacked: true,
      semanticFoldKind: gatewayNoticeFoldKind(message.content) };
  }
  if (message.messageType === 'agent' || sender.startsWith('agent:') || sender.startsWith('session:')) {
    const name = rawDisplayName(message) ?? 'Another agent';
    const detail = bodyGist(stripProvenanceMarkup(message.content));
    const gist = detail ? `${name} — ${detail}` : name;
    return { id, kind: 'agent', runKey: '', anchorSeq: message.seq,
      position: { sequence: message.seq, phase: 1, order: 0 }, gist,
      accessibleText: `Other agent: ${gist}`,
      originalContent: message.content,
      presentation: activityPillPresentation({ kind: 'agent', gist, content: message.content, sender,
        senderDisplayName: rawDisplayName(message) }), sortTime,
      historyBacked: true };
  }
  return undefined;
}

function memberCandidate(carrier: CanonicalMessage, member: ParsedBatchMember,
  senderDisplayName?: string): Candidate | undefined {
  if (member.sender.startsWith('user:')) return undefined;
  // The carrier's turnSeq belongs to the batching turn, not this notice member.
  const id = `member:${member.sourceId}`;
  const position = { sequence: carrier.seq, phase: 1, order: member.index };
  const parsedTime = carrier.createdAt ? Date.parse(carrier.createdAt) : Number.NaN;
  const sortTime = Number.isFinite(parsedTime) ? parsedTime : undefined;
  const detail = bodyGist(stripProvenanceMarkup(member.content));
  if (member.sender.startsWith('remedy:')) {
    const statute = member.sender.slice('remedy:'.length).trim();
    const gist = `Remedy ${statute || 'sent'} sent${detail ? ` — ${detail}` : ''}`;
    return { id, kind: 'rail', runKey: '', anchorSeq: carrier.seq, position, gist,
      accessibleText: `Rail: ${gist}`,
      originalContent: member.content,
      presentation: activityPillPresentation({ kind: 'rail', gist, content: member.content, sender: member.sender,
        source: member.source }),
      sortTime, historyBacked: true };
  }
  if (member.sender.startsWith('process:')) {
    const gist = detail || 'Substrate activity';
    const presentation = activityPillPresentation({ kind: 'substrate', gist, content: member.content,
      sender: member.sender, source: member.source, messageType: carrier.messageType });
    return { id, kind: 'substrate', runKey: '', anchorSeq: carrier.seq, position, gist,
      accessibleText: `Substrate: ${gist}`,
      originalContent: member.content,
      presentation,
      sortTime, historyBacked: true,
      semanticFoldKind: gatewayNoticeFoldKind(member.content) };
  }
  if (member.sender.startsWith('agent:') || member.sender.startsWith('session:')) {
    const displayName = senderDisplayName?.trim();
    const label = displayName || 'Another agent';
    const gist = detail ? `${label} — ${detail}` : label;
    return { id, kind: 'agent', runKey: '', anchorSeq: carrier.seq, position, gist,
      accessibleText: `Other agent: ${gist}`,
      originalContent: member.content,
      presentation: activityPillPresentation({ kind: 'agent', gist, content: member.content, sender: member.sender,
        senderDisplayName: displayName }),
      sortTime, historyBacked: true };
  }
  return undefined;
}

function toolCandidate(call: ToolCallRecord): Candidate {
  return { id: `tool:${call.id}`, kind: 'tool', runKey: '', anchorSeq: call.afterMessageSeq,
    position: { sequence: call.afterMessageSeq, phase: 2, order: call.seq }, gist: '', accessibleText: '',
    sortTime: call.startedAt, call, historyBacked: false };
}

function railCandidate(denial: LiveRailDenial | HistoryRailDenial, anchorSeq: number, order: number,
  persisted: boolean): Candidate {
  const gist = `${denial.verb} refused by ${denial.rule}`;
  return { id: `rail:${denial.id}`, kind: 'rail', runKey: '',
    anchorSeq,
    position: { sequence: anchorSeq, phase: 3, order },
    gist, accessibleText: `Rail: ${gist}`, originalContent: gist, sortTime: denial.occurredAt,
    presentation: activityPillPresentation({ kind: 'rail', gist, content: gist }),
    ...('tailEligibleAtArrival' in denial ? { liveTailEligibleAtArrival: denial.tailEligibleAtArrival } : {}),
    historyBacked: persisted, ...(persisted ? { persistedRailDenial: true } : {}) };
}

function historyDenialAnchor(denial: HistoryRailDenial, records: readonly {
  readonly seq: number; readonly createdAt?: string;
}[]): number {
  if (denial.afterMessageSeq !== undefined) return denial.afterMessageSeq;
  const timed = records.flatMap((record) => {
    const time = record.createdAt ? Date.parse(record.createdAt) : Number.NaN;
    return Number.isFinite(time) ? [{ seq: record.seq, time }] : [];
  }).sort((left, right) => left.seq - right.seq);
  const prior = timed.filter((record) => record.time <= denial.occurredAt);
  if (prior.length) return prior[prior.length - 1].seq;
  if (timed.length) return timed[0].seq;
  return records.reduce((latest, record) => Math.max(latest, record.seq), 0);
}

const comparePosition = (left: Position, right: Position): number =>
  left.sequence - right.sequence || left.phase - right.phase || left.order - right.order;

function bubbleEvents(bubbles: readonly ActivityBubble[]): BubbleEvent[] {
  const ordered = [...bubbles].sort((left, right) => left.record.seq - right.record.seq ||
    (left.record.id === right.record.id ? (left.member?.index ?? 0) - (right.member?.index ?? 0) : 0) ||
    left.key.localeCompare(right.key));
  const events: BubbleEvent[] = [];
  let spanKey: string | undefined;
  let spanRootMessageId: string | undefined;
  let spanRootTurnSeq: number | undefined;
  let ownerTurnScoped = false;
  let hasReply = false;
  for (let order = 0; order < ordered.length; order++) {
    const bubble = ordered[order];
    if (bubble.side === 'human') {
      if (!spanKey || hasReply || ownerTurnScoped !== bubble.ownerScoped) {
        spanKey = `prompt:${bubble.key}`;
        spanRootMessageId = bubble.record.id;
        spanRootTurnSeq = bubble.record.turnSeq;
        ownerTurnScoped = bubble.ownerScoped;
      }
      hasReply = false;
    } else if (spanKey) {
      hasReply = true;
    }
    events.push({ kind: 'bubble', bubble, spanKey, spanRootMessageId,
      ownerTurnSeq: bubble.record.turnSeq ?? spanRootTurnSeq, ownerTurnScoped,
      sequence: bubble.record.seq, phase: 0, order });
  }
  return events;
}

function belongsToOwnerConversation(candidate: Candidate, precedingBubble: BubbleEvent,
  nextBubble: BubbleEvent | undefined, activeOwnerTurnRunning: boolean, activeOwnerTurnSeq: number | undefined,
  activeOwnerTurnMessageId: string | undefined, ownerReplyByTurn: ReadonlyMap<number, BubbleEvent>,
  ownerReplyBySpan: ReadonlyMap<string, BubbleEvent>): boolean {
  if (!candidate.historyBacked || !precedingBubble.ownerTurnScoped) return false;
  const turnReply = precedingBubble.ownerTurnSeq !== undefined
    ? ownerReplyByTurn.get(precedingBubble.ownerTurnSeq) : undefined;
  const spanReply = precedingBubble.spanKey ? ownerReplyBySpan.get(precedingBubble.spanKey) : undefined;
  const closedByLaterReply = [turnReply, spanReply].some(reply => reply && comparePosition(reply, candidate.position) > 0);
  // Running activity belongs only to the active owner's turn. A later owner
  // prompt cannot make an older, completed exchange look live again.
  const matchesActiveTurn = activeOwnerTurnRunning && (
    activeOwnerTurnSeq !== undefined && precedingBubble.ownerTurnSeq !== undefined
      ? activeOwnerTurnSeq === precedingBubble.ownerTurnSeq
      : !!activeOwnerTurnMessageId && (precedingBubble.bubble.record.id === activeOwnerTurnMessageId ||
        precedingBubble.spanRootMessageId === activeOwnerTurnMessageId)
  );
  const beforeOwnerFollowUp = !!nextBubble && nextBubble.ownerTurnScoped &&
    nextBubble.bubble.side === 'human' && matchesActiveTurn;
  const activeOwnerTail = !nextBubble && matchesActiveTurn;
  return closedByLaterReply || beforeOwnerFollowUp || activeOwnerTail;
}

function lineWithRun(candidate: Candidate, runKey: string, includeToolDetails = true): ActivityLine {
  const { liveTailEligibleAtArrival: _eligibleAtArrival,
    historyBacked: _historyBacked,
    semanticFoldKind: _semanticFoldKind, ...line } = candidate;
  if (candidate.kind === 'tool' && candidate.call) {
    if (!includeToolDetails) return { ...line, runKey, gist: '', accessibleText: '' };
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
    readonly isBatchCarrier?: boolean; readonly turnSeq?: number; readonly recordEventIds?: readonly string[]; readonly raw: Readonly<Record<string, unknown>> }[];
  readonly senderDisplayNames?: ReadonlyMap<string, string>;
  readonly bubbles: readonly ActivityBubble[];
  readonly transitions: readonly CanonicalTransition[];
  /** Unmatched local sends use timestamps to find their place between tool rows. */
  readonly localSendTimes?: readonly number[];
  readonly tools: readonly ToolCallRecord[];
  readonly toolsEnabled: boolean;
  readonly turnStateAvailable: boolean;
  /** Any running turn still gates non-history tool rows and live refusals. */
  readonly activeTurnRunning: boolean;
  readonly activeOwnerTurnRunning: boolean;
  /** Source-backed identity of the currently running owner turn, when available. */
  readonly activeOwnerTurnSeq?: number;
  readonly activeOwnerTurnMessageId?: string;
  readonly railDenials: readonly LiveRailDenial[];
  readonly historyRailDenials?: readonly HistoryRailDenial[];
  readonly shownRuns: ReadonlyMap<string, string>;
  readonly expandedRuns: ReadonlySet<string>;
}): ActivityTrailPlan {
  const visibleIds = new Set(input.bubbles.filter((bubble) => !bubble.member).map((bubble) => bubble.record.id));
  const senderDisplayNames = new Map(knownSenderDisplayNames(input.records));
  for (const [sender, displayName] of input.senderDisplayNames ?? []) {
    if (displayName.trim()) senderDisplayNames.set(sender, displayName.trim());
  }
  const candidates: Candidate[] = [];
  for (const message of input.records) {
    if (visibleIds.has(message.id)) continue;
    if (message.recordEventIds?.length) {
      candidates.push(messageCandidate(message as CanonicalMessage)!);
      continue;
    }
    const batchMembers = parseBatchMembers(message as CanonicalMessage);
    if (batchMembers) {
      for (const member of batchMembers) {
        const candidate = memberCandidate(message as CanonicalMessage, member,
          senderDisplayNames.get(member.sender));
        if (candidate) candidates.push(candidate);
      }
      continue;
    }
    const candidate = messageCandidate(message as CanonicalMessage);
    if (candidate) candidates.push(candidate);
    else if (message.role === 'assistant') continue;
  }
  const historyDenials: HistoryRailDenial[] = [];
  const historyIds = new Set<string>();
  for (const denial of input.historyRailDenials ?? []) {
    if (denial.sessionKey === input.sessionKey && denial.principal === `session:${input.sessionKey}` &&
        !historyIds.has(denial.id)) {
      historyDenials.push(denial);
      historyIds.add(denial.id);
    }
  }
  historyDenials.forEach((denial, index) => candidates.push(railCandidate(denial,
    historyDenialAnchor(denial, input.records), index, true)));
  const liveDenials: LiveRailDenial[] = [];
  for (const denial of input.railDenials) {
    if (denial.sessionKey === input.sessionKey && denial.principal === `session:${input.sessionKey}` &&
        !historyDenials.some((history) => sameRailDenial(history, denial))) {
      liveDenials.push(denial);
    }
  }
  liveDenials.forEach((denial) => candidates.push(railCandidate(denial,
    denial.afterMessageSeq, denial.arrivalOrder, false)));
  if (input.toolsEnabled) candidates.push(...input.tools.map(toolCandidate));

  const orderedBubbles = bubbleEvents(input.bubbles);
  const events: TrailEvent[] = [
    ...orderedBubbles,
    ...candidates.map((candidate): CandidateEvent => ({
      kind: 'candidate', candidate, ...candidate.position,
    })),
  ].sort(comparePosition);
  const ownerReplyByTurn = new Map<number, BubbleEvent>();
  const ownerReplyBySpan = new Map<string, BubbleEvent>();
  for (const bubble of orderedBubbles) {
    if (!bubble.ownerTurnScoped || bubble.bubble.side !== 'agent') continue;
    if (bubble.ownerTurnSeq !== undefined) ownerReplyByTurn.set(bubble.ownerTurnSeq, bubble);
    if (bubble.spanKey) ownerReplyBySpan.set(bubble.spanKey, bubble);
  }
  // Canonical activity persists when a later owner reply closes its turn/span,
  // including gaps across follow-up prompts. A running turn keeps only its own
  // gaps visible; the current turn identity prevents unrelated older gaps from
  // becoming visible simply because another owner turn is active.
  const historyInOwnerConversation = (candidate: Candidate, precedingBubble: BubbleEvent,
    nextBubble?: BubbleEvent) => {
    return belongsToOwnerConversation(candidate, precedingBubble, nextBubble, input.activeOwnerTurnRunning,
      input.activeOwnerTurnSeq, input.activeOwnerTurnMessageId, ownerReplyByTurn, ownerReplyBySpan);
  };

  const eligible = new Map<string, EligibleCandidate[]>();
  const membership = new Map<string, string>();
  const add = (candidate: Candidate, runKey: string) => {
    const priorRun = input.shownRuns.get(candidate.id);
    const chosenRun = priorRun ?? runKey;
    const rows = eligible.get(chosenRun) ?? [];
    rows.push({ candidate, segmentKey: runKey });
    eligible.set(chosenRun, rows);
    membership.set(candidate.id, chosenRun);
  };

  let previousBubble: BubbleEvent | undefined;
  let pending: CandidateEvent[] = [];
  const closeGap = (nextBubble?: BubbleEvent) => {
    if (!previousBubble?.spanKey) { pending = []; return; }
    const runKey = `run:${previousBubble.bubble.key}`;
    const closedByReply = !!nextBubble && previousBubble.ownerTurnScoped && nextBubble.ownerTurnScoped &&
      nextBubble.bubble.side === 'agent' && nextBubble.spanKey === previousBubble.spanKey;
    const tail = pending.map((event) => event.candidate);
    const beforeOrAtTool = new Set<string>();
    let foundTool = false;
    for (let index = tail.length - 1; index >= 0; index--) {
      const candidate = tail[index];
      if (candidate.kind === 'tool') foundTool = true;
      if (foundTool) beforeOrAtTool.add(candidate.id);
    }
    if (closedByReply) {
      for (const event of pending) {
        if (!event.candidate.historyBacked || event.candidate.persistedRailDenial ||
            historyInOwnerConversation(event.candidate, previousBubble, nextBubble)) {
          add(event.candidate, runKey);
        }
      }
    } else if (!nextBubble) {
      for (const candidate of tail) {
        const allowed = candidate.kind === 'rail'
          ? (!input.turnStateAvailable || candidate.liveTailEligibleAtArrival === true)
          : (beforeOrAtTool.has(candidate.id) || (input.turnStateAvailable && input.activeTurnRunning));
        const historyAllowed = historyInOwnerConversation(candidate, previousBubble);
        if (candidate.historyBacked
          ? historyAllowed || candidate.persistedRailDenial
          : allowed || input.shownRuns.has(candidate.id)) add(candidate, runKey);
      }
    } else {
      for (const candidate of tail) {
        const oldRun = input.shownRuns.get(candidate.id);
        const allowed = candidate.kind === 'rail'
          ? (!input.turnStateAvailable || candidate.liveTailEligibleAtArrival === true)
          : beforeOrAtTool.has(candidate.id);
        const historyAllowed = historyInOwnerConversation(candidate, previousBubble, nextBubble);
        if (candidate.historyBacked ? historyAllowed || candidate.persistedRailDenial : allowed || oldRun) {
          add(candidate, oldRun ?? runKey);
        }
      }
    }
    pending = [];
  };

  for (const event of events) {
    if (event.kind === 'candidate') {
      // A stamped notice is the durable event's visible representation even
      // outside a human reply span. Keep the complete canonical notice once.
      if (event.candidate.recordEventNotice) add(event.candidate, `notice:${event.candidate.id}`);
      else pending.push(event);
    }
    else {
      closeGap(event);
      previousBubble = event;
    }
  }
  closeGap();

  const messageItems: MessageActivityItem[] = [];
  const toolItems = new Map<string, ToolActivityItem>();
  const transitionSequences = input.transitions.map((record) => record.seq).sort((a, b) => a - b);
  const localSendTimes = [...(input.localSendTimes ?? [])].sort((a, b) => a - b);
  const hasTransitionBetween = (previous: number, next: number) => {
    let low = 0;
    let high = transitionSequences.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (transitionSequences[middle] <= previous) low = middle + 1;
      else high = middle;
    }
    return low < transitionSequences.length && transitionSequences[low] <= next;
  };
  const hasPendingSendBetween = (previous?: number, next?: number) => {
    if (previous === undefined || next === undefined || previous >= next) return false;
    let low = 0;
    let high = localSendTimes.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (localSendTimes[middle] <= previous) low = middle + 1;
      else high = middle;
    }
    return low < localSendTimes.length && localSendTimes[low] < next;
  };
  const addLine = (line: ActivityLine) => {
    if (line.kind === 'tool' && line.call) toolItems.set(line.call.id, line);
    else messageItems.push(line);
  };
  const addCollapsedItem = (item: ActivityLine | ActivityFold) => {
    if (item.kind === 'fold') {
      if (item.activityKind === 'tool') {
        for (const line of item.lines) if (line.call) toolItems.set(line.call.id, item);
      } else messageItems.push(item);
    } else addLine(item);
  };

  const addOverflow = (runKey: string, hiddenItems: readonly (ActivityLine | ActivityFold)[]) => {
    const first = hiddenItems[0];
    const firstLine = first.kind === 'fold' ? first.lines[0] : first;
    const overflow: ActivityOverflow = { kind: 'overflow', id: `overflow:${runKey}`,
      runKey, hiddenItemIds: hiddenItems.map(item => item.id),
      anchorSeq: firstLine.anchorSeq, position: firstLine.position, sortTime: firstLine.sortTime };
    for (const item of hiddenItems) {
      const lines = item.kind === 'fold' ? item.lines : [item];
      for (const line of lines) {
        if (line.kind === 'tool' && line.call) toolItems.set(line.call.id, overflow);
      }
    }
    messageItems.push(overflow);
  };

  for (const [runKey, rows] of eligible) {
    rows.sort((left, right) => comparePosition(left.candidate.position, right.candidate.position));
    const foldGroupByCandidateId = new Map<string, string>();
    const foldGroupCounts = new Map<string, number>();
    const foldGroupIdentity = (candidate: Candidate) => {
      if (candidate.kind === 'tool') {
        const toolName = candidate.call?.toolName?.trim();
        return toolName ? `tool:${toolName}` : `single:${candidate.id}`;
      }
      if (candidate.kind === 'agent') return 'agent';
      if (candidate.kind === 'substrate' && candidate.semanticFoldKind) {
        return `gateway:${candidate.semanticFoldKind}`;
      }
      return `single:${candidate.id}`;
    };
    let previousRow: EligibleCandidate | undefined;
    let groupId = '';
    for (const row of rows) {
      if (!previousRow || previousRow.segmentKey !== row.segmentKey ||
        foldGroupIdentity(previousRow.candidate) !== foldGroupIdentity(row.candidate) ||
        hasTransitionBetween(previousRow.candidate.position.sequence, row.candidate.position.sequence) ||
        hasPendingSendBetween(previousRow.candidate.sortTime, row.candidate.sortTime)) {
        groupId = row.candidate.id;
      }
      foldGroupByCandidateId.set(row.candidate.id, groupId);
      foldGroupCounts.set(groupId, (foldGroupCounts.get(groupId) ?? 0) + 1);
      previousRow = row;
    }
    const expanded = input.expandedRuns.has(runKey);
    const collapsedItems: (ActivityLine | ActivityFold)[] = [];
    let currentLines: ActivityLine[] = [];
    let currentSegment: string | undefined;
    const flush = () => {
      if (currentLines.length > 1) {
        const summary = currentLines[currentLines.length - 1];
        // A growing non-tool fold stays at its first row's timeline position
        // while its displayed summary advances to the newest member. This
        // keeps the row in the same indexed branch and lets React update it
        // without replacing the row or moving its neighbors.
        const anchor = currentLines[0].kind === 'tool' ? summary : currentLines[0];
        collapsedItems.push({ kind: 'fold', id: currentSegment!, runKey: currentLines[0].runKey,
          activityKind: currentLines[0].kind, lines: currentLines, summary,
          anchorSeq: anchor.anchorSeq, position: anchor.position, sortTime: anchor.sortTime });
      } else if (currentLines.length === 1) collapsedItems.push(currentLines[0]);
      currentLines = [];
      currentSegment = undefined;
    };
    const append = (line: ActivityLine, foldGroupId: string) => {
      if (currentLines.length && currentSegment !== foldGroupId) flush();
      if (!currentLines.length) currentSegment = foldGroupId;
      currentLines.push(line);
    };
    for (let index = 0; index < rows.length; index++) {
      const { candidate } = rows[index];
      const candidateGroup = foldGroupByCandidateId.get(candidate.id) ?? candidate.id;
      const nextGroup = rows[index + 1] && foldGroupByCandidateId.get(rows[index + 1].candidate.id);
      const includeToolDetails = expanded || foldGroupCounts.get(candidateGroup) === 1 || nextGroup !== candidateGroup;
      append(lineWithRun(candidate, runKey, includeToolDetails), candidateGroup);
    }
    flush();

    // Fold first so a long homogeneous run remains one useful ×N entry. The
    // five-item history cap applies to the displayed groups, not their rows.
    const hiddenCount = expanded ? 0 : Math.max(0, collapsedItems.length - 5);
    if (hiddenCount) addOverflow(runKey, collapsedItems.slice(0, hiddenCount));
    for (const item of collapsedItems.slice(hiddenCount)) addCollapsedItem(item);
  }
  messageItems.sort((left, right) => left.anchorSeq - right.anchorSeq ||
    comparePosition(left.position, right.position) || left.id.localeCompare(right.id));
  return { messageItems, toolItems, membership };
}
