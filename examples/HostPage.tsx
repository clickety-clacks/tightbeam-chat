import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TightbeamChat, createPublic019Transport, createTightbeamAdapter, type TightbeamAdapter } from '../src';
import { createActivitySummaryTransport } from '../src/activitySummaries';
import { browserHost, type BrowserDevice } from './browserHost';
import { DevicePairingBar, type BrowserDeviceState } from './DevicePairingBar';
import { fetchDeviceStatus, forgetBrowserDevice, pairBrowser, type EphemeralReply, type PairOutcome } from './devicePairing';
import { EphemeralRepliesPanel, type ShownEphemeralReply } from './EphemeralRepliesPanel';
import { resolveEntrySelection, type ChatTarget, type ConfiguredChatTarget } from './entry';

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
  const pairingEnabled = selected?.devicePairingEnabled === true;
  const device = useBrowserDevice(pairingEnabled ? selected : undefined);
  // Paired (or just revoked): this browser's device sends. Unpaired: the provisioned
  // service path. Unknown: no adapter, so nothing can go out on the wrong credential.
  const sendMode = !pairingEnabled ? 'service'
    : device.state.kind === 'paired' || device.state.kind === 'revoked' ? `device:${device.state.deviceId}`
      : device.state.kind === 'unpaired' ? 'service' : undefined;
  const onCredentialLost = device.onCredentialLost;
  const ephemeral = useEphemeralReplies();
  const onEphemeral = ephemeral.add;

  useEffect(() => {
    if (!selected || !sendMode) {
      setAdapter(undefined);
      return;
    }
    setAdapter(undefined);
    setError('');
    try {
      const paired: BrowserDevice | undefined = sendMode.startsWith('device:')
        ? { deviceId: sendMode.slice('device:'.length), onCredentialLost, onEphemeral }
        : undefined;
      const host = browserHost(selected, paired);
      const origin = window.location.origin;
      const { transport, profile } = createPublic019Transport({
        baseUrl: `${origin}/__chat`,
        targetGateway: selected.gateway,
        restHumanSendEnabled: selected.restHumanSendEnabled,
        host,
      });
      setAdapter({ ...createTightbeamAdapter(transport, profile),
        activitySummaries: createActivitySummaryTransport(host.fetch, `${origin}/__chat`) });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The configured Chat service is unavailable.');
    }
  }, [selected?.gateway, selected?.sessionKey, selected?.principalKey, selected?.deviceId,
    selected?.restHumanSendEnabled, selected?.submitter?.identity, selected?.submitter?.displayName,
    sendMode, onCredentialLost, onEphemeral]);

  const bar = pairingEnabled && <DevicePairingBar state={device.state} onPair={device.pair}
    onForget={device.forget} onRetry={device.check} onUseService={device.useService} />;
  if (selected && adapter) {
    const chat = <TightbeamChat sessionKey={selected.sessionKey} adapter={adapter}
      configuredConversationHref={configuredConversationHref}
      submitterAttributionEnabled={selected.restHumanSendEnabled === true} />;
    return bar ? <div className="chat-device-layout">{bar}
      <EphemeralRepliesPanel replies={ephemeral.replies.filter((reply) => reply.sessionKey === selected.sessionKey)}
        onDismiss={ephemeral.dismiss} />
      {chat}</div> : chat;
  }
  if (resolution.kind === 'configuration-error') return <main className="chat-entry-state">
    <p className="tb-chat-empty">No conversation is available.</p>
  </main>;

  const entryState = <main className="chat-entry-state">
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
    {selected && !adapter && !error && sendMode && <p role="status">Connecting…</p>}
    {error && <div role="alert">
      <p>{error}</p>
      {configuredConversationHref &&
        <a href={configuredConversationHref}>Open the configured conversation</a>}
    </div>}
  </main>;
  return bar ? <div className="chat-device-layout">{bar}{entryState}</div> : entryState;
}

/**
 * This browser's device state, read from the bridge on load. Only an explicit
 * pairing changes it to paired; a dead credential is shown and never re-paired.
 */
function useBrowserDevice(target: ChatTarget | undefined) {
  const [state, setState] = useState<BrowserDeviceState>({ kind: 'checking' });
  const [revision, setRevision] = useState(0);
  const gateway = target?.gateway;
  // The bridge fetch helper depends only on the selected Gateway.
  const deviceFetch = useMemo(() => target ? browserHost(target).fetch
    : () => Promise.reject(new Error('Browser pairing is not available.')), [gateway]);

  useEffect(() => {
    if (!gateway) return;
    const controller = new AbortController();
    setState({ kind: 'checking' });
    fetchDeviceStatus(deviceFetch, controller.signal).then(
      (status) => {
        if (controller.signal.aborted) return;
        setState(status.paired
          ? { kind: 'paired', deviceId: status.deviceId, verified: status.verified,
            ...(status.userId ? { userId: status.userId } : {}), ...(status.scope ? { scope: status.scope } : {}) }
          : { kind: 'unpaired', ...(status.reason ? { notice: { reason: status.reason } } : {}) });
      },
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setState({ kind: 'check-failed', message: failure instanceof Error ? failure.message
          : "This browser's pairing could not be checked." });
      },
    );
    return () => controller.abort();
  }, [gateway, deviceFetch, revision]);

  const pair = useCallback(async (name: string, code: string): Promise<PairOutcome> => {
    const outcome = await pairBrowser(deviceFetch, { name, code });
    if (outcome.success) {
      setState({ kind: 'paired', deviceId: outcome.deviceId, userId: outcome.userId, verified: outcome.signedIn,
        ...(outcome.scope ? { scope: outcome.scope } : {}), notice: { reason: 'paired' } });
    }
    return outcome;
  }, [deviceFetch]);

  const forget = useCallback(async () => {
    await forgetBrowserDevice(deviceFetch);
    setState({ kind: 'unpaired', notice: { reason: 'forgotten' } });
  }, [deviceFetch]);

  const onCredentialLost = useCallback((reason: string) => {
    setState((current) => current.kind === 'paired' || current.kind === 'revoked'
      ? { kind: 'revoked', deviceId: current.deviceId, notice: { reason } }
      : current);
  }, []);
  const useService = useCallback(() => setState({ kind: 'unpaired' }), []);

  const check = useCallback(() => setRevision((value) => value + 1), []);
  return { state, pair, forget, onCredentialLost, useService, check };
}

/** Page-memory only: secrets and codes shown here are never stored anywhere and vanish on reload. */
function useEphemeralReplies() {
  const [replies, setReplies] = useState<readonly ShownEphemeralReply[]>([]);
  const nextKey = useRef(0);
  const add = useCallback((incoming: readonly EphemeralReply[]) => {
    const shown = incoming.map((reply) => ({ ...reply, key: nextKey.current++ }));
    setReplies((current) => [...current, ...shown]);
  }, []);
  const dismiss = useCallback((key: number) => setReplies((current) => current.filter((reply) => reply.key !== key)), []);
  return { replies, add, dismiss };
}
