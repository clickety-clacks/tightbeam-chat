import type { BatchMember, CanonicalMessage, CanonicalTurn, TurnProvenance, TurnSourceKind } from './types';

const batchHeading = /^\[batched notices:\s*(\d+)\s*\]$/m;
const memberHeading = /^\[(\d+)\]\s+source=\S+\s+sender=([^\s]+)\s+cause=\S+\s+class=\S+.*$/gm;

export function turnSourceKind(origin: string): TurnSourceKind {
  const separator = origin.indexOf(':');
  if (separator <= 0 || separator === origin.length - 1) return 'unknown';
  switch (origin.slice(0, separator)) {
    case 'user': return 'human';
    case 'agent':
    case 'session': return 'agent';
    case 'process':
    case 'remedy': return 'substrate';
    default: return 'unknown';
  }
}

function readBatchMembers(content: string): { count: number; members: readonly BatchMember[] } | undefined {
  const heading = batchHeading.exec(content);
  if (!heading) return undefined;
  const count = Number(heading[1]);
  if (!Number.isSafeInteger(count) || count < 1) return { count: 0, members: [] };

  const matches = [...content.matchAll(memberHeading)];
  memberHeading.lastIndex = 0;
  if (matches.length !== count) return { count, members: [] };
  const indices = new Set<number>();
  const footer = /\n\ncoalesced by [^\r\n]+\s*$/.exec(content);
  const members = matches.map((match, offset) => {
    const index = Number(match[1]);
    indices.add(index);
    const start = (match.index ?? 0) + match[0].length;
    const nextStart = matches[offset + 1]?.index ?? footer?.index ?? content.length;
    let payload = content.slice(start, nextStart);
    if (payload.startsWith('\r\n')) payload = payload.slice(2);
    else if (payload.startsWith('\n')) payload = payload.slice(1);
    if (payload.endsWith('\r\n\r\n')) payload = payload.slice(0, -4);
    else if (payload.endsWith('\n\n')) payload = payload.slice(0, -2);
    return Object.freeze({ index, origin: match[2], content: payload });
  });
  if (indices.size !== count || members.some((member) => member.index < 1 || member.index > count)) {
    return { count, members: [] };
  }
  return { count, members: Object.freeze(members) };
}

export function createTurnProvenance(
  turn: CanonicalTurn,
  trigger?: CanonicalMessage,
  sourceDisplayName?: string,
): TurnProvenance {
  const sourceKind = turnSourceKind(turn.origin);
  const batch = sourceKind === 'substrate' && trigger ? readBatchMembers(trigger.content) : undefined;
  const humanMembers = batch?.members.filter((member) => turnSourceKind(member.origin) === 'human') ?? [];
  const captionOrigin = batch?.count === 1 && batch.members.length === 1
    ? batch.members[0].origin
    : turn.origin;
  return Object.freeze({
    turn,
    trigger,
    sourceKind,
    sourceDisplayName,
    sourceMessageType: trigger?.messageType,
    ...(batch ? { batchCount: batch.count } : {}),
    captionOrigin,
    humanMembers: Object.freeze(humanMembers),
  });
}

export function provenanceHasHumanSource(provenance: TurnProvenance): boolean {
  return provenance.sourceKind === 'human' || provenance.humanMembers.length > 0;
}
