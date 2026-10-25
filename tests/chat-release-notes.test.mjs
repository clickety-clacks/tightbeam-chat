import { describe, expect, it } from 'vitest';
import { hasUserFacingNotesForTag } from '../scripts/chat-release-notes.mjs';

describe('release note tag check', () => {
  it('requires a matching version with at least one nonempty note', () => {
    const entries = [
      { version: 'v0.1.26', items: [] },
      { version: 'v0.1.27', items: [{ title: 'A change', description: 'What changed.' }] },
    ];
    expect(hasUserFacingNotesForTag(entries, 'v0.1.27')).toBe(true);
    expect(hasUserFacingNotesForTag(entries, 'v0.1.28')).toBe(false);
    expect(hasUserFacingNotesForTag([{ version: 'v0.1.28', items: [{ title: '', description: '' }] }], 'v0.1.28'))
      .toBe(false);
  });
});
