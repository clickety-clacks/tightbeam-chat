import type { CanonicalMessage, CanonicalTurn, ConversationRecord, TurnProvenance, TurnSourceKind } from './types';
import { classifyMessage, isHumanMessage, scopedHumanFlag } from './messageVisibility';

/** Only delivered typed relationships contribute; this never reads a trigger. */
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
  if (turn.triggerSource === 'mike' || (turn.triggerSource === 'batch' && turn.batchMemberCount === 1)) {
    if (human) sourceKind = 'human';
  } else if (turn.triggerSource === 'agent') sourceKind = 'agent';
  else if (turn.triggerSource === 'process') sourceKind = 'substrate';
  return Object.freeze({ turn, trigger, sourceKind, captionOrigin: '',
    ...(turn.triggerSource === 'batch' ? { batchCount: turn.batchMemberCount } : {}),
    humanMembers: Object.freeze([]),
  });
}
