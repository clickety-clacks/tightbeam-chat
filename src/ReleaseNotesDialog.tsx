import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { ReleaseNotesEntry } from './releaseNotes';

export type ChatOverlay =
  | { readonly kind: 'whats-new'; readonly entries: readonly ReleaseNotesEntry[] }
  | { readonly kind: 'settings'; readonly page: 'home' | 'release-notes' };

export function ReleaseNotesDialog({ overlay, entries, onClose, onOpenReleaseNotes, onBack }:
  { overlay: ChatOverlay; entries: readonly ReleaseNotesEntry[]; onClose: () => void;
    onOpenReleaseNotes: () => void; onBack: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const title = overlay.kind === 'whats-new' ? "What's new"
    : overlay.page === 'home' ? 'Settings' : 'Release notes';
  const shownEntries = overlay.kind === 'whats-new' ? overlay.entries : entries;

  useLayoutEffect(() => {
    closeButton.current?.focus({ preventScroll: true });
  }, [overlay.kind, overlay.kind === 'settings' ? overlay.page : undefined]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return <div className="tb-chat-overlay">
    <section className="tb-chat-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="tb-chat-modal-header">
        <h2 id={titleId}>{title}</h2>
        <button ref={closeButton} type="button" className="tb-chat-modal-close"
          aria-label={`Close ${title}`} onClick={onClose}>×</button>
      </header>
      {overlay.kind === 'settings' && overlay.page === 'home'
        ? <div className="tb-chat-modal-content">
          <button type="button" className="tb-chat-settings-item" onClick={onOpenReleaseNotes}>
            <span>Release notes</span><span aria-hidden="true">›</span>
          </button>
        </div>
        : <div className="tb-chat-modal-content">
          {overlay.kind === 'settings' && <button type="button" className="tb-chat-settings-back"
            onClick={onBack}>‹ Settings</button>}
          {shownEntries.map((entry) => <section className="tb-chat-release-entry" key={entry.version}>
            <h3>{entry.version}</h3>
            <ul>
              {entry.items.map((item) => <li key={`${entry.version}-${item.title}`}>
                <strong>{item.title}</strong><p>{item.description}</p>
              </li>)}
            </ul>
          </section>)}
        </div>}
    </section>
  </div>;
}
