import type { CanonicalMessage, ConversationRecord } from './types';

export interface HumanMember {
  readonly index: number;
  readonly sourceId: string;
  readonly sender: string;
  readonly content: string;
}

export type MessageClassification =
  | { readonly kind: 'human' | 'assistant' | 'nonhuman' | 'separate-carrier' | 'unknown' }
  | { readonly kind: 'batch'; readonly members: readonly HumanMember[]; readonly includesHuman: boolean }
  | { readonly kind: 'invalid'; readonly reason: string };

// Cache by immutable canonical record, so unchanged history is not reparsed on
// send/status publications, paging or updates to a different message.
const classifications = new WeakMap<CanonicalMessage, MessageClassification>();
const nonhumanTypes = new Set(['substrate', 'agent', 'process', 'marker']);
const nonhumanSender = /^(?:agent|session|process|remedy):/;
const humanSender = /^user:[^\s]+$/;
const memberHeader = /^\[(\d+)\] source=(\S+) sender=(.+?) cause=(\S+) class=(\S+)$/;

function parseCarrier(content: string): MessageClassification | undefined {
  const header = /^(?:\[from [^\r\n]+\]\r?\n\r?\n)?\[batched notices: (\d+)\]\r?\n/.exec(content);
  if (!header) return undefined;
  const count = Number(header[1]);
  const footer = /\r?\n\r?\ncoalesced by [^\r\n]+(?:\r?\n)?$/.exec(content);
  if (!Number.isSafeInteger(count) || count < 1 || !footer) {
    return { kind: 'invalid', reason: 'Incomplete batch framing' };
  }
  const lines = [...content.matchAll(/[^\r\n]*(?:\r?\n|$)/g)];
  const headings: Array<{ match: RegExpExecArray; start: number; bodyStart: number }> = [];
  let fence: { character: string; length: number } | undefined;
  for (const line of lines) {
    const start = line.index!;
    if (start < header[0].length || start >= footer.index!) continue;
    const text = line[0].replace(/\r?\n$/, '');
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) fence = { character: marker[0], length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length && !fenceMatch[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = memberHeader.exec(text);
    if (match) headings.push({ match, start, bodyStart: start + line[0].length });
  }
  // The numbers are publication sequences, not positions from 1 to count.
  if (headings.length !== count) return { kind: 'invalid', reason: 'Batch member count does not match its framing' };
  const members: HumanMember[] = [];
  const sources = new Set<string>();
  let previous = -1;
  for (let position = 0; position < headings.length; position++) {
    const heading = headings[position];
    const index = Number(heading.match[1]);
    const sourceId = heading.match[2];
    const sender = heading.match[3];
    if (!Number.isSafeInteger(index) || index <= previous || sources.has(sourceId) ||
        (!humanSender.test(sender) && !nonhumanSender.test(sender))) {
      return { kind: 'invalid', reason: 'Unrecognized batch member identity' };
    }
    previous = index;
    sources.add(sourceId);
    let end = headings[position + 1]?.start ?? footer.index!;
    if (position + 1 < headings.length) {
      const separator = /\r?\n\r?\n$/.exec(content.slice(heading.bodyStart, end));
      if (!separator) return { kind: 'invalid', reason: 'Missing batch member separator' };
      end -= separator[0].length;
    }
    members.push(Object.freeze({ index, sourceId, sender, content: content.slice(heading.bodyStart, end) }));
  }
  return Object.freeze({ kind: 'batch', members: Object.freeze(members),
    includesHuman: members.some((member) => humanSender.test(member.sender)) });
}

export function classifyMessage(record: CanonicalMessage): MessageClassification {
  const cached = classifications.get(record);
  if (cached) return cached;
  let result: MessageClassification;
  if (record.isBatchCarrier === true) {
    result = { kind: 'separate-carrier' };
  } else if (nonhumanTypes.has(record.messageType ?? '') || nonhumanSender.test(record.sender ?? '')) {
    // Only a nonhuman record can be a carrier. A human quoting the format is
    // ordinary human content and never gets interpreted as an envelope.
    result = parseCarrier(record.content) ?? { kind: 'nonhuman' };
  } else if (record.role === 'user' && (humanSender.test(record.sender ?? '') || record.raw.sender === null)) {
    result = { kind: 'human' };
  } else if (record.role === 'assistant') {
    result = { kind: 'assistant' };
  } else {
    result = { kind: 'unknown' };
  }
  classifications.set(record, result);
  return result;
}

export function isHumanMember(member: HumanMember): boolean {
  return humanSender.test(member.sender);
}

export interface VisibleMessage {
  readonly key: string;
  /** Canonical position and intact source; never mutated by the display projection. */
  readonly source: CanonicalMessage;
  readonly side: 'human' | 'agent';
  readonly member?: HumanMember;
}

export function projectMessages(records: readonly ConversationRecord[]): {
  messages: VisibleMessage[]; issues: readonly string[];
} {
  const byId = new Map<string, MessageClassification>();
  const issues: string[] = [];
  for (const record of records) {
    if (record.kind !== 'message') continue;
    const classification = classifyMessage(record);
    byId.set(record.id, classification);
    if (classification.kind === 'invalid') issues.push(classification.reason);
  }
  const messages: VisibleMessage[] = [];
  for (const record of records) {
    if (record.kind !== 'message') continue;
    const classification = byId.get(record.id)!;
    if (classification.kind === 'human') {
      messages.push({ key: record.id, source: record, side: 'human' });
    } else if (classification.kind === 'batch') {
      for (const member of classification.members) if (isHumanMember(member)) {
        messages.push({ key: JSON.stringify([record.id, 'member', member.sourceId]), source: record, side: 'human', member });
      }
    } else if (classification.kind === 'assistant') {
      const parent = record.replyToMessageId ? byId.get(record.replyToMessageId) : undefined;
      const humanParent = parent?.kind === 'human' || (parent?.kind === 'batch' && parent.includesHuman);
      if (record.turnIncludesHuman === false && humanParent) issues.push('Reply classification conflicts with its human parent');
      if (record.turnIncludesHuman === true && (parent?.kind === 'nonhuman' || (parent?.kind === 'batch' && !parent.includesHuman))) {
        issues.push('Reply classification conflicts with its nonhuman parent');
      }
      // Preserve a demonstrated human exchange even if the delivered flag conflicts.
      if (humanParent || record.turnIncludesHuman === true || (record.turnIncludesHuman === undefined &&
          (!parent || parent.kind === 'separate-carrier' || parent.kind === 'assistant' || parent.kind === 'unknown'))) {
        messages.push({ key: record.id, source: record, side: 'agent' });
      }
    }
  }
  return { messages, issues: Object.freeze([...new Set(issues)]) };
}
