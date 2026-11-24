import { afterEach, describe, expect, it, vi } from 'vitest';
import { newUuid } from '../src/uuid';

const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newUuid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('mints a version 4 UUID with randomUUID present', () => {
    expect(newUuid()).toMatch(v4);
  });

  it('mints a version 4 UUID from getRandomValues when randomUUID is absent (insecure context)', () => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => original.getRandomValues(array) });
    expect((globalThis.crypto as { randomUUID?: unknown }).randomUUID).toBeUndefined();
    const ids = Array.from({ length: 50 }, () => newUuid());
    for (const id of ids) expect(id).toMatch(v4);
    expect(new Set(ids).size).toBe(50);
  });

  it('keeps the variant and version bits whatever the random bytes', () => {
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => { array.fill(0xff); return array; } });
    expect(newUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => { array.fill(0); return array; } });
    expect(newUuid()).toBe('00000000-0000-4000-8000-000000000000');
  });
});
