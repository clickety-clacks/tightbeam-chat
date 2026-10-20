import { useEffect, useState } from 'react';
import { HostPage } from './HostPage';
import { loadConfiguredChatTarget, type ChatTarget } from './entry';

type ConfigState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly target: ChatTarget }
  | { readonly status: 'error'; readonly message: string };

/** Loads service configuration before binding a link to the provisioned Gateway identity. */
export function RuntimeEntry() {
  const [config, setConfig] = useState<ConfigState>({ status: 'loading' });

  useEffect(() => {
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
  }, []);

  if (config.status === 'loading') return <main className="chat-entry-state" aria-busy="true">
    <p role="status">Connecting…</p>
  </main>;
  if (config.status === 'error') return <HostPage defaultTarget={{}} configurationError={config.message} />;
  return <HostPage defaultTarget={config.target} />;
}
