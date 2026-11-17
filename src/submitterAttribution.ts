import type { SubmitterAttribution } from './types';

export const REMEMBERED_SUBMITTER_DISPLAY_NAME_KEY = 'tightbeam-chat.submitter.display-name';

export function nonemptySubmitterText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

/** Normalize optional attribution fields without deriving them from Chat identity. */
export function normalizeSubmitterAttribution(value: unknown,
  rememberedDisplayName?: unknown): SubmitterAttribution | undefined {
  const supplied = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const identity = nonemptySubmitterText(supplied.identity);
  const displayName = nonemptySubmitterText(supplied.displayName) ?? nonemptySubmitterText(rememberedDisplayName);
  if (!identity && !displayName) return undefined;
  return Object.freeze({ identity: identity ?? null, displayName: displayName ?? null });
}

export function readRememberedSubmitterDisplayName(storage: Pick<Storage, 'getItem'>): string | undefined {
  try {
    return nonemptySubmitterText(storage.getItem(REMEMBERED_SUBMITTER_DISPLAY_NAME_KEY));
  } catch {
    return undefined;
  }
}

export function writeRememberedSubmitterDisplayName(storage: Pick<Storage, 'setItem' | 'removeItem'>,
  value: unknown): boolean {
  try {
    const displayName = nonemptySubmitterText(value);
    if (displayName) storage.setItem(REMEMBERED_SUBMITTER_DISPLAY_NAME_KEY, displayName);
    else storage.removeItem(REMEMBERED_SUBMITTER_DISPLAY_NAME_KEY);
    return true;
  } catch {
    return false;
  }
}

export function readBrowserRememberedSubmitterDisplayName(): string | undefined {
  try {
    return typeof window === 'undefined' ? undefined : readRememberedSubmitterDisplayName(window.localStorage);
  } catch {
    return undefined;
  }
}

export function writeBrowserRememberedSubmitterDisplayName(value: unknown): boolean {
  try {
    return typeof window !== 'undefined' && writeRememberedSubmitterDisplayName(window.localStorage, value);
  } catch {
    return false;
  }
}
