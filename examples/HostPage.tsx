import { useEffect, useRef, useState, type FormEvent } from 'react';
import { TightbeamChat, createPublic019Transport, createTightbeamAdapter, type TightbeamAdapter } from '../src';
import { browserHost } from './browserHost';
import { canUseBrowserCredentials, resolveEntrySelection, type ConfiguredChatTarget } from './entry';

export function HostPage({ defaultTarget, configurationError }: {
  readonly defaultTarget: ConfiguredChatTarget;
  readonly configurationError?: string;
}) {
  const [adapter, setAdapter] = useState<TightbeamAdapter>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState('');
  const [token, setToken] = useState('');
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => attempt.current?.abort(), []);

  const resolution = resolveEntrySelection(window.location.search, defaultTarget);
  const selected = resolution.kind === 'selected' ? resolution.target : undefined;
  const selectionSource = resolution.kind === 'selected' ? resolution.source : undefined;
  const secureContext = canUseBrowserCredentials(window.location.href, window.isSecureContext);
  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !secureContext) return;
    const controller = new AbortController();
    attempt.current?.abort();
    attempt.current = controller;
    setBusy(true); setError('');
    try {
      const host = browserHost(selected.gateway, token, device);
      setToken('');
      // The person explicitly signs in before the adapter opens or reads the selected session.
      const channel = await host.openAuthenticatedHuman(controller.signal);
      channel.close();
      const response = await host.fetch(`${selected.gateway}/version`, { signal: controller.signal });
      if (!response.ok) throw new Error('Could not read the selected gateway version.');
      const version = await response.json();
      if (version.version !== '0.1.9') throw new Error('This example requires a supported Tightbeam 0.1.9 build.');
      const { transport, profile } = createPublic019Transport({ baseUrl: selected.gateway,
        build: version.build, sha: version.sha, host });
      if (!controller.signal.aborted) setAdapter(createTightbeamAdapter(transport, profile));
    } catch (error) {
      if (!controller.signal.aborted) setError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return <main>
    <header><h1>Tightbeam Chat</h1></header>
    {selected && <section aria-labelledby="selected-target-heading">
      <h2 id="selected-target-heading">Selected target</h2>
      <p>Gateway: <code>{selected.gateway}</code></p>
      <p>Session: <code>{selected.sessionKey}</code></p>
      <p>{selectionSource === 'configured' ? 'Using the configured target.' : 'Selected from this link.'}</p>
    </section>}
    {resolution.kind === 'configuration-error' && <p role="alert">
      {configurationError ?? resolution.message}
    </p>}
    {resolution.kind === 'invalid-selection' && <div role="alert">
      <p>{resolution.message}</p>
      {configurationError && <p>{configurationError}</p>}
      {resolution.canRecoverToConfigured &&
        <a href={window.location.pathname || '/'}>Use configured default target</a>}
    </div>}
    {selected && !secureContext && <p role="alert">
      Sign-in requires a secure browser context. Open Chat over private HTTPS; localhost is available for local development.
    </p>}
    {selected && (adapter ? <>
      <button onClick={() => { setAdapter(undefined); attempt.current?.abort(); setToken(''); }}>Sign out</button>
      <div className="chat-slot"><TightbeamChat sessionKey={selected.sessionKey} adapter={adapter} /></div>
    </> : <form onSubmit={(event) => void signIn(event)}>
      <p>Sign in separately with an existing approved human device. Credentials are used only after you choose Sign in.</p>
      <label>Device ID <input name="device" required autoComplete="username" value={device}
        onChange={(event) => setDevice(event.target.value)} /></label>
      <label>Device token <input name="token" type="password" required autoComplete="current-password"
        value={token} onChange={(event) => setToken(event.target.value)} /></label>
      <button disabled={busy || !secureContext}>{busy ? 'Signing in…' : 'Sign in'}</button>
      {error && <p role="alert">{error}</p>}
    </form>)}
  </main>;
}
