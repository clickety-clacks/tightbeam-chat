import { forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type AnchorHTMLAttributes, type FormEvent, type HTMLAttributes, type ImgHTMLAttributes,
  type ReactNode, type RefObject, type TableHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatRuntime, CanonicalMessage, CanonicalTransition, ToolCallRecord, ToolCallIndex, ConversationRecord, LocalSend, RuntimeState, TightbeamAdapter, TurnProvenance } from './types';
import { projectMessages, type HumanMember } from './messageVisibility';
import { useReadingPosition } from './useReadingPosition';
import { firstAfterTime, getIndex, putIndex, type RecordIndex } from './recordIndex';
import { getHostComposerSnapshot, HostComposerBridge, subscribeHostComposer } from './hostComposer';
import { ReleaseNotesDialog, type ChatOverlay } from './ReleaseNotesDialog';
import { CHAT_RELEASE_VERSION, RELEASE_NOTES, recordSeenReleaseVersion, releaseNotesForBuild, unseenReleaseNotes } from './releaseNotes';
import { isSettingsCommand } from './settingsCommand';
import './style.css';

export interface RenderContext {
  readonly sessionKey: string;
  readonly recordKey: string;
  /** Carrier identity and provenance only; excludes its body and sibling data. */
  readonly sourceRecord?: Readonly<Pick<CanonicalMessage,
    'id' | 'sessionKey' | 'seq' | 'rowVersion' | 'sender' | 'messageType' | 'turnSeq' | 'createdAt'>>;
  readonly member?: HumanMember;
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
  readonly member?: HumanMember;
  readonly derived: boolean;
}

type TimelineItem =
  | { readonly kind: 'tool'; readonly call: ToolCallRecord }
  | { readonly kind: 'transition'; readonly record: CanonicalTransition }
  | { readonly kind: 'bubble'; readonly bubble: Bubble; readonly scrollKey?: string }
  | { readonly kind: 'local'; readonly send: LocalSend; readonly canonical?: CanonicalMessage };

function sendIdentity(value: Pick<LocalSend, 'sessionKey' | 'deviceId' | 'clientMessageId'>): string {
  return JSON.stringify([value.sessionKey, value.deviceId, value.clientMessageId]);
}

function canonicalSendIdentity(record: CanonicalMessage): string | undefined {
  return record.deviceId && record.clientMessageId
    ? sendIdentity({ sessionKey: record.sessionKey, deviceId: record.deviceId,
      clientMessageId: record.clientMessageId })
    : undefined;
}

function itemTime(item: TimelineItem): number | undefined {
  if (item.kind === 'tool') return item.call.startedAt;
  const value = item.kind === 'transition' ? item.record.createdAt
    : item.kind === 'bubble' ? item.bubble.record.createdAt
    : item.canonical?.createdAt ?? item.send.submittedAt;
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

interface TimelineAnchor {
  readonly item: TimelineItem;
  readonly record: Pick<ConversationRecord, 'id' | 'seq'>;
  readonly order: number;
}

interface TimedTimelineAnchor {
  readonly time: number;
  readonly position: number;
}

interface UnmatchedTimelineItem {
  readonly item: TimelineItem;
  readonly time: number;
  readonly order: number;
}

function upperBoundByTime(items: readonly TimedTimelineAnchor[], time: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (items[middle].time <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function composeTimeline(bubbles: readonly Bubble[], localSends: readonly LocalSend[],
  canonicalSends: ReadonlyMap<string, CanonicalMessage>,
  sendsByIdentity: ReadonlyMap<string, LocalSend>,
  transitions: readonly CanonicalTransition[]): TimelineItem[] {
  const anchoredSendIdentities = new Set<string>();
  const anchors: TimelineAnchor[] = bubbles.map((bubble, order) => {
    const identity = bubble.derived ? undefined : canonicalSendIdentity(bubble.record);
    const send = identity && !anchoredSendIdentities.has(identity) ? sendsByIdentity.get(identity) : undefined;
    if (identity && send) anchoredSendIdentities.add(identity);
    const item: TimelineItem = { kind: 'bubble', bubble, scrollKey: send ? `local-${send.clientMessageId}` : undefined };
    return { item, record: bubble.record, order };
  });
  for (const record of transitions) anchors.push({ item: { kind: 'transition', record }, record, order: anchors.length });
  const unmatched: UnmatchedTimelineItem[] = [];
  let order = anchors.length;
  for (const send of localSends) {
    const canonical = canonicalSends.get(sendIdentity(send));
    const item: TimelineItem = { kind: 'local', send, canonical };
    if (canonical) {
      anchors.push({ item, record: canonical, order });
    } else {
      const parsed = Date.parse(send.submittedAt);
      unmatched.push({ item, time: Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY, order });
    }
    order++;
  }

  anchors.sort((left, right) => left.record.seq - right.record.seq ||
    left.record.id.localeCompare(right.record.id) ||
    Number(left.item.kind !== 'bubble') - Number(right.item.kind !== 'bubble') || left.order - right.order);

  const timedAnchors: TimedTimelineAnchor[] = [];
  const earliestBubbleAtTime = new Map<number, number>();
  for (let position = 0; position < anchors.length; position++) {
    const item = anchors[position].item;
    const time = itemTime(item);
    if (time === undefined) continue;
    const isBubble = item.kind === 'bubble';
    timedAnchors.push({ time, position });
    if (isBubble) {
      const prior = earliestBubbleAtTime.get(time);
      if (prior === undefined || position < prior) earliestBubbleAtTime.set(time, position);
    }
  }
  // Canonical order follows sequence, but an unmatched send follows its timestamp.
  // The suffix minimum finds the earliest sequence position satisfying each time query.
  timedAnchors.sort((left, right) => left.time - right.time || left.position - right.position);
  const earliestPositionAtOrAfterTime = new Array<number>(timedAnchors.length);
  let earliestPosition = anchors.length;
  for (let index = timedAnchors.length - 1; index >= 0; index--) {
    earliestPosition = Math.min(earliestPosition, timedAnchors[index].position);
    earliestPositionAtOrAfterTime[index] = earliestPosition;
  }

  unmatched.sort((left, right) => left.time - right.time || left.order - right.order);
  const insertions = new Map<number, TimelineItem[]>();
  for (const pending of unmatched) {
    let position = anchors.length;
    if (Number.isFinite(pending.time)) {
      const firstGreaterTime = upperBoundByTime(timedAnchors, pending.time);
      const firstLaterAnchor = firstGreaterTime < timedAnchors.length
        ? earliestPositionAtOrAfterTime[firstGreaterTime] : anchors.length;
      const firstEqualBubble = earliestBubbleAtTime.get(pending.time) ?? anchors.length;
      position = Math.min(firstLaterAnchor, firstEqualBubble);
    }
    const bucket = insertions.get(position);
    if (bucket) bucket.push(pending.item);
    else insertions.set(position, [pending.item]);
  }

  const timeline: TimelineItem[] = [];
  for (let position = 0; position <= anchors.length; position++) {
    const bucket = insertions.get(position);
    if (bucket) timeline.push(...bucket);
    if (position < anchors.length) timeline.push(anchors[position].item);
  }
  return timeline;
}

interface PendingPlacement { readonly item: TimelineItem; readonly beforeAnchor?: number }
interface PendingAtAnchor {
  readonly messages: readonly TimelineItem[];
  readonly tools?: RecordIndex<readonly TimelineItem[]>;
}

function transcriptIndex(timeline: readonly TimelineItem[]) {
  let index: RecordIndex<readonly TimelineItem[]> | undefined;
  const placements: PendingPlacement[] = [];
  let pending: TimelineItem[] = [];
  for (const item of timeline) {
    if (item.kind === 'local' && !item.canonical) { pending.push(item); continue; }
    const anchor = item.kind === 'bubble' ? item.bubble.record.seq : item.kind === 'transition'
      ? item.record.seq : item.kind === 'tool' ? item.call.afterMessageSeq : item.canonical!.seq;
    for (const item of pending) placements.push({ item, beforeAnchor: anchor });
    pending = [];
    index = putIndex(index, anchor, [...(getIndex(index, anchor) ?? []), item]);
  }
  for (const item of pending) placements.push({ item });
  return { index, placements };
}

// Only unmatched sends need timestamp placement. Search the timestamp aggregate
// along fixed index paths, never scan the accumulated tool history.
function placePending(placements: readonly PendingPlacement[], tools: ToolCallIndex | undefined) {
  let index: RecordIndex<PendingAtAnchor> | undefined;
  const tail: TimelineItem[] = [];
  for (const { item, beforeAnchor } of placements) {
    const time = itemTime(item);
    const group = time === undefined ? undefined : firstAfterTime(tools, time);
    const call = group && time !== undefined ? firstAfterTime(group, time) : undefined;
    if (call && (beforeAnchor === undefined || call.afterMessageSeq < beforeAnchor)) {
      const previous = getIndex(index, call.afterMessageSeq);
      const slots = putIndex(previous?.tools, call.seq, [...(getIndex(previous?.tools, call.seq) ?? []), item]);
      index = putIndex(index, call.afterMessageSeq, { messages: previous?.messages ?? [], tools: slots });
    } else if (beforeAnchor !== undefined) {
      const previous = getIndex(index, beforeAnchor);
      index = putIndex(index, beforeAnchor, { messages: [...(previous?.messages ?? []), item], tools: previous?.tools });
    } else tail.push(item);
  }
  return { index, tail };
}

const IndexedTools = memo(function IndexedToolsBranch({ node, pending, render }: {
  node?: RecordIndex<ToolCallRecord>;
  pending?: RecordIndex<readonly TimelineItem[]>;
  render: (item: TimelineItem) => ReactNode;
}): ReactNode {
  if (!node && !pending) return null;
  if (node?.value || pending?.value) return <>
    {pending?.value?.map(render)}
    {node?.value && render({ kind: 'tool', call: node.value })}
  </>;
  return <>
    <IndexedTools node={node?.zero} pending={pending?.zero} render={render} />
    <IndexedTools node={node?.one} pending={pending?.one} render={render} />
  </>;
});

const IndexedTimeline = memo(function IndexedTimelineBranch({ messages, tools, pending, render }: {
  messages?: RecordIndex<readonly TimelineItem[]>;
  tools?: ToolCallIndex;
  pending?: RecordIndex<PendingAtAnchor>;
  render: (item: TimelineItem) => ReactNode;
}): ReactNode {
  if (!messages && !tools && !pending) return null;
  if (messages?.value || tools?.value || pending?.value) return <>
    {pending?.value?.messages.map(render)}
    {messages?.value?.map(render)}
    <IndexedTools node={tools?.value} pending={pending?.value?.tools} render={render} />
  </>;
  return <>
    <IndexedTimeline messages={messages?.zero} tools={tools?.zero} pending={pending?.zero} render={render} />
    <IndexedTimeline messages={messages?.one} tools={tools?.one} pending={pending?.one} render={render} />
  </>;
});

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
  if (provenance.turn.triggerSource === 'batch' && provenance.batchCount !== 1) return undefined;
  const kind = provenance.sourceKind;
  if (kind === 'human') return { icon: '●', text: 'Replying to you' };
  if (kind === 'agent') {
    if (provenance.sourceDisplayName) return { icon: '◌', text: provenance.sourceDisplayName };
    return provenance.batchCount !== undefined ? undefined : { icon: '⚙', text: 'Other activity' };
  }
  if (kind === 'substrate') {
    const messageType = provenance.sourceMessageType?.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').trim();
    if (messageType) return { icon: '⚙', text: messageType };
    return provenance.batchCount !== undefined ? undefined : { icon: '⚙', text: 'Other activity' };
  }
  if (provenance.batchCount !== undefined) return undefined;
  return { icon: '⚙', text: 'Other activity' };
}

function StatusIcon({ state }: { state: RuntimeState }) {
  const status = state.status;
  return <span className={`tb-chat-status-dot tb-chat-status-${status}`} aria-hidden="true" />;
}

const RecordRow = memo(function RecordRow({ bubble, renderMessage, agentName, registerRow, scrollKey: scrollKeyOverride, arriving }: {
  bubble: Bubble;
  renderMessage?: TightbeamChatProps['renderMessage'];
  agentName: string;
  registerRow: (key: string, element: HTMLElement | null) => void;
  scrollKey?: string;
  arriving: boolean;
}) {
  const { record } = bubble;
  const scrollKey = scrollKeyOverride ?? (bubble.derived ? bubble.key : record.id);
  const row = useRef<HTMLElement | null>(null);
  const entrance = useRef<Animation | undefined>(undefined);
  const rowRef = useCallback((element: HTMLElement | null) => {
    row.current = element;
    registerRow(scrollKey, element);
  }, [registerRow, scrollKey]);
  useLayoutEffect(() => {
    if (!arriving || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    // Opacity leaves row geometry intact for reading anchors and smooth follow.
    const animation = row.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], {
      duration: 180, easing: 'ease-out',
    });
    entrance.current = animation;
    if (animation) animation.onfinish = () => { entrance.current = undefined; };
  }, [arriving]);
  useLayoutEffect(() => () => entrance.current?.cancel(), []);
  const time = localTimestamp(record.createdAt);
  const context: RenderContext = {
    sessionKey: record.sessionKey,
    recordKey: bubble.key,
    ...(bubble.member ? { sourceRecord: Object.freeze({
      id: record.id, sessionKey: record.sessionKey, seq: record.seq, rowVersion: record.rowVersion,
      sender: record.sender, messageType: record.messageType, turnSeq: record.turnSeq, createdAt: record.createdAt,
    }), member: Object.freeze({ ...bubble.member }) } : {}),
    defaultRender: () => bubble.derived ? markdownBody(bubble.displayContent ?? '') : defaultBody(record),
    copyText: () => navigator.clipboard.writeText(bubble.displayContent ?? record.content),
  };
  // Existing renderers consume record.content. Give them only the member view;
  // source context identifies the carrier without exposing hidden siblings.
  const displayRecord: CanonicalMessage = bubble.member ? Object.freeze({
    kind: 'message', id: bubble.key, sessionKey: record.sessionKey, seq: record.seq,
    rowVersion: record.rowVersion, role: 'user', sender: bubble.member.sender,
    content: bubble.member.content, createdAt: record.createdAt,
    raw: Object.freeze({ carrierId: record.id, memberSourceId: bubble.member.sourceId,
      memberIndex: bubble.member.index, sender: bubble.member.sender, content: bubble.member.content }),
  }) : record;
  const custom = renderMessage?.(displayRecord, context);
  return <article ref={rowRef} className={`tb-chat-bubble tb-chat-bubble-${bubble.side}`} data-record-key={bubble.key} data-scroll-key={scrollKey}
    aria-label={`Message from ${bubble.sender || sourceLabel(bubble.side, agentName)}`}>
    {bubble.side === 'human' && <span className="tb-chat-bubble-sender" aria-hidden="true">{bubble.sender}</span>}
    <div className="tb-chat-bubble-body">{custom === undefined ? context.defaultRender() : custom}</div>
    <time className="tb-chat-time" dateTime={time.dateTime}>{time.text}</time>
  </article>;
}, (previous, next) => {
  const before = previous.bubble;
  const after = next.bubble;
  const sameMember = before.member === after.member || Boolean(before.member && after.member &&
    before.member.index === after.member.index && before.member.sourceId === after.member.sourceId &&
    before.member.sender === after.member.sender && before.member.content === after.member.content);
  // Projection rebuilds wrappers when history changes. Keep unchanged canonical
  // rows memoized so appending to a long transcript doesn't re-render every body.
  return before.key === after.key && before.record === after.record && before.side === after.side &&
    before.sender === after.sender && before.displayContent === after.displayContent &&
    before.derived === after.derived && sameMember && previous.renderMessage === next.renderMessage &&
    previous.agentName === next.agentName && previous.registerRow === next.registerRow &&
    previous.scrollKey === next.scrollKey && previous.arriving === next.arriving;
});

interface ComposerHandle {
  restore(content: string): void;
  contains(target: EventTarget | null): boolean;
  focusAtEnd(): boolean;
  closeStatusPopup(): void;
}

const Composer = forwardRef<ComposerHandle, {
  runtime: ChatRuntime;
  state: RuntimeState;
  agentName: string;
  root: RefObject<HTMLElement | null>;
  suppressStatus: boolean;
  onSettings: () => void;
  onSendAccepted: () => void;
}>(function Composer({ runtime, state, agentName, root, suppressStatus, onSettings, onSendAccepted }, ref) {
  const [draft, setDraft] = useState('');
  const [statusOpen, setStatusOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const statusControl = useRef<HTMLButtonElement>(null);
  const sendControl = useRef<HTMLButtonElement>(null);
  const shell = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const statusName = statusText(state);
  const statusId = `${titleId}-status-details`;

  useImperativeHandle(ref, () => ({
    restore: setDraft,
    contains: (target) => target instanceof Node && Boolean(shell.current?.contains(target)),
    focusAtEnd: () => {
      const element = input.current;
      if (!element || element.disabled) return false;
      element.focus({ preventScroll: true });
      const end = element.value.length;
      element.setSelectionRange(end, end);
      return document.activeElement === element;
    },
    closeStatusPopup: () => setStatusOpen(false),
  }), []);

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
    if (pendingCaret.current !== null) {
      const caret = Math.min(pendingCaret.current, element.value.length);
      element.setSelectionRange(caret, caret);
      pendingCaret.current = null;
    }
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
    if (isSettingsCommand(draft)) {
      setDraft('');
      setStatusOpen(false);
      onSettings();
      return;
    }
    if (state.status !== 'ready') return;
    if (runtime.send(draft)) {
      setDraft('');
      onSendAccepted();
    }
  };

  return <form className="tb-chat-composer" onSubmit={submit} ref={shell}>
    <label className="tb-chat-sr-only" htmlFor={`${titleId}-input`}>Message to {agentName || 'the selected agent'}</label>
    <div className="tb-chat-input-shell">
      <textarea ref={input} id={`${titleId}-input`} value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.shiftKey || event.ctrlKey) {
            // Insert into the controlled value explicitly: Ctrl+Return does not
            // produce a textarea newline in every browser. Restore the caret
            // after React commits the updated value.
            event.preventDefault();
            const element = event.currentTarget;
            const start = element.selectionStart;
            const end = element.selectionEnd;
            pendingCaret.current = start + 1;
            setDraft((current) => `${current.slice(0, start)}\n${current.slice(end)}`);
            return;
          }
          if (event.altKey || event.metaKey) return;
          event.preventDefault();
          sendControl.current?.click();
        }}
        rows={1}
        aria-label={`Message to ${agentName || 'the selected agent'}`} placeholder={agentName}
        autoComplete="off" spellCheck />
      {!suppressStatus && <button ref={statusControl} type="button" className="tb-chat-status-control" aria-label={`Connection status: ${statusName}. Show details`}
        aria-expanded={statusOpen} aria-controls={statusId} onClick={() => setStatusOpen((open) => !open)}>
        <StatusIcon state={state} />
      </button>}
      {!suppressStatus && statusOpen && <div className="tb-chat-status-popup" id={statusId} role="dialog" aria-label="Connection details">
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
        {state.status === 'error' && <button type="button" onClick={() => void runtime.rebuild({ restart: true })}>Reconnect</button>}
      </div>}
      <button ref={sendControl} type="submit" className="tb-chat-send-button" aria-label="Send message"
        disabled={!draft.trim() || (state.status !== 'ready' && !isSettingsCommand(draft))}>
        <span className="tb-chat-send-button-disc" aria-hidden="true" />
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0L6 11m6-6 6 6" /></svg>
      </button>
    </div>
  </form>;
});

const ToolCallRow = memo(function ToolCallRow({ call, registerRow }: {
  call: ToolCallRecord;
  registerRow: (key: string, element: HTMLElement | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const terminal = call.status === 'completed' || call.status === 'failed';
  const status = call.status === 'in_progress' ? 'Running' : call.status === 'pending' ? 'Pending' : call.status === 'completed' ? 'Completed' : 'Failed';
  const key = 'tool-' + call.id;
  return <article ref={element => registerRow(key, element)} data-record-key={key} data-scroll-key={key}
    className="tb-chat-tool" aria-label={'Tool call: ' + (call.toolName || call.kind) + ', ' + status}>
    <div className="tb-chat-tool-heading"><strong>{call.toolName || call.kind}</strong><span>{status}</span></div>
    {call.title && <p>{call.title}</p>}
    <details onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>Input and result</summary>
      {expanded && <div>
        {(['rawInput', 'rawOutput', 'content'] as const).map(field => {
          const label = field === 'rawInput' ? 'Input' : field === 'rawOutput' ? 'Result' : 'Result content';
          const truncated = call.truncated.find(entry => entry.field === field);
          const value = call[field];
          if (value === null && field === 'content') return null;
          return <section key={field} aria-label={label}>
            <h4>{label}</h4>
            {truncated && <p>{label} truncated — original size {truncated.originalBytes} bytes.</p>}
            {value === null ? <p>{field === 'rawInput' ? 'No input recorded.' : terminal ? 'No result recorded.' : 'Waiting for result…'}</p>
              : <pre>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>}
          </section>;
        })}
      </div>}
    </details>
  </article>;
});

function ChatBody({ runtime, renderMessage, className, hostBridge }: {
  runtime: ChatRuntime;
  renderMessage?: TightbeamChatProps['renderMessage'];
  className?: string;
  hostBridge: HostComposerBridge | null;
}) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const subscribeHost = useCallback((listener: () => void) => subscribeHostComposer(hostBridge, listener), [hostBridge]);
  const getHostSnapshot = useCallback(() => getHostComposerSnapshot(hostBridge), [hostBridge]);
  const host = useSyncExternalStore(subscribeHost, getHostSnapshot, getHostSnapshot);
  const readingRevision = useMemo(() => ({ state, host }), [state, host]);
  const reading = useReadingPosition(state.status === 'ready', readingRevision);
  const { viewport } = reading;
  const root = useRef<HTMLElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const [overlay, setOverlay] = useState<ChatOverlay | null>(null);
  const overlayRef = useRef<ChatOverlay | null>(null);
  const handledSettingsRevision = useRef(0);
  const overlayWasOpen = useRef(false);
  const setOverlayState = useCallback((next: ChatOverlay | null) => {
    overlayRef.current = next;
    setOverlay(next);
  }, []);
  const recordWhatsNewSeen = useCallback(() => {
    if (!CHAT_RELEASE_VERSION || typeof window === 'undefined') return;
    try { recordSeenReleaseVersion(window.localStorage, CHAT_RELEASE_VERSION); } catch { /* Storage may be unavailable. */ }
  }, []);
  const openSettings = useCallback(() => {
    const current = overlayRef.current;
    if (current?.kind === 'settings') return;
    if (current?.kind === 'whats-new') recordWhatsNewSeen();
    composer.current?.closeStatusPopup();
    setOverlayState({ kind: 'settings', page: 'home' });
  }, [recordWhatsNewSeen, setOverlayState]);
  const openReleaseNotes = useCallback(() => {
    const current = overlayRef.current;
    if (current?.kind === 'settings' && current.page === 'home') {
      setOverlayState({ kind: 'settings', page: 'release-notes' });
    }
  }, [setOverlayState]);
  const backToSettings = useCallback(() => {
    const current = overlayRef.current;
    if (current?.kind === 'settings' && current.page === 'release-notes') {
      setOverlayState({ kind: 'settings', page: 'home' });
    }
  }, [setOverlayState]);
  const closeOverlay = useCallback(() => {
    if (overlayRef.current?.kind === 'whats-new') recordWhatsNewSeen();
    setOverlayState(null);
  }, [recordWhatsNewSeen, setOverlayState]);
  const bundledNotes = useMemo(() => releaseNotesForBuild(CHAT_RELEASE_VERSION, RELEASE_NOTES), []);
  const lastPointerInChat = useRef(false);
  const keyboardActions = useRef({ optedIn: host.optedIn, composerHidden: host.composerHidden, scrollBy: reading.scrollBy });
  keyboardActions.current = { optedIn: host.optedIn, composerHidden: host.composerHidden, scrollBy: reading.scrollBy };
  const agentName = state.agentDisplayName ?? '';
  const projection = useMemo(() => projectMessages(state.records, state.principalKey, state.session?.raw.ownerUserId),
    [state.records, state.principalKey, state.session?.raw.ownerUserId]);
  const bubbles: Bubble[] = useMemo(() => projection.messages
    .map((message) => ({
      key: message.key, record: message.source, side: message.side,
      sender: message.senderLabel ?? sourceLabel(message.side, agentName), derived: Boolean(message.member),
      displayContent: message.member?.content, member: message.member,
    })), [projection, agentName]);
  const caption = state.provenanceAvailable === false ? undefined : activeCaption(state.activeTurn);
  const visibleSendIdentities = useMemo(() => new Set(bubbles.flatMap((bubble) => {
    const identity = bubble.derived ? undefined : canonicalSendIdentity(bubble.record);
    return identity ? [identity] : [];
  })), [bubbles]);
  const sendsByIdentity = useMemo(() => new Map(state.sends.map((send) => [sendIdentity(send), send])), [state.sends]);
  const canonicalSends = useMemo(() => {
    const records = new Map<string, CanonicalMessage>();
    for (const record of state.records) {
      if (record.kind === 'message') {
        const identity = canonicalSendIdentity(record);
        if (identity) records.set(identity, record);
      }
    }
    return records;
  }, [state.records]);
  const localSends = useMemo(() => state.sends.filter((send) =>
    !visibleSendIdentities.has(sendIdentity(send))), [state.sends, visibleSendIdentities]);
  const timeline = useMemo(() => {
    return composeTimeline(bubbles, localSends, canonicalSends, sendsByIdentity,
      state.records.filter((record): record is CanonicalTransition => record.kind === 'transition'));
  }, [bubbles, canonicalSends, localSends, sendsByIdentity, state.records]);
  const transcript = useMemo(() => transcriptIndex(timeline), [timeline]);
  const tools = useMemo(() => {
    if (!state.toolCallsEnabled) return undefined;
    if (state.toolCallIndex) return state.toolCallIndex;
    // Custom hosts may still provide an array snapshot. The live runtime uses
    // the persistent index and never takes this full conversion path.
    let index: ToolCallIndex | undefined;
    for (const call of state.toolCalls ?? []) {
      const calls = putIndex(getIndex(index, call.afterMessageSeq), call.seq, call, call.startedAt);
      index = putIndex(index, call.afterMessageSeq, calls, calls.maxTime);
    }
    return index;
  }, [state.toolCallsEnabled, state.toolCallIndex, state.toolCalls]);
  const pending = useMemo(() => placePending(transcript.placements, tools), [transcript, tools]);
  const previousTail = useRef<{ generation: number; ready: boolean; seq: number } | null>(null);
  // Canonical records are ordered by sequence. A high-water mark excludes old
  // pages and newly revealed filtered rows without scanning retained history.
  const tailSeq = state.records.at(-1)?.seq ?? -1;
  const arrivalFloor = useMemo(() => {
    const prior = previousTail.current;
    return state.status === 'ready' && prior?.ready && prior.generation === state.generation ? prior.seq : Infinity;
  }, [state.records, state.status, state.generation]);
  useLayoutEffect(() => {
    previousTail.current = { generation: state.generation, ready: state.status === 'ready',
      seq: Math.max(previousTail.current?.seq ?? -1, tailSeq) };
  }, [state.generation, state.status, tailSeq]);
  const statusName = statusText(state);

  useEffect(() => {
    if (host.settingsRequestRevision <= handledSettingsRevision.current) return;
    handledSettingsRevision.current = host.settingsRequestRevision;
    openSettings();
  }, [host.settingsRequestRevision, openSettings]);

  useEffect(() => {
    if (typeof window === 'undefined' || overlayRef.current) return;
    try {
      const entries = unseenReleaseNotes(window.localStorage, CHAT_RELEASE_VERSION, RELEASE_NOTES);
      if (entries?.length) setOverlayState({ kind: 'whats-new', entries });
    } catch { /* Storage may be unavailable. */ }
  }, [setOverlayState]);

  useLayoutEffect(() => {
    const isOpen = overlay !== null;
    if (isOpen) composer.current?.closeStatusPopup();
    if (!isOpen && overlayWasOpen.current && !host.composerHidden) composer.current?.focusAtEnd();
    overlayWasOpen.current = isOpen;
    hostBridge?.setOverlayOpen(isOpen);
  }, [overlay, host.composerHidden, host.ready, hostBridge]);

  useEffect(() => {
    if (!agentName) return;
    const priorTitle = document.title;
    document.title = agentName;
    return () => { if (document.title === agentName) document.title = priorTitle; };
  }, [agentName]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onPointerDown = (event: PointerEvent) => {
      lastPointerInChat.current = event.target instanceof Node && element.contains(event.target);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const { optedIn, composerHidden, scrollBy } = keyboardActions.current;
      // A host that opted into its native composer owns keyboard behavior.
      if (optedIn || composerHidden) return;
      const target = event.target;
      const targetNode = target instanceof Node ? target : null;
      const inChat = Boolean(targetNode && element.contains(targetNode));
      const bodyFocused = target === document.body && document.activeElement === document.body;
      const standalonePage = Boolean(element.closest('[data-chat-standalone]'));
      // Body-targeted events belong to Chat only on the standalone example or
      // after a pointer interaction in the embedded Chat surface.
      if (!inChat && !(bodyFocused && (standalonePage || lastPointerInChat.current))) return;
      if (event.key === 'Tab') {
        if (event.shiftKey || (targetNode && composer.current?.contains(targetNode))) return;
        if (composer.current?.focusAtEnd()) event.preventDefault();
        return;
      }
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const box = viewport.current;
      if (!box) return;
      const key = event.key.toLowerCase();
      let distance: number | undefined;
      if (key === 'j' || key === 'k') {
        const style = getComputedStyle(box);
        const lineHeight = Number.parseFloat(style.lineHeight) || (Number.parseFloat(style.fontSize) || 16) * 1.5;
        distance = lineHeight * 3 * (key === 'j' ? 1 : -1);
      } else if (key === 'u' || key === 'd') {
        distance = Math.max(1, box.clientHeight * 0.85) * (key === 'd' ? 1 : -1);
      }
      if (distance === undefined) return;
      event.preventDefault();
      scrollBy(distance);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

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

  const loadOlder = () => {
    reading.holdPosition();
    void runtime.loadOlder();
  };

  useLayoutEffect(() => {
    const box = viewport.current;
    if (!box || state.status !== 'ready' || !state.hasOlder || state.loadingOlder || state.historyError || box.scrollTop >= 80) return;
    const frame = requestAnimationFrame(() => loadOlder());
    return () => cancelAnimationFrame(frame);
  }, [state.status, state.hasOlder, state.loadingOlder, state.historyError, state.records, state.provenance]);

  const handleScroll = () => {
    const box = viewport.current;
    if (!box) return;
    reading.onScroll();
    if (box.scrollTop < 80 && state.status === 'ready' && state.hasOlder && !state.loadingOlder) loadOlder();
  };

  const notice = state.status === 'ready' ? undefined
    : state.status === 'loading' ? 'Connecting to the selected conversation…'
      : state.status === 'stale' ? 'Reconnecting; the conversation may be out of date.'
        : state.status === 'error' ? (host.optedIn
          ? 'Disconnected. Reconnect to refresh the conversation.'
          : 'Disconnected. Open connection details to reconnect.')
          : statusName;
  const noticeTone = state.status === 'stale' ? 'caution'
    : state.status === 'error' || state.status === 'unauthorized' || state.status === 'unsupported' ? 'danger'
      : 'neutral';

  const renderItem = useCallback((item: TimelineItem) => {
        if (item.kind === 'tool') return <ToolCallRow key={'tool-' + item.call.id} call={item.call} registerRow={reading.registerRow} />;
        if (item.kind === 'transition') {
          const record = item.record;
          return <article key={record.id} ref={element => reading.registerRow(record.id, element)}
            data-record-key={record.id} data-scroll-key={record.id} className="tb-chat-transition tb-chat-caption tb-chat-caption-neutral" aria-label="Session transition">
            {record.content || [record.from, record.to].filter(Boolean).join(' → ')}
          </article>;
        }
        if (item.kind === 'bubble') {
          const { bubble } = item;
          return <RecordRow key={bubble.key} bubble={bubble} scrollKey={item.scrollKey}
            arriving={bubble.record.seq > arrivalFloor && !item.scrollKey}
            renderMessage={renderMessage} agentName={agentName} registerRow={reading.registerRow} />;
        }
        const { send } = item;
        const time = localTimestamp(send.submittedAt);
        const hostManaged = send.hostSend !== undefined;
        const unreachable = send.reason === 'unreachable';
        const retryUnavailable = send.reason === 'retry-unavailable';
        const reconnectingSend = send.status === 'pending' && unreachable;
        const retryAvailable = !hostManaged && ['failed', 'uncertain'].includes(send.status) && !send.reconciled;
        return <article ref={element => reading.registerRow(`local-${send.clientMessageId}`, element)} className="tb-chat-bubble tb-chat-bubble-human tb-chat-local" key={send.clientMessageId}
          data-record-key={`local-${send.clientMessageId}`} data-scroll-key={`local-${send.clientMessageId}`} aria-label={`Your message, ${send.status}`}>
          <div className="tb-chat-bubble-body">{markdownBody(send.content)}</div>
          <p className="tb-chat-send-state" data-send-status={send.status} role={reconnectingSend ? 'status' : undefined}>{send.status === 'uncertain' ? 'Delivery is uncertain'
            : send.status === 'failed' ? unreachable ? 'Not connected to the server' : 'Message could not be sent'
              : send.status === 'pending' ? reconnectingSend ? 'Not connected to the server; retrying…' : 'Sending…'
                : hostManaged && !send.reconciled ? 'Accepted; checking conversation history' : 'Sent'}</p>
          {send.reason && !reconnectingSend && <p className="tb-chat-send-reason" role="alert">
            {send.status === 'uncertain'
              ? hostManaged
                ? 'Delivery could not be confirmed. Use the host composer to decide whether to retry.'
                : retryUnavailable
                  ? 'This target stopped supporting safe retries. Delivery could not be confirmed; check the conversation before retrying.'
                : 'Delivery could not be confirmed. Retry after the connection is current.'
              : unreachable ? 'Reconnect, then check the conversation before retrying this message.'
              : hostManaged
                ? 'This message was refused. Any retry or text editing belongs in the host composer.'
                : 'The message could not be sent. Retry it or restore the text to the composer.'}
          </p>}
          {retryAvailable && <div className="tb-chat-send-actions">
            <button type="button" disabled={state.status !== 'ready'}
              onClick={() => void runtime.retrySend(send.clientMessageId)}>Retry message</button>
            {state.status !== 'ready' && <span>{state.status === 'unsupported'
              ? 'Reconnect to a supported target before retrying.' : 'Reconnect before retrying.'}</span>}
            <button type="button" onClick={() => composer.current?.restore(send.content)}>Restore text to the composer</button>
          </div>}
          <time className="tb-chat-time" dateTime={time.dateTime}>{time.text}</time>
        </article>;
  }, [reading.registerRow, arrivalFloor, renderMessage, agentName, state.status, runtime]);

  return <section ref={root} className={`tb-chat ${host.composerHidden ? 'tb-chat-host-composer-hidden' : ''} ${className || ''}`}
    aria-label={agentName ? `${agentName} conversation` : 'Conversation'}>
    <div className="tb-chat-viewport" ref={viewport} onScroll={handleScroll} role="log" tabIndex={-1}
      onWheel={reading.interrupt} onTouchStart={reading.interrupt} onPointerDown={reading.interrupt}
      onKeyDown={(event) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) reading.interrupt(); }}
      aria-label={`${agentName || 'Conversation'} messages`} aria-live="polite" aria-relevant="additions text">
      {state.loadingOlder && <div className="tb-chat-history-loading tb-chat-caption tb-chat-caption-neutral" role="status">Loading earlier messages…</div>}
      <div className="tb-chat-message-content" ref={reading.content}>
      {notice && <div className={`tb-chat-notice tb-chat-caption tb-chat-caption-${noticeTone} tb-chat-notice-${state.status}`} role={state.status === 'loading' ? 'status' : 'alert'}>
        <span className="tb-chat-caption-body">
          <span>{notice}</span>
          {host.optedIn && state.status === 'error' &&
            <button type="button" onClick={() => void runtime.rebuild({ restart: true })}>Reconnect</button>}
        </span>
      </div>}
      {state.toolCallsEnabled !== undefined && <div className="tb-chat-tool-controls">
        <button type="button" aria-pressed={state.toolCallsEnabled}
          onClick={() => runtime.setToolCallsEnabled?.(!state.toolCallsEnabled)}>Tool calls</button>
        {state.toolCallsEnabled && state.toolCallsLoading && <span className="tb-chat-caption tb-chat-caption-neutral" role="status">Loading tool history…</span>}
        {state.toolCallsEnabled && state.toolCallsError && <span className="tb-chat-caption tb-chat-caption-danger" role="status">
          <span className="tb-chat-caption-body">
            <span>Tool history is not current: {state.toolCallsError}{' '}</span>
            <button type="button" onClick={() => runtime.retryToolCalls?.()}>Retry tool history</button>
          </span>
        </span>}
      </div>}
      {state.historyError && <div className="tb-chat-history-error tb-chat-caption tb-chat-caption-danger" role="alert">
        <span className="tb-chat-caption-body">
          <span>Earlier messages could not be loaded: {state.historyError}</span>
          <button type="button" onClick={loadOlder}>Retry loading messages</button>
        </span>
      </div>}
      {projection.issues.length > 0 && <div className="tb-chat-history-error tb-chat-caption tb-chat-caption-danger" role="alert">
        Some message sources could not be interpreted. Conversation filtering is incomplete.
      </div>}
      <IndexedTimeline messages={transcript.index} tools={tools} pending={pending.index} render={renderItem} />
      {pending.tail.map(renderItem)}
      {caption && <div className="tb-chat-active-caption tb-chat-caption tb-chat-caption-neutral" role="status" aria-label={`Active turn: ${caption.text}`}>
        <span className="tb-chat-caption-body"><span aria-hidden="true">{caption.icon}</span><span>{caption.text}</span></span>
      </div>}
      {state.status === 'ready' && state.records.length === 0 && localSends.length === 0 && !state.hasOlder &&
        <p className="tb-chat-empty">No messages yet.</p>}
      </div>
    </div>
    {reading.showLatest && <button type="button" className="tb-chat-scroll-latest" data-scroll-latest="true"
      aria-label="Scroll to latest messages" onMouseDown={(event) => event.preventDefault()} onClick={reading.scrollToLatest}>
      <span aria-hidden="true">↓</span> Latest messages
    </button>}
    {!host.composerHidden && <Composer ref={composer} runtime={runtime} state={state} agentName={agentName}
      root={root} suppressStatus={host.optedIn} onSettings={openSettings} onSendAccepted={reading.scrollToLatest} />}
    {overlay && <ReleaseNotesDialog overlay={overlay} entries={bundledNotes} onClose={closeOverlay}
      onOpenReleaseNotes={openReleaseNotes} onBack={backToSettings} />}
  </section>;
}

/** One host-selected session. Changing selection/identity disposes the old runtime. */
export function TightbeamChat({ sessionKey, adapter, identityKey, renderMessage, className }: TightbeamChatProps) {
  const key = `${sessionKey}\u0000${identityKey || ''}`;
  const latest = useRef({ key, sessionKey, adapter });
  latest.current = { key, sessionKey, adapter };
  const [opened, setOpened] = useState<{ key: string; adapter: TightbeamAdapter; runtime: ChatRuntime } | null>(null);
  const bridgeRef = useRef<HostComposerBridge | null>(null);
  const [hostBridge, setHostBridge] = useState<HostComposerBridge | null>(null);
  useEffect(() => {
    const bridge = typeof window === 'undefined' ? null : HostComposerBridge.create(window);
    bridgeRef.current = bridge;
    setHostBridge(bridge);
    return () => {
      bridge?.dispose();
      if (bridgeRef.current === bridge) bridgeRef.current = null;
    };
  }, []);
  useEffect(() => {
    const runtime = adapter.open(sessionKey);
    setOpened({ key, adapter, runtime });
    bridgeRef.current?.attach(runtime);
    return () => {
      const current = latest.current;
      const reason = current.sessionKey !== sessionKey ? 'target-changed'
        : current.key !== key || current.adapter !== adapter ? 'identity-changed' : 'disposed';
      bridgeRef.current?.detach(reason);
      runtime.dispose();
    };
  }, [adapter, sessionKey, key]);
  if (!opened || opened.key !== key || opened.adapter !== adapter) {
    return <section className={`tb-chat ${className || ''}`} aria-label="Conversation" role="status">
      <span className="tb-chat-initial-caption tb-chat-caption tb-chat-caption-neutral">Connecting…</span>
    </section>;
  }
  return <ChatBody key={key} runtime={opened.runtime} renderMessage={renderMessage}
    className={className} hostBridge={hostBridge} />;
}
