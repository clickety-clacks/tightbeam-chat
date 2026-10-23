import { forwardRef, memo, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type AnchorHTMLAttributes, type FormEvent, type HTMLAttributes, type ImgHTMLAttributes,
  type ReactNode, type RefObject, type TableHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatRuntime, CanonicalMessage, ConversationRecord, RuntimeState, TightbeamAdapter, TurnProvenance } from './types';
import { provenanceHasHumanSource, turnSourceKind } from './provenance';
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

interface Bubble {
  readonly key: string;
  readonly record: CanonicalMessage;
  readonly side: 'human' | 'agent';
  readonly sender: string;
  readonly displayContent?: string;
  readonly derived: boolean;
}

const markdownPlugins = [remarkGfm];
const markdownComponents = {
  a: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) =>
    <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
  pre: ({ children, ...props }: HTMLAttributes<HTMLPreElement>) =>
    <div className="tb-chat-code-scroll"><pre {...props}>{children}</pre></div>,
  table: ({ children, ...props }: TableHTMLAttributes<HTMLTableElement>) =>
    <div className="tb-chat-table-scroll"><table {...props}>{children}</table></div>,
  img: ({ alt }: ImgHTMLAttributes<HTMLImageElement>) =>
    <span className="tb-chat-image-alt">{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
};

function markdownBody(content: string): ReactNode {
  return <div className="tb-chat-markdown">
    <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents} skipHtml>{content}</ReactMarkdown>
  </div>;
}

function attachmentDetails(record: CanonicalMessage): ReactNode {
  if (!record.attachments?.length) return null;
  return <details className="tb-chat-attachments">
    <summary>{record.attachments.length} attachment {record.attachments.length === 1 ? 'detail' : 'details'}</summary>
    <pre>{JSON.stringify(record.attachments, null, 2)}</pre>
  </details>;
}

function defaultBody(record: CanonicalMessage, content = record.content): ReactNode {
  return <>
    {markdownBody(content || '(No text content)')}
    {attachmentDetails(record)}
  </>;
}

function localTimestamp(value?: string): { text: string; dateTime?: string } {
  if (!value) return { text: 'Time unavailable' };
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { text: 'Time unavailable' };
  const now = new Date();
  const dayNumber = (item: Date) => Math.floor(Date.UTC(item.getFullYear(), item.getMonth(), item.getDate()) / 86_400_000);
  const dayDelta = dayNumber(now) - dayNumber(date);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  if (dayDelta === 0) return { text: time, dateTime: date.toISOString() };
  if (dayDelta === 1) return { text: `Yesterday ${time}`, dateTime: date.toISOString() };
  if (dayDelta >= 2 && dayDelta <= 6) {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
    return { text: `${weekday} ${time}`, dateTime: date.toISOString() };
  }
  const differentYear = date.getFullYear() !== now.getFullYear();
  const datePart = new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', ...(differentYear ? { year: 'numeric' as const } : {}),
  }).format(date);
  return { text: datePart, dateTime: date.toISOString() };
}

function sourceLabel(side: Bubble['side'], agentName: string): string {
  if (side === 'human') return 'You';
  return agentName || 'Assistant';
}

function isProvenHumanMessage(record: CanonicalMessage): boolean {
  if (record.role !== 'user' || record.messageType === 'substrate' || record.messageType === 'marker') return false;
  const senderKind = record.sender ? turnSourceKind(record.sender) : 'unknown';
  if (senderKind !== 'unknown') return senderKind === 'human';
  return Boolean(record.clientMessageId && record.deviceId);
}

function visibleBubbles(state: RuntimeState, agentName: string): Bubble[] {
  if (state.provenanceAvailable === false) {
    return state.records.flatMap((record): Bubble[] => {
      if (record.kind === 'message' && isProvenHumanMessage(record)) {
        return [{ key: record.id, record, side: 'human', sender: 'You', derived: false }];
      }
      return [];
    });
  }
  const provenance = state.provenance ?? [];
  const byTurn = new Map(provenance.map((item) => [item.turn.seq, item]));
  const byMessage = new Map<string, TurnProvenance[]>();
  for (const item of provenance) {
    const matching = byMessage.get(item.turn.messageId);
    if (matching) matching.push(item);
    else byMessage.set(item.turn.messageId, [item]);
  }
  const messageIds = new Set(state.records.filter((record): record is CanonicalMessage => record.kind === 'message')
    .map((record) => record.id));
  const bubbles: Bubble[] = [];
  const addedTriggers = new Set<number>();
  const addHumanTrigger = (item: TurnProvenance) => {
    if (addedTriggers.has(item.turn.seq)) return;
    addedTriggers.add(item.turn.seq);
    if (item.batchCount !== undefined && item.trigger) {
      for (const member of item.humanMembers) {
        bubbles.push({
          key: `${item.turn.messageId}:human:${member.index}`, record: item.trigger,
          side: 'human', sender: 'You', displayContent: member.content, derived: true,
        });
      }
    } else if (item.sourceKind === 'human' && item.trigger && item.trigger.messageType !== 'substrate') {
      bubbles.push({ key: `${item.trigger.id}:provenance:${item.turn.seq}`, record: item.trigger,
        side: 'human', sender: 'You', derived: false });
    }
  };
  for (const record of state.records) {
    if (record.kind !== 'message') continue;
    const triggers = byMessage.get(record.id) ?? [];
    let displayedAsTrigger = false;
    for (const item of triggers) {
      addHumanTrigger(item);
      displayedAsTrigger ||= provenanceHasHumanSource(item);
    }
    if (record.messageType === 'substrate') continue;
    if (displayedAsTrigger) continue;
    const turnSeq = record.turnSeq;
    const item = turnSeq === undefined ? undefined : byTurn.get(turnSeq);
    if (record.role === 'assistant' && item && item.turn.messageId !== record.id && provenanceHasHumanSource(item)) {
      if (!messageIds.has(item.turn.messageId)) addHumanTrigger(item);
      bubbles.push({ key: record.id, record, side: 'agent', sender: sourceLabel('agent', agentName), derived: false });
    }
  }
  const active = state.activeTurn;
  if (active && active.turn.status === 'running' && !messageIds.has(active.turn.messageId)) {
    addHumanTrigger(active);
  }
  return bubbles;
}

function statusText(state: RuntimeState): string {
  switch (state.status) {
    case 'ready': return 'Connected';
    case 'loading': return 'Connecting';
    case 'stale': return 'Reconnecting; conversation may be out of date';
    case 'unsupported': return 'This conversation is not supported';
    case 'unauthorized': return 'Access to this conversation is unavailable';
    case 'error': return 'Disconnected';
  }
}

function activeCaption(provenance?: TurnProvenance): { icon: string; text: string } | undefined {
  if (!provenance || provenance.turn.status !== 'running') return undefined;
  if (provenance.batchCount !== undefined && provenance.batchCount > 1) return { icon: '▣', text: 'Processing message batch' };
  const kind = turnSourceKind(provenance.captionOrigin);
  if (kind === 'human') return { icon: '●', text: 'Replying to you' };
  if (kind === 'agent') {
    if (provenance.sourceDisplayName) return { icon: '◌', text: provenance.sourceDisplayName };
    return provenance.batchCount !== undefined ? undefined : { icon: '⚙', text: 'Other activity' };
  }
  if (kind === 'substrate') {
    const messageType = provenance.sourceMessageType?.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').trim();
    if (messageType) return { icon: '⚙', text: messageType };
    return undefined;
  }
  if (provenance.batchCount !== undefined) return undefined;
  return { icon: '⚙', text: 'Other activity' };
}

function StatusIcon({ state }: { state: RuntimeState }) {
  const status = state.status;
  return <span className={`tb-chat-status-dot tb-chat-status-${status}`} aria-hidden="true" />;
}

const RecordRow = memo(function RecordRow({ bubble, renderMessage, agentName }: {
  bubble: Bubble;
  renderMessage?: TightbeamChatProps['renderMessage'];
  agentName: string;
}) {
  const { record } = bubble;
  const time = localTimestamp(record.createdAt);
  const context: RenderContext = {
    sessionKey: record.sessionKey,
    recordKey: bubble.key,
    defaultRender: () => defaultBody(record, bubble.displayContent),
    copyText: () => navigator.clipboard.writeText(record.content),
  };
  const custom = bubble.derived ? undefined : renderMessage?.(record, context);
  return <article className={`tb-chat-bubble tb-chat-bubble-${bubble.side}`} data-record-key={bubble.key}
    aria-label={`Message from ${bubble.sender || sourceLabel(bubble.side, agentName)}`}>
    <div className="tb-chat-bubble-body">{custom === undefined ? defaultBody(record, bubble.displayContent) : custom}</div>
    <time className="tb-chat-time" dateTime={time.dateTime}>{time.text}</time>
  </article>;
});

interface ComposerHandle {
  restore(content: string): void;
}

const Composer = forwardRef<ComposerHandle, {
  runtime: ChatRuntime;
  state: RuntimeState;
  agentName: string;
  root: RefObject<HTMLElement | null>;
}>(function Composer({ runtime, state, agentName, root }, ref) {
  const [draft, setDraft] = useState('');
  const [statusOpen, setStatusOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const statusControl = useRef<HTMLButtonElement>(null);
  const shell = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const composerLocked = state.status === 'unsupported' || state.status === 'unauthorized';
  const statusName = statusText(state);
  const statusId = `${titleId}-status-details`;

  useImperativeHandle(ref, () => ({ restore: setDraft }), []);

  const closeStatusPopup = () => {
    setStatusOpen(false);
    statusControl.current?.focus();
  };

  useEffect(() => {
    if (!statusOpen) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeStatusPopup();
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [statusOpen]);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, Number.parseFloat(getComputedStyle(element).maxHeight) || element.scrollHeight)}px`;
  }, [draft]);

  useLayoutEffect(() => {
    const element = shell.current;
    const container = root.current;
    if (!element || !container) return;
    const update = () => container.style.setProperty('--tb-chat-composer-height', `${element.getBoundingClientRect().height}px`);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    update();
    return () => observer?.disconnect();
  }, [root]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.trim()) return;
    if (runtime.send(draft)) setDraft('');
  };

  return <form className="tb-chat-composer" onSubmit={submit} ref={shell}>
    <label className="tb-chat-sr-only" htmlFor={`${titleId}-input`}>Message to {agentName || 'the selected agent'}</label>
    <div className="tb-chat-input-shell">
      <textarea ref={input} id={`${titleId}-input`} value={draft}
        onChange={(event) => setDraft(event.target.value)} rows={1} disabled={composerLocked}
        aria-label={`Message to ${agentName || 'the selected agent'}`} placeholder={agentName}
        autoComplete="off" spellCheck />
      <button ref={statusControl} type="button" className="tb-chat-status-control" aria-label={`Connection status: ${statusName}. Show details`}
        aria-expanded={statusOpen} aria-controls={statusId} onClick={() => setStatusOpen((open) => !open)}>
        <StatusIcon state={state} />
      </button>
      {statusOpen && <div className="tb-chat-status-popup" id={statusId} role="dialog" aria-label="Connection details">
        <div className="tb-chat-popup-heading"><StatusIcon state={state} /><strong>{statusName}</strong>
          <button type="button" aria-label="Close connection details" onClick={closeStatusPopup}>×</button>
        </div>
        {state.statusDetail && <p>{state.statusDetail}</p>}
        <dl>
          <dt>Gateway</dt><dd>{state.targetGateway || 'Unavailable'}</dd>
          <dt>Session</dt><dd>{state.sessionKey}</dd>
          <dt>Agent</dt><dd>{agentName || 'Unavailable'}</dd>
          <dt>Model</dt><dd>{state.session?.model || 'Unavailable'}</dd>
          <dt>Harness</dt><dd>{state.session?.harness || 'Unavailable'}</dd>
        </dl>
        {state.status === 'error' && <button type="button" onClick={() => void runtime.rebuild()}>Reconnect</button>}
      </div>}
      <button type="submit" className="tb-chat-send-button" aria-label="Send message"
        disabled={state.status !== 'ready' || !draft.trim()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0L6 11m6-6 6 6" /></svg>
      </button>
    </div>
  </form>;
});

function ChatBody({ runtime, renderMessage, className }: {
  runtime: ChatRuntime;
  renderMessage?: TightbeamChatProps['renderMessage'];
  className?: string;
}) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const viewport = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const initialScrollDone = useRef(false);
  const atBottom = useRef(true);
  const anchor = useRef<{ id: string; top: number } | null>(null);
  const agentName = state.agentDisplayName ?? '';
  const bubbles = useMemo(() => visibleBubbles(state, agentName),
    [state.records, state.provenance, state.provenanceAvailable, state.activeTurn, agentName]);
  const caption = state.provenanceAvailable === false ? undefined : activeCaption(state.activeTurn);
  const visibleCanonicalIds = useMemo(() => new Set(bubbles.map((bubble) => bubble.record.clientMessageId).filter(Boolean)), [bubbles]);
  const localSends = state.sends.filter((send) => !visibleCanonicalIds.has(send.clientMessageId));
  const statusName = statusText(state);

  useEffect(() => {
    if (!agentName) return;
    const priorTitle = document.title;
    document.title = agentName;
    return () => { if (document.title === agentName) document.title = priorTitle; };
  }, [agentName]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let fullHeight = element.clientHeight || window.innerHeight;
    let baselineViewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const update = () => {
      const visual = window.visualViewport;
      const currentHeight = element.clientHeight;
      const keyboardOpen = Boolean(visual && visual.height < baselineViewportHeight - 120);
      if (!keyboardOpen && currentHeight > 0) {
        fullHeight = currentHeight;
        if (visual) baselineViewportHeight = visual.height;
      }
      element.style.setProperty('--tb-chat-full-height', `${fullHeight}px`);
      const visibleBottom = visual ? visual.offsetTop + visual.height : window.innerHeight;
      const bottom = element.getBoundingClientRect().bottom;
      element.style.setProperty('--tb-chat-keyboard-inset', `${Math.max(0, bottom - visibleBottom)}px`);
    };
    const preventGesture = (event: Event) => event.preventDefault();
    const preventPinch = (event: TouchEvent) => { if (event.touches.length > 1) event.preventDefault(); };
    element.addEventListener('gesturestart', preventGesture, { passive: false });
    element.addEventListener('gesturechange', preventGesture, { passive: false });
    element.addEventListener('touchmove', preventPinch, { passive: false });
    window.addEventListener('resize', update);
    const orient = () => {
      baselineViewportHeight = window.visualViewport?.height ?? window.innerHeight;
      fullHeight = element.clientHeight || window.innerHeight;
      update();
    };
    window.addEventListener('orientationchange', orient);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    resizeObserver?.observe(element);
    update();
    return () => {
      element.removeEventListener('gesturestart', preventGesture);
      element.removeEventListener('gesturechange', preventGesture);
      element.removeEventListener('touchmove', preventPinch);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', orient);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      resizeObserver?.disconnect();
    };
  }, []);

  const captureAnchor = () => {
    const box = viewport.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    const first = [...box.querySelectorAll<HTMLElement>('[data-record-key]')]
      .find((row) => row.getBoundingClientRect().bottom > top);
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
      if (state.status === 'ready' && state.loadingOlder) return;
      if (state.status !== 'ready' || state.historyError) {
        anchor.current = null;
        return;
      }
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
  }, [state.records, state.provenance, state.status, state.loadingOlder, state.historyError, state.activeTurn, state.sends]);

  useLayoutEffect(() => {
    const box = viewport.current;
    if (!box || state.status !== 'ready' || !state.hasOlder || state.loadingOlder || state.historyError || box.scrollTop >= 80) return;
    const frame = requestAnimationFrame(() => loadOlder());
    return () => cancelAnimationFrame(frame);
  }, [state.status, state.hasOlder, state.loadingOlder, state.historyError, state.records, state.provenance]);

  const handleScroll = () => {
    const box = viewport.current;
    if (!box) return;
    atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    if (state.loadingOlder && anchor.current) {
      if (atBottom.current) anchor.current = null;
      else captureAnchor();
      return;
    }
    if (box.scrollTop < 80 && state.status === 'ready' && state.hasOlder && !state.loadingOlder) loadOlder();
  };

  const notice = state.status === 'ready' ? undefined
    : state.status === 'loading' ? 'Connecting to the selected conversation…'
      : state.status === 'stale' ? 'Reconnecting; the conversation may be out of date.'
        : state.status === 'error' ? 'Disconnected. Open connection details to reconnect.'
          : statusName;

  return <section ref={root} className={`tb-chat ${className || ''}`} aria-label={agentName ? `${agentName} conversation` : 'Conversation'}>
    <div className="tb-chat-viewport" ref={viewport} onScroll={handleScroll} role="log"
      aria-label={`${agentName || 'Conversation'} messages`} aria-live="polite" aria-relevant="additions text">
      {notice && <div className={`tb-chat-notice tb-chat-notice-${state.status}`} role={state.status === 'loading' ? 'status' : 'alert'}>
        <span>{notice}</span>
      </div>}
      {state.loadingOlder && <div className="tb-chat-history-loading" role="status">Loading earlier messages…</div>}
      {state.historyError && <div className="tb-chat-history-error" role="alert">
        <span>Earlier messages could not be loaded: {state.historyError}</span>
        <button type="button" onClick={loadOlder}>Retry loading messages</button>
      </div>}
      {bubbles.map((bubble) => <RecordRow key={bubble.key} bubble={bubble} renderMessage={renderMessage} agentName={agentName} />)}
      {localSends.map((send) => {
        const time = localTimestamp(send.submittedAt);
        const retryAvailable = ['failed', 'uncertain'].includes(send.status) && !send.reconciled;
        return <article className="tb-chat-bubble tb-chat-bubble-human tb-chat-local" key={send.clientMessageId}
          data-record-key={`local-${send.clientMessageId}`} aria-label={`Your message, ${send.status}`}>
          <div className="tb-chat-bubble-body">{markdownBody(send.content)}</div>
          <p className="tb-chat-send-state">{send.status === 'uncertain' ? 'Delivery is uncertain' : send.status === 'failed' ? 'Message could not be sent' : send.status === 'pending' ? 'Sending…' : 'Sent'}</p>
          {send.reason && <p className="tb-chat-send-reason" role="alert">
            {send.status === 'uncertain'
              ? 'Delivery could not be confirmed. Retry after the connection is current.'
              : 'The message could not be sent. Retry it or restore the text to the composer.'}
          </p>}
          {retryAvailable && <div className="tb-chat-send-actions">
            <button type="button" disabled={state.status !== 'ready'}
              onClick={() => void runtime.retrySend(send.clientMessageId)}>Retry message</button>
            {state.status !== 'ready' && <span>Reconnect before retrying.</span>}
            <button type="button" onClick={() => composer.current?.restore(send.content)}>Restore text to the composer</button>
          </div>}
          <time className="tb-chat-time" dateTime={time.dateTime}>{time.text}</time>
        </article>;
      })}
      {caption && <div className="tb-chat-active-caption" role="status" aria-label={`Active turn: ${caption.text}`}>
        <span aria-hidden="true">{caption.icon}</span><span>{caption.text}</span>
      </div>}
      {state.status === 'ready' && state.records.length === 0 && localSends.length === 0 && !state.hasOlder &&
        <p className="tb-chat-empty">No messages yet.</p>}
    </div>
    <Composer ref={composer} runtime={runtime} state={state} agentName={agentName} root={root} />
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
    return <section className={`tb-chat ${className || ''}`} aria-label="Conversation" role="status">Connecting…</section>;
  }
  return <ChatBody key={key} runtime={opened.runtime} renderMessage={renderMessage} className={className} />;
}
