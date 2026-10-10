import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import type { ChatRuntime, ConversationRecord, TightbeamAdapter } from './types';
import './style.css';

export interface RenderContext {
  readonly sessionKey: string;
  readonly recordKey: string;
  readonly defaultRender: () => ReactNode;
  readonly copyText: () => Promise<void>;
}

export interface TightbeamChatProps {
  readonly sessionKey: string;
  readonly adapter: TightbeamAdapter;
  /** Change when the host changes principal or transport lifetime. */
  readonly identityKey?: string;
  readonly renderMessage?: (record: ConversationRecord, context: RenderContext) => ReactNode | undefined;
  readonly className?: string;
}

function defaultBody(record: ConversationRecord): ReactNode {
  if (record.kind === 'transition') {
    return <>
      <strong>{record.transition === 'harness' ? 'Harness' : 'Model'} switched</strong>
      <span>{record.from ? ` from ${record.from}` : ''} to {record.to}</span>
    </>;
  }
  return <>
    {record.messageType && <span className="tb-chat-kind">{record.messageType}</span>}
    <p className="tb-chat-content">{record.content || '(No text content)'}</p>
    {record.attachments && record.attachments.length > 0 &&
      <details><summary>{record.attachments.length} attachment metadata item(s)</summary>
        <pre>{JSON.stringify(record.attachments, null, 2)}</pre>
      </details>}
  </>;
}

function RecordRow({ record, renderMessage }: {
  record: ConversationRecord;
  renderMessage?: TightbeamChatProps['renderMessage'];
}) {
  const [copyStatus, setCopyStatus] = useState('');
  const copyText = async () => {
    const text = record.kind === 'message' ? record.content
      : `${record.transition} switched${record.from ? ` from ${record.from}` : ''} to ${record.to}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('Copied');
    } catch {
      setCopyStatus('Copy unavailable; select the text above.');
    }
  };
  const context: RenderContext = {
    sessionKey: record.sessionKey,
    recordKey: record.id,
    defaultRender: () => defaultBody(record),
    copyText,
  };
  const custom = renderMessage?.(record, context);
  const label = record.kind === 'transition' ? 'Recorded transition'
    : record.sender || record.role || 'Unknown sender';
  return <article className={`tb-chat-row tb-chat-${record.kind}`} data-record-key={record.id}>
    <div className="tb-chat-row-heading">
      <strong>{label}</strong>
      {record.createdAt && <time dateTime={record.createdAt}>{record.createdAt}</time>}
    </div>
    <div className="tb-chat-row-body">{custom === undefined ? defaultBody(record) : custom}</div>
    <button type="button" className="tb-chat-copy" onClick={() => void copyText()}
      aria-label={`Copy ${label} text`}>Copy</button>
    {copyStatus && <span className="tb-chat-copy-status" role="status">{copyStatus}</span>}
  </article>;
}

function ChatBody({ runtime, renderMessage, className }: {
  runtime: ChatRuntime;
  renderMessage?: TightbeamChatProps['renderMessage'];
  className?: string;
}) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const [draft, setDraft] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);
  const atBottom = useRef(true);
  const anchor = useRef<{ id: string; top: number } | null>(null);

  const captureAnchor = () => {
    const box = viewport.current;
    if (!box) return;
    const first = [...box.querySelectorAll<HTMLElement>('[data-record-key]')]
      .find((row) => row.getBoundingClientRect().bottom > box.getBoundingClientRect().top);
    if (first) anchor.current = { id: first.dataset.recordKey || '', top: first.getBoundingClientRect().top };
    atBottom.current = false;
  };

  const loadOlder = () => {
    captureAnchor();
    void runtime.loadOlder();
  };

  useLayoutEffect(() => {
    const box = viewport.current;
    if (!box) return;
    if (anchor.current) {
      const saved = anchor.current;
      const row = [...box.querySelectorAll<HTMLElement>('[data-record-key]')]
        .find((element) => element.dataset.recordKey === saved.id);
      if (row) box.scrollTop += row.getBoundingClientRect().top - saved.top;
      anchor.current = null;
      return;
    }
    if (state.status === 'ready' && !initialScrollDone.current) {
      box.scrollTop = box.scrollHeight;
      initialScrollDone.current = true;
    } else if (initialScrollDone.current && atBottom.current) {
      box.scrollTop = box.scrollHeight;
    }
  }, [state.records, state.status]);

  const handleScroll = () => {
    const box = viewport.current;
    if (!box) return;
    atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    if (box.scrollTop < 80 && state.status === 'ready' && state.hasOlder && !state.loadingOlder) loadOlder();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    const id = runtime.send(draft);
    if (id) setDraft('');
  };

  const statusLabel = state.status === 'ready' ? 'Current'
    : state.status === 'loading' ? 'Loading conversation'
      : state.status === 'stale' ? 'Reconnecting; conversation may be out of date'
        : state.status === 'unsupported' ? 'Unsupported Tightbeam target'
          : state.status === 'unauthorized' ? 'Access to this conversation is unavailable'
            : 'Conversation unavailable';

  return <section className={`tb-chat ${className || ''}`} aria-label="Tightbeam conversation">
    <div className="tb-chat-status" role="status" aria-live="polite">
      <strong>{statusLabel}</strong>{state.statusDetail && <span> — {state.statusDetail}</span>}
      {state.session?.activity && <span> · {state.session.activity}</span>}
    </div>
    <div className="tb-chat-history-control">
      <button type="button" onClick={loadOlder} disabled={state.status !== 'ready' || !state.hasOlder || state.loadingOlder}>
        {state.loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
      </button>
      {state.historyError && <span role="alert">Earlier messages could not be loaded: {state.historyError}</span>}
    </div>
    <div className="tb-chat-viewport" ref={viewport} onScroll={handleScroll} role="log"
      aria-label="Conversation transcript" aria-live="polite" aria-relevant="additions">
      {state.status === 'ready' && state.records.length === 0 && <p className="tb-chat-empty">No messages yet.</p>}
      {state.records.map((record) => <RecordRow key={record.id} record={record} renderMessage={renderMessage} />)}
      {state.sends.filter((send) => !send.reconciled).map((send) =>
        <article className="tb-chat-row tb-chat-local" key={send.clientMessageId}>
          <strong>Your message · {send.status}</strong>
          <p className="tb-chat-content">{send.content}</p>
          {send.reason && <p role="alert">{send.reason}</p>}
          {send.status === 'uncertain' && <button type="button" onClick={() => void runtime.retrySend(send.clientMessageId)}>
            Check and retry this send
          </button>}
          {(send.status === 'failed' || send.status === 'uncertain') &&
            <button type="button" onClick={() => setDraft(send.content)}>Restore to composer</button>}
        </article>)}
    </div>
    <form className="tb-chat-composer" onSubmit={submit}>
      <label htmlFor="tb-chat-composer-input">Message</label>
      <textarea id="tb-chat-composer-input" value={draft} onChange={(event) => setDraft(event.target.value)} rows={3}
        disabled={state.status !== 'ready'} />
      <button type="submit" disabled={state.status !== 'ready' || !draft.trim()}>Send message</button>
    </form>
  </section>;
}

/** One host-selected session. Changing selection/identity disposes the old runtime. */
export function TightbeamChat({ sessionKey, adapter, identityKey, renderMessage, className }: TightbeamChatProps) {
  const key = `${sessionKey}\u0000${identityKey || ''}`;
  const [opened, setOpened] = useState<{ key: string; adapter: TightbeamAdapter; runtime: ChatRuntime } | null>(null);
  useEffect(() => {
    const runtime = adapter.open(sessionKey);
    setOpened({ key, adapter, runtime });
    return () => runtime.dispose();
  }, [adapter, sessionKey, key]);
  if (!opened || opened.key !== key || opened.adapter !== adapter) {
    return <section className={`tb-chat ${className || ''}`} aria-label="Tightbeam conversation" role="status">Loading conversation…</section>;
  }
  return <ChatBody key={key} runtime={opened.runtime} renderMessage={renderMessage} className={className} />;
}
