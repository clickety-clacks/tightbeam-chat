import type { CanonicalMessage, CanonicalTurn, ConversationRecord, TurnProvenance, TurnSourceKind } from './types';
import { classifyMessage, isHumanMessage, scopedHumanFlag } from './messageVisibility';

const genericMessageTypes = new Set(['agent', 'assistant', 'human', 'marker', 'message', 'other', 'process', 'substrate', 'unknown', 'user']);

/** Only already-delivered typed relationships contribute; this performs no trigger lookup. */
export function createTurnProvenance(
  turn: CanonicalTurn,
  records: readonly ConversationRecord[],
  principalKey?: string,
  ownerUserId?: unknown,
): TurnProvenance {
  const trigger = records.find((row): row is CanonicalMessage => row.kind === 'message' &&
    row.sessionKey === turn.sessionKey && row.id === turn.messageId);
  const human = (trigger && isHumanMessage(trigger, principalKey)) || records.some((row) =>
    row.kind === 'message' && row.sessionKey === turn.sessionKey && row.turnSeq === turn.seq &&
      (isHumanMessage(row, principalKey) || (classifyMessage(row, principalKey) === 'assistant' && scopedHumanFlag(row, principalKey, ownerUserId) === true)));
  let sourceKind: TurnSourceKind = 'unknown';
  if (turn.triggerSource === 'mike' || (turn.triggerSource === 'batch' && turn.batchMemberCount === 1 && human)) {
    sourceKind = 'human';
  } else if (turn.triggerSource === 'agent') sourceKind = 'agent';
  else if (turn.triggerSource === 'process') sourceKind = 'substrate';
  const deliveredString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const sourceDisplayName = sourceKind === 'agent'
    ? deliveredString(trigger?.raw.senderDisplayName) ?? deliveredString(turn.raw.sourceDisplayName) ??
      deliveredString(turn.raw.senderDisplayName)
    : undefined;
  const sourceMessageType = sourceKind === 'substrate'
    ? [trigger?.messageType, trigger?.raw.sourceMessageType, turn.raw.sourceMessageType, turn.raw.messageType]
      .map(deliveredString).find((value) => value && !genericMessageTypes.has(value.toLowerCase()))
    : undefined;
  return Object.freeze({ turn, trigger, sourceKind, captionOrigin: '',
    ...(sourceDisplayName ? { sourceDisplayName } : {}),
    ...(sourceMessageType ? { sourceMessageType } : {}),
    ...(turn.triggerSource === 'batch' ? { batchCount: turn.batchMemberCount } : {}),
    humanMembers: Object.freeze([]),
  });
}
