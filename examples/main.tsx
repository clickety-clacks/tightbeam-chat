import React from 'react';
import { createRoot } from 'react-dom/client';
import { TightbeamChat, createTightbeamAdapter } from '../src';
import { fixtureTarget, LocalFixtureTransport } from './mockTransport';
import './site.css';

const transport = new LocalFixtureTransport();
const adapter = createTightbeamAdapter(transport, { ...fixtureTarget, label: 'LOCAL FIXTURE — no Tightbeam backend' });

function HostPage() {
  return <main>
    <header><p className="eyebrow">LOCAL FIXTURE · NO BACKEND CONNECTION</p>
      <h1>Host application with embedded Tightbeam Chat</h1>
      <p>This page is a runnable component fixture. Its conversation, transitions, reset and acknowledgements are synthetic.</p>
    </header>
    <div className="layout">
      <aside><h2>Host controls</h2><p>The host selects <code>fixture-session</code>. The component has no session picker.</p>
        <button onClick={() => transport.appendAssistant()}>Append fixture message</button>
        <button onClick={() => transport.resetAgentContext()}>Reset fixture agent context</button>
        <button onClick={() => transport.disconnect()}>Interrupt fixture connection</button>
        <p>Scroll upward in the transcript to load all earlier retained fixture history.</p>
      </aside>
      <div className="chat-slot">
        <TightbeamChat sessionKey="fixture-session" adapter={adapter}
          renderMessage={(record, context) => record.kind === 'message' && record.messageType === 'future-kind'
            ? <div><strong>Host renderer for future-kind</strong><p>{record.content}</p>
                <button onClick={() => void context.copyText()}>Copy via host callback</button></div>
            : undefined} />
      </div>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><HostPage /></React.StrictMode>);
