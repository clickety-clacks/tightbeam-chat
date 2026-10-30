import { describe, expect, it, vi } from 'vitest';
import {
  advanceReadMarkerForwardOnly,
  compareReadMarkerSequences,
  prepareReadMarkerWrite,
  type ReadMarkerPort,
} from '../src/readMarker';
import type { ReadMarkerCandidate } from '../src/types';

const candidate: ReadMarkerCandidate = {
  userId: 'mike',
  scopeKey: 'agent:sample assistant with space:session-read-position',
  sequence: '90071992547409930',
};

describe('read marker sequence handling', () => {
  it('compares decimal message positions without numeric precision loss', () => {
    expect(compareReadMarkerSequences('90071992547409930', '90071992547409929')).toBe(1);
    expect(compareReadMarkerSequences('43', 42)).toBe(1);
    expect(compareReadMarkerSequences('12', '012')).toBeUndefined();
    expect(prepareReadMarkerWrite(candidate, '90071992547409931')).toBeUndefined();
    expect(prepareReadMarkerWrite(candidate, '90071992547409930')).toBeUndefined();
    expect(prepareReadMarkerWrite({ ...candidate, sequence: '43' }, 42)?.expectedCurrent).toBe(42);
  });

  it('rereads a conflict and retries only with a fresh expected value', async () => {
    const reads = [
      { supported: true as const, marker: null },
      { supported: true as const, marker: '90071992547409929' },
    ];
    const port: ReadMarkerPort = {
      readReadMarker: vi.fn(async () => reads.shift()!),
      writeReadMarker: vi.fn()
        .mockResolvedValueOnce('conflict')
        .mockResolvedValueOnce('written'),
    };

    await advanceReadMarkerForwardOnly(port, candidate, new AbortController().signal);

    expect(port.readReadMarker).toHaveBeenCalledTimes(2);
    expect(port.writeReadMarker).toHaveBeenNthCalledWith(1,
      { ...candidate, expectedCurrent: null }, expect.any(AbortSignal));
    expect(port.writeReadMarker).toHaveBeenNthCalledWith(2,
      { ...candidate, expectedCurrent: '90071992547409929' }, expect.any(AbortSignal));
  });

  it('keeps a higher marker and leaves unsupported routes untouched', async () => {
    const higher: ReadMarkerPort = {
      readReadMarker: vi.fn(async () => ({ supported: true, marker: '90071992547409931' })),
      writeReadMarker: vi.fn(),
    };
    const unavailable: ReadMarkerPort = {
      readReadMarker: vi.fn(async () => ({ supported: false as const })),
      writeReadMarker: vi.fn(),
    };

    await advanceReadMarkerForwardOnly(higher, candidate, new AbortController().signal);
    await advanceReadMarkerForwardOnly(unavailable, candidate, new AbortController().signal);

    expect(higher.writeReadMarker).not.toHaveBeenCalled();
    expect(unavailable.writeReadMarker).not.toHaveBeenCalled();
  });
});
