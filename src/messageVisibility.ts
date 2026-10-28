import type { CanonicalMessage, ConversationRecord } from './types';

export interface HumanMember {
  readonly index: number;
  readonly sourceId: string;
  readonly sender: string;
  readonly content: string;
}

export interface ParsedBatchMember extends HumanMember {
  readonly sender: string;
}

const batchHeading = /^\[(\d+)\] source=([^\s]+) sender=([^\s]+) cause=([^\s]+) class=([^\s]+)$/;

/** Parse only the delivered, indexed notice-batch form; unknown wrappers stay hidden. */
export function parseBatchMembers(record: CanonicalMessage): readonly ParsedBatchMember[] | undefined {
  if (record.isBatchCarrier !== true && !record.sender?.startsWith('process:')) return undefined;
  const lines = record.content.split(/\r?\n/);
  const countMatch = /^\[batched notices: ([1-9]\d*)\]$/.exec(lines[0] ?? '');
  if (!countMatch) return undefined;
  const count = Number(countMatch[1]);
  if (!Number.isSafeInteger(count)) return undefined;

  const headers = lines.flatMap((line, lineIndex) => {
    const match = batchHeading.exec(line);
    return match ? [{ lineIndex, index: Number(match[1]), sender: match[3] }] : [];
  });
  if (headers.length !== count || headers.some((header, index) => header.index !== index + 1)) return undefined;
  const footerIndex = lines.reduce((found, line, index) => /^coalesced by\s+\S/.test(line) ? index : found, -1);
  if (footerIndex <= headers.at(-1)!.lineIndex) return undefined;

  return headers.map((header, index) => {
    const bodyStart = header.lineIndex + 1;
    const boundary = headers[index + 1]?.lineIndex ?? footerIndex;
    let bodyEnd = boundary;
    // A single empty line separates a member body from the next framing line.
    if (bodyEnd > bodyStart && lines[bodyEnd - 1] === '') bodyEnd--;
    return Object.freeze({ index: header.index, sourceId: `${record.id}:member:${header.index}`,
      sender: header.sender, content: lines.slice(bodyStart, bodyEnd).join('\n') });
  });
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
  readonly senderLabel?: 'You' | 'User';
  /** Included by the projection, but awaiting relation/turn evidence before UI rendering. */
  readonly provenancePending: boolean;
  readonly member?: HumanMember;
}

function isVisibleHumanRow(record: CanonicalMessage): boolean {
  return record.role === 'user' && record.isBatchCarrier !== true &&
    !nonhumanTypes.has(record.messageType ?? '') && !nonhumanSender.test(record.sender ?? '');
}

export function projectMessages(records: readonly ConversationRecord[], principalKey?: string, ownerUserId?: unknown): {
  messages: VisibleMessage[]; issues: readonly string[];
} {
  const byId = new Map(records.filter((row): row is CanonicalMessage => row.kind === 'message').map((row) => [row.id, row]));
  const messages: VisibleMessage[] = [];
  const issues: string[] = [];
  for (const record of byId.values()) {
    const classification = classifyMessage(record, principalKey);
    const members = parseBatchMembers(record);
    if (members && record.isBatchCarrier !== true) {
      for (const member of members) {
        if (member.sender.startsWith('user:')) {
          messages.push({ key: `${record.id}:member:${member.index}`, source: record, side: 'human',
            senderLabel: member.sender === `user:${principalKey}` ? 'You' : 'User',
            provenancePending: false, member });
        }
      }
    } else if (classification === 'human') {
      messages.push({ key: record.id, source: record, side: 'human', senderLabel: 'You', provenancePending: false });
    } else if (isVisibleHumanRow(record)) {
      // A missing or different sender does not prove this row belongs to the viewer,
      // but it also is not a reason to omit the row from the conversation.
      messages.push({ key: record.id, source: record, side: 'human', senderLabel: 'User', provenancePending: false });
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
        key: record.id, source: record, side: 'agent', provenancePending,
      });
    }
  }
  return { messages, issues: Object.freeze([...new Set(issues)]) };
}
