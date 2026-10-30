import { useEffect, useState } from 'react';
import { TightbeamChat, createPublic019Transport, createTightbeamAdapter, type TightbeamAdapter } from '../src';
import { createActivitySummaryTransport } from '../src/activitySummaries';
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
  const configuredConversationHref = selectionSource === 'link' ? (window.location.pathname || '/') : undefined;

  useEffect(() => {
    if (!selected) return;
    setAdapter(undefined);
    setError('');
    try {
      const host = browserHost(selected);
      const origin = window.location.origin;
      const { transport, profile } = createPublic019Transport({
        baseUrl: `${origin}/__chat`,
        targetGateway: selected.gateway,
        host,
      });
      setAdapter({ ...createTightbeamAdapter(transport, profile),
        activitySummaries: createActivitySummaryTransport(host.fetch, `${origin}/__chat`) });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The configured Chat service is unavailable.');
    }
  }, [selected?.gateway, selected?.sessionKey, selected?.principalKey, selected?.deviceId]);

  if (selected && adapter) return <TightbeamChat sessionKey={selected.sessionKey} adapter={adapter}
    configuredConversationHref={configuredConversationHref} />;
  if (resolution.kind === 'configuration-error') return <main className="chat-entry-state">
    <p className="tb-chat-empty">No conversation is available.</p>
  </main>;

  return <main className="chat-entry-state">
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
      {configuredConversationHref &&
        <a href={configuredConversationHref}>Open the configured conversation</a>}
    </div>}
  </main>;
}
