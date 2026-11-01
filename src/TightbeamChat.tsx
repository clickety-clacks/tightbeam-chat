import { uncoveredRecordEvents, recordEventPresentation } from './sessionRecordEvents';
import type { SessionRecordEvent } from './types';
import { forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type AnchorHTMLAttributes, type FormEvent, type HTMLAttributes, type ImgHTMLAttributes,
  type ReactNode, type RefObject, type TableHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightRecognizedCode } from './markdownHighlight';
import type { ChatRuntime, CanonicalMessage, CanonicalTransition, ToolCallRecord, ToolCallIndex, ConversationRecord, LocalSend, RuntimeState, TightbeamAdapter, TurnProvenance } from './types';
import { projectMessages, type HumanMember } from './messageVisibility';
import { ActivitySummaryProvider, useActivitySummary } from './ActivitySummaryView';
import type { SummaryAnswer, ActivitySummaryTransport } from './activitySummaries';
import { buildActivityTrail, type ActivityFold, type ActivityLine, type ActivityOverflow, type MessageActivityItem } from './activityTrail';
import type { ActivityPillIcon, ActivityPillPresentation } from './activityPresentation';
import { useReadingPosition } from './useReadingPosition';
import { firstAfterTime, getIndex, indexValues, putIndex, type RecordIndex } from './recordIndex';
import { getHostComposerSnapshot, HostComposerBridge, subscribeHostComposer } from './hostComposer';
import { ReleaseNotesDialog, type ChatOverlay } from './ReleaseNotesDialog';
import { CHAT_RELEASE_VERSION, RELEASE_NOTES, recordSeenReleaseVersion, releaseNotesForBuild, unseenReleaseNotes } from './releaseNotes';
import { isSettingsCommand } from './settingsCommand';
import { stripProvenanceMarkup } from './displayText';
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
  | { readonly kind: 'record-event'; readonly event: SessionRecordEvent }
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

function bubblePromptIdentity(bubble: Bubble): string {
  const identity = bubble.derived ? undefined : canonicalSendIdentity(bubble.record);
  return identity ? `send:${identity}` : `record:${JSON.stringify([bubble.record.sessionKey, bubble.key])}`;
}

interface UserPrompt {
  readonly identity: string;
  readonly content: string;
  readonly targetKey: string;
  readonly scrollKey: string;
}

function userPrompts(timeline: readonly TimelineItem[]): UserPrompt[] {
  const prompts: UserPrompt[] = [];
  const seen = new Set<string>();
  for (const item of timeline) {
    let prompt: UserPrompt | undefined;
    if (item.kind === 'bubble' && item.bubble.side === 'human' && item.bubble.ownerScoped) {
      prompt = { identity: bubblePromptIdentity(item.bubble),
        content: stripProvenanceMarkup(item.bubble.displayContent ?? item.bubble.record.content), targetKey: item.bubble.key,
        scrollKey: item.scrollKey ?? (item.bubble.derived ? item.bubble.key : item.bubble.record.id) };
    } else if (item.kind === 'local') {
      prompt = { identity: `send:${sendIdentity(item.send)}`, content: stripProvenanceMarkup(item.send.content),
        targetKey: `local-${item.send.clientMessageId}`, scrollKey: `local-${item.send.clientMessageId}` };
    }
    if (!prompt || seen.has(prompt.identity)) continue;
    seen.add(prompt.identity);
    prompts.push(prompt);
  }
  return prompts;
}

function nearestPromptAboveLine(prompts: readonly UserPrompt[], viewport: HTMLElement,
  getRow: (key: string) => HTMLElement | undefined, thresholdTop?: number): UserPrompt | undefined {
  const viewportRect = viewport.getBoundingClientRect();
  if (!Number.isFinite(viewportRect.top) || !Number.isFinite(viewportRect.bottom) ||
    viewportRect.bottom <= viewportRect.top) return undefined;
  const line = thresholdTop ?? viewportRect.top;

  // User prompts retain timeline order in the rendered transcript. Binary
  // search keeps per-scroll geometry work bounded as history grows.
  let low = 0;
  let high = prompts.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const row = getRow(prompts[middle].scrollKey);
    if (!row) return undefined;
    const rowRect = row.getBoundingClientRect();
    if (!Number.isFinite(rowRect.top) || !Number.isFinite(rowRect.bottom) || rowRect.bottom <= rowRect.top) {
      return undefined;
    }
    if (rowRect.bottom <= line) low = middle + 1;
    else high = middle;
  }
  return low > 0 ? prompts[low - 1] : undefined;
}

function latestPromptIntersectingBubble(prompts: readonly UserPrompt[], top: number, bottom: number,
  getRow: (key: string) => HTMLElement | undefined): UserPrompt | undefined {
  if (bottom <= top) return undefined;
  let low = 0;
  let high = prompts.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const row = getRow(prompts[middle].scrollKey);
    if (!row) return undefined;
    const rowRect = row.getBoundingClientRect();
    if (!Number.isFinite(rowRect.bottom)) return undefined;
    if (rowRect.bottom <= top) low = middle + 1;
    else high = middle;
  }
  let intersecting: UserPrompt | undefined;
  for (let index = low; index < prompts.length; index++) {
    const prompt = prompts[index];
    const row = getRow(prompt.scrollKey);
    if (!row) break;
    const rowRect = row.getBoundingClientRect();
    if (!Number.isFinite(rowRect.top) || !Number.isFinite(rowRect.bottom) || rowRect.top >= bottom) break;
    if (rowRect.bottom > top) intersecting = prompt;
  }
  return intersecting;
}

interface PromptHandoffRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

type PromptHandoffPhase = 'entering' | 'pinned' | 'leaving';

interface PromptHandoffState {
  readonly identity: string;
  readonly phase: PromptHandoffPhase;
}

function promptHandoffRect(rect: DOMRect): PromptHandoffRect {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function promptHandoffTransform(rect: PromptHandoffRect, base: DOMRect): string {
  const scaleX = rect.width / base.width;
  const scaleY = rect.height / base.height;
  const dx = rect.left - base.left;
  const dy = rect.top - base.top;
  return `translateX(calc(-50% + ${dx}px)) translateY(${dy}px) scale(${scaleX}, ${scaleY})`;
}

function animatePromptHandoff(node: HTMLElement, from: PromptHandoffRect, to: PromptHandoffRect): Animation | undefined {
  const base = node.getBoundingClientRect();
  if (base.width <= 0 || base.height <= 0 || from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0 ||
    typeof node.animate !== 'function') return undefined;
  node.style.transformOrigin = 'top left';
  return node.animate([
    { transform: promptHandoffTransform(from, base) },
    { transform: promptHandoffTransform(to, base) },
  ], { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'forwards' });
}

function messageSourceLabel(record: CanonicalMessage, defaultLabel: string): string {
  const assignmentId = record.raw.assignmentId;
  return typeof assignmentId === 'string' && assignmentId.trim() ? 'Assigned task' : defaultLabel;
}

function itemTime(item: TimelineItem): number | undefined {
  if (item.kind === 'tool') return item.call.startedAt;
  if (item.kind === 'record-event') return item.event.at;
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
    if (item.kind === 'record-event' || (item.kind === 'local' && !item.canonical)) { pending.push(item); continue; }
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

// Record events have their own timestamp/id domain, never a transcript sequence.
// Position them before the next later message and then among the anchored tools.
function eventPlacements(events: readonly SessionRecordEvent[], records: readonly ConversationRecord[]): PendingPlacement[] {
  const times = records.flatMap(row => {
    const at = row.createdAt ? Date.parse(row.createdAt) : NaN;
    return Number.isFinite(at) ? [{ at, seq: row.seq }] : [];
  }).sort((a, b) => a.at - b.at || a.seq - b.seq);
  const suffix: number[] = [];
  for (let i = times.length - 1; i >= 0; i--) suffix[i] = Math.min(times[i].seq, suffix[i + 1] ?? Infinity);
  return events.map(event => {
    let low = 0, high = times.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (times[mid].at <= event.at) low = mid + 1;
      else high = mid;
    }
    return { item: { kind: 'record-event', event }, beforeAnchor: suffix[low] };
  });
}

// Unmatched sends and record events use timestamp placement. Search the timestamp aggregate
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

const foldMotionDuration = 180;
const foldMotionEasing = 'cubic-bezier(0.2, 0, 0, 1)';

function AnimatedFoldContent({ expanded, className, onPresenceChange, onLayoutChange, children }: {
  readonly expanded: boolean;
  readonly className: string;
  readonly onPresenceChange?: (present: boolean) => void;
  readonly onLayoutChange?: () => void;
  readonly children: ReactNode | (() => ReactNode);
}) {
  const [present, setPresent] = useState(expanded);
  const element = useRef<HTMLDivElement>(null);
  const interruptedHeight = useRef<number | undefined>(undefined);
  const previousPresent = useRef(present);

  useLayoutEffect(() => {
    const wasPresent = previousPresent.current;
    previousPresent.current = present;
    if (expanded && !present) {
      setPresent(true);
      onPresenceChange?.(true);
      return;
    }
    if (!present) {
      if (wasPresent) onLayoutChange?.();
      return;
    }
    const node = element.current;
    if (!node) return;
    if (expanded) onPresenceChange?.(true);
    const finish = (nextPresent: boolean) => {
      if (!nextPresent) setPresent(false);
      onPresenceChange?.(nextPresent);
    };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof node.animate !== 'function') {
      if (!expanded) finish(false);
      else onPresenceChange?.(true);
      onLayoutChange?.();
      return;
    }

    const previousHeight = interruptedHeight.current;
    interruptedHeight.current = undefined;
    const from = previousHeight ?? (expanded ? 0 : node.getBoundingClientRect().height);
    const to = expanded ? node.scrollHeight : 0;
    node.style.overflow = 'hidden';
    const animation = node.animate([
      { height: `${from}px`, opacity: expanded ? 0 : 1 },
      { height: `${to}px`, opacity: expanded ? 1 : 0 },
    ], { duration: foldMotionDuration, easing: foldMotionEasing, fill: 'forwards' });
    onLayoutChange?.();
    let finished = false;
    animation.onfinish = () => {
      finished = true;
      node.style.height = expanded ? '' : '0px';
      node.style.overflow = expanded ? '' : 'hidden';
      animation.cancel();
      finish(expanded);
    };
    return () => {
      if (finished) return;
      const currentHeight = node.getBoundingClientRect().height;
      interruptedHeight.current = currentHeight;
      node.style.height = `${currentHeight}px`;
      node.style.overflow = 'hidden';
      animation.cancel();
    };
  }, [expanded, onLayoutChange, onPresenceChange, present]);

  if (!present) return null;
  const content = typeof children === 'function' ? children() : children;
  return <div ref={element} className={`tb-chat-fold-content ${className}`}
    data-fold-content="true" aria-hidden={!expanded} inert={!expanded}>{content}</div>;
}

function useActivityRevealAnimation<T extends HTMLElement>(active: boolean, key: string,
  onComplete?: (key: string) => void) {
  const element = useRef<T | null>(null);
  const complete = useRef(onComplete);
  complete.current = onComplete;

  useLayoutEffect(() => {
    const node = element.current;
    if (!active || !node) return;
    const finish = () => {
      complete.current?.(key);
    };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof node.animate !== 'function') {
      finish();
      return;
    }

    const height = node.getBoundingClientRect().height;
    if (height <= 0) {
      finish();
      return;
    }
    node.style.height = '0px';
    node.style.opacity = '0';
    node.style.overflow = 'hidden';
    const animation = node.animate([
      { height: '0px', opacity: 0 },
      { height: `${height}px`, opacity: 1 },
    ], { duration: foldMotionDuration, easing: foldMotionEasing, fill: 'forwards' });
    let finished = false;
    animation.onfinish = () => {
      finished = true;
      node.style.removeProperty('height');
      node.style.removeProperty('opacity');
      node.style.removeProperty('overflow');
      animation.cancel();
      finish();
    };
    return () => {
      if (finished) return;
      animation.cancel();
      node.style.removeProperty('height');
      node.style.removeProperty('opacity');
      node.style.removeProperty('overflow');
    };
  }, [active, key]);

  return element;
}

function AttachmentDetails({ record, preservePosition, reconcileLayout }: {
  readonly record: CanonicalMessage;
  readonly preservePosition: () => void;
  readonly reconcileLayout: () => void;
}): ReactNode {
  if (!record.attachments?.length) return null;
  return <AttachmentDisclosure record={record} preservePosition={preservePosition} reconcileLayout={reconcileLayout} />;
}

function AttachmentDisclosure({ record, preservePosition, reconcileLayout }: {
  readonly record: CanonicalMessage;
  readonly preservePosition: () => void;
  readonly reconcileLayout: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [contentPresent, setContentPresent] = useState(expanded);
  return <details className="tb-chat-attachments" open={expanded || contentPresent}>
    <summary aria-expanded={expanded} onClick={event => {
      event.preventDefault();
      preservePosition();
      setExpanded(value => !value);
    }}>{record.attachments!.length} attachment {record.attachments!.length === 1 ? 'detail' : 'details'}</summary>
    <AnimatedFoldContent expanded={expanded} className="tb-chat-attachment-content"
      onPresenceChange={setContentPresent} onLayoutChange={reconcileLayout}>
      {() => <pre>{JSON.stringify(record.attachments, null, 2)}</pre>}
    </AnimatedFoldContent>
  </details>;
}

function defaultBody(record: CanonicalMessage, preservePosition: () => void, reconcileLayout: () => void,
  content = record.content): ReactNode {
  return <>
    {markdownBody(content || '(No text content)')}
    <AttachmentDetails record={record} preservePosition={preservePosition} reconcileLayout={reconcileLayout} />
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
  if (state.status === 'unauthorized') return 'Chat is no longer authorized. The message was not sent';
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

const RecordRow = memo(function RecordRow({ bubble, renderMessage, agentName, registerRow, preservePosition,
  reconcileLayout, scrollKey: scrollKeyOverride, promptTargetPrefix }: {
  bubble: Bubble;
  renderMessage?: TightbeamChatProps['renderMessage'];
  agentName: string;
  registerRow: (key: string, element: HTMLElement | null) => void;
  preservePosition: () => void;
  reconcileLayout: () => void;
  scrollKey?: string;
  promptTargetPrefix: string;
}) {
  const { record } = bubble;
  const scrollKey = scrollKeyOverride ?? (bubble.derived ? bubble.key : record.id);
  const rowRef = useCallback((element: HTMLElement | null) => {
    registerRow(scrollKey, element);
  }, [registerRow, scrollKey]);
  const time = localTimestamp(record.createdAt);
  const displayContent = stripProvenanceMarkup(bubble.displayContent ?? record.content);
  const context: RenderContext = {
    sessionKey: record.sessionKey,
    recordKey: bubble.key,
    ...(bubble.member ? { sourceRecord: Object.freeze({
      id: record.id, sessionKey: record.sessionKey, seq: record.seq, rowVersion: record.rowVersion,
      sender: record.sender, messageType: record.messageType, turnSeq: record.turnSeq, createdAt: record.createdAt,
    }), member: Object.freeze({ ...bubble.member }) } : {}),
    defaultRender: () => bubble.derived ? markdownBody(displayContent)
      : defaultBody(record, preservePosition, reconcileLayout, displayContent),
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
  return <article ref={rowRef} id={`${promptTargetPrefix}-${encodeURIComponent(bubble.key)}`}
    className={`tb-chat-bubble tb-chat-bubble-${bubble.side}`} data-record-key={bubble.key} data-scroll-key={scrollKey}
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
    previous.promptTargetPrefix === next.promptTargetPrefix &&
    previous.agentName === next.agentName && previous.registerRow === next.registerRow &&
    previous.preservePosition === next.preservePosition && previous.reconcileLayout === next.reconcileLayout &&
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
  onSubmitted: () => void;
}>(function Composer({ runtime, state, agentName, root, suppressStatus, onSettings, onSubmitted }, ref) {
  const [draft, setDraft] = useState('');
  const [statusOpen, setStatusOpen] = useState(false);
  const editRevision = useRef(0);
  const submittedRevisions = useRef(new Map<string, number>());
  const nativeContentSizing = useRef<boolean | null>(null);
  if (nativeContentSizing.current === null) {
    nativeContentSizing.current = typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');
  }
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const statusControl = useRef<HTMLButtonElement>(null);
  const sendControl = useRef<HTMLButtonElement>(null);
  const shell = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const statusName = statusText(state);
  const statusId = `${titleId}-status-details`;

  useImperativeHandle(ref, () => ({
    restore: (content) => {
      editRevision.current++;
      setDraft(content);
    },
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
    if (!nativeContentSizing.current) {
      // Older browsers retain the existing autosize path; supported browsers
      // let CSS grow the field without a forced layout read on each edit.
      element.style.height = 'auto';
      element.style.height = `${Math.min(element.scrollHeight, Number.parseFloat(getComputedStyle(element).maxHeight) || element.scrollHeight)}px`;
    }
    if (pendingCaret.current !== null) {
      const caret = Math.min(pendingCaret.current, element.value.length);
      element.setSelectionRange(caret, caret);
      pendingCaret.current = null;
    }
  }, [draft]);

  useEffect(() => {
    for (const send of state.sends) {
      const submittedRevision = submittedRevisions.current.get(send.clientMessageId);
      if (submittedRevision === undefined || send.status === 'pending') continue;
      submittedRevisions.current.delete(send.clientMessageId);
      if (send.status === 'accepted' && editRevision.current === submittedRevision) {
        editRevision.current++;
        setDraft('');
      }
    }
  }, [state.sends]);

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
      editRevision.current++;
      setDraft('');
      setStatusOpen(false);
      onSettings();
      return;
    }
    if (state.status === 'unauthorized') return;
    const sendId = runtime.send(draft);
    if (sendId) {
      submittedRevisions.current.set(sendId, editRevision.current);
      onSubmitted();
    }
  };

  return <form className="tb-chat-composer" onSubmit={submit} ref={shell}>
    <label className="tb-chat-sr-only" htmlFor={`${titleId}-input`}>Message to {agentName || 'the selected agent'}</label>
    <div className="tb-chat-input-shell">
      <textarea ref={input} id={`${titleId}-input`} value={draft}
        onChange={(event) => {
          editRevision.current++;
          setDraft(event.target.value);
        }}
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
            editRevision.current++;
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
  readonly expand: (runKey: string, control: HTMLButtonElement, hiddenItemIds?: readonly string[]) => void;
}) {
  return <button type="button" className="tb-chat-activity-overflow" aria-label="Show earlier activity"
    key={entry.id} ref={element => registerRow(entry.id, element)} data-record-key={entry.id}
    data-scroll-key={entry.id} data-activity-run={entry.runKey}
    onClick={event => expand(entry.runKey, event.currentTarget, entry.hiddenItemIds)}>…</button>;
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

function ActivityPillContents({ presentation, summaryState }: { readonly presentation: ActivityPillPresentation;
  readonly summaryState?: SummaryAnswer['state'] }) {
  return <>
    <span className={`tb-chat-activity-pill tb-chat-activity-pill-${presentation.tone}${
      presentation.senderLabel ? ' tb-chat-activity-pill-sender' : ''}`}>
      <ActivityPillIconView icon={presentation.icon} />
      <span className={presentation.senderLabel ? 'tb-chat-activity-pill-sender-name' : undefined}>{presentation.label}</span>
    </span>
    <span className="tb-chat-activity-pill-text">{presentation.text}</span>
    {summaryState === 'pending' && <span className="tb-chat-summary-pending">summarizing</span>}
    {summaryState === 'summary' && <span className="tb-chat-summary-marker">summarized</span>}
    {presentation.metadata && <span className="tb-chat-activity-pill-meta">{presentation.metadata}</span>}
  </>;
}

function displayPillPresentation(presentation: ActivityPillPresentation): ActivityPillPresentation {
  return { ...presentation,
    label: stripProvenanceMarkup(presentation.label),
    text: stripProvenanceMarkup(presentation.text),
    metadata: presentation.metadata ? stripProvenanceMarkup(presentation.metadata) || undefined : undefined };
}

function sameActivityPresentation(left: ActivityPillPresentation | undefined,
  right: ActivityPillPresentation | undefined): boolean {
  return left === right || Boolean(left && right && left.label === right.label && left.tone === right.tone &&
    left.icon === right.icon && left.text === right.text && left.senderLabel === right.senderLabel && left.metadata === right.metadata &&
    left.summaryText === right.summaryText && left.summaryPrefix === right.summaryPrefix && left.attestId === right.attestId);
}

function sameActivityLine(left: ActivityLine, right: ActivityLine): boolean {
  return left.id === right.id && left.kind === right.kind && left.runKey === right.runKey &&
    left.gist === right.gist && left.accessibleText === right.accessibleText &&
    left.originalContent === right.originalContent &&
    sameActivityPresentation(left.presentation, right.presentation);
}

const ActivityMessageRow = memo(function ActivityMessageRow({ entry, registerRow, scrollKey = entry.id, reveal = false,
  onRevealComplete, preservePosition, reconcileLayout }: {
  readonly entry: ActivityLine;
  readonly registerRow: (key: string, element: HTMLElement | null) => void;
  readonly scrollKey?: string;
  readonly reveal?: boolean;
  readonly onRevealComplete?: (key: string) => void;
  readonly preservePosition: () => void;
  readonly reconcileLayout: () => void;
}) {
  const revealElement = useActivityRevealAnimation<HTMLDivElement>(reveal, entry.id, onRevealComplete);
  const summary = useActivitySummary(entry);
  const [expanded, setExpanded] = useState(false);
  const [detailContentPresent, setDetailContentPresent] = useState(false);
  const presentation = summary.presentation ? displayPillPresentation(summary.presentation) : undefined;
  const accessibleText = presentation
    ? `${presentation.label}: ${presentation.text}${presentation.metadata ? `, ${presentation.metadata}` : ''}`
    : entry.accessibleText;
  const fullMessage = stripProvenanceMarkup(entry.originalContent ?? entry.accessibleText);
  const displayOriginal = stripProvenanceMarkup(summary.original);
  const registerElement = useCallback((element: HTMLDivElement | null) => {
    registerRow(scrollKey, element);
    revealElement.current = element;
  }, [registerRow, revealElement, scrollKey]);
  if (presentation) {
    return <div role="note" tabIndex={-1} aria-label={accessibleText}
      className={`tb-chat-activity-line tb-chat-activity-${entry.kind} tb-chat-activity-pill-row`}
      onMouseEnter={summary.restoreOriginal}
      ref={registerElement} data-record-key={entry.id} data-scroll-key={scrollKey}
      data-activity-run={entry.runKey} title={displayOriginal}>
      <details className="tb-chat-activity-pill-disclosure" open={expanded || detailContentPresent}>
        <summary role="button" aria-label={`${accessibleText}. Show full message`} aria-expanded={expanded}
          title={displayOriginal} onClick={event => {
            event.preventDefault();
            preservePosition();
            setExpanded(value => !value);
          }}>
          <ActivityPillContents presentation={presentation} summaryState={summary.state} />
        </summary>
        <AnimatedFoldContent expanded={expanded} className="tb-chat-tool-detail-rail"
          onPresenceChange={setDetailContentPresent} onLayoutChange={reconcileLayout}>
          {() => <pre className="tb-chat-activity-message-content" data-activity-message-content="true">{fullMessage}</pre>}
        </AnimatedFoldContent>
      </details>
    </div>;
  }
  return <div role="note" tabIndex={-1} aria-label={accessibleText}
    className={`tb-chat-activity-line tb-chat-activity-${entry.kind}`}
    ref={registerElement} data-record-key={entry.id} data-scroll-key={scrollKey}
    data-activity-run={entry.runKey}>
    <span className="tb-chat-activity-bullet" aria-hidden="true">•</span>
    <span className="tb-chat-activity-gist">{entry.gist}</span>
  </div>;
}, (previous, next) => previous.registerRow === next.registerRow && previous.scrollKey === next.scrollKey &&
  previous.reveal === next.reveal && previous.onRevealComplete === next.onRevealComplete &&
  previous.preservePosition === next.preservePosition && previous.reconcileLayout === next.reconcileLayout &&
  sameActivityLine(previous.entry, next.entry));

const ToolCallRow = memo(function ToolCallRow({ call, entry, registerRow, preservePosition, reconcileLayout, expandRun,
  expandedToolCalls, setToolCallExpanded, reveal = false, onRevealComplete }: {
  call: ToolCallRecord;
  entry?: ActivityLine | ActivityOverflow;
  registerRow: (key: string, element: HTMLElement | null) => void;
  preservePosition: () => void;
  reconcileLayout: () => void;
  expandRun: (runKey: string, control: HTMLButtonElement, hiddenItemIds?: readonly string[]) => void;
  expandedToolCalls?: ReadonlySet<string>;
  setToolCallExpanded?: (id: string, expanded: boolean) => void;
  reveal?: boolean;
  onRevealComplete?: (key: string) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const [detailContentPresent, setDetailContentPresent] = useState(false);
  const expanded = expandedToolCalls ? expandedToolCalls.has(call.id) : localExpanded;
  const rowKey = 'tool-' + call.id;
  const revealElement = useActivityRevealAnimation<HTMLDetailsElement>(reveal, entry?.id ?? rowKey, onRevealComplete);
  const registerElement = useCallback((element: HTMLDetailsElement | null) => {
    registerRow(rowKey, element);
    revealElement.current = element;
  }, [registerRow, revealElement, rowKey]);
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
  return <details ref={registerElement} tabIndex={-1} data-record-key={rowKey} data-scroll-key={rowKey}
    open={expanded || detailContentPresent} data-activity-run={entry.runKey} className="tb-chat-activity-line tb-chat-activity-tool"
    aria-label={accessibleText}>
      <summary aria-label={`${accessibleText}. Show input and result`} aria-expanded={expanded}
        onClick={event => {
          event.preventDefault();
          preservePosition();
          updateExpanded(!expanded);
        }}>
        <ToolCallTerminalIcon className="tb-chat-tool-terminal-icon" />
        <span className="tb-chat-activity-gist">{gist}</span>
      </summary>
      <AnimatedFoldContent expanded={expanded} className="tb-chat-tool-detail-rail"
        onPresenceChange={setDetailContentPresent} onLayoutChange={reconcileLayout}>
        {() => (['rawInput', 'rawOutput', 'content'] as const).map(field => {
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
      </AnimatedFoldContent>
  </details>;
});

const ActivityRunRow = memo(function ActivityRunRow({ entry, expanded, toggle, registerRow, preservePosition, reconcileLayout, expandHistoryRun,
  expandedToolCalls, setToolCallExpanded, reveal = false, onRevealComplete }: {
  readonly entry: ActivityFold;
  readonly expanded: boolean;
  readonly toggle: (id: string) => void;
  readonly registerRow: (key: string, element: HTMLElement | null) => void;
  readonly preservePosition: () => void;
  readonly reconcileLayout: () => void;
  readonly expandHistoryRun: (runKey: string, control: HTMLButtonElement, hiddenItemIds?: readonly string[]) => void;
  readonly expandedToolCalls: ReadonlySet<string>;
  readonly setToolCallExpanded: (id: string, expanded: boolean) => void;
  readonly reveal?: boolean;
  readonly onRevealComplete?: (key: string) => void;
}) {
  const revealElement = useActivityRevealAnimation<HTMLDivElement>(reveal, entry.id, onRevealComplete);
  const registerElement = useCallback((element: HTMLDivElement | null) => {
    registerRow(entry.id, element);
    revealElement.current = element;
  }, [entry.id, registerRow, revealElement]);
  const toolRun = entry.activityKind === 'tool';
  const detailLines = entry.lines;
  const summary = useActivitySummary(entry.summary);
  const presentation = summary.presentation ? displayPillPresentation(summary.presentation) : undefined;
  const latestDescription = presentation
    ? `${presentation.label}: ${presentation.text}${presentation.metadata ? `, ${presentation.metadata}` : ''}`
    : entry.summary.gist;
  return <div className={`tb-chat-activity-run tb-chat-activity-${entry.activityKind}`} tabIndex={-1}
    onMouseEnter={summary.restoreOriginal}
    ref={registerElement} data-record-key={entry.id} data-scroll-key={entry.id}
    data-activity-run={entry.runKey} data-activity-fold="true" data-run-expanded={expanded ? 'true' : 'false'}>
    <button type="button" className={`tb-chat-activity-run-toggle tb-chat-activity-${entry.activityKind}${toolRun ? ' tb-chat-activity-tool-run-toggle' : ''}${presentation ? ' tb-chat-activity-pill-toggle' : ''}`}
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${entry.activityKind} activity run, ${entry.lines.length} entries. Latest: ${latestDescription}`}
      title={presentation ? stripProvenanceMarkup(summary.original) : undefined}
      onClick={() => { preservePosition(); toggle(entry.id); }}>
      {toolRun
        ? <ToolCallTerminalIcon className="tb-chat-tool-terminal-icon" />
        : <>
          {!presentation && <span className="tb-chat-activity-bullet" aria-hidden="true">•</span>}
          <span className={`tb-chat-activity-run-chevron${expanded ? ' is-expanded' : ''}`} aria-hidden="true" />
        </>}
      {presentation ? <ActivityPillContents presentation={presentation} summaryState={summary.state} />
        : <span className="tb-chat-activity-gist">{entry.summary.gist}</span>}
      <span className="tb-chat-activity-run-count" aria-hidden="true">×{entry.lines.length}</span>
      {toolRun && <span className={`tb-chat-activity-run-chevron${expanded ? ' is-expanded' : ''}`} aria-hidden="true" />}
    </button>
    <AnimatedFoldContent expanded={expanded} className="tb-chat-activity-run-content"
      onLayoutChange={reconcileLayout}>
      {() => <div className="tb-chat-activity-run-rows">
        {detailLines.map(line => line.kind === 'tool' && line.call
          ? <ToolCallRow key={line.id} call={line.call} entry={line} registerRow={registerRow}
            preservePosition={preservePosition} reconcileLayout={reconcileLayout} expandRun={expandHistoryRun}
            expandedToolCalls={expandedToolCalls} setToolCallExpanded={setToolCallExpanded} />
          : <ActivityMessageRow key={line.id} entry={line} registerRow={registerRow}
            scrollKey={`activity-detail:${line.id}`} preservePosition={preservePosition}
            reconcileLayout={reconcileLayout} />)}
      </div>}
    </AnimatedFoldContent>
  </div>;
}, (previous, next) => {
  // Tool rows keep their existing update path. Non-tool folds are summarized
  // by their latest member, so the common collapsed update check is constant
  // time even when a long run grows.
  if (previous.entry.activityKind === 'tool' || next.entry.activityKind === 'tool') return false;
  const before = previous.entry;
  const after = next.entry;
  if (previous.expanded !== next.expanded || previous.toggle !== next.toggle ||
      previous.registerRow !== next.registerRow || previous.reveal !== next.reveal ||
      previous.onRevealComplete !== next.onRevealComplete || previous.reconcileLayout !== next.reconcileLayout ||
      before.id !== after.id || before.runKey !== after.runKey ||
      before.activityKind !== after.activityKind || before.lines.length !== after.lines.length ||
      !sameActivityLine(before.summary, after.summary)) return false;
  if (!next.expanded) return true;
  return before.lines.every((line, index) => sameActivityLine(line, after.lines[index]));
});

function ChatBody({ runtime, renderMessage, className, hostBridge, configuredConversationHref, activitySummaries }: {
  activitySummaries?: ActivitySummaryTransport;
  runtime: ChatRuntime;
  renderMessage?: TightbeamChatProps['renderMessage'];
  className?: string;
  hostBridge: HostComposerBridge | null;
  configuredConversationHref?: string;
}) {
  const state = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const promptTargetPrefix = useId();
  const markedOpenRuntime = useRef<ChatRuntime | null>(null);
  const pendingVisibleReturn = useRef(false);
  const markReadPosition = useCallback(() => {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    void runtime.markReadPosition?.();
  }, [runtime]);
  useEffect(() => {
    if (state.status !== 'ready' || markedOpenRuntime.current === runtime) return;
    markedOpenRuntime.current = runtime;
    if (document.visibilityState === 'visible') {
      pendingVisibleReturn.current = false;
      void runtime.markReadPosition?.();
    }
  }, [runtime, state.status]);
  useEffect(() => {
    if (!pendingVisibleReturn.current || document.visibilityState !== 'visible' ||
        state.session?.sessionKey !== state.sessionKey) return;
    pendingVisibleReturn.current = false;
    void runtime.markReadPosition?.();
  }, [runtime, state.session, state.sessionKey, state.status]);
  useEffect(() => {
    let wasNotVisible = document.visibilityState !== 'visible';
    const onVisibilityChange = () => {
      const visible = document.visibilityState === 'visible';
      if (!visible) {
        wasNotVisible = true;
        return;
      }
      if (!wasNotVisible) return;
      wasNotVisible = false;
      if (state.session?.sessionKey === state.sessionKey) markReadPosition();
      else pendingVisibleReturn.current = true;
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [markReadPosition, state.session, state.sessionKey]);
  useEffect(() => {
    let wasNotVisible = document.visibilityState !== 'visible';
    let returnCheckScheduled = false;
    let mounted = true;
    const checkForegroundReturn = () => {
      if (returnCheckScheduled) return;
      returnCheckScheduled = true;
      // Let transport-level foreground checks mark a stale feed before reading
      // the runtime snapshot. This listener remains mounted after that feed closes.
      void Promise.resolve().then(() => {
        if (!mounted) return;
        const current = runtime.getSnapshot();
        if (current.status !== 'ready' || current.identityChanged || !current.liveError) return;
        // Plain rebuild supersedes the pending retry without resetting its backoff.
        void runtime.rebuild();
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        wasNotVisible = true;
        returnCheckScheduled = false;
        return;
      }
      if (!wasNotVisible) return;
      wasNotVisible = false;
      checkForegroundReturn();
    };
    const onPageHide = () => {
      wasNotVisible = true;
      returnCheckScheduled = false;
    };
    const onPageShow = () => {
      if (document.visibilityState !== 'visible') return;
      wasNotVisible = false;
      checkForegroundReturn();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [runtime]);
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
  const [revealingActivityItems, setRevealingActivityItems] = useState<ReadonlySet<string>>(() => new Set());
  const activityRevealBatches = useRef(new Map<string, { readonly ids: ReadonlySet<string>; readonly remaining: Set<string> }>());
  const activityRevealRuns = useRef(new Map<string, string>());
  const [shownRuns, setShownRuns] = useState<ReadonlyMap<string, string>>(() => new Map());
  const focusExpandedRun = useRef<string | undefined>(undefined);
  const readingRevision = useMemo(() => ({ state, host, expandedRuns, expandedActivityRuns, expandedToolCalls }),
    [state, host, expandedRuns, expandedActivityRuns, expandedToolCalls]);
  const recoveryRevision = state.recoveryRevision ?? 0;
  const previousArrivalContext = useRef<{ sessionKey: string; generation: number; recoveryRevision: number; ready: boolean } | null>(null);
  const priorArrivalContext = previousArrivalContext.current;
  const arrivalEligible = state.status === 'ready' && priorArrivalContext?.ready === true &&
    priorArrivalContext.sessionKey === state.sessionKey && priorArrivalContext.generation === state.generation &&
    priorArrivalContext.recoveryRevision === recoveryRevision;
  const reading = useReadingPosition(state.status === 'ready', readingRevision, box =>
    Boolean(state.loadingOlder || state.recordEventsLoading || (!state.historyError && (state.hasOlder || state.recordEventsHasOlder) && box.scrollTop < olderHistoryPrefetchDistance(box))),
    arrivalEligible, state.sessionKey, markReadPosition, state.activeTurn?.turn.status === 'running');
  const preserveReadingPositionRef = useRef(reading.preserveVisiblePosition);
  preserveReadingPositionRef.current = reading.preserveVisiblePosition;
  const preserveReadingPosition = useCallback(() => preserveReadingPositionRef.current(), []);
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
  const runtimeNotice = useRef<HTMLDivElement>(null);
  const toolHistoryStatus = useRef<HTMLDivElement>(null);
  const stickyPromptOverlay = useRef<HTMLDivElement>(null);
  const stickyPromptMeasurement = useRef<HTMLDivElement>(null);
  const promptHandoffAnimation = useRef<Animation | null>(null);
  const promptHandoffAnimationKey = useRef<string | null>(null);
  const promptHandoffSource = useRef<{ identity: string; row: HTMLElement; visibility: string } | null>(null);
  const promptHandoffMotionStart = useRef<{ identity: string; rect: PromptHandoffRect } | null>(null);
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
    .filter(message => message.member || !message.source.recordEventIds?.length)
    .map((message) => ({
      key: message.key, record: message.source, side: message.side,
      ownerScoped: message.side === 'agent' || message.senderLabel === 'You',
      sender: message.side === 'human'
        ? messageSourceLabel(message.source, message.senderLabel ?? sourceLabel(message.side, agentName))
        : sourceLabel(message.side, agentName),
      derived: Boolean(message.member),
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
    senderDisplayNames: state.activitySenderDisplayNames,
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
    state.liveRailDenials, state.historyRailDenials, state.sessionKey, state.activitySenderDisplayNames,
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
  const finishActivityReveal = useCallback((key: string) => {
    const runKey = activityRevealRuns.current.get(key);
    if (!runKey) return;
    activityRevealRuns.current.delete(key);
    const batch = activityRevealBatches.current.get(runKey);
    if (!batch) return;
    batch.remaining.delete(key);
    if (batch.remaining.size) return;
    activityRevealBatches.current.delete(runKey);
    reading.reconcileViewportLayout();
    setRevealingActivityItems(prior => {
      if (![...batch.ids].some(id => prior.has(id))) return prior;
      const next = new Set(prior);
      batch.ids.forEach(id => next.delete(id));
      return next;
    });
  }, [reading.reconcileViewportLayout]);
  const expandRun = useCallback((runKey: string, control: HTMLButtonElement, hiddenItemIds: readonly string[] = []) => {
    reading.preserveVisiblePosition();
    focusExpandedRun.current = typeof document !== 'undefined' && document.activeElement === control ? runKey : undefined;
    if (hiddenItemIds.length) {
      const ids = new Set(hiddenItemIds);
      activityRevealBatches.current.set(runKey, { ids, remaining: new Set(ids) });
      ids.forEach(id => activityRevealRuns.current.set(id, runKey));
      setRevealingActivityItems(prior => new Set([...prior, ...hiddenItemIds]));
    }
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
  const messageRows = useMemo(() => {
    const rows = new Map<string, { key: string; scrollKey: string; role: string; prompt: boolean; isFromReader: boolean }>();
    for (const item of timeline) {
      if (item.kind === 'bubble') {
        const scrollKey = item.scrollKey ?? (item.bubble.derived ? item.bubble.key : item.bubble.record.id);
        const isFromReader = item.bubble.side === 'human' && item.bubble.ownerScoped;
        rows.set(scrollKey, { key: scrollKey, scrollKey, role: item.bubble.record.role,
          prompt: isFromReader, isFromReader });
      } else if (item.kind === 'local') {
        const scrollKey = `local-${item.send.clientMessageId}`;
        rows.set(scrollKey, { key: scrollKey, scrollKey, role: 'user', prompt: true, isFromReader: true });
      }
    }
    return rows;
  }, [timeline]);
  reading.setMessageRows(messageRows);
  const promptCandidates = useMemo(() => userPrompts(timeline), [timeline]);
  const promptsByIdentity = useMemo(() => new Map(promptCandidates.map(prompt => [prompt.identity, prompt])), [promptCandidates]);
  const [stickyPromptIdentity, setStickyPromptIdentity] = useState<string | undefined>(undefined);
  const stickyPrompt = stickyPromptIdentity ? promptsByIdentity.get(stickyPromptIdentity) : undefined;
  const [overlappingPromptIdentity, setOverlappingPromptIdentity] = useState<string | undefined>(undefined);
  const [promptHandoff, setPromptHandoff] = useState<PromptHandoffState | null>(null);
  const [latestPromptDismissed, setLatestPromptDismissed] = useState(false);
  const [suppressOlderStickyPrompt, setSuppressOlderStickyPrompt] = useState(false);
  // Transcript refreshes can change the latest row; only a new submission clears dismissal.
  const observedPromptSubmissions = useRef<Set<string> | null>(null);
  if (!observedPromptSubmissions.current) {
    observedPromptSubmissions.current = new Set(state.sends
      .filter(send => send.sessionKey === state.sessionKey).map(sendIdentity));
  }
  useLayoutEffect(() => {
    const observed = observedPromptSubmissions.current!;
    let newSubmission = false;
    for (const send of state.sends) {
      if (send.sessionKey !== state.sessionKey) continue;
      const identity = sendIdentity(send);
      if (observed.has(identity)) continue;
      observed.add(identity);
      newSubmission = true;
    }
    if (newSubmission) setLatestPromptDismissed(false);
  }, [state.sends, state.sessionKey]);
  const transcript = useMemo(() => transcriptIndex(timeline), [timeline]);
  const eventPositions = useMemo(() => eventPlacements(
    uncoveredRecordEvents(state.recordEvents ?? [], state.records), state.records), [state.recordEvents, state.records]);
  const pending = useMemo(() => placePending([...transcript.placements, ...eventPositions].sort((a, b) =>
    (itemTime(a.item) ?? Infinity) - (itemTime(b.item) ?? Infinity) ||
    (a.item.kind === 'record-event' && b.item.kind === 'record-event' ? a.item.event.eventId.localeCompare(b.item.event.eventId) : 0)), tools),
    [transcript, tools, eventPositions]);
  const updateStickyPrompt = useCallback(() => {
    const element = root.current;
    const notice = runtimeNotice.current;
    const content = reading.content.current;
    if (content) {
      const noticeHeight = `${notice?.getBoundingClientRect().height ?? 0}px`;
      if (content.style.getPropertyValue('--tb-chat-runtime-notice-height') !== noticeHeight) {
        content.style.setProperty('--tb-chat-runtime-notice-height', noticeHeight);
      }
    }
    if (element) {
      const rootTop = element.getBoundingClientRect().top;
      const safeAreaTop = Number.parseFloat(getComputedStyle(element).getPropertyValue('--tb-chat-safe-area-top')) || 0;
      const safeTop = Math.max(10, safeAreaTop - rootTop + 10);
      const noticeBottom = notice?.getBoundingClientRect().bottom;
      const toolStatusBottom = toolHistoryStatus.current?.getBoundingClientRect().bottom;
      const blockingBottom = Math.max(noticeBottom ?? Number.NEGATIVE_INFINITY,
        toolStatusBottom ?? Number.NEGATIVE_INFINITY);
      const top = Number.isFinite(blockingBottom) ? Math.max(safeTop, blockingBottom - rootTop + 8) : safeTop;
      const topValue = `${top}px`;
      if (element.style.getPropertyValue('--tb-chat-floating-prompt-top') !== topValue) {
        element.style.setProperty('--tb-chat-floating-prompt-top', topValue);
      }
    }

    const box = viewport.current;
    const viewportBounds = box?.getBoundingClientRect();
    const measuredBubble = stickyPromptMeasurement.current?.getBoundingClientRect();
    const bubbleTop = measuredBubble && measuredBubble.height > 0
      ? measuredBubble.top : viewportBounds?.top ?? 0;
    const bubbleBottom = measuredBubble && measuredBubble.height > 0
      ? measuredBubble.bottom : viewportBounds?.top ?? 0;
    const prompt = box
      ? nearestPromptAboveLine(promptCandidates, box, reading.getRow, bubbleBottom)
      : undefined;
    const overlappingPrompt = measuredBubble && measuredBubble.height > 0
      ? latestPromptIntersectingBubble(promptCandidates, bubbleTop, bubbleBottom, reading.getRow)
      : undefined;
    const identity = prompt?.identity;
    let suppressSticky = false;
    const anchoredPromptKey = reading.getTopAnchoredPromptScrollKey();
    if (box && anchoredPromptKey) {
      const answeredPromptIndex = promptCandidates.findIndex(candidate => candidate.scrollKey === anchoredPromptKey);
      const selectedPromptIndex = promptCandidates.findIndex(candidate => candidate.identity === identity);
      const answeredPromptRow = reading.getRow(anchoredPromptKey);
      if (answeredPromptIndex >= 0 && selectedPromptIndex >= 0 && selectedPromptIndex <= answeredPromptIndex && answeredPromptRow) {
        const viewportBounds = box.getBoundingClientRect();
        const promptBounds = answeredPromptRow.getBoundingClientRect();
        const otherTopOverlayBottom = Math.max(viewportBounds.top,
          notice?.getBoundingClientRect().bottom ?? Number.NEGATIVE_INFINITY);
        suppressSticky = promptBounds.bottom > otherTopOverlayBottom && promptBounds.top < viewportBounds.bottom;
      }
    }
    setSuppressOlderStickyPrompt(current => current === suppressSticky ? current : suppressSticky);
    setOverlappingPromptIdentity(current => current === overlappingPrompt?.identity
      ? current : overlappingPrompt?.identity);
    if (stickyPromptIdentity === identity) reading.reconcileReducedMotionTopAnchor();
    else setStickyPromptIdentity(identity);
  }, [promptCandidates, reading.getRow, reading.getTopAnchoredPromptScrollKey,
    reading.reconcileReducedMotionTopAnchor, stickyPromptIdentity]);
  const restorePromptHandoffSource = useCallback(() => {
    const source = promptHandoffSource.current;
    if (!source) return;
    if (source.row.style.visibility === 'hidden') source.row.style.visibility = source.visibility;
    promptHandoffSource.current = null;
  }, []);
  const cancelPromptHandoffAnimation = useCallback(() => {
    const animation = promptHandoffAnimation.current;
    promptHandoffAnimation.current = null;
    promptHandoffAnimationKey.current = null;
    if (animation) animation.cancel();
  }, []);
  const hidePromptHandoffSource = useCallback((identity: string) => {
    if (promptHandoffSource.current?.identity === identity) return promptHandoffSource.current.row;
    restorePromptHandoffSource();
    const prompt = promptsByIdentity.get(identity);
    const row = prompt && reading.getRow(prompt.scrollKey);
    if (!row) return undefined;
    promptHandoffSource.current = { identity, row, visibility: row.style.visibility };
    row.style.visibility = 'hidden';
    return row;
  }, [promptsByIdentity, reading.getRow, restorePromptHandoffSource]);
  useLayoutEffect(() => {
    const isEligible = (identity: string) => identity === stickyPromptIdentity &&
      !latestPromptDismissed && !suppressOlderStickyPrompt &&
      (!overlappingPromptIdentity || overlappingPromptIdentity === identity);
    const active = promptHandoff;
    if (!active) {
      cancelPromptHandoffAnimation();
      restorePromptHandoffSource();
      if (stickyPromptIdentity && isEligible(stickyPromptIdentity)) {
        setPromptHandoff({ identity: stickyPromptIdentity, phase: 'entering' });
      }
      return;
    }

    const activeIsEligible = isEligible(active.identity);
    if (active.phase === 'leaving' && activeIsEligible) {
      const node = stickyPromptOverlay.current;
      if (node) promptHandoffMotionStart.current = { identity: active.identity, rect: promptHandoffRect(node.getBoundingClientRect()) };
      cancelPromptHandoffAnimation();
      setPromptHandoff({ identity: active.identity, phase: 'entering' });
      return;
    }
    if (activeIsEligible) {
      if (active.phase !== 'entering') return;
      const animationKey = `${active.identity}:entering`;
      if (promptHandoffAnimationKey.current === animationKey) return;
      const prompt = promptsByIdentity.get(active.identity);
      const row = prompt && reading.getRow(prompt.scrollKey);
      const from = promptHandoffMotionStart.current?.identity === active.identity
        ? promptHandoffMotionStart.current.rect
        : row ? promptHandoffRect(row.getBoundingClientRect()) : undefined;
      promptHandoffMotionStart.current = null;
      const node = stickyPromptOverlay.current;
      const hasMeasuredBubble = (stickyPromptMeasurement.current?.getBoundingClientRect().height ?? 0) > 0;
      if (hasMeasuredBubble) hidePromptHandoffSource(active.identity);
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const animation = !reducedMotion && hasMeasuredBubble && node && from
        ? animatePromptHandoff(node, from, promptHandoffRect(node.getBoundingClientRect())) : undefined;
      if (!animation) {
        setPromptHandoff({ identity: active.identity, phase: 'pinned' });
        return;
      }
      promptHandoffAnimationKey.current = animationKey;
      promptHandoffAnimation.current = animation;
      animation.onfinish = () => {
        if (promptHandoffAnimation.current !== animation) return;
        promptHandoffAnimation.current = null;
        promptHandoffAnimationKey.current = null;
        animation.cancel();
        setPromptHandoff(current => current?.identity === active.identity
          ? { identity: active.identity, phase: 'pinned' } : current);
      };
      return;
    }

    const shouldAnimateOut = !latestPromptDismissed && !suppressOlderStickyPrompt &&
      (!overlappingPromptIdentity || overlappingPromptIdentity === active.identity);
    if (!shouldAnimateOut) {
      promptHandoffMotionStart.current = null;
      setPromptHandoff(null);
      return;
    }
    if (active.phase === 'leaving') return;
    const animationKey = `${active.identity}:leaving`;
    const node = stickyPromptOverlay.current;
    const source = promptHandoffSource.current;
    const to = source?.identity === active.identity
      ? promptHandoffRect(source.row.getBoundingClientRect()) : undefined;
    const from = promptHandoffMotionStart.current?.identity === active.identity
      ? promptHandoffMotionStart.current.rect
      : node ? promptHandoffRect(node.getBoundingClientRect()) : undefined;
    promptHandoffMotionStart.current = null;
    cancelPromptHandoffAnimation();
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const animation = !reducedMotion && node && from && to ? animatePromptHandoff(node, from, to) : undefined;
    if (!animation) {
      setPromptHandoff(null);
      return;
    }
    setPromptHandoff({ identity: active.identity, phase: 'leaving' });
    promptHandoffAnimationKey.current = animationKey;
    promptHandoffAnimation.current = animation;
    animation.onfinish = () => {
      if (promptHandoffAnimation.current !== animation) return;
      setPromptHandoff(current => current?.identity === active.identity && current.phase === 'leaving' ? null : current);
    };
  }, [cancelPromptHandoffAnimation, hidePromptHandoffSource, latestPromptDismissed,
    overlappingPromptIdentity, promptHandoff, promptsByIdentity, reading.getRow,
    restorePromptHandoffSource, stickyPromptIdentity, suppressOlderStickyPrompt]);
  useEffect(() => () => {
    cancelPromptHandoffAnimation();
    restorePromptHandoffSource();
  }, [cancelPromptHandoffAnimation, restorePromptHandoffSource]);
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

  const hasOlder = state.hasOlder || state.recordEventsHasOlder;
  const loadingOlder = state.loadingOlder || state.recordEventsLoading;
  const loadOlder = () => {
    const releasePosition = reading.holdPosition();
    void runtime.loadOlder().finally(releasePosition);
  };

  const previousScrollTop = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const box = viewport.current;
    if (box) previousScrollTop.current = box.scrollTop;
  }, [state, host]);

  useLayoutEffect(() => {
    const box = viewport.current;
    if (!box || state.status !== 'ready' || !hasOlder || loadingOlder || state.historyError || state.recordEventsError
      || box.scrollTop < 0 || box.scrollTop >= olderHistoryPrefetchDistance(box)) return;
    const frame = requestAnimationFrame(() => loadOlder());
    return () => cancelAnimationFrame(frame);
  }, [state.status, hasOlder, loadingOlder, state.historyError, state.recordEventsError, state.records, state.provenance]);

  const handleScroll = () => {
    const box = viewport.current;
    if (!box) return;
    const previous = previousScrollTop.current;
    const current = box.scrollTop;
    previousScrollTop.current = current;
    reading.onScroll();
    updateStickyPrompt();
    const movedUp = previous !== undefined && current < previous;
    if (!movedUp || current < 0 || state.status !== 'ready' || !hasOlder || loadingOlder) return;
    if (state.historyError || current < olderHistoryPrefetchDistance(box)) loadOlder();
  };

  const localNotice = state.sessionNotFound ? 'This conversation no longer exists.'
    : state.status === 'unauthorized' ? 'Chat is no longer authorized. The message was not sent.'
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
  useLayoutEffect(() => {
    const box = viewport.current;
    const content = reading.content.current;
    const notice = runtimeNotice.current;
    const toolStatus = toolHistoryStatus.current;
    const observer = typeof ResizeObserver === 'undefined'
      ? undefined : new ResizeObserver(updateStickyPrompt);
    for (const element of [root.current, box, content, notice, toolStatus,
      stickyPromptOverlay.current, stickyPromptMeasurement.current]) {
      if (element) observer?.observe(element);
    }
    window.addEventListener('resize', updateStickyPrompt);
    window.addEventListener('orientationchange', updateStickyPrompt);
    window.visualViewport?.addEventListener('resize', updateStickyPrompt);
    window.visualViewport?.addEventListener('scroll', updateStickyPrompt);
    updateStickyPrompt();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateStickyPrompt);
      window.removeEventListener('orientationchange', updateStickyPrompt);
      window.visualViewport?.removeEventListener('resize', updateStickyPrompt);
      window.visualViewport?.removeEventListener('scroll', updateStickyPrompt);
    };
  }, [promptCandidates, showRuntimeNotice, showToolHistoryStatusInNotice, state.loadingOlder, state.historyError, localNotice,
    updateStickyPrompt, reading.content, stickyPromptIdentity, overlappingPromptIdentity,
    promptHandoff?.identity, promptHandoff?.phase, latestPromptDismissed, suppressOlderStickyPrompt]);
  const overlappingPrompt = overlappingPromptIdentity ? promptsByIdentity.get(overlappingPromptIdentity) : undefined;
  const handoffPrompt = promptHandoff ? promptsByIdentity.get(promptHandoff.identity) : undefined;
  const measurementPrompt = promptHandoff?.phase === 'leaving'
    ? handoffPrompt : overlappingPrompt ?? handoffPrompt ?? stickyPrompt;
  const displayedPrompt = handoffPrompt ?? stickyPrompt;
  const displayedPromptTargetId = displayedPrompt
    ? `${promptTargetPrefix}-${encodeURIComponent(displayedPrompt.targetKey)}` : undefined;
  const activeHandoffVisible = !!handoffPrompt && !latestPromptDismissed && !suppressOlderStickyPrompt &&
    (!overlappingPromptIdentity || overlappingPromptIdentity === promptHandoff?.identity);
  const candidatePromptVisible = !!stickyPrompt && !latestPromptDismissed && !suppressOlderStickyPrompt &&
    (!overlappingPromptIdentity || overlappingPromptIdentity === stickyPromptIdentity);
  const showStickyPrompt = promptHandoff ? activeHandoffVisible : candidatePromptVisible;
  const jumpToStickyPrompt = () => {
    const box = viewport.current;
    if (!box || !displayedPrompt || !displayedPromptTargetId) return;
    const target = reading.getRow(displayedPrompt.scrollKey);
    if (!target) return;
    const viewportRect = box.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const destination = Math.max(0, Math.min(box.scrollHeight - box.clientHeight,
      box.scrollTop + targetRect.top - viewportRect.top - (box.clientHeight - targetRect.height) / 2));
    reading.interrupt();
    reading.noteUserScroll();
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    box.scrollTo({ top: destination, behavior: reducedMotion ? 'instant' : 'smooth' });
    updateStickyPrompt();
  };
  const renderToolHistoryStatus = (placeholder = false) => <div
    ref={placeholder ? undefined : toolHistoryStatus}
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
        if (item.kind === 'record-event') {
          const key = 'record-event:' + item.event.eventId;
          const presentation = recordEventPresentation(item.event);
          return <div key={key} role="note" tabIndex={-1}
            ref={element => reading.registerRow(key, element)} data-record-key={key} data-scroll-key={key}
            className="tb-chat-activity-line tb-chat-activity-substrate tb-chat-activity-pill-row"
            aria-label={`${presentation.label}: ${presentation.text}, ${item.event.record.id}`}
            title={`${presentation.text} · ${item.event.record.id}`}>
            <ActivityPillContents presentation={presentation} />
          </div>;
        }
        if (item.kind === 'tool') {
          const entry = activityPlan.toolItems.get(item.call.id);
          // The earlier-activity control is indexed once in messageItems. Tool
          // records hidden behind that control only point to it for filtering.
          if (entry?.kind === 'overflow') return null;
          if (entry?.kind === 'fold') {
            if (entry.summary.call?.id !== item.call.id) return null;
            return <ActivityRunRow key={entry.id} entry={entry} expanded={expandedActivityRuns.has(entry.id)}
              toggle={toggleActivityRun} registerRow={reading.registerRow}
              preservePosition={reading.preserveVisiblePosition} reconcileLayout={reading.reconcileViewportLayout}
              expandHistoryRun={expandRun}
              expandedToolCalls={expandedToolCalls} setToolCallExpanded={setToolCallExpanded}
              reveal={revealingActivityItems.has(entry.id)} onRevealComplete={finishActivityReveal} />;
          }
          return <ToolCallRow key={'tool-' + item.call.id} call={item.call}
            entry={entry} registerRow={reading.registerRow}
            preservePosition={reading.preserveVisiblePosition} reconcileLayout={reading.reconcileViewportLayout}
            expandRun={expandRun}
            expandedToolCalls={expandedToolCalls} setToolCallExpanded={setToolCallExpanded}
            reveal={Boolean(entry && revealingActivityItems.has(entry.id))} onRevealComplete={finishActivityReveal} />;
        }
        if (item.kind === 'activity') return <ActivityMessageRow key={item.entry.id} entry={item.entry}
          registerRow={reading.registerRow} reveal={revealingActivityItems.has(item.entry.id)}
          onRevealComplete={finishActivityReveal} preservePosition={reading.preserveVisiblePosition}
          reconcileLayout={reading.reconcileViewportLayout} />;
        if (item.kind === 'activity-fold') return <ActivityRunRow key={item.entry.id} entry={item.entry}
          expanded={expandedActivityRuns.has(item.entry.id)} toggle={toggleActivityRun}
          registerRow={reading.registerRow} preservePosition={reading.preserveVisiblePosition}
          reconcileLayout={reading.reconcileViewportLayout}
          expandHistoryRun={expandRun} expandedToolCalls={expandedToolCalls} setToolCallExpanded={setToolCallExpanded}
          reveal={revealingActivityItems.has(item.entry.id)} onRevealComplete={finishActivityReveal} />;
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
            renderMessage={renderMessage} agentName={agentName} registerRow={reading.registerRow}
            preservePosition={preserveReadingPosition} reconcileLayout={reading.reconcileViewportLayout}
            promptTargetPrefix={promptTargetPrefix} />;
        }
        const { send } = item;
        const time = localTimestamp(send.submittedAt);
        const hostManaged = send.hostSend !== undefined;
        const refused = send.status === 'failed' && !send.reconciled;
        const retryAvailable = !hostManaged && refused;
        const announcement = send.reconciled
          ? 'Your message is in the conversation.'
          : refused
            ? `Your message was not sent. Reason: ${send.reason || 'The message was refused.'}`
            : 'Your message is sending.';
        const targetKey = `local-${send.clientMessageId}`;
        return <article ref={element => reading.registerRow(targetKey, element)}
          id={`${promptTargetPrefix}-${encodeURIComponent(`local-${send.clientMessageId}`)}`}
          className="tb-chat-bubble tb-chat-bubble-human tb-chat-local" key={send.clientMessageId}
          data-record-key={targetKey} data-scroll-key={targetKey}
          aria-label={announcement}
          data-send-state={send.reconciled ? 'solid' : refused ? 'refused' : 'ghosted'}>
          <div className="tb-chat-bubble-body">{markdownBody(stripProvenanceMarkup(send.content))}</div>
          {!send.reconciled && <div className="tb-chat-send-indicator" data-send-status={send.status} aria-hidden="true">
            {refused ? <span className="tb-chat-send-error">!</span> : <span className="tb-chat-send-spinner" />}
          </div>}
          <span className="tb-chat-sr-only" role={refused ? 'alert' : 'status'} aria-atomic="true">{announcement}</span>
          {retryAvailable && <div className="tb-chat-send-actions">
            <button type="button" disabled={state.status === 'unauthorized'}
              onClick={() => void runtime.retrySend(send.clientMessageId)}>Retry message</button>
            {state.status === 'unauthorized' && <span>Access to this conversation is unavailable.</span>}
            <button type="button" onClick={() => composer.current?.restore(send.content)}>Restore text to the composer</button>
          </div>}
          <time className="tb-chat-time" dateTime={time.dateTime}>{time.text}</time>
        </article>;
  }, [activityPlan.toolItems, expandedActivityRuns, expandedToolCalls, toggleActivityRun, setToolCallExpanded,
    revealingActivityItems, finishActivityReveal, reading.registerRow, reading.preserveVisiblePosition,
    reading.reconcileViewportLayout, preserveReadingPosition, expandRun,
    renderMessage, agentName, state.status, runtime, promptTargetPrefix]);

  return <ActivitySummaryProvider transport={activitySummaries}
    connected={state.liveConnectionState ? state.liveConnectionState === 'connected' : state.status === 'ready'}
    reconcile={reading.reconcileViewportLayout}><section ref={root} className={`tb-chat ${host.composerHidden ? 'tb-chat-host-composer-hidden' : ''} ${className || ''}`}
    aria-label={agentName ? `${agentName} conversation` : 'Conversation'}>
    <div className="tb-chat-viewport" ref={viewport} onScroll={handleScroll} role="log" tabIndex={-1}
      onWheel={(event) => { reading.interrupt(); if (event.deltaY !== 0) reading.noteUserScroll(); }}
      onTouchStart={reading.interrupt} onTouchMove={reading.noteUserScroll}
      onPointerDown={reading.interrupt} onPointerMove={(event) => { if (event.buttons !== 0) reading.noteUserScroll(); }}
      onKeyDown={(event) => {
        const target = event.target;
        const isControl = target instanceof Element &&
          Boolean(target.closest('button, a, input, textarea, select, [contenteditable="true"]'));
        if (!isControl && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
          reading.interrupt();
          reading.noteUserScroll();
        }
      }}
      aria-label={`${agentName || 'Conversation'} messages`} aria-live="polite" aria-relevant="additions text">
      {showRuntimeNotice && <div ref={runtimeNotice} className={`tb-chat-runtime-notice ${showToolHistoryStatusInNotice ? 'tb-chat-runtime-notice-with-tool-history ' : ''}${state.loadingOlder ? 'tb-chat-history-loading ' : ''} tb-chat-caption ${state.historyError || state.sessionNotFound || state.sessionError || state.conversationError || state.status === 'unauthorized' || state.status === 'unsupported'
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
      <div className={`tb-chat-message-content${showToolHistoryStatusInNotice ? ' tb-chat-runtime-notice-reserved' : ''}`} ref={reading.content}>
      {hasToolHistoryStatus && renderToolHistoryStatus(showToolHistoryStatusInNotice)}
      {projection.issues.length > 0 && <div className="tb-chat-history-error tb-chat-caption tb-chat-caption-danger" role="alert">
        Some message sources could not be interpreted. Conversation filtering is incomplete.
      </div>}
      {state.recordEventsError && <div role="status" className="tb-chat-caption">
        Activity history is unavailable. <button type="button" onClick={() => runtime.retryRecordEvents?.()}>Retry activity history</button>
      </div>}
      <IndexedTimeline messages={transcript.index} tools={tools} pending={pending.index} render={renderItem} />
      {pending.tail.map(renderItem)}
      {caption && state.activeTurn && <WorkingStateCaption caption={caption} turnSeq={state.activeTurn.turn.seq} />}
      {state.status === 'ready' && !state.conversationError && !state.sessionNotFound &&
        bubbles.length === 0 && localSends.length === 0 &&
        <p className="tb-chat-empty">No messages yet.</p>}
      </div>
    </div>
    {measurementPrompt && <div ref={stickyPromptMeasurement} className="tb-chat-latest-user-prompt-measurement"
      aria-hidden="true" inert>
      <button type="button" className="tb-chat-latest-user-prompt-jump" tabIndex={-1}>
        <span className="tb-chat-latest-user-prompt-text">{measurementPrompt.content}</span>
      </button>
      <button type="button" className="tb-chat-latest-user-prompt-dismiss" tabIndex={-1}>×</button>
    </div>}
    {showStickyPrompt && displayedPrompt && <div ref={stickyPromptOverlay} className="tb-chat-latest-user-prompt">
      <button type="button" className="tb-chat-latest-user-prompt-jump" aria-controls={displayedPromptTargetId}
        aria-label="Jump to user prompt" onClick={jumpToStickyPrompt}>
        <span className="tb-chat-latest-user-prompt-text">{displayedPrompt.content}</span>
      </button>
      <button type="button" className="tb-chat-latest-user-prompt-dismiss" aria-label="Dismiss user prompt preview"
        onClick={() => setLatestPromptDismissed(true)}>×</button>
    </div>}
    {reading.showLatest && <button type="button" className="tb-chat-scroll-latest" data-scroll-latest="true"
      aria-label={reading.unseenButtonLabel} onMouseDown={(event) => event.preventDefault()} onClick={() => {
        if (reading.hasUnseenButtonCount && reading.scrollToNextUnseen()) return;
        reading.scrollToLatestFromControl();
      }}>
      <span aria-hidden="true">↓</span> {reading.unseenButtonLabel}
    </button>}
    {!host.composerHidden && <Composer ref={composer} runtime={runtime} state={state} agentName={agentName}
      root={root} suppressStatus={host.optedIn} onSettings={openSettings} onSubmitted={reading.scrollToLatest} />}
    {overlay && <ReleaseNotesDialog overlay={overlay} entries={bundledNotes} onClose={closeOverlay}
      onOpenReleaseNotes={openReleaseNotes} onBack={backToSettings} />}
  </section></ActivitySummaryProvider>;
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
    className={className} hostBridge={hostBridge} configuredConversationHref={configuredConversationHref}
    activitySummaries={adapter.activitySummaries} />;
}
