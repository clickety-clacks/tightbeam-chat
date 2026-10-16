import { useEffect, useState } from 'react';
import { HostPage } from './HostPage';
import { loadConfiguredChatTarget, resolveEntrySelection, type ConfiguredChatTarget } from './entry';

type ConfigState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly target: ConfiguredChatTarget }
  | { readonly status: 'error'; readonly message: string };

/** Resolves a link directly, or loads the private server's configured root target. */
export function RuntimeEntry() {
  const hasValidLinkTarget = resolveEntrySelection(window.location.search, undefined).kind === 'selected';
  const [config, setConfig] = useState<ConfigState>({ status: 'loading' });

  useEffect(() => {
    if (hasValidLinkTarget) return;
    const controller = new AbortController();
    let current = true;
    void loadConfiguredChatTarget(fetch, controller.signal).then(
      (target) => { if (current) setConfig({ status: 'ready', target }); },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : 'The configured Chat target could not be loaded.';
        if (current) setConfig({ status: 'error', message });
      },
    );
    return () => { current = false; controller.abort(); };
  }, [hasValidLinkTarget]);

  if (hasValidLinkTarget) return <HostPage defaultTarget={{}} />;
  if (config.status === 'loading') return <main aria-busy="true">
    <header><h1>Tightbeam Chat</h1></header>
    <p role="status">Loading the configured Chat target…</p>
  </main>;
  if (config.status === 'error') return <HostPage defaultTarget={{}} configurationError={config.message} />;
  return <HostPage defaultTarget={config.target} />;
}
