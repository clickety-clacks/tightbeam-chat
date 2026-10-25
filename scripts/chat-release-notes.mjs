export function hasUserFacingNotesForTag(entries, tag) {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => entry && entry.version === tag && Array.isArray(entry.items) &&
    entry.items.some((item) => item && typeof item.title === 'string' && item.title.trim() &&
      typeof item.description === 'string' && item.description.trim()));
}
