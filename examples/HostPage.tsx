import { useEffect, useState } from 'react';
import { TightbeamChat, createPublic019Transport, createTightbeamAdapter, type TightbeamAdapter } from '../src';
import { browserHost } from './browserHost';
import { resolveEntrySelection, type ConfiguredChatTarget } from './entry';

export function HostPage({ defaultTarget, configurationError }: {
  readonly defaultTarget: ConfiguredChatTarget;
  readonly configurationError?: string;
}) {
  const [adapter, setAdapter] = useState<TightbeamAdapter>();
  const [error, setError] = useState('');
  const resolution = resolveEntrySelection(window.location.search, defaultTarget);
  const selected = resolution.kind === 'selected' ? resolution.target : undefined;
  const selectionSource = resolution.kind === 'selected' ? resolution.source : undefined;
  const unavailable = resolution.kind === 'unavailable-selection' ? resolution : undefined;

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    let current = true;
    setAdapter(undefined);
    setError('');
    void (async () => {
      try {
        const host = browserHost(selected);
        const origin = window.location.origin;
        const response = await host.fetch(`${origin}/__chat/gateway/version`, { method: 'GET', signal: controller.signal });
        if (response.status === 503) {
          let failure: unknown;
          try { failure = await response.json(); } catch { failure = undefined; }
          if (failure && typeof failure === 'object' && 'error' in failure &&
              failure.error && typeof failure.error === 'object' && 'code' in failure.error &&
              failure.error.code === 'chat_gateway_unavailable') {
            throw new Error('No Gateway access is provisioned for the selected conversation. The selected target was not changed.');
          }
        }
        if (!response.ok) throw new Error('The configured Chat service is unavailable.');
        const version = await response.json() as { protocolVersion?: unknown };
        if (version.protocolVersion !== 1) {
          throw new Error('The configured service does not expose Gateway API protocol 1.');
        }
        const { transport, profile } = createPublic019Transport({
          baseUrl: `${origin}/__chat`,
          gatewayVersionPath: '/gateway/version',
          targetGateway: selected.gateway,
          host,
        });
        if (current) setAdapter(createTightbeamAdapter(transport, profile));
      } catch (failure) {
        if (current && !controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : 'The configured Chat service is unavailable.');
        }
      }
    })();
    return () => { current = false; controller.abort(); };
  }, [selected?.gateway, selected?.sessionKey, selected?.principalKey, selected?.deviceId]);

  if (selected && adapter) return <TightbeamChat sessionKey={selected.sessionKey} adapter={adapter} />;

  return <main className="chat-entry-state">
    {resolution.kind === 'configuration-error' && <p role="alert">
      {configurationError ?? resolution.message}
    </p>}
    {resolution.kind === 'invalid-selection' && <div role="alert">
      <p>{resolution.message}</p>
      {configurationError && <p>{configurationError}</p>}
      {resolution.canRecoverToConfigured &&
        <a href={window.location.pathname || '/'}>Open the configured conversation</a>}
    </div>}
    {unavailable && <div role="alert">
      <p>{unavailable.message}</p>
      {configurationError && <p>{configurationError}</p>}
      {unavailable.canRecoverToConfigured &&
        <a href={window.location.pathname || '/'}>Open the configured conversation</a>}
    </div>}
    {selected && !adapter && !error && <p role="status">Connecting…</p>}
    {error && <div role="alert">
      <p>{error}</p>
      {selectionSource === 'link' &&
        <a href={window.location.pathname || '/'}>Open the configured conversation</a>}
    </div>}
  </main>;
}
