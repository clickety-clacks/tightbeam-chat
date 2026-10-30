import type {
  ReadMarkerCandidate,
  ReadMarkerReadResult,
  ReadMarkerWriteRequest,
  ReadMarkerWriteResult,
} from './types';

const decimalSequence = /^(0|[1-9]\d*)$/;

function decimalValue(value: string | number): string | undefined {
  if (typeof value === 'string') return decimalSequence.test(value) ? value : undefined;
  if (Number.isSafeInteger(value) && value >= 0) return value.toString(10);
  return undefined;
}

export function isReadMarkerSequence(value: string | number): boolean {
  return decimalValue(value) !== undefined;
}

/** Compare canonical decimal sequences without converting them to imprecise numbers. */
export function compareReadMarkerSequences(left: string | number, right: string | number): -1 | 0 | 1 | undefined {
  const leftValue = decimalValue(left);
  const rightValue = decimalValue(right);
  if (leftValue === undefined || rightValue === undefined) return undefined;
  const a = BigInt(leftValue);
  const b = BigInt(rightValue);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Prepare a conditional write only when the new position advances the stored one. */
export function prepareReadMarkerWrite(candidate: ReadMarkerCandidate,
  expectedCurrent: string | number | null): ReadMarkerWriteRequest | undefined {
  if (!candidate.userId || !candidate.scopeKey || !isReadMarkerSequence(candidate.sequence) ||
      (expectedCurrent !== null && !isReadMarkerSequence(expectedCurrent))) return undefined;
  if (expectedCurrent !== null && compareReadMarkerSequences(candidate.sequence, expectedCurrent)! <= 0) return undefined;
  return Object.freeze({ ...candidate, expectedCurrent });
}

export interface ReadMarkerPort {
  readReadMarker(scopeKey: string, signal: AbortSignal): Promise<ReadMarkerReadResult>;
  writeReadMarker(request: ReadMarkerWriteRequest, signal: AbortSignal): Promise<ReadMarkerWriteResult>;
}

/** Read, compare, and conditionally advance a marker without ever moving it backward. */
export async function advanceReadMarkerForwardOnly(port: ReadMarkerPort,
  candidate: ReadMarkerCandidate, signal: AbortSignal): Promise<void> {
  if (!candidate.userId || !candidate.scopeKey || !isReadMarkerSequence(candidate.sequence)) return;

  let current = await port.readReadMarker(candidate.scopeKey, signal);
  if (!current.supported || (current.marker !== null && !isReadMarkerSequence(current.marker))) return;
  let conflicts = 0;

  while (true) {
    const request = prepareReadMarkerWrite(candidate, current.marker);
    if (!request) return;

    const result = await port.writeReadMarker(request, signal);
    if (result !== 'conflict') return;

    const reread = await port.readReadMarker(candidate.scopeKey, signal);
    if (!reread.supported || (reread.marker !== null && !isReadMarkerSequence(reread.marker))) return;
    current = reread;
    conflicts++;
    if (conflicts >= 3) return;
  }
}
