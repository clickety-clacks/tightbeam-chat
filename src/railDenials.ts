import type { RailDenialIdentity } from './types';

/** The live event and its history row can differ slightly in event-clock precision. */
export const railDenialMatchWindowMs = 5_000;

/** Keep selected-session denials, plus user denials matched to its known owner. */
export function isHistoryRailDenialForSession(
  denial: Pick<RailDenialIdentity, 'sessionKey' | 'principal'>,
  sessionKey: string,
  ownerUserId?: unknown,
): boolean {
  if (denial.sessionKey !== sessionKey) return false;
  if (denial.principal === `session:${sessionKey}`) return true;
  return typeof ownerUserId === 'string' && ownerUserId.length > 0 &&
    denial.principal === `user:${ownerUserId}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Match only a complete source-backed live/history pair, never by ID alone. */
export function sameRailDenial(left: RailDenialIdentity, right: RailDenialIdentity): boolean {
  if (left.sessionKey !== right.sessionKey || left.origin === undefined || right.origin === undefined ||
      left.origin !== right.origin || left.principal !== right.principal || left.verb !== right.verb ||
      left.rule !== right.rule || left.payload === undefined || right.payload === undefined ||
      left.occurredAt === undefined || right.occurredAt === undefined ||
      Math.abs(left.occurredAt - right.occurredAt) > railDenialMatchWindowMs) return false;
  try {
    return stableJson(left.payload) === stableJson(right.payload);
  } catch {
    return false;
  }
}
