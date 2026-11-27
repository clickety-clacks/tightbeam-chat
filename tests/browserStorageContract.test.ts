import { afterEach, describe, expect, it } from 'vitest';
import contract from '../scripts/chat-storage-contract.json';
import { recordSeenReleaseVersion, unseenReleaseNotes } from '../src/releaseNotes';
import { readRememberedSubmitterDisplayName, writeRememberedSubmitterDisplayName } from '../src/submitterAttribution';
import { readDismissedPrompt, storeDismissedPrompt } from '../src/TightbeamChat';
import { readHidden, writeHidden } from '../src/WorkItemStrip';

// Readers' browsers already hold these. Each entry must still be read as meant and written the same way.
// Changing one changes the contract file, which the release tag job requires the notes to declare.
const store = window.localStorage;
const check: Record<string, { reads(): void; writes(): void }> = {
  'tightbeam-chat.submitter.display-name': {
    reads: () => expect(readRememberedSubmitterDisplayName(store)).toBe('Ada Lovelace'),
    writes: () => { writeRememberedSubmitterDisplayName(store, 'Ada Lovelace'); },
  },
  'tightbeam-chat.release-notes.seen-version': {
    reads: () => expect(unseenReleaseNotes(store, 'v0.1.114',
      [{ version: 'v0.1.114', items: [{ title: 'T', description: 'D' }] }])).toEqual([]),
    writes: () => { recordSeenReleaseVersion(store, 'v0.1.114'); },
  },
  'tb-chat-work-items-hidden': {
    reads: () => expect(readHidden()).toBe(true),
    writes: () => writeHidden(true),
  },
  'tb-chat:dismissed-prompt:agent%3Aexample%3Amain': {
    reads: () => expect(readDismissedPrompt('agent:example:main')).toBe(true),
    writes: () => storeDismissedPrompt('agent:example:main', true),
  },
};

afterEach(() => store.clear());

describe('browser storage contract', () => {
  it('covers exactly the contracted entries', () => {
    expect(contract.map(item => item.key).sort()).toEqual(Object.keys(check).sort());
  });

  it.each(contract)('reads and writes $key as stored', ({ key, value }) => {
    store.setItem(key, value);
    check[key].reads();
    store.clear();
    check[key].writes();
    expect(store.getItem(key)).toBe(value);
  });
});
