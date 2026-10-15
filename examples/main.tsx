import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { TightbeamChat, createPublic019Transport, createTightbeamAdapter, type TightbeamAdapter } from '../src';
import { browserHost, pairDevice, selection } from './browserHost';
import './site.css';

function HostPage() {
  const [adapter, setAdapter] = useState<TightbeamAdapter>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState(() => `chat_${crypto.randomUUID()}`);
  const [token, setToken] = useState('');
  const attempt = useRef<AbortController | null>(null);
  useEffect(() => () => attempt.current?.abort(), []);
  let selected: ReturnType<typeof selection> | undefined;
  let selectionError = '';
  try { selected = selection(window.location.search); }
  catch (error) { selectionError = String((error as Error).message); }
  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const host = browserHost(selected.gateway, String(data.get('token')), String(data.get('device')));
    form.reset();
    setToken('');
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setBusy(true); setError('');
    try {
      // Establish the actual principal before the component captures its identity.
      const channel = await host.openAuthenticatedHuman(controller.signal);
      channel.close();
      const response = await host.fetch(`${selected.gateway}/version`, { signal: controller.signal });
      if (!response.ok) throw new Error('Could not read gateway version.');
      const version = await response.json();
      if (version.version !== '0.1.9') throw new Error('This example requires Tightbeam 0.1.9.');
      const { transport, profile } = createPublic019Transport({ baseUrl: selected.gateway,
        build: version.build, sha: version.sha, host });
      if (!controller.signal.aborted) setAdapter(createTightbeamAdapter(transport, profile));
    } catch (error) { if (!controller.signal.aborted) setError((error as Error).message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <main>
    <header><h1>Tightbeam Chat</h1>
      {selected && <p>Gateway: {selected.gateway}<br />Session: {selected.sessionKey}</p>}
    </header>
    {selectionError ? <p role="alert">{selectionError} Use <code>?gateway=https%3A%2F%2Fgateway.example&session=SESSION_KEY</code>.</p>
      : adapter ? <>
        <button onClick={() => { setAdapter(undefined); attempt.current?.abort(); }}>Sign out</button>
        <div className="chat-slot"><TightbeamChat sessionKey={selected!.sessionKey} adapter={adapter} newestFirst /></div>
      </> : <form onSubmit={(event) => void signIn(event)}>
        <p>Sign in with an approved device's ID and token. Credentials stay in memory until sign-out or reload.</p>
        <label>Device ID <input name="device" required autoComplete="off" value={device} onChange={(event) => setDevice(event.target.value)} /></label>
        <button type="button" disabled={busy || !device} onClick={() => {
          setBusy(true); setError('');
          void pairDevice(selected!.gateway, device).then(setToken).catch((error: Error) => setError(error.message))
            .finally(() => setBusy(false));
        }}>Pair device</button>
        <p>Pair this browser, obtain administrator approval if requested, then pair again and sign in. You can also supply an existing device ID and token.</p>
        <label>Device token <input name="token" type="password" required autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label>
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {error && <p role="alert">{error}</p>}
      </form>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<HostPage />);
