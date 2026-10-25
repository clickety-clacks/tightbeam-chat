import entries from './release-notes.json';

export interface ReleaseNoteItem {
  readonly title: string;
  readonly description: string;
}

export interface ReleaseNotesEntry {
  readonly version: string;
  readonly items: readonly ReleaseNoteItem[];
}

export const RELEASE_NOTES = entries as readonly ReleaseNotesEntry[];
export const SEEN_RELEASE_VERSION_KEY = 'tightbeam-chat.release-notes.seen-version';

declare const __CHAT_RELEASE_VERSION__: string | null;

export function isChatVersion(value: unknown): value is string {
  return typeof value === 'string' && /^v\d+\.\d+\.\d+$/.test(value);
}

export const CHAT_RELEASE_VERSION = typeof __CHAT_RELEASE_VERSION__ === 'string' &&
  isChatVersion(__CHAT_RELEASE_VERSION__) ? __CHAT_RELEASE_VERSION__ : null;

function versionParts(version: string): readonly number[] {
  return version.slice(1).split('.').map(Number);
}

export function compareChatVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

function newestFirst(notes: readonly ReleaseNotesEntry[]): ReleaseNotesEntry[] {
  return [...notes].sort((left, right) => compareChatVersions(right.version, left.version));
}

export function releaseNotesForBuild(
  version: string | null,
  notes: readonly ReleaseNotesEntry[] = RELEASE_NOTES,
): ReleaseNotesEntry[] {
  return newestFirst(notes.filter((entry) => !version || compareChatVersions(entry.version, version) <= 0));
}

function storageCanRoundTrip(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): boolean {
  const probeKey = `${SEEN_RELEASE_VERSION_KEY}.probe.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const probeValue = 'available';
  try {
    storage.setItem(probeKey, probeValue);
    const available = storage.getItem(probeKey) === probeValue;
    storage.removeItem(probeKey);
    return available;
  } catch {
    try { storage.removeItem(probeKey); } catch { /* Storage is unavailable. */ }
    return false;
  }
}

export function unseenReleaseNotes(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  currentVersion: string | null,
  notes: readonly ReleaseNotesEntry[] = RELEASE_NOTES,
): ReleaseNotesEntry[] | null {
  if (!isChatVersion(currentVersion)) return null;
  try {
    const seenValue = storage.getItem(SEEN_RELEASE_VERSION_KEY);
    if (!storageCanRoundTrip(storage)) return null;
    const currentEntry = notes.find((entry) => entry.version === currentVersion);
    if (!currentEntry || !currentEntry.items.length) return null;
    if (seenValue === null) return [currentEntry];
    if (!isChatVersion(seenValue)) return null;
    if (compareChatVersions(seenValue, currentVersion) >= 0) return [];
    return newestFirst(notes.filter((entry) => compareChatVersions(entry.version, seenValue) > 0 &&
      compareChatVersions(entry.version, currentVersion) <= 0));
  } catch {
    return null;
  }
}

export function recordSeenReleaseVersion(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  currentVersion: string,
): boolean {
  if (!isChatVersion(currentVersion)) return false;
  try {
    const previous = storage.getItem(SEEN_RELEASE_VERSION_KEY);
    const highest = isChatVersion(previous) && compareChatVersions(previous, currentVersion) > 0
      ? previous : currentVersion;
    storage.setItem(SEEN_RELEASE_VERSION_KEY, highest);
    return true;
  } catch {
    return false;
  }
}
