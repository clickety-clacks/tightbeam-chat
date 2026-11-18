import type { CanonicalMessage, ConversationRecord } from './types';

export interface HumanMember {
  readonly index: number;
  readonly sourceId: string;
  readonly sender: string;
  readonly content: string;
}

export interface ParsedBatchMember extends HumanMember {
  readonly source: string;
  readonly sender: string;
}

const batchHeading = /^\[(\d+)\] source=([^\s]+) sender=([^\s]+) cause=([^\s]+) class=([^\s]+)$/;
const canonicalBatchHeading = /^\[(\d+)\] source=([^\s]+) sender=(.+?) cause=([^\s]+) class=([^\s]+)$/;
const batchCountHeading = /^\[batched notices: ([1-9]\d*)\]$/;

export function isUnmarkedCanonicalProcessBatch(record: CanonicalMessage): boolean {
  return record.isBatchCarrier !== true && record.sender === 'process:tightbeam';
}

/** Parse only the delivered, indexed notice-batch form; unknown wrappers stay hidden. */
export function parseBatchMembers(record: CanonicalMessage): readonly ParsedBatchMember[] | undefined {
  const isCanonicalCarrier = record.isBatchCarrier === true;
  if (!isCanonicalCarrier && !record.sender?.startsWith('process:')) return undefined;
  const lines = record.content.split(/\r?\n/);
  // Keep the count-first form already in use while recognizing the process
  // preamble used by current canonical carriers.
  const countFirst = batchCountHeading.test(lines[0] ?? '');
  const processPreamble = /^\[from (process:[^\]]+)\]$/.exec(lines[0] ?? '');
  const hasProcessPreamble = !!processPreamble && lines[1] === '' &&
    (isCanonicalCarrier || processPreamble[1] === record.sender);
  const countLineIndex = countFirst ? 0 : hasProcessPreamble ? 2 : -1;
  if (countLineIndex < 0) return undefined;
  const countMatch = batchCountHeading.exec(lines[countLineIndex] ?? '');
  if (!countMatch) return undefined;
  const declaredCount = Number(countMatch[1]);
  if (!Number.isSafeInteger(declaredCount)) return undefined;

  const headers = lines.flatMap((line, lineIndex) => {
    const match = (isCanonicalCarrier || hasProcessPreamble ? canonicalBatchHeading : batchHeading).exec(line);
    return match ? [{ lineIndex, index: Number(match[1]), source: match[2], sender: match[3] }] : [];
  });
  const canonicalHeaders = isCanonicalCarrier || hasProcessPreamble;
  const validIndexes = headers.every((header, index) => Number.isSafeInteger(header.index) && header.index > 0 &&
    (canonicalHeaders ? index === 0 || header.index > headers[index - 1].index : header.index === index + 1));
  if (!headers.length || headers.length !== declaredCount || !validIndexes ||
    headers.some(header => header.lineIndex <= countLineIndex)) return undefined;
  const footerIndex = lines.reduce((found, line, index) => /^coalesced by\s+\S/.test(line) ? index : found, -1);
  if (footerIndex <= headers.at(-1)!.lineIndex) return undefined;

  const members = headers.map((header, index) => {
    const bodyStart = header.lineIndex + 1;
    const boundary = headers[index + 1]?.lineIndex ?? footerIndex;
    let bodyEnd = boundary;
    // A single empty line separates a member body from the next framing line.
    if (bodyEnd > bodyStart && lines[bodyEnd - 1] === '') bodyEnd--;
    return Object.freeze({ index: header.index, sourceId: `${record.id}:member:${header.index}`,
      source: header.source, sender: header.sender, content: lines.slice(bodyStart, bodyEnd).join('\n') });
  });
  // Older decoders may omit isBatchCarrier. Use a sender-matched, complete
  // process envelope to recognize mixed batches, while leaving unmarked
  // process-only batches on their existing single-notice path.
  const hasAgentMember = members.some(member => /^(?:agent|session):/.test(member.sender));
  if (!isCanonicalCarrier && isUnmarkedCanonicalProcessBatch(record) && !hasAgentMember) return undefined;
  if (!isCanonicalCarrier && hasProcessPreamble && !isUnmarkedCanonicalProcessBatch(record)) return undefined;
  return members;
}

const nonhumanTypes = new Set(['substrate', 'agent', 'process', 'marker']);
const nonhumanSender = /^(?:agent|session|process|remedy):/;

export function isHumanMessage(record: CanonicalMessage, principalKey?: string): boolean {
  return !!principalKey && record.role === 'user' && record.sender === `user:${principalKey}` &&
    record.isBatchCarrier !== true;
}

export function classifyMessage(record: CanonicalMessage, principalKey?: string):
  'human' | 'assistant' | 'nonhuman' | 'carrier' | 'unknown' {
  if (record.isBatchCarrier === true) return 'carrier';
  if (isHumanMessage(record, principalKey)) return 'human';
  if (nonhumanTypes.has(record.messageType ?? '') || nonhumanSender.test(record.sender ?? '')) return 'nonhuman';
  if (record.role === 'user' && record.sender?.startsWith('user:')) return 'nonhuman';
  if (record.role === 'assistant') return 'assistant';
  return 'unknown';
}

/** The delivered flag describes the session owner's principal, not any user. */
export function scopedHumanFlag(record: CanonicalMessage, principalKey?: string, ownerUserId?: unknown): boolean | undefined {
  return principalKey && ownerUserId === principalKey && record.turnSeq !== undefined
    ? record.turnIncludesHuman : undefined;
}

export interface VisibleMessage {
  readonly key: string;
  readonly source: CanonicalMessage;
  readonly side: 'human' | 'agent';
  /** User rows without exact principal proof remain visible without claiming ownership. */
  readonly senderLabel?: string;
  /** Exact configured-principal membership, independent of a display label. */
  readonly ownerScoped: boolean;
  /** Included by the projection, but awaiting relation/turn evidence before UI rendering. */
  readonly provenancePending: boolean;
  /** Harness failure carried by a process row that explicitly refers to this prompt. */
  readonly failureReason?: string;
  readonly member?: HumanMember;
}

function isVisibleHumanRow(record: CanonicalMessage): boolean {
  return record.role === 'user' && record.isBatchCarrier !== true &&
    !nonhumanTypes.has(record.messageType ?? '') && !nonhumanSender.test(record.sender ?? '');
}

function submitterDisplayName(record: CanonicalMessage): string | undefined {
  const submitter = record.raw.submitter;
  if (!submitter || typeof submitter !== 'object' || Array.isArray(submitter)) return undefined;
  const displayName = (submitter as Record<string, unknown>).displayName;
  return typeof displayName === 'string' && displayName.trim() ? displayName.trim() : undefined;
}

function submitterKey(record: CanonicalMessage): string | undefined {
  const submitter = record.raw.submitter;
  if (!submitter || typeof submitter !== 'object' || Array.isArray(submitter)) return undefined;
  const attribution = submitter as Record<string, unknown>;
  const identity = attribution.identity;
  if (typeof identity === 'string' && identity.trim()) return `identity:${identity.trim()}`;
  const displayName = attribution.displayName;
  return typeof displayName === 'string' && displayName.trim() ? `display:${displayName.trim()}` : undefined;
}

function turnFailureReason(record: CanonicalMessage): string | undefined {
  if (record.role !== 'assistant' || record.sender !== 'process:tightbeam' ||
      record.messageType !== 'substrate' || record.isBatchCarrier === true ||
      !record.content.startsWith('[turn failed]')) return undefined;
  const afterMarker = record.content.slice('[turn failed]'.length).replace(/^\r?\n(?:\r?\n)?/, '');
  const messageAbovePrefix = 'The agent could not answer the message above:';
  if (afterMarker.startsWith(messageAbovePrefix)) {
    const reason = afterMarker.slice(messageAbovePrefix.length);
    return reason.startsWith(' ') ? reason.slice(1) : reason;
  }
  return afterMarker || undefined;
}

export function projectMessages(records: readonly ConversationRecord[], principalKey?: string, ownerUserId?: unknown,
  submitterAttributionEnabled = false): {
  messages: VisibleMessage[]; issues: readonly string[]; multipleSubmitters: boolean;
} {
  const byId = new Map(records.filter((row): row is CanonicalMessage => row.kind === 'message').map((row) => [row.id, row]));
  const submitterKeys = new Set<string>();
  for (const record of byId.values()) {
    if (!isVisibleHumanRow(record)) continue;
    const key = submitterKey(record);
    if (key) submitterKeys.add(key);
  }
  const multipleSubmitters = submitterKeys.size > 1;
  const showSubmitterNames = submitterAttributionEnabled && multipleSubmitters;
  // Runtime history and change updates are kept in message sequence order.
  // Track one prompt per session so failure attribution stays a single pass.
  const failuresByPrompt = new Map<string, string>();
  const latestPromptBySession = new Map<string, { prompt?: CanonicalMessage; hasAssistantReply: boolean }>();
  for (const record of byId.values()) {
    const reason = turnFailureReason(record);
    if (reason) {
      const explicitParent = record.replyToMessageId ? byId.get(record.replyToMessageId) : undefined;
      let promptId: string | undefined;
      if (record.replyToMessageId) {
        if (explicitParent?.sessionKey === record.sessionKey && isHumanMessage(explicitParent, principalKey)) {
          promptId = explicitParent.id;
        }
      } else if (record.content.includes('The agent could not answer the message above:')) {
        const latest = latestPromptBySession.get(record.sessionKey);
        if (latest && !latest.hasAssistantReply && latest.prompt && isHumanMessage(latest.prompt, principalKey)) {
          promptId = latest.prompt.id;
        }
      }
      if (promptId) {
        // Keep the originating refusal when later rows repeat the failed turn.
        if (!failuresByPrompt.has(promptId)) failuresByPrompt.set(promptId, reason);
      }
    }

    if (record.role === 'user') {
      latestPromptBySession.set(record.sessionKey, { prompt: record, hasAssistantReply: false });
    } else if (record.role === 'assistant' && !record.sender?.startsWith('process:')) {
      const latest = latestPromptBySession.get(record.sessionKey);
      if (latest) latest.hasAssistantReply = true;
    }
  }
  const messages: VisibleMessage[] = [];
  const issues: string[] = [];
  for (const record of byId.values()) {
    const classification = classifyMessage(record, principalKey);
    const members = parseBatchMembers(record);
    if (members && record.isBatchCarrier !== true) {
      const preserveNotices = isUnmarkedCanonicalProcessBatch(record) &&
        members.some(member => /^(?:agent|session):/.test(member.sender));
      for (const member of members) {
        if (member.sender.startsWith('user:')) {
          if (!preserveNotices) {
            const ownerScoped = member.sender === `user:${principalKey}`;
            messages.push({ key: `${record.id}:member:${member.index}`, source: record, side: 'human',
              senderLabel: ownerScoped ? 'You' : 'User', ownerScoped,
              provenancePending: false, member: Object.freeze({ index: member.index, sourceId: member.sourceId,
                sender: member.sender, content: member.content }) });
          }
        }
      }
    } else if (classification === 'human') {
      messages.push({ key: record.id, source: record, side: 'human',
        senderLabel: showSubmitterNames ? submitterDisplayName(record) ?? 'You' : 'You',
        ownerScoped: true, provenancePending: false,
        ...(failuresByPrompt.has(record.id) ? { failureReason: failuresByPrompt.get(record.id) } : {}) });
    } else if (isVisibleHumanRow(record)) {
      // A missing or different sender does not prove this row belongs to the viewer,
      // but it also is not a reason to omit the row from the conversation.
      messages.push({ key: record.id, source: record, side: 'human',
        senderLabel: showSubmitterNames ? submitterDisplayName(record) ?? 'You' : 'User',
        ownerScoped: false, provenancePending: false });
    } else if (classification === 'assistant') {
      const parent = record.replyToMessageId ? byId.get(record.replyToMessageId) : undefined;
      // Both rows must participate in the same typed generating turn. A loaded
      // parent alone, its body, or a wake origin does not establish membership.
      const linked = parent && parent.sessionKey === record.sessionKey && record.turnSeq !== undefined &&
        parent.turnSeq === record.turnSeq;
      const parentKind = linked ? classifyMessage(parent, principalKey) : 'unknown';
      const parentMembers = linked && parent?.isBatchCarrier !== true ? parseBatchMembers(parent!) : undefined;
      const parentHasHumanMember = parentMembers?.some(member => member.sender === `user:${principalKey}`) === true;
      const parentIsClassifiedBatch = parentMembers !== undefined;
      const direct = parentKind === 'human' || parentHasHumanMember ? true
        : parentKind === 'nonhuman' || (parentIsClassifiedBatch && !parentHasHumanMember) ? false : undefined;
      const flag = scopedHumanFlag(record, principalKey, ownerUserId);
      if (direct === true && flag === false) issues.push('Reply classification conflicts with its human parent');
      const includesHuman = direct === true ? true : flag ?? direct;
      const provenancePending = includesHuman === undefined && !!record.replyToMessageId && !parent;
      // An incomplete relation remains unknown; it is not exclusion evidence.
      if (includesHuman !== false) messages.push({
        key: record.id, source: record, side: 'agent', ownerScoped: true, provenancePending,
      });
    }
  }
  return { messages, issues: Object.freeze([...new Set(issues)]), multipleSubmitters };
}
