import { forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type AnchorHTMLAttributes, type FormEvent, type HTMLAttributes, type ImgHTMLAttributes,
  type ReactNode, type RefObject, type TableHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightRecognizedCode } from './markdownHighlight';
import type { ChatRuntime, CanonicalMessage, CanonicalTransition, ToolCallRecord, ToolCallIndex, ConversationRecord, LocalSend, RuntimeState, TightbeamAdapter, TurnProvenance } from './types';
import { projectMessages, type HumanMember } from './messageVisibility';
import { buildActivityTrail, type ActivityFold, type ActivityLine, type ActivityOverflow, type MessageActivityItem } from './activityTrail';
import type { ActivityPillIcon, ActivityPillPresentation } from './activityPresentation';
import { useReadingPosition } from './useReadingPosition';
import { firstAfterTime, getIndex, indexValues, putIndex, type RecordIndex } from './recordIndex';
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
  /** Same-page route to the configured conversation for an unavailable linked target. */
  readonly configuredConversationHref?: string;
  /** Change when the host changes principal or transport lifetime. */
  readonly identityKey?: string;
  readonly renderMessage?: (record: ConversationRecord, context: RenderContext) => ReactNode | undefined;
  readonly className?: string;
}

interface Bubble {
  readonly key: string;
  readonly record: CanonicalMessage;
  readonly side: 'human' | 'agent';
  readonly ownerScoped: boolean;
  readonly sender: string;
  readonly displayContent?: string;
  readonly member?: HumanMember;
  readonly derived: boolean;
}

const olderHistoryPrefetchDistance = (viewport: HTMLElement) => Math.max(80, viewport.clientHeight * 1.5);
const toolHistoryErrorGraceMs = 1000;

type TimelineItem =
  | { readonly kind: 'tool'; readonly call: ToolCallRecord }
  | { readonly kind: 'transition'; readonly record: CanonicalTransition }
  | { readonly kind: 'activity'; readonly entry: ActivityLine }
  | { readonly kind: 'activity-fold'; readonly entry: ActivityFold }
  | { readonly kind: 'overflow'; readonly entry: ActivityOverflow }
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
  if (item.kind === 'activity' || item.kind === 'activity-fold' || item.kind === 'overflow') return undefined;
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
  transitions: readonly CanonicalTransition[], activityItems: readonly MessageActivityItem[]): TimelineItem[] {
  const anchoredSendIdentities = new Set<string>();
  const anchors: TimelineAnchor[] = bubbles.map((bubble, order) => {
    const identity = bubble.derived ? undefined : canonicalSendIdentity(bubble.record);
    const send = identity && !anchoredSendIdentities.has(identity) ? sendsByIdentity.get(identity) : undefined;
    if (identity && send) anchoredSendIdentities.add(identity);
    const item: TimelineItem = { kind: 'bubble', bubble, scrollKey: send ? `local-${send.clientMessageId}` : undefined };
    return { item, record: bubble.record, order };
  });
  for (const record of transitions) anchors.push({ item: { kind: 'transition', record }, record, order: anchors.length });
  for (const entry of activityItems) {
    const item: TimelineItem = entry.kind === 'overflow' ? { kind: 'overflow', entry }
      : entry.kind === 'fold' ? { kind: 'activity-fold', entry } : { kind: 'activity', entry };
    anchors.push({ item, record: { id: entry.id, seq: entry.anchorSeq }, order: anchors.length });
  }
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

  const anchorPriority = (item: TimelineItem) => item.kind === 'bubble' || (item.kind === 'local' && item.canonical) ? 0
    : item.kind === 'transition' ? 1 : 2;
  anchors.sort((left, right) => left.record.seq - right.record.seq ||
    anchorPriority(left.item) - anchorPriority(right.item) || left.order - right.order ||
    left.record.id.localeCompare(right.record.id));

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
      ? item.record.seq : item.kind === 'activity' || item.kind === 'overflow' ? item.entry.anchorSeq
        : item.kind === 'activity-fold' ? item.entry.anchorSeq
          : item.kind === 'tool' ? item.call.afterMessageSeq : item.canonical!.seq;
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
const markdownRehypePlugins = [highlightRecognizedCode];
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
    <ReactMarkdown remarkPlugins={markdownPlugins} rehypePlugins={markdownRehypePlugins}
      components={markdownComponents} skipHtml>{content}</ReactMarkdown>
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
  if (state.status === 'error') return 'Disconnected';
  if (state.status === 'loading') return 'Connecting';
  if (state.status === 'unauthorized') return 'Access to this conversation is unavailable';
  if (state.status === 'ready' && state.liveConnectionState === 'disconnected') return 'Disconnected';
  if (state.status === 'stale' || (state.status === 'ready' &&
      (state.liveConnectionState === 'connecting' || state.liveConnectionState === 'reconnecting' ||
        (!state.liveConnectionState && state.liveError)))) return 'Reconnecting';
  if (state.sessionNotFound) return 'Conversation not found';
  if (state.conversationError) return 'Conversation history unavailable';
  if (state.sessionError) return 'Session details unavailable';
  return state.status === 'ready' ? 'Connected' : 'This conversation is not supported';
}

function statusIndicatorState(state: RuntimeState): RuntimeState['status'] {
  if (state.status !== 'ready') return state.status;
  if (state.liveConnectionState === 'disconnected') return 'error';
  if (state.liveConnectionState === 'connecting' || state.liveConnectionState === 'reconnecting' ||
      (!state.liveConnectionState && state.liveError)) return 'stale';
  return 'ready';
}

type ActiveIcon = 'person' | 'batch' | 'chat' | 'gear';

function activeCaption(provenance?: TurnProvenance): { icon: ActiveIcon; text: string } | undefined {
  if (!provenance || provenance.turn.status !== 'running') return undefined;
  if (provenance.batchCount !== undefined && provenance.batchCount > 1) return { icon: 'batch', text: 'Processing message batch' };
  if (provenance.turn.triggerSource === 'batch' && provenance.batchCount !== 1) return undefined;
  const kind = provenance.sourceKind;
  if (kind === 'human') return { icon: 'person', text: 'Replying to you' };
  if (kind === 'agent') {
    if (provenance.sourceDisplayName) return { icon: 'chat', text: provenance.sourceDisplayName };
    return provenance.batchCount !== undefined ? undefined : { icon: 'gear', text: 'Other activity' };
  }
  if (kind === 'substrate') {
    const messageType = provenance.sourceMessageType?.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').trim();
    if (messageType) return { icon: 'gear', text: messageType };
    return provenance.batchCount !== undefined ? undefined : { icon: 'gear', text: 'Other activity' };
  }
  if (provenance.batchCount !== undefined) return undefined;
  return { icon: 'gear', text: 'Other activity' };
}

export function workingStateOpacity(elapsedMs: number): number {
  const phase = ((Math.max(0, elapsedMs) % 5000) + 5000) % 5000 / 1000;
  let brightness: number;
  if (phase < 1.7) brightness = (1 - Math.cos(Math.PI * phase / 1.7)) / 2;
  else if (phase < 1.9) brightness = 1;
  else if (phase < 4.5) brightness = (1 + Math.cos(Math.PI * (phase - 1.9) / 2.6)) / 2;
  else brightness = 0;
  return 0.4 + 0.6 * brightness;
}

function ActiveTurnIcon({ icon }: { readonly icon: ActiveIcon }) {
  if (icon === 'person') return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="7.5" r="4" fill="currentColor" />
    <path d="M4.5 22c.7-5.1 3.2-8 7.5-8s6.8 2.9 7.5 8" fill="currentColor" />
  </svg>;
  if (icon === 'chat') return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M4 5.5A3.5 3.5 0 0 1 7.5 2h9A3.5 3.5 0 0 1 20 5.5v7a3.5 3.5 0 0 1-3.5 3.5H12l-5.5 4v-4h-1A3.5 3.5 0 0 1 2 12.5v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
  </svg>;
  return <span aria-hidden="true">{icon === 'batch' ? '▣' : '⚙'}</span>;
}

function WorkingStateCaption({ caption, turnSeq }: {
  readonly caption: { readonly icon: ActiveIcon; readonly text: string };
  readonly turnSeq: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || typeof window === 'undefined') return;
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const startedAt = performance.now();
    let frame: number | undefined;
    let stopped = false;
    const draw = (now: number) => {
      if (stopped) return;
      const reduced = preference?.matches ?? false;
      node.style.opacity = reduced ? '1' : workingStateOpacity(now - startedAt).toFixed(3);
      if (!reduced) frame = window.requestAnimationFrame(draw);
    };
    const onPreferenceChange = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      draw(performance.now());
    };
    draw(startedAt);
    preference?.addEventListener?.('change', onPreferenceChange);
    return () => {
      stopped = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      preference?.removeEventListener?.('change', onPreferenceChange);
    };
  }, [turnSeq]);
  return <div ref={element} className="tb-chat-active-caption tb-chat-caption tb-chat-caption-neutral" role="status"
    aria-label={`Active turn: ${caption.text}`}>
    <span className="tb-chat-caption-body"><span className="tb-chat-active-caption-icon"><ActiveTurnIcon icon={caption.icon} /></span>
      <span>{caption.text}</span></span>
  </div>;
}

function transitionGist(record: CanonicalTransition): string {
  if (record.transition === 'restart') return 'Context reset';
  if (record.transition === 'compaction') return 'Context compacted';
  if (record.transition === 'model' && record.from && record.to) {
    return `Model settings changed: ${record.from} → ${record.to}`;
  }
  if (record.transition === 'harness' && record.from && record.to) {
    return `Harness changed: ${record.from} → ${record.to}`;
  }
  return record.content ?? '';
}

function StatusIcon({ state }: { state: RuntimeState }) {
  const status = statusIndicatorState(state);
  return <span className={`tb-chat-status-dot tb-chat-status-${status}`} aria-hidden="true" />;
}

const RecordRow = memo(function RecordRow({ bubble, renderMessage, agentName, registerRow, scrollKey: scrollKeyOverride }: {
  bubble: Bubble;
  renderMessage?: TightbeamChatProps['renderMessage'];
  agentName: string;
  registerRow: (key: string, element: HTMLElement | null) => void;
  scrollKey?: string;
}) {
  const { record } = bubble;
  const scrollKey = scrollKeyOverride ?? (bubble.derived ? bubble.key : record.id);
  const rowRef = useCallback((element: HTMLElement | null) => {
    registerRow(scrollKey, element);
  }, [registerRow, scrollKey]);
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
    previous.scrollKey === next.scrollKey;
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
    if (state.status === 'unauthorized') return;
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
        <div className="tb-chat-popup-heading"><StatusIcon state={state} />
          <button type="button" aria-label="Close connection details" onClick={closeStatusPopup}>×</button>
        </div>
        {state.sessionError && <p>Session details: {state.sessionError}</p>}
        {state.sessionNotFound && <p>This conversation no longer exists.</p>}
        {state.conversationError && <p>Conversation history: {state.conversationError}</p>}
        {state.historyError && <p>Earlier messages: {state.historyError}</p>}
        <dl>
          <dt>Gateway</dt><dd>{state.targetGateway || 'Unavailable'}</dd>
          <dt>Session</dt><dd>{state.sessionKey}</dd>
          <dt>Agent</dt><dd>{agentName || 'Unavailable'}</dd>
          <dt>Model</dt><dd>{state.session?.model || 'Unavailable'}</dd>
          <dt>Harness</dt><dd>{state.session?.harness || 'Unavailable'}</dd>
        </dl>
        {(state.status === 'error' || state.sessionError || state.sessionNotFound || state.conversationError || state.liveError ||
          state.liveConnectionState === 'disconnected') &&
          <button type="button" onClick={() => void runtime.rebuild({ restart: true })}>Reconnect</button>}
      </div>}
      <button ref={sendControl} type="submit" className="tb-chat-send-button" aria-label="Send message"
        disabled={!draft.trim() || (state.status === 'unauthorized' && !isSettingsCommand(draft))}>
        <span className="tb-chat-send-button-disc" aria-hidden="true" />
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0L6 11m6-6 6 6" /></svg>
      </button>
    </div>
  </form>;
});

function ActivityOverflowButton({ entry, registerRow, expand }: {
  readonly entry: ActivityOverflow;
  readonly registerRow: (key: string, element: HTMLElement | null) => void;
  readonly expand: (runKey: string, control: HTMLButtonElement) => void;
}) {
  return <button type="button" className="tb-chat-activity-overflow" aria-label="Show earlier activity"
    key={entry.id} ref={element => registerRow(entry.id, element)} data-record-key={entry.id}
    data-scroll-key={entry.id} data-activity-run={entry.runKey}
    onClick={event => expand(entry.runKey, event.currentTarget)}>…</button>;
}

const activityPillIconPaths: Record<ActivityPillIcon, ReactNode> = {
  message: <path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />,
  attest: <><rect x="7" y="3" width="10" height="4" rx="1" /><path d="M17 5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" /><path d="m8 14 2.5 2.5L16 11" /></>,
  assignment: <><path d="M9 4h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M7 11h10M7 15h7" /></>,
  decision: <><circle cx="12" cy="12" r="9" /><path d="M9.4 9a2.7 2.7 0 1 1 4.8 1.7c-1 1.1-2.2 1.4-2.2 3" /><path d="M12 17h.01" /></>,
  'decision-answered': <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="m9 10 2 2 4-4" /></>,
  hourglass: <><path d="M5 22h14M5 2h14M7 2v4l5 6 5-6V2M7 22v-4l5-6 5 6v4" /></>,
  'work-item': <><path d="M3 12h5l2 3h4l2-3h5" /><path d="m5 5-2 7v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7l-3-7z" /></>,
  session: <><path d="M3 7h18v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M2 3h20v4H2zM10 12h4" /></>,
  turn: <><path d="m10.3 3.9-8.5 14a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3l-8.5-14a2 2 0 0 0-3.4 0z" /><path d="M12 9v4m0 4h.01" /></>,
  remedy: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />,
  refused: <><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></>,
  alarm: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2M5 3 2 6m17-3 3 3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 4h13l-2 4 2 4H5" /></>,
  activity: <><path d="M3 12h4l2-6 4 12 2-6h6" /></>,
  notice: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
  process: <><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M8 7.5 10.8 16m5.2-8.5L13.2 16M8 6h8" /></>,
};

function ActivityPillIconView({ icon }: { readonly icon: ActivityPillIcon }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{activityPillIconPaths[icon]}</svg>;
}

function ToolCallTerminalIcon({ className }: { readonly className: string }) {
  return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="3" y="3" width="18" height="18" rx="3" fill="currentColor" />
    <path d="m7 9 3 3-3 3" fill="none" stroke="var(--tb-chat-background)" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12.5 15h4.5" fill="none" stroke="var(--tb-chat-background)" strokeWidth={1.8}
      strokeLinecap="round" />
  </svg>;
}

function ActivityPillContents({ presentation }: { readonly presentation: ActivityPillPresentation }) {
  return <>
    <span className={`tb-chat-activity-pill tb-chat-activity-pill-${presentation.tone}`}>
      <ActivityPillIconView icon={presentation.icon} />
      <span>{presentation.label}</span>
    </span>
    <span className="tb-chat-activity-pill-text">{presentation.text}</span>
    {presentation.metadata && <span className="tb-chat-activity-pill-meta">{presentation.metadata}</span>}
  </>;
}

function sameActivityPresentation(left: ActivityPillPresentation | undefined,
  right: ActivityPillPresentation | undefined): boolean {
  return left === right || Boolean(left && right && left.label === right.label && left.tone === right.tone &&
    left.icon === right.icon && left.text === right.text && left.metadata === right.metadata);
}

function sameActivityLine(left: ActivityLine, right: ActivityLine): boolean {
  return left.id === right.id && left.kind === right.kind && left.runKey === right.runKey &&
    left.gist === right.gist && left.accessibleText === right.accessibleText &&
    left.originalContent === right.originalContent &&
    sameActivityPresentation(left.presentation, right.presentation);
}

const ActivityMessageRow = memo(function ActivityMessageRow({ entry, registerRow, scrollKey = entry.id }: {
  readonly entry: ActivityLine;
  readonly registerRow: (key: string, element: HTMLElement | null) => void;
  readonly scrollKey?: string;
}) {
  const presentation = entry.presentation;
  const accessibleText = presentation
    ? `${presentation.label}: ${presentation.text}${presentation.metadata ? `, ${presentation.metadata}` : ''}`
    : entry.accessibleText;
  return <div role="note" tabIndex={-1} aria-label={accessibleText}
    className={`tb-chat-activity-line tb-chat-activity-${entry.kind}${presentation ? ' tb-chat-activity-pill-row' : ''}`}
    ref={element => registerRow(scrollKey, element)} data-record-key={entry.id} data-scroll-key={scrollKey}
    data-activity-run={entry.runKey} title={presentation ? entry.originalContent ?? entry.accessibleText : undefined}>
    {!presentation && <span className="tb-chat-activity-bullet" aria-hidden="true">•</span>}
    {presentation ? <ActivityPillContents presentation={presentation} />
      : <span className="tb-chat-activity-gist">{entry.gist}</span>}
  </div>;
}, (previous, next) => previous.registerRow === next.registerRow && previous.scrollKey === next.scrollKey &&
  sameActivityLine(previous.entry, next.entry));

const ToolCallRow = memo(function ToolCallRow({ call, entry, registerRow, preservePosition, expandRun,
  expandedToolCalls, setToolCallExpanded }: {
  call: ToolCallRecord;
  entry?: ActivityLine | ActivityOverflow;
  registerRow: (key: string, element: HTMLElement | null) => void;
  preservePosition: () => void;
  expandRun: (runKey: string, control: HTMLButtonElement) => void;
  expandedToolCalls?: ReadonlySet<string>;
  setToolCallExpanded?: (id: string, expanded: boolean) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = expandedToolCalls ? expandedToolCalls.has(call.id) : localExpanded;
  const updateExpanded = (next: boolean) => {
    if (expandedToolCalls) setToolCallExpanded?.(call.id, next);
    else setLocalExpanded(next);
  };
  const terminal = call.status === 'completed' || call.status === 'failed';
  if (!entry) return null;
  if (entry.kind === 'overflow') return <ActivityOverflowButton entry={entry} registerRow={registerRow} expand={expandRun} />;
  const title = call.title.trim() || call.toolName?.trim() || call.kind;
  const status = call.status === 'pending' || call.status === 'in_progress' ? 'running'
    : call.status === 'completed' ? 'done' : 'failed';
  const gist = entry.gist || `${title} · ${status}`;
  const accessibleText = entry.accessibleText || `Tool call: ${gist}`;
  const key = 'tool-' + call.id;
  return <details ref={element => registerRow(key, element)} tabIndex={-1} data-record-key={key} data-scroll-key={key}
    open={expanded} data-activity-run={entry.runKey} className="tb-chat-activity-line tb-chat-activity-tool"
    aria-label={accessibleText} onToggle={event => updateExpanded(event.currentTarget.open)}>
      <summary aria-label={`${accessibleText}. Show input and result`}
        onClick={preservePosition}>
        <ToolCallTerminalIcon className="tb-chat-tool-terminal-icon" />
        <span className="tb-chat-activity-gist">{gist}</span>
      </summary>
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
  </details>;
});

const ActivityRunRow = memo(function ActivityRunRow({ entry, expanded, toggle, registerRow, preservePosition, expandHistoryRun,
  expandedToolCalls, setToolCallExpanded }: {
  readonly entry: ActivityFold;
  readonly expanded: boolean;
  readonly toggle: (id: string) => void;
  readonly registerRow: (key: string, element: HTMLElement | null) => void;
  readonly preservePosition: () => void;
  readonly expandHistoryRun: (runKey: string, control: HTMLButtonElement) => void;
  readonly expandedToolCalls: ReadonlySet<string>;
  readonly setToolCallExpanded: (id: string, expanded: boolean) => void;
}) {
  const toolRun = entry.activityKind === 'tool';
  const detailLines = entry.lines;
  const presentation = entry.summary.presentation;
  const latestDescription = presentation
    ? `${presentation.label}: ${presentation.text}${presentation.metadata ? `, ${presentation.metadata}` : ''}`
    : entry.summary.gist;
  return <div className={`tb-chat-activity-run tb-chat-activity-${entry.activityKind}`} tabIndex={-1}
    ref={element => registerRow(entry.id, element)} data-record-key={entry.id} data-scroll-key={entry.id}
    data-activity-run={entry.runKey} data-activity-fold="true" data-run-expanded={expanded ? 'true' : 'false'}>
    <button type="button" className={`tb-chat-activity-run-toggle tb-chat-activity-${entry.activityKind}${toolRun ? ' tb-chat-activity-tool-run-toggle' : ''}${presentation ? ' tb-chat-activity-pill-toggle' : ''}`}
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${entry.activityKind} activity run, ${entry.lines.length} entries. Latest: ${latestDescription}`}
      title={presentation ? entry.summary.originalContent ?? entry.summary.accessibleText : undefined}
      onClick={() => { preservePosition(); toggle(entry.id); }}>
      {toolRun
        ? <ToolCallTerminalIcon className="tb-chat-tool-terminal-icon" />
        : <>
          {!presentation && <span className="tb-chat-activity-bullet" aria-hidden="true">•</span>}
          <span className={`tb-chat-activity-run-chevron${expanded ? ' is-expanded' : ''}`} aria-hidden="true" />
        </>}
      {presentation ? <ActivityPillContents presentation={presentation} />
        : <span className="tb-chat-activity-gist">{entry.summary.gist}</span>}
      <span className="tb-chat-activity-run-count" aria-hidden="true">×{entry.lines.length}</span>
      {toolRun && <span className={`tb-chat-activity-run-chevron${expanded ? ' is-expanded' : ''}`} aria-hidden="true" />}
    </button>
    {expanded && <div className="tb-chat-activity-run-rows">
      {detailLines.map(line => line.kind === 'tool' && line.call
        ? <ToolCallRow key={line.id} call={line.call} entry={line} registerRow={registerRow}
          preservePosition={preservePosition} expandRun={expandHistoryRun}
          expandedToolCalls={expandedToolCalls} setToolCallExpanded={setToolCallExpanded} />
        : <ActivityMessageRow key={line.id} entry={line} registerRow={registerRow}
          scrollKey={`activity-detail:${line.id}`} />)}
    </div>}
  </div>;
}, (previous, next) => {
  // Tool rows keep their existing update path. Non-tool folds are summarized
  // by their latest member, so the common collapsed update check is constant
  // time even when a long run grows.
  if (previous.entry.activityKind === 'tool' || next.entry.activityKind === 'tool') return false;
  const before = previous.entry;
  const after = next.entry;
  if (previous.expanded !== next.expanded || previous.toggle !== next.toggle ||
      previous.registerRow !== next.registerRow || before.id !== after.id || before.runKey !== after.runKey ||
      before.activityKind !== after.activityKind || before.lines.length !== after.lines.length ||
      !sameActivityLine(before.summary, after.summary)) return false;
  if (!next.expanded) return true;
  return before.lines.every((line, index) => sameActivityLine(line, after.lines[index]));
});

function ChatBody({ runtime, renderMessage, className, hostBridge, configuredConversationHref }: {
  runtime: ChatRuntime;
  renderMessage?: TightbeamChatProps['renderMessage'];
  className?: string;
  hostBridge: HostComposerBridge | null;
  configuredConversationHref?: string;
}) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const [toolCallsErrorAfterGrace, setToolCallsErrorAfterGrace] = useState<string | undefined>(undefined);
  useEffect(() => {
    const error = state.toolCallsError;
    if (!error) {
      setToolCallsErrorAfterGrace(undefined);
      return;
    }
    // Avoid a short-lived optional-feed warning changing transcript height.
    const timer = window.setTimeout(() => setToolCallsErrorAfterGrace(error), toolHistoryErrorGraceMs);
    return () => window.clearTimeout(timer);
  }, [state.toolCallsError]);
  const visibleToolCallsError = state.toolCallsError === toolCallsErrorAfterGrace
    ? toolCallsErrorAfterGrace : undefined;
  const subscribeHost = useCallback((listener: () => void) => subscribeHostComposer(hostBridge, listener), [hostBridge]);
  const getHostSnapshot = useCallback(() => getHostComposerSnapshot(hostBridge), [hostBridge]);
  const host = useSyncExternalStore(subscribeHost, getHostSnapshot, getHostSnapshot);
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedActivityRuns, setExpandedActivityRuns] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedToolCalls, setExpandedToolCalls] = useState<ReadonlySet<string>>(() => new Set());
  const [shownRuns, setShownRuns] = useState<ReadonlyMap<string, string>>(() => new Map());
  const focusExpandedRun = useRef<string | undefined>(undefined);
  const readingRevision = useMemo(() => ({ state, host, expandedRuns, expandedActivityRuns }),
    [state, host, expandedRuns, expandedActivityRuns]);
  const recoveryRevision = state.recoveryRevision ?? 0;
  const previousArrivalContext = useRef<{ sessionKey: string; generation: number; recoveryRevision: number; ready: boolean } | null>(null);
  const priorArrivalContext = previousArrivalContext.current;
  const arrivalEligible = state.status === 'ready' && priorArrivalContext?.ready === true &&
    priorArrivalContext.sessionKey === state.sessionKey && priorArrivalContext.generation === state.generation &&
    priorArrivalContext.recoveryRevision === recoveryRevision;
  const reading = useReadingPosition(state.status === 'ready', readingRevision, box =>
    state.loadingOlder || (!state.historyError && state.hasOlder && box.scrollTop < olderHistoryPrefetchDistance(box)),
    arrivalEligible, state.sessionKey);
  useLayoutEffect(() => {
    previousArrivalContext.current = { sessionKey: state.sessionKey, generation: state.generation,
      recoveryRevision, ready: state.status === 'ready' };
  }, [state.sessionKey, state.generation, state.status, recoveryRevision]);
  const { viewport } = reading;
  const observedHostSendIds = useRef<Set<string> | undefined>(undefined);
  if (!observedHostSendIds.current) {
    observedHostSendIds.current = new Set(state.sends
      .filter((send) => send.hostSend)
      .map((send) => send.clientMessageId));
  }
  const arriveOwnMessagesRef = useRef(reading.arriveOwnMessages);
  arriveOwnMessagesRef.current = reading.arriveOwnMessages;
  useLayoutEffect(() => {
    const observed = observedHostSendIds.current!;
    const submitted: string[] = [];
    for (const send of state.sends) {
      if (!send.hostSend || observed.has(send.clientMessageId)) continue;
      observed.add(send.clientMessageId);
      submitted.push(send.clientMessageId);
    }
    if (submitted.length) arriveOwnMessagesRef.current(submitted.map(id => `local-${id}`));
  }, [state.sends]);
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
      ownerScoped: message.side === 'agent' || message.senderLabel === 'You',
      sender: message.senderLabel ?? sourceLabel(message.side, agentName), derived: Boolean(message.member),
      displayContent: message.member?.content, member: message.member,
    })), [projection, agentName]);
  const caption = state.activityTurnStateAvailable === true ? activeCaption(state.activeTurn) : undefined;
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
  const localSendTimes = useMemo(() => localSends.flatMap(send => {
    const time = Date.parse(send.submittedAt);
    return Number.isFinite(time) ? [time] : [];
  }), [localSends]);
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
  const toolRecords = useMemo(() => {
    if (!tools) return [];
    const calls: ToolCallRecord[] = [];
    for (const byAnchor of indexValues(tools)) calls.push(...indexValues(byAnchor));
    return calls;
  }, [tools]);
  const activityRecords = useMemo(() => state.records.filter((record): record is CanonicalMessage => record.kind === 'message'), [state.records]);
  const transitions = useMemo(() => state.records.filter((record): record is CanonicalTransition => record.kind === 'transition'), [state.records]);
  const activityPlan = useMemo(() => buildActivityTrail({
    sessionKey: state.sessionKey,
    records: activityRecords,
    bubbles,
    transitions,
    localSendTimes,
    tools: toolRecords,
    toolsEnabled: Boolean(state.toolCallsEnabled),
    turnStateAvailable: state.activityTurnStateAvailable === true,
    activeTurnRunning: state.activeTurn?.turn.status === 'running',
    activeOwnerTurnRunning: state.activeTurn?.sourceKind === 'human' && state.activeTurn.turn.status === 'running',
    activeOwnerTurnSeq: state.activeTurn?.sourceKind === 'human' && state.activeTurn.turn.status === 'running'
      ? state.activeTurn.turn.seq : undefined,
    activeOwnerTurnMessageId: state.activeTurn?.sourceKind === 'human' && state.activeTurn.turn.status === 'running'
      ? state.activeTurn.turn.messageId : undefined,
    railDenials: state.liveRailDenials ?? [],
    historyRailDenials: state.historyRailDenials ?? [],
    shownRuns,
    expandedRuns,
  }), [activityRecords, bubbles, transitions, localSendTimes, expandedRuns, shownRuns, state.activityTurnStateAvailable, state.activeTurn,
    state.liveRailDenials, state.historyRailDenials, state.sessionKey,
    state.toolCallsEnabled, toolRecords]);
  const activityFoldIds = useMemo(() => new Set([
    ...activityPlan.messageItems.filter((item): item is ActivityFold => item.kind === 'fold').map(item => item.id),
    ...[...activityPlan.toolItems.values()].filter((item): item is ActivityFold => item.kind === 'fold').map(item => item.id),
  ]), [activityPlan]);
  useLayoutEffect(() => {
    setExpandedActivityRuns(prior => {
      const next = new Set([...prior].filter(id => activityFoldIds.has(id)));
      return next.size === prior.size ? prior : next;
    });
  }, [activityFoldIds]);
  useLayoutEffect(() => {
    let next: Map<string, string> | undefined;
    for (const [id, runKey] of activityPlan.membership) {
      if (shownRuns.has(id)) continue;
      next ??= new Map(shownRuns);
      next.set(id, runKey);
    }
    if (next) setShownRuns(next);
  }, [activityPlan.membership, shownRuns]);
  const expandRun = useCallback((runKey: string, control: HTMLButtonElement) => {
    reading.preserveVisiblePosition();
    focusExpandedRun.current = typeof document !== 'undefined' && document.activeElement === control ? runKey : undefined;
    setExpandedRuns((prior) => {
      if (prior.has(runKey)) return prior;
      const next = new Set(prior);
      next.add(runKey);
      return next;
    });
  }, [reading.preserveVisiblePosition]);
  const toggleActivityRun = useCallback((id: string) => {
    setExpandedActivityRuns(prior => {
      const next = new Set(prior);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const setToolCallExpanded = useCallback((id: string, expanded: boolean) => {
    setExpandedToolCalls(prior => {
      if (prior.has(id) === expanded) return prior;
      const next = new Set(prior);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  useLayoutEffect(() => {
    const runKey = focusExpandedRun.current;
    if (!runKey) return;
    focusExpandedRun.current = undefined;
    const rows = viewport.current?.querySelectorAll<HTMLElement>('[data-activity-run]');
    const first = rows && [...rows].find((row) => row.dataset.activityRun === runKey);
    first?.focus({ preventScroll: true });
  }, [expandedRuns, viewport]);
  const timeline = useMemo(() => composeTimeline(bubbles, localSends, canonicalSends, sendsByIdentity,
    transitions, activityPlan.messageItems), [activityPlan.messageItems, bubbles, canonicalSends, localSends, sendsByIdentity, transitions]);
  const transcript = useMemo(() => transcriptIndex(timeline), [timeline]);
  const pending = useMemo(() => placePending(transcript.placements, tools), [transcript, tools]);
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
    let lastRootHeight = element.clientHeight;
    let lastKeyboardInset = Number.parseFloat(element.style.getPropertyValue('--tb-chat-keyboard-inset')) || 0;
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
      const keyboardInset = Math.max(0, bottom - visibleBottom);
      element.style.setProperty('--tb-chat-keyboard-inset', `${keyboardInset}px`);
      const viewportGeometryChanged = currentHeight !== lastRootHeight || keyboardInset !== lastKeyboardInset;
      lastRootHeight = currentHeight;
      lastKeyboardInset = keyboardInset;
      // The inset changes the transcript's max-height; commit the new scroll
      // position alongside that geometry change.
      if (viewportGeometryChanged) reading.reconcileViewportLayout();
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

  const previousScrollTop = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const box = viewport.current;
    if (box) previousScrollTop.current = box.scrollTop;
  }, [state, host]);

  useLayoutEffect(() => {
    const box = viewport.current;
    if (!box || state.status !== 'ready' || !state.hasOlder || state.loadingOlder || state.historyError
      || box.scrollTop < 0 || box.scrollTop >= olderHistoryPrefetchDistance(box)) return;
    const frame = requestAnimationFrame(() => loadOlder());
    return () => cancelAnimationFrame(frame);
  }, [state.status, state.hasOlder, state.loadingOlder, state.historyError, state.records, state.provenance]);

  const handleScroll = () => {
    const box = viewport.current;
    if (!box) return;
    const previous = previousScrollTop.current;
    const current = box.scrollTop;
    previousScrollTop.current = current;
    reading.onScroll();
    const movedUp = previous !== undefined && current < previous;
    if (!movedUp || current < 0 || state.status !== 'ready' || !state.hasOlder || state.loadingOlder) return;
    if (state.historyError || current < olderHistoryPrefetchDistance(box)) loadOlder();
  };

  const localNotice = state.sessionNotFound ? 'This conversation no longer exists.'
    : state.status === 'unauthorized' ? 'Access to this conversation is unavailable.'
      : state.status === 'unsupported' ? 'This conversation is not supported.'
    : state.conversationError ? `Conversation history could not be loaded: ${state.conversationError}`
      : state.sessionError ? `Some conversation details are unavailable: ${state.sessionError}`
        : undefined;
  const showRuntimeNotice = state.loadingOlder || !!state.historyError || !!localNotice;
  const showConfiguredConversationLink = !!configuredConversationHref &&
    (state.sessionNotFound || state.sessionError || state.conversationError ||
      state.status === 'unauthorized' || state.status === 'unsupported');
  const showReconnect = state.sessionNotFound || state.sessionError || state.conversationError;
  const hasToolHistoryStatus = state.toolCallsEnabled === true &&
    (state.toolCallsLoading || visibleToolCallsError !== undefined);
  const showToolHistoryStatusInNotice = hasToolHistoryStatus && !state.loadingOlder && !!(state.historyError || localNotice);
  const renderToolHistoryStatus = (placeholder = false) => <div
    className={`tb-chat-tool-history-status${placeholder ? ' tb-chat-tool-history-status-placeholder' : ''}`}
    aria-hidden={placeholder || undefined}>
    {state.toolCallsLoading && <span className="tb-chat-caption tb-chat-caption-neutral" role="status">Loading tool history…</span>}
    {visibleToolCallsError && <span className="tb-chat-caption tb-chat-caption-danger" role="status">
      <span className="tb-chat-caption-body">
        <span>Tool history is not current: {visibleToolCallsError}{' '}</span>
          <button type="button" disabled={placeholder || undefined} tabIndex={placeholder ? -1 : undefined}
            onClick={() => runtime.retryToolCalls?.()}>Retry tool history</button>
      </span>
    </span>}
  </div>;

  const renderItem = useCallback((item: TimelineItem) => {
        if (item.kind === 'tool') {
          const entry = activityPlan.toolItems.get(item.call.id);
          // The earlier-activity control is indexed once in messageItems. Tool
          // records hidden behind that control only point to it for filtering.
          if (entry?.kind === 'overflow') return null;
          if (entry?.kind === 'fold') {
            if (entry.summary.call?.id !== item.call.id) return null;
            return <ActivityRunRow key={entry.id} entry={entry} expanded={expandedActivityRuns.has(entry.id)}
              toggle={toggleActivityRun} registerRow={reading.registerRow}
              preservePosition={reading.preserveVisiblePosition} expandHistoryRun={expandRun}
              expandedToolCalls={expandedToolCalls} setToolCallExpanded={setToolCallExpanded} />;
          }
          return <ToolCallRow key={'tool-' + item.call.id} call={item.call}
            entry={entry} registerRow={reading.registerRow}
            preservePosition={reading.preserveVisiblePosition} expandRun={expandRun}
            expandedToolCalls={expandedToolCalls} setToolCallExpanded={setToolCallExpanded} />;
        }
        if (item.kind === 'activity') return <ActivityMessageRow key={item.entry.id} entry={item.entry} registerRow={reading.registerRow} />;
        if (item.kind === 'activity-fold') return <ActivityRunRow key={item.entry.id} entry={item.entry}
          expanded={expandedActivityRuns.has(item.entry.id)} toggle={toggleActivityRun}
          registerRow={reading.registerRow} preservePosition={reading.preserveVisiblePosition}
          expandHistoryRun={expandRun} expandedToolCalls={expandedToolCalls} setToolCallExpanded={setToolCallExpanded} />;
        if (item.kind === 'overflow') return <ActivityOverflowButton key={item.entry.id} entry={item.entry}
          registerRow={reading.registerRow} expand={expandRun} />;
        if (item.kind === 'transition') {
          const record = item.record;
          const gist = transitionGist(record);
          return <div role="separator" aria-orientation="horizontal" key={record.id} ref={element => reading.registerRow(record.id, element)}
            data-record-key={record.id} data-scroll-key={record.id}
            className="tb-chat-transition tb-chat-transition-marker" aria-label={`Transition: ${gist}`}>
            {gist}
          </div>;
        }
        if (item.kind === 'bubble') {
          const { bubble } = item;
          return <RecordRow key={bubble.key} bubble={bubble} scrollKey={item.scrollKey}
            renderMessage={renderMessage} agentName={agentName} registerRow={reading.registerRow} />;
        }
        const { send } = item;
        const time = localTimestamp(send.submittedAt);
        const hostManaged = send.hostSend !== undefined;
        const unreachable = send.reason === 'unreachable';
        const retryUnavailable = send.reason === 'retry-unavailable';
        const reconnectingSend = send.status === 'pending' && unreachable;
        const retryAvailable = !hostManaged && !retryUnavailable &&
          ['failed', 'uncertain'].includes(send.status) && !send.reconciled;
        return <article ref={element => reading.registerRow(`local-${send.clientMessageId}`, element)} className="tb-chat-bubble tb-chat-bubble-human tb-chat-local" key={send.clientMessageId}
          data-record-key={`local-${send.clientMessageId}`} data-scroll-key={`local-${send.clientMessageId}`} aria-label={`Your message, ${send.status}`}>
          <div className="tb-chat-bubble-body">{markdownBody(send.content)}</div>
          <p className="tb-chat-send-state" data-send-status={send.status} role={send.status === 'pending' ? 'status' : undefined}>{send.status === 'uncertain' ? 'Delivery is uncertain'
            : send.status === 'failed' ? 'Message could not be sent'
              : send.status === 'pending' ? 'Sending…'
                : hostManaged && !send.reconciled ? 'Accepted; checking conversation history' : 'Sent'}</p>
          {send.reason && !reconnectingSend && <p className="tb-chat-send-reason" role="alert">
            {send.status === 'uncertain'
              ? hostManaged
                ? 'Delivery could not be confirmed. Use the host composer to decide whether to retry.'
                : retryUnavailable
                  ? 'This target stopped supporting safe retries. Delivery could not be confirmed; check the conversation before retrying.'
                : 'Delivery could not be confirmed. Retry after the connection is current.'
              : unreachable ? 'Delivery could not be confirmed. Check the conversation before retrying this message.'
              : hostManaged
                ? 'This message was refused. Any retry or text editing belongs in the host composer.'
                : 'The message could not be sent. Retry it or restore the text to the composer.'}
          </p>}
          {retryAvailable && <div className="tb-chat-send-actions">
            <button type="button" disabled={state.status === 'unauthorized'}
              onClick={() => void runtime.retrySend(send.clientMessageId)}>Retry message</button>
            {state.status === 'unauthorized' && <span>Access to this conversation is unavailable.</span>}
            <button type="button" onClick={() => composer.current?.restore(send.content)}>Restore text to the composer</button>
          </div>}
          <time className="tb-chat-time" dateTime={time.dateTime}>{time.text}</time>
        </article>;
  }, [activityPlan.toolItems, expandedActivityRuns, expandedToolCalls, toggleActivityRun, setToolCallExpanded,
    reading.registerRow, reading.preserveVisiblePosition, expandRun,
    renderMessage, agentName, state.status, runtime]);

  return <section ref={root} className={`tb-chat ${host.composerHidden ? 'tb-chat-host-composer-hidden' : ''} ${className || ''}`}
    aria-label={agentName ? `${agentName} conversation` : 'Conversation'}>
    <div className="tb-chat-viewport" ref={viewport} onScroll={handleScroll} role="log" tabIndex={-1}
      onWheel={(event) => { reading.interrupt(); if (event.deltaY !== 0) reading.noteUserScroll(); }}
      onTouchStart={reading.interrupt} onTouchMove={reading.noteUserScroll}
      onPointerDown={reading.interrupt} onPointerMove={(event) => { if (event.buttons !== 0) reading.noteUserScroll(); }}
      onKeyDown={(event) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) { reading.interrupt(); reading.noteUserScroll(); } }}
      aria-label={`${agentName || 'Conversation'} messages`} aria-live="polite" aria-relevant="additions text">
      {showRuntimeNotice && <div className={`tb-chat-runtime-notice ${showToolHistoryStatusInNotice ? 'tb-chat-runtime-notice-with-tool-history ' : ''}${state.loadingOlder ? 'tb-chat-history-loading ' : ''} tb-chat-caption ${state.historyError || state.sessionNotFound || state.sessionError || state.conversationError || state.status === 'unauthorized' || state.status === 'unsupported'
        ? 'tb-chat-caption-danger' : 'tb-chat-caption-neutral'}`} role={state.historyError || state.sessionNotFound || state.conversationError || state.sessionError || state.status === 'unauthorized' || state.status === 'unsupported' ? 'alert' : 'status'}>
        <span className="tb-chat-caption-body">
          {(state.loadingOlder || state.historyError || localNotice) && <span>{state.loadingOlder ? 'Loading earlier messages…'
            : state.historyError ? `Earlier messages could not be loaded: ${state.historyError}` : localNotice}</span>}
          {state.historyError && <button type="button" onClick={loadOlder}>Retry loading messages</button>}
          {showReconnect &&
            <button type="button" onClick={() => void runtime.rebuild({ restart: true })}>Reconnect</button>}
          {showConfiguredConversationLink && <a href={configuredConversationHref}>Open the configured conversation</a>}
        </span>
        {showToolHistoryStatusInNotice && <div className="tb-chat-runtime-tool-history">
          {renderToolHistoryStatus()}
        </div>}
      </div>}
      <div className="tb-chat-message-content" ref={reading.content}>
      {hasToolHistoryStatus && renderToolHistoryStatus(showToolHistoryStatusInNotice)}
      {projection.issues.length > 0 && <div className="tb-chat-history-error tb-chat-caption tb-chat-caption-danger" role="alert">
        Some message sources could not be interpreted. Conversation filtering is incomplete.
      </div>}
      <IndexedTimeline messages={transcript.index} tools={tools} pending={pending.index} render={renderItem} />
      {pending.tail.map(renderItem)}
      {caption && state.activeTurn && <WorkingStateCaption caption={caption} turnSeq={state.activeTurn.turn.seq} />}
      {state.status === 'ready' && !state.conversationError && !state.sessionNotFound &&
        bubbles.length === 0 && localSends.length === 0 &&
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
export function TightbeamChat({ sessionKey, adapter, identityKey, renderMessage, className,
  configuredConversationHref }: TightbeamChatProps) {
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
      <span className="tb-chat-initial-caption">
        <span className="tb-chat-status-dot tb-chat-status-loading" aria-hidden="true" />
        <span className="tb-chat-sr-only">Connecting</span>
      </span>
    </section>;
  }
  return <ChatBody key={key} runtime={opened.runtime} renderMessage={renderMessage}
    className={className} hostBridge={hostBridge} configuredConversationHref={configuredConversationHref} />;
}
