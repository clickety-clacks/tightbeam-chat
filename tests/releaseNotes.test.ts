import { describe, expect, it } from 'vitest';
import {
  compareChatVersions, recordSeenReleaseVersion, releaseNotesForBuild, SEEN_RELEASE_VERSION_KEY,
  unseenReleaseNotes, type ReleaseNotesEntry,
} from '../src/releaseNotes';

const notes: readonly ReleaseNotesEntry[] = [
  { version: 'v0.1.25', items: [{ title: 'Older', description: 'An earlier change.' }] },
  { version: 'v0.1.26', items: [{ title: 'Middle', description: 'A middle change.' }] },
  { version: 'v0.1.27', items: [{ title: 'Previous', description: 'A previous change.' }] },
  { version: 'v0.1.28', items: [{ title: 'Current', description: 'A current change.' }] },
];

function memoryStorage(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('release notes versions and browser record', () => {
  it('compares and filters numeric release versions', () => {
    expect(compareChatVersions('v0.10.0', 'v0.2.9')).toBeGreaterThan(0);
    expect(releaseNotesForBuild('v0.1.26', notes).map((entry) => entry.version))
      .toEqual(['v0.1.26', 'v0.1.25']);
    expect(releaseNotesForBuild(null, notes).map((entry) => entry.version))
      .toEqual(['v0.1.28', 'v0.1.27', 'v0.1.26', 'v0.1.25']);
  });

  it('shows only the current release for a first visit and all skipped releases newest first', () => {
    expect(unseenReleaseNotes(memoryStorage(), 'v0.1.28', notes)?.map((entry) => entry.version))
      .toEqual(['v0.1.28']);
    const seenOlder = memoryStorage({ [SEEN_RELEASE_VERSION_KEY]: 'v0.1.24' });
    expect(unseenReleaseNotes(seenOlder, 'v0.1.28', notes)?.map((entry) => entry.version))
      .toEqual(['v0.1.28', 'v0.1.27', 'v0.1.26', 'v0.1.25']);
    expect(unseenReleaseNotes(memoryStorage({ [SEEN_RELEASE_VERSION_KEY]: 'v0.1.28' }), 'v0.1.27', notes))
      .toEqual([]);
    expect(unseenReleaseNotes(memoryStorage(), null, notes)).toBeNull();
  });

  it('does not open What\'s New when the current version has no note entry', () => {
    expect(unseenReleaseNotes(memoryStorage(), 'v0.1.29', notes)).toBeNull();
  });

  it('fails closed when browser storage cannot be read or written and preserves a higher seen version', () => {
    const unreadable = { ...memoryStorage(), getItem: () => { throw new Error('blocked'); } };
    const unwritable = { ...memoryStorage(), setItem: () => { throw new Error('blocked'); } };
    expect(unseenReleaseNotes(unreadable, 'v0.1.28', notes)).toBeNull();
    expect(unseenReleaseNotes(unwritable, 'v0.1.28', notes)).toBeNull();

    const storage = memoryStorage({ [SEEN_RELEASE_VERSION_KEY]: 'v0.1.29' });
    expect(recordSeenReleaseVersion(storage, 'v0.1.28')).toBe(true);
    expect(storage.getItem(SEEN_RELEASE_VERSION_KEY)).toBe('v0.1.29');
  });
});
