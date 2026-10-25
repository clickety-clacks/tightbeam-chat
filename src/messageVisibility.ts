import type { CanonicalMessage, ConversationRecord } from './types';

/** Retained for renderer source compatibility; canonical member rows need no extraction. */
export interface HumanMember {
  readonly index: number;
  readonly sourceId: string;
  readonly sender: string;
  readonly content: string;
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
  /** Included by the projection, but awaiting relation/turn evidence before UI rendering. */
  readonly provenancePending: boolean;
  readonly member?: HumanMember;
}

export function projectMessages(records: readonly ConversationRecord[], principalKey?: string, ownerUserId?: unknown): {
  messages: VisibleMessage[]; issues: readonly string[];
} {
  const byId = new Map(records.filter((row): row is CanonicalMessage => row.kind === 'message').map((row) => [row.id, row]));
  const messages: VisibleMessage[] = [];
  const issues: string[] = [];
  for (const record of byId.values()) {
    const classification = classifyMessage(record, principalKey);
    if (classification === 'human') {
      messages.push({ key: record.id, source: record, side: 'human', provenancePending: false });
    } else if (classification === 'assistant') {
      const parent = record.replyToMessageId ? byId.get(record.replyToMessageId) : undefined;
      // Both rows must participate in the same typed generating turn. A loaded
      // parent alone, its body, or a wake origin does not establish membership.
      const linked = parent && parent.sessionKey === record.sessionKey && record.turnSeq !== undefined &&
        parent.turnSeq === record.turnSeq;
      const parentKind = linked ? classifyMessage(parent, principalKey) : 'unknown';
      const direct = parentKind === 'human' ? true : parentKind === 'nonhuman' ? false : undefined;
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
