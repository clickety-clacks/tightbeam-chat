import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReleaseNotesDialog } from '../src/ReleaseNotesDialog';
import {
  normalizeSubmitterAttribution, readRememberedSubmitterDisplayName,
  REMEMBERED_SUBMITTER_DISPLAY_NAME_KEY, writeRememberedSubmitterDisplayName,
} from '../src/submitterAttribution';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('submitter attribution', () => {
  it('uses only supplied identity and display values, with remembered name as the display fallback', () => {
    expect(normalizeSubmitterAttribution(undefined, ' Riley ')).toEqual({ identity: null, displayName: 'Riley' });
    expect(normalizeSubmitterAttribution({ identity: 'tailnet-login' }, 'Riley'))
      .toEqual({ identity: 'tailnet-login', displayName: 'Riley' });
    expect(normalizeSubmitterAttribution({ identity: 'tailnet-login', displayName: 'Request name' }, 'Riley'))
      .toEqual({ identity: 'tailnet-login', displayName: 'Request name' });
    expect(normalizeSubmitterAttribution(undefined)).toBeUndefined();
  });

  it('stores a trimmed remembered name and removes an empty value', () => {
    expect(writeRememberedSubmitterDisplayName(window.localStorage, '  Riley  ')).toBe(true);
    expect(window.localStorage.getItem(REMEMBERED_SUBMITTER_DISPLAY_NAME_KEY)).toBe('Riley');
    expect(readRememberedSubmitterDisplayName(window.localStorage)).toBe('Riley');
    expect(writeRememberedSubmitterDisplayName(window.localStorage, '   ')).toBe(true);
    expect(window.localStorage.getItem(REMEMBERED_SUBMITTER_DISPLAY_NAME_KEY)).toBeNull();
  });

  it('shows the remembered-name setting only while attribution is enabled and saves changes', () => {
    const settings = { kind: 'settings', page: 'home' } as const;
    const renderSettings = (enabled: boolean) => render(<ReleaseNotesDialog overlay={settings} entries={[]}
      onClose={() => {}} onOpenReleaseNotes={() => {}} onBack={() => {}}
      submitterAttributionEnabled={enabled} />);

    const hidden = renderSettings(false);
    expect(screen.queryByRole('textbox', { name: 'Name shown on your prompts' })).toBeNull();
    hidden.unmount();

    renderSettings(true);
    const field = screen.getByRole('textbox', { name: 'Name shown on your prompts' });
    fireEvent.change(field, { target: { value: 'Riley' } });
    fireEvent.blur(field);
    expect(window.localStorage.getItem(REMEMBERED_SUBMITTER_DISPLAY_NAME_KEY)).toBe('Riley');
  });
});
