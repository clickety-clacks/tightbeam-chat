import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// About two lines of conversation text. Measure intent before content grows.
const bottomThreshold = 64;
const bottomTolerance = 1;
const arrivalDuration = 240;
const arrivalEasing = 'cubic-bezier(0.2, 0, 0, 1)';
const arrivalTopInset = 40;
type Anchor = { key: string; top: number };
type MessageRow = { key: string; scrollKey: string; role: string };
type IncomingMessageArrival = {
  readonly scrollKey: string;
  readonly groupEndScrollKey: string;
  streaming: boolean;
  locked: boolean;
  mode?: 'bottom' | 'top';
  lockedTarget?: number;
};

function easeArrival(progress: number): number {
  // Match cubic-bezier(0.2, 0, 0, 1) for the scroll and row entrance.
  let low = 0;
  let high = 1;
  let parameter = progress;
  for (let i = 0; i < 12; i++) {
    const inverse = 1 - parameter;
    const x = 3 * inverse * inverse * parameter * .2 + parameter * parameter * parameter;
    if (x < progress) low = parameter;
    else high = parameter;
    parameter = (low + high) / 2;
  }
  return 3 * (1 - parameter) * parameter * parameter + parameter * parameter * parameter;
}

export function useReadingPosition(
  ready: boolean,
  revision: unknown,
  shouldKeepInitialSettle: (box: HTMLElement) => boolean = () => false,
  arrivalEligible = false,
  arrivalScope?: string,
  onManualScroll?: () => void,
  arrivalStreaming = false,
) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const following = useRef(true);
  const animating = useRef(false);
  const target = useRef<number | undefined>(undefined);
  const arrivalStartTime = useRef<number | undefined>(undefined);
  const arrivalStartTop = useRef(0);
  const arrivalFrame = useRef<number | undefined>(undefined);
  const previousTailRow = useRef<HTMLElement | undefined>(undefined);
  const incomingMessageArrival = useRef<IncomingMessageArrival | undefined>(undefined);
  const arrivalStreamingRef = useRef(arrivalStreaming);
  const seenArrivalRows = useRef(new Set<string>());
  const arrivalScopeRef = useRef(arrivalScope);
  const messageRows = useRef<ReadonlyMap<string, MessageRow>>(new Map());
  const knownMessages = useRef(new Set<string>());
  const unseenMessages = useRef(new Map<string, string>());
  const messageBaselineReady = useRef(false);
  const [unseenMessageCount, setUnseenMessageCount] = useState(0);
  const [unseenControlPrimed, setUnseenControlPrimed] = useState(false);
  if (arrivalScopeRef.current !== arrivalScope) {
    seenArrivalRows.current.clear();
    previousTailRow.current = undefined;
    incomingMessageArrival.current = undefined;
    knownMessages.current.clear();
    unseenMessages.current.clear();
    messageBaselineReady.current = false;
    arrivalScopeRef.current = arrivalScope;
  }
  const arrivalAnimations = useRef(new Map<HTMLElement, Animation>());
  const arrivalAnimationStarts = useRef(new Map<HTMLElement, number>());
  const arrivalEligibleRef = useRef(arrivalEligible);
  const userScrollIntent = useRef(false);
  const userScrollTimeout = useRef<number | undefined>(undefined);
  const manualScrollReported = useRef(false);
  const onManualScrollRef = useRef(onManualScroll);
  onManualScrollRef.current = onManualScroll;
  const lastKnownScrollTop = useRef<number | undefined>(undefined);
  const lastKnownBottom = useRef<number | undefined>(undefined);
  const pendingLayoutRestoreOffsets = useRef<number[]>([]);
  const initialSettlePending = useRef(false);
  const shouldKeepInitialSettleRef = useRef(shouldKeepInitialSettle);
  shouldKeepInitialSettleRef.current = shouldKeepInitialSettle;
  const viewportHeight = useRef<number | undefined>(undefined);
  const anchors = useRef<Anchor[]>([]);
  const registeredRows = useRef(new Map<string, HTMLElement>());
  const registerRow = useCallback((key: string, element: HTMLElement | null) => {
    if (element) registeredRows.current.set(key, element);
    else registeredRows.current.delete(key);
  }, []);
  const getRow = useCallback((key: string) => registeredRows.current.get(key), []);
  const latestReady = useRef(ready);
  const [showLatest, setShowLatest] = useState(false);
  latestReady.current = ready;
  arrivalEligibleRef.current = arrivalEligible;
  arrivalStreamingRef.current = arrivalStreaming;

  const distance = (box: HTMLElement) => Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop);
  const updateLatestControl = (box: HTMLElement) => {
    const atBottom = distance(box) <= bottomTolerance;
    setShowLatest(!atBottom);
    if (atBottom) {
      setUnseenControlPrimed(false);
      if (document.activeElement?.getAttribute('data-scroll-latest') === 'true') {
        box.focus({ preventScroll: true });
      }
    }
  };
  const unobscuredBounds = (box: HTMLElement, viewportBounds?: Pick<DOMRect, 'top' | 'bottom'>,
    includeTopOverlays = false): Pick<DOMRect, 'top' | 'bottom'> => {
    const bounds = viewportBounds ?? box.getBoundingClientRect();
    const root = box.parentElement;
    let top = bounds.top;
    if (includeTopOverlays) {
      const topOverlays = root?.querySelectorAll<HTMLElement>('.tb-chat-runtime-notice, .tb-chat-latest-user-prompt');
      for (const overlay of topOverlays ?? []) {
        const overlayBounds = overlay.getBoundingClientRect();
        if (!Number.isFinite(overlayBounds.top) || !Number.isFinite(overlayBounds.bottom) ||
          overlayBounds.bottom <= top || overlayBounds.top >= bounds.bottom ||
          overlayBounds.top >= top + arrivalTopInset + 24) continue;
        // Keep both the prior bubble's prompt-tail strip and the reply's first
        // line below top overlays before placing the reply's top inset.
        top = Math.min(bounds.bottom, Math.max(top, overlayBounds.bottom));
      }
    }
    const button = root?.querySelector<HTMLElement>('.tb-chat-scroll-latest');
    const composer = !button && !root?.classList.contains('tb-chat-host-composer-hidden')
      ? root?.querySelector<HTMLElement>('.tb-chat-composer') : undefined;
    const occluder = button ?? composer;
    if (!occluder) return { top, bottom: bounds.bottom };
    const overlay = occluder.getBoundingClientRect();
    if (!Number.isFinite(overlay.top) || !Number.isFinite(overlay.bottom) ||
      overlay.bottom <= top || overlay.top >= bounds.bottom) return { top, bottom: bounds.bottom };
    return { top, bottom: Math.max(top, Math.min(bounds.bottom, overlay.top)) };
  };
  const refreshUnseenMessages = (viewportBounds?: Pick<DOMRect, 'top' | 'bottom'>, measuredRows?: Map<HTMLElement, DOMRect>,
    measureOverlayOnIntersection = false) => {
    const box = viewport.current;
    if (!box || unseenMessages.current.size === 0) return;
    let bounds = viewportBounds ?? unobscuredBounds(box);
    if (!Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom) || bounds.bottom <= bounds.top) return;
    let overlayMeasured = !measureOverlayOnIntersection;
    for (const [key, scrollKey] of unseenMessages.current) {
      if (!messageRows.current.has(key)) {
        unseenMessages.current.delete(key);
        knownMessages.current.add(key);
        continue;
      }
      const row = registeredRows.current.get(scrollKey);
      if (!row) continue;
      const rect = measuredRows?.get(row) ?? row.getBoundingClientRect();
      measuredRows?.set(row, rect);
      if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) continue;
      if (!overlayMeasured && rect.bottom > bounds.top && rect.top < bounds.bottom) {
        bounds = unobscuredBounds(box, bounds);
        overlayMeasured = true;
      }
      // Seeing any part of a bubble settles it as seen, including a partially
      // visible bubble at the edge of the viewport.
      if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
        unseenMessages.current.delete(key);
        knownMessages.current.add(key);
      }
    }
    setUnseenMessageCount(prior => prior === unseenMessages.current.size ? prior : unseenMessages.current.size);
  };
  const setMessageRows = useCallback((rows: ReadonlyMap<string, MessageRow>) => {
    messageRows.current = rows;
  }, []);
  const addAppendedMessageRows = (appendedScrollKeys: ReadonlySet<string>) => {
    if (!messageBaselineReady.current) {
      for (const row of messageRows.current.values()) knownMessages.current.add(row.key);
      messageBaselineReady.current = true;
      unseenMessages.current.clear();
      setUnseenMessageCount(0);
      setUnseenControlPrimed(false);
      return;
    }
    for (const scrollKey of appendedScrollKeys) {
      const row = messageRows.current.get(scrollKey);
      if (!row || knownMessages.current.has(row.key)) continue;
      knownMessages.current.add(row.key);
      // Initial and prepended history never appears after the previous tail.
      // Appended message bubbles stay unseen until they intersect the viewport.
      unseenMessages.current.set(row.key, row.scrollKey);
    }
  };
  const isAtLatest = (box: HTMLElement, scrollTop = box.scrollTop) => {
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    // A short transcript can fit entirely inside the usual following tolerance.
    const threshold = bottom <= bottomThreshold ? bottomTolerance : bottomThreshold;
    return Math.max(0, bottom - scrollTop) <= threshold;
  };
  const viewportResized = (box: HTMLElement) => viewportHeight.current !== undefined && viewportHeight.current !== box.clientHeight;
  const lastArrivalAnchorRow = () => {
    let row = content.current?.lastElementChild ?? null;
    while (row instanceof HTMLElement && (row.dataset.scrollKey === undefined ||
      row.dataset.recordKey?.startsWith('local-'))) row = row.previousElementSibling;
    return row instanceof HTMLElement && row.dataset.scrollKey !== undefined ? row : undefined;
  };
  const incomingMessageTarget = (box: HTMLElement, arrival: IncomingMessageArrival) => {
    if (arrival.locked && arrival.lockedTarget !== undefined) return arrival.lockedTarget;
    const row = registeredRows.current.get(arrival.scrollKey);
    if (!row) return Math.max(0, box.scrollHeight - box.clientHeight);
    const groupEndRow = registeredRows.current.get(arrival.groupEndScrollKey) ?? row;

    const bounds = unobscuredBounds(box, undefined, true);
    const rowBounds = row.getBoundingClientRect();
    const groupEndBounds = groupEndRow.getBoundingClientRect();
    const arrivalHeight = Math.max(rowBounds.height, groupEndBounds.bottom - rowBounds.top);
    const visibleHeight = Math.max(0, bounds.bottom - bounds.top);
    if (arrival.mode === undefined && arrivalHeight > visibleHeight) {
      arrival.mode = 'top';
      arrival.locked = true;
      following.current = false;
    } else if (arrival.mode === undefined) {
      arrival.mode = 'bottom';
      if (!arrival.streaming) arrival.locked = true;
    } else if (arrival.mode === 'bottom' && !arrival.locked && arrivalHeight > visibleHeight) {
      arrival.mode = 'top';
      arrival.locked = true;
      following.current = false;
    }

    const maxScrollTop = Math.max(0, box.scrollHeight - box.clientHeight);
    let destination: number;
    if (arrival.mode === 'top') {
      const topInset = Math.min(arrivalTopInset, Math.max(12, visibleHeight / 4));
      destination = box.scrollTop + rowBounds.top - (bounds.top + topInset);
    } else {
      // Messages published together form one arrival. If the group fits, keep
      // following its end; if it does not, the first bubble gets the top anchor.
      destination = maxScrollTop;
    }
    destination = Math.max(0, Math.min(maxScrollTop, destination));
    if (arrival.locked && arrival.lockedTarget === undefined) arrival.lockedTarget = destination;
    return arrival.lockedTarget ?? destination;
  };
  const cancelArrivalAnimations = () => {
    if (arrivalFrame.current !== undefined) window.cancelAnimationFrame(arrivalFrame.current);
    arrivalFrame.current = undefined;
    if (arrivalStartTime.current !== undefined) {
      arrivalStartTime.current = undefined;
      animating.current = false;
      target.current = undefined;
    }
    for (const animation of arrivalAnimations.current.values()) animation.cancel();
    arrivalAnimations.current.clear();
    arrivalAnimationStarts.current.clear();
  };
  const animateArrivalRow = (row: HTMLElement, startedAt: number, elapsed = 0) => {
    const animation = row.animate?.([
      { opacity: 0, transform: 'translateY(18px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: arrivalDuration, easing: arrivalEasing });
    if (!animation) return;
    if (elapsed > 0) animation.currentTime = elapsed;
    arrivalAnimations.current.set(row, animation);
    arrivalAnimationStarts.current.set(row, startedAt);
    animation.onfinish = () => {
      if (arrivalAnimations.current.get(row) !== animation) return;
      arrivalAnimations.current.delete(row);
      arrivalAnimationStarts.current.delete(row);
    };
  };
  const animateArrivalRows = (rows: readonly HTMLElement[]) => {
    const startedAt = performance.now();
    for (const row of rows) {
      if (arrivalAnimations.current.has(row)) continue;
      animateArrivalRow(row, startedAt);
    }
  };
  const startArrivalScroll = (rows: readonly HTMLElement[], reduceMotion: boolean) => {
    const box = viewport.current;
    if (!box) return false;
    if (!reduceMotion) animateArrivalRows(rows);
    if (arrivalStartTime.current !== undefined) return true;

    // An explicit return-to-latest may already have a native smooth scroll in
    // flight. Take it over from its current position so the new row joins it.
    if (animating.current) box.scrollTo({ top: box.scrollTop, behavior: 'instant' });
    animating.current = false;
    target.current = undefined;
    const start = box.scrollTop;
    const startedAt = performance.now();
    arrivalStartTop.current = start;
    arrivalStartTime.current = startedAt;
    animating.current = !reduceMotion;
    const step = (now: number) => {
      const currentBox = viewport.current;
      if (!currentBox || arrivalStartTime.current === undefined) return;
      const incoming = incomingMessageArrival.current;
      const destination = incoming
        ? incomingMessageTarget(currentBox, incoming)
        : Math.max(0, currentBox.scrollHeight - currentBox.clientHeight);
      const progress = reduceMotion ? 1 : Math.min(1, Math.max(0, (now - arrivalStartTime.current) / arrivalDuration));
      target.current = destination;
      if (reduceMotion) currentBox.scrollTo({ top: destination, behavior: 'instant' });
      else currentBox.scrollTop = arrivalStartTop.current + (destination - arrivalStartTop.current) * easeArrival(progress);
      if (progress >= 1) {
        if (!reduceMotion) currentBox.scrollTop = destination;
        arrivalFrame.current = undefined;
        arrivalStartTime.current = undefined;
        target.current = undefined;
        animating.current = false;
        if (!incoming || !incoming.locked) following.current = true;
        const settledArrival = incomingMessageArrival.current;
        if (settledArrival && !settledArrival.streaming) incomingMessageArrival.current = undefined;
        updateLatestControl(currentBox);
        capture();
        return;
      }
      arrivalFrame.current = window.requestAnimationFrame(step);
    };
    arrivalFrame.current = window.requestAnimationFrame(step);
    return true;
  };
  const startArrivalMotion = (rows: readonly HTMLElement[]) => {
    const box = viewport.current;
    if (!box || !arrivalEligibleRef.current || !following.current || userScrollIntent.current ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
    return startArrivalScroll(rows, false);
  };
  const startIncomingMessageArrival = (
    rows: readonly HTMLElement[], scrollKey: string, groupEndScrollKey: string,
  ) => {
    const box = viewport.current;
    if (!box || !arrivalEligibleRef.current || !following.current || userScrollIntent.current) return false;
    const streaming = arrivalStreamingRef.current;
    incomingMessageArrival.current = { scrollKey, groupEndScrollKey, streaming, locked: !streaming };
    updateLatestControl(box);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    return startArrivalScroll(reduceMotion ? [] : rows, reduceMotion);
  };
  const clearUserScrollIntent = () => {
    userScrollIntent.current = false;
    manualScrollReported.current = false;
    window.clearTimeout(userScrollTimeout.current);
    userScrollTimeout.current = undefined;
  };
  const deferUserScrollIntentExpiry = () => {
    window.clearTimeout(userScrollTimeout.current);
    userScrollTimeout.current = window.setTimeout(clearUserScrollIntent, 250);
  };
  const noteUserScroll = () => {
    if (arrivalStartTime.current !== undefined || arrivalAnimations.current.size > 0) cancelArrivalAnimations();
    if (incomingMessageArrival.current) {
      incomingMessageArrival.current.streaming = false;
      incomingMessageArrival.current.locked = true;
      incomingMessageArrival.current.lockedTarget = undefined;
    }
    if (!userScrollIntent.current) manualScrollReported.current = false;
    userScrollIntent.current = true;
    initialSettlePending.current = false;
    pendingLayoutRestoreOffsets.current = [];
    deferUserScrollIntentExpiry();
  };
  const recordLayoutRestoreOffsets = (box: HTMLElement) => {
    pendingLayoutRestoreOffsets.current = [...new Set([
      lastKnownScrollTop.current,
      lastKnownBottom.current,
      box.scrollTop,
    ].filter((offset): offset is number => offset !== undefined))];
  };
  const isPendingLayoutRestore = (scrollTop: number) =>
    pendingLayoutRestoreOffsets.current.some(offset => Math.abs(offset - scrollTop) < 1);
  const capture = () => {
    const box = viewport.current;
    const children = content.current?.children;
    if (!box || !children) return;
    const bounds = following.current ? undefined : box.getBoundingClientRect();
    if (box.clientHeight > 0) viewportHeight.current = box.clientHeight;
    lastKnownScrollTop.current = box.scrollTop;
    lastKnownBottom.current = Math.max(0, box.scrollHeight - box.clientHeight);
    const measuredRows = new Map<HTMLElement, DOMRect>();
    const unseenBounds = unseenMessages.current.size > 0 ? bounds ?? box.getBoundingClientRect() : bounds;
    refreshUnseenMessages(unseenBounds, measuredRows, true);
    anchors.current = [];
    if (following.current) return;
    const anchorBounds = bounds ?? box.getBoundingClientRect();
    const measureRow = (row: HTMLElement) => {
      const measured = measuredRows.get(row);
      if (measured) return measured;
      const rect = row.getBoundingClientRect();
      measuredRows.set(row, rect);
      return rect;
    };
    const remembered = new Set<string>();
    // Direct children are vertically ordered. Locate the viewport without
    // enumerating history, then retain visible rows and one neighbor each side.
    let low = 0;
    let high = children.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (measureRow(children[middle] as HTMLElement).bottom <= anchorBounds.top) low = middle + 1;
      else high = middle;
    }
    const remember = (row: HTMLElement, top: number) => {
      const key = row.dataset.scrollKey;
      if (key !== undefined && !remembered.has(key)) {
        remembered.add(key);
        anchors.current.push({ key, top: top - anchorBounds.top + box.scrollTop });
      }
    };
    for (let i = low; i < children.length; i++) {
      const row = children[i] as HTMLElement;
      const rect = measureRow(row);
      remember(row, rect.top);
      if (rect.top >= anchorBounds.bottom) break;
    }
    if (low > 0) {
      const previous = children[low - 1] as HTMLElement;
      remember(previous, measureRow(previous).top);
    }
    // If filtering removes every row around the reader, retain a distant
    // survivor so its old position can keep the transcript from collapsing.
    for (let i = children.length - 1; i >= 0; i--) {
      const lastRow = children[i] as HTMLElement;
      if (lastRow.dataset.scrollKey === undefined) continue;
      remember(lastRow, measureRow(lastRow).top);
      break;
    }
  };

  const moveToLatest = (smooth: boolean): boolean => {
    const box = viewport.current;
    if (!box) return false;
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    following.current = true;
    if (Math.abs(box.scrollTop - bottom) <= bottomTolerance) {
      animating.current = false;
      target.current = undefined;
      updateLatestControl(box);
      return false;
    }
    if (animating.current && target.current === bottom) return true;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    animating.current = smooth && !reduceMotion;
    target.current = bottom;
    box.scrollTo({ top: bottom, behavior: animating.current ? 'smooth' : 'instant' });
    updateLatestControl(box);
    return true;
  };

  const updateLayout = () => {
    const box = viewport.current;
    if (!box) return;
    const previousTail = previousTailRow.current;
    const currentTail = lastArrivalAnchorRow();
    const canAnimateArrival = arrivalEligibleRef.current && following.current && !userScrollIntent.current &&
      !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const appendedRows: HTMLElement[] = [];
    const appendedScrollKeys = new Set<string>();
    const contentElement = content.current;
    if (initialized.current && contentElement) {
      const retainedTail = previousTail && registeredRows.current.get(previousTail.dataset.scrollKey ?? '');
      const afterPreviousTail = retainedTail?.parentElement === contentElement
        ? retainedTail.nextElementSibling
        : previousTail ? null : contentElement.firstElementChild;
      for (let row = afterPreviousTail; row; row = row.nextElementSibling) {
        if (!(row instanceof HTMLElement) || row.dataset.scrollKey === undefined) continue;
        const scrollKey = row.dataset.scrollKey;
        if (seenArrivalRows.current.has(scrollKey)) continue;
        seenArrivalRows.current.add(scrollKey);
        appendedScrollKeys.add(scrollKey);
        appendedRows.push(row);
      }
    } else if (contentElement) {
      // Initial content and catch-up are already on screen; remember them so a
      // later layout change cannot replay their arrival.
      for (const row of contentElement.children) {
        if (row instanceof HTMLElement && row.dataset.scrollKey !== undefined) {
          seenArrivalRows.current.add(row.dataset.scrollKey);
        }
      }
    }
    addAppendedMessageRows(appendedScrollKeys);
    previousTailRow.current = currentTail;
    for (const [row, animation] of [...arrivalAnimations.current]) {
      if (row.parentElement === content.current) continue;
      const scrollKey = row.dataset.scrollKey;
      const replacement = scrollKey?.startsWith('local-') ? registeredRows.current.get(scrollKey) : undefined;
      const startedAt = arrivalAnimationStarts.current.get(row);
      const elapsed = startedAt === undefined ? arrivalDuration : performance.now() - startedAt;
      if (replacement && replacement !== row && replacement.parentElement === content.current &&
        startedAt !== undefined && elapsed >= 0 && elapsed < arrivalDuration) {
        animation.cancel();
        arrivalAnimations.current.delete(row);
        arrivalAnimationStarts.current.delete(row);
        animateArrivalRow(replacement, startedAt, elapsed);
        continue;
      }
      animation.cancel();
      arrivalAnimations.current.delete(row);
      arrivalAnimationStarts.current.delete(row);
    }

    let incoming = incomingMessageArrival.current;
    if (incoming?.streaming && !arrivalStreamingRef.current) {
      incoming.streaming = false;
      incoming.locked = true;
    }
    if (arrivalStartTime.current !== undefined &&
      (userScrollIntent.current || !arrivalEligibleRef.current || (!following.current && !incoming))) {
      cancelArrivalAnimations();
    }
    if (arrivalStartTime.current !== undefined && !incoming && canAnimateArrival && appendedRows.length) {
      animateArrivalRows(appendedRows);
    }

    const firstAppendedMessage = [...appendedScrollKeys].find(scrollKey =>
      !scrollKey.startsWith('local-') && messageRows.current.get(scrollKey)?.role === 'assistant');
    if (!incoming && firstAppendedMessage && arrivalEligibleRef.current && following.current && !userScrollIntent.current) {
      const appendedMessageKeys = [...appendedScrollKeys].filter(scrollKey =>
        !scrollKey.startsWith('local-') && messageRows.current.has(scrollKey));
      const groupEndScrollKey = appendedMessageKeys.at(-1) ?? firstAppendedMessage;
      const started = startIncomingMessageArrival(canAnimateArrival ? appendedRows : [], firstAppendedMessage, groupEndScrollKey);
      if (started) {
        capture();
        return;
      }
    }

    incoming = incomingMessageArrival.current;
    if (incoming) {
      if (!incoming.locked && canAnimateArrival && appendedRows.length) animateArrivalRows(appendedRows);
      if (incoming.streaming && !incoming.locked) {
        const destination = incomingMessageTarget(box, incoming);
        if (arrivalStartTime.current !== undefined) {
          target.current = destination;
          updateLatestControl(box);
          capture();
          return;
        }
        if (incoming.locked) {
          const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
          startArrivalScroll([], reduceMotion);
        } else if (Math.abs(box.scrollTop - destination) > .5) {
          box.scrollTop = destination;
        }
        updateLatestControl(box);
        capture();
        return;
      }
    }

    if (arrivalStartTime.current !== undefined) {
      const activeArrival = incomingMessageArrival.current;
      target.current = activeArrival
        ? incomingMessageTarget(box, activeArrival)
        : Math.max(0, box.scrollHeight - box.clientHeight);
      updateLatestControl(box);
      capture();
      return;
    }
    if (!incoming && appendedRows.length && canAnimateArrival && startArrivalMotion(appendedRows)) {
      capture();
      return;
    }

    const resized = viewportResized(box);
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    const layoutChanged = lastKnownBottom.current !== undefined && Math.abs(bottom - lastKnownBottom.current) > .5;
    if (following.current && !userScrollIntent.current && (resized || layoutChanged)) recordLayoutRestoreOffsets(box);
    if (!initialized.current) {
      if (!latestReady.current) return;
      initialized.current = true;
      initialSettlePending.current = true;
      if (!moveToLatest(false) && !shouldKeepInitialSettleRef.current(box)) initialSettlePending.current = false;
    } else if (following.current && !userScrollIntent.current) {
      // Layout corrections run before paint. Smooth-scrolling here exposes a
      // temporary gap whenever a caption, message, or optional tool row changes
      // height while the reader is following the latest content.
      const moved = moveToLatest(false);
      if (initialSettlePending.current && !moved && !shouldKeepInitialSettleRef.current(box)) initialSettlePending.current = false;
    } else if (!following.current) {
      // Content changes should preserve the reader's current anchor rather
      // than compete with a still-running manual smooth scroll.
      if (animating.current) {
        box.scrollTo({ top: box.scrollTop, behavior: 'instant' });
        animating.current = false;
        target.current = undefined;
      }
      const rows = registeredRows.current;
      const survivor = anchors.current.find(anchor => rows.has(anchor.key));
      if (survivor) {
        // Retain the next visible row if filtering removed the original anchor.
        box.style.removeProperty('--tb-chat-anchor-space');
        const offset = rows.get(survivor.key)!.getBoundingClientRect().top - box.getBoundingClientRect().top;
        const currentScrollTop = box.scrollTop;
        const currentBottom = Math.max(0, box.scrollHeight - box.clientHeight);
        const previousScrollTop = lastKnownScrollTop.current;
        const previousBottom = lastKnownBottom.current;
        // A native scroll can reach scrollTop before its scroll event is
        // delivered; normally preserve that current position and add only the
        // content's anchor shift. A shrink can also make the browser clamp
        // scrollTop to the new bottom before this correction runs. In that
        // case, reconstruct the pre-clamp position so the same shift is applied
        // once rather than treating the clamp as reader movement.
        const wasClampedByShrink = !userScrollIntent.current &&
          previousScrollTop !== undefined && previousBottom !== undefined &&
          previousBottom > currentBottom + .5 && previousScrollTop > currentBottom + .5 &&
          currentScrollTop >= currentBottom - .5;
        const scrollBase = wasClampedByShrink ? previousScrollTop! : currentScrollTop;
        const anchorShift = currentScrollTop + offset - survivor.top;
        const wanted = scrollBase + anchorShift;
        // A removed first row can require negative scrollTop; browsers clamp it.
        if (wanted < 0) box.style.setProperty('--tb-chat-anchor-space', `${-wanted}px`);
        if (Math.abs(box.scrollTop - Math.max(0, wanted)) > .5) box.scrollTop = Math.max(0, wanted);
      }
      updateLatestControl(box);
    }
    const settledArrival = incomingMessageArrival.current;
    if (settledArrival && !settledArrival.streaming && arrivalStartTime.current === undefined) {
      incomingMessageArrival.current = undefined;
    }
    capture();
  };
  const currentUpdate = useRef(updateLayout);
  currentUpdate.current = updateLayout;
  const reconcileViewportLayout = useCallback(() => currentUpdate.current(), []);

  useLayoutEffect(updateLayout, [revision]);
  useLayoutEffect(() => {
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => currentUpdate.current());
    if (content.current) observer?.observe(content.current);
    const box = viewport.current;
    if (box) {
      observer?.observe(box);
      box.addEventListener('scrollend', clearUserScrollIntent);
    }
    return () => {
      observer?.disconnect();
      box?.removeEventListener('scrollend', clearUserScrollIntent);
      cancelArrivalAnimations();
      clearUserScrollIntent();
    };
  }, []);

  const onScroll = () => {
    const box = viewport.current;
    if (!box) return;
    const readerInitiated = userScrollIntent.current;
    if (readerInitiated && !manualScrollReported.current && lastKnownScrollTop.current !== undefined &&
        Math.abs(box.scrollTop - lastKnownScrollTop.current) >= 1) {
      manualScrollReported.current = true;
      onManualScrollRef.current?.();
    }
    if (readerInitiated && arrivalStartTime.current !== undefined) cancelArrivalAnimations();
    if (readerInitiated) deferUserScrollIntentExpiry();
    const resized = viewportResized(box);
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    const layoutChanged = lastKnownBottom.current !== undefined && Math.abs(bottom - lastKnownBottom.current) > .5;
    if (following.current && !readerInitiated && (resized || layoutChanged)) recordLayoutRestoreOffsets(box);
    const currentDistance = distance(box);
    const reachedTarget = arrivalStartTime.current === undefined && target.current !== undefined &&
      Math.abs(box.scrollTop - target.current) < 1;
    if (reachedTarget) {
      animating.current = false;
      target.current = undefined;
      if (!shouldKeepInitialSettleRef.current(box)) initialSettlePending.current = false;
    } else if (!animating.current) {
      target.current = undefined;
    }
    if (arrivalStartTime.current !== undefined && !readerInitiated) {
      const incoming = incomingMessageArrival.current;
      target.current = incoming ? incomingMessageTarget(box, incoming) : bottom;
      updateLatestControl(box);
      capture();
      return;
    }
    // Intermediate animation frames are not a user's decision to leave the tail.
    if (resized) {
      if (readerInitiated) {
        initialSettlePending.current = false;
        following.current = isAtLatest(box);
        if (following.current) incomingMessageArrival.current = undefined;
        else if (incomingMessageArrival.current) {
          incomingMessageArrival.current.streaming = false;
          incomingMessageArrival.current.locked = true;
          incomingMessageArrival.current.lockedTarget = undefined;
        }
      } else if (following.current) {
        if (!moveToLatest(false) && initialSettlePending.current && !shouldKeepInitialSettleRef.current(box)) initialSettlePending.current = false;
      }
    } else if (!animating.current) {
      if (readerInitiated) {
        initialSettlePending.current = false;
        following.current = isAtLatest(box);
        if (following.current) incomingMessageArrival.current = undefined;
        else if (incomingMessageArrival.current) {
          incomingMessageArrival.current.streaming = false;
          incomingMessageArrival.current.locked = true;
          incomingMessageArrival.current.lockedTarget = undefined;
        }
      } else if (following.current && currentDistance > bottomThreshold && initialSettlePending.current && latestReady.current) {
        // Correct only the initial browser restoration before the first settle.
        moveToLatest(false);
      } else {
        const restoredLayoutOffset = isPendingLayoutRestore(box.scrollTop);
        if (restoredLayoutOffset) pendingLayoutRestoreOffsets.current = [];
        else if (pendingLayoutRestoreOffsets.current.length > 0 && currentDistance > 1) pendingLayoutRestoreOffsets.current = [];
        if (following.current && currentDistance > bottomThreshold && restoredLayoutOffset) {
          // After startup, correct only offsets that match a measured layout restore.
          moveToLatest(false);
        } else {
          following.current = isAtLatest(box);
        }
      }
    }
    updateLatestControl(box);
    capture();
  };

  const interrupt = () => {
    const box = viewport.current;
    if (!box) return;
    const resized = viewportResized(box);
    if (arrivalStartTime.current !== undefined || arrivalAnimations.current.size > 0) {
      cancelArrivalAnimations();
    } else {
      if (animating.current) box.scrollTo({ top: box.scrollTop, behavior: 'instant' });
      animating.current = false;
      target.current = undefined;
    }
    if (resized) {
      if (following.current) moveToLatest(false);
    } else if (userScrollIntent.current) {
      initialSettlePending.current = false;
      following.current = isAtLatest(box);
    }
    capture();
  };
  const holdPosition = () => {
    // Older-page loading captures current intent; it must not turn an initial
    // underfilled view at the latest message into an away-from-bottom reading.
    interrupt();
  };
  const preserveVisiblePosition = () => {
    const box = viewport.current;
    if (!box) return;
    initialSettlePending.current = false;
    if (arrivalStartTime.current !== undefined || arrivalAnimations.current.size > 0) {
      cancelArrivalAnimations();
    } else {
      if (animating.current) box.scrollTo({ top: box.scrollTop, behavior: 'instant' });
      animating.current = false;
      target.current = undefined;
    }
    // Expanding an activity run is not reader intent to leave the latest edge.
    updateLatestControl(box);
    capture();
  };
  const scrollBy = (amount: number) => {
    const box = viewport.current;
    if (!box || !Number.isFinite(amount) || amount === 0) return;
    incomingMessageArrival.current = undefined;
    if (arrivalStartTime.current !== undefined || arrivalAnimations.current.size > 0) cancelArrivalAnimations();
    initialSettlePending.current = false;
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    // Repeat events build on the pending destination, so held keys continue
    // moving instead of repeatedly resetting the same smooth scroll.
    const origin = animating.current && target.current !== undefined ? target.current : box.scrollTop;
    const destination = Math.max(0, Math.min(bottom, origin + amount));
    if (Math.abs(destination - origin) < 1) {
      if (!animating.current) {
        following.current = isAtLatest(box);
        updateLatestControl(box);
        capture();
      }
      return;
    }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    animating.current = !reduceMotion;
    target.current = animating.current ? destination : undefined;
    following.current = isAtLatest(box, destination);
    updateLatestControl(box);
    box.scrollTo({ top: destination, behavior: animating.current ? 'smooth' : 'instant' });
    if (!animating.current) {
      following.current = isAtLatest(box);
      updateLatestControl(box);
    }
    capture();
  };
  const scrollToLatest = () => {
    const box = viewport.current;
    if (!box) return;
    incomingMessageArrival.current = undefined;
    if (arrivalStartTime.current !== undefined || arrivalAnimations.current.size > 0) cancelArrivalAnimations();
    initialSettlePending.current = false;
    // Keep keyboard navigation somewhere useful after its button disappears.
    if (document.activeElement?.getAttribute('data-scroll-latest') === 'true') box.focus({ preventScroll: true });
    moveToLatest(true);
  };

  const scrollToLatestFromControl = () => {
    // The floating control is local navigation. A pending wheel or key intent
    // must not turn its programmatic scroll into a read-marker write.
    clearUserScrollIntent();
    scrollToLatest();
  };

  const scrollToNextUnseen = (): boolean => {
    const box = viewport.current;
    if (!box) return false;
    incomingMessageArrival.current = undefined;
    const bounds = unobscuredBounds(box);
    const measuredRows = new Map<HTMLElement, DOMRect>();
    refreshUnseenMessages(bounds, measuredRows);
    const rowBounds = (row: HTMLElement) => measuredRows.get(row) ?? row.getBoundingClientRect();
    const next = [...unseenMessages.current.entries()].find(([key, scrollKey]) => {
      if (!messageRows.current.has(key)) return false;
      const row = registeredRows.current.get(scrollKey);
      if (!row) return false;
      const rect = rowBounds(row);
      return !(rect.bottom > bounds.top && rect.top < bounds.bottom);
    });
    if (!next) return false;
    const row = registeredRows.current.get(next[1]);
    if (!row) return false;
    const rect = rowBounds(row);
    const visibleHeight = Math.max(0, bounds.bottom - bounds.top);
    let destination = box.scrollTop;
    if (rect.height > visibleHeight || rect.top < bounds.top) {
      destination += rect.top - bounds.top;
    } else if (rect.bottom > bounds.bottom) {
      destination += rect.bottom - bounds.bottom;
    }
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    destination = Math.max(0, Math.min(bottom, destination));
    if (arrivalStartTime.current !== undefined || arrivalAnimations.current.size > 0) cancelArrivalAnimations();
    clearUserScrollIntent();
    if (animating.current) box.scrollTo({ top: box.scrollTop, behavior: 'instant' });
    animating.current = false;
    target.current = undefined;
    initialSettlePending.current = false;
    setUnseenControlPrimed(true);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    animating.current = !reduceMotion && Math.abs(destination - box.scrollTop) >= 1;
    target.current = animating.current ? destination : undefined;
    following.current = isAtLatest(box, destination);
    box.scrollTo({ top: destination, behavior: animating.current ? 'smooth' : 'instant' });
    updateLatestControl(box);
    capture();
    return true;
  };

  const arriveOwnMessages = (scrollKeys: readonly string[]) => {
    const box = viewport.current;
    if (!box) return;
    incomingMessageArrival.current = undefined;
    initialSettlePending.current = false;
    for (const key of scrollKeys) {
      unseenMessages.current.delete(key);
      knownMessages.current.add(key);
    }
    setUnseenMessageCount(unseenMessages.current.size);
    setUnseenControlPrimed(false);
    // A deliberate send from older history keeps the existing behavior of
    // bringing that prompt into view. Arrival motion itself belongs to rows
    // appended while the reader was already following the bottom.
    if (!following.current) {
      moveToLatest(true);
      capture();
      return;
    }
    following.current = true;
    setShowLatest(false);
    const rows = scrollKeys.flatMap(key => {
      const row = registeredRows.current.get(key);
      return row ? [row] : [];
    });
    if (rows.length && startArrivalMotion(rows)) {
      capture();
      return;
    }
    moveToLatest(true);
    capture();
  };

  const unseenButtonLabel = unseenMessageCount > 0 && !unseenControlPrimed
    ? `${unseenMessageCount} unseen message${unseenMessageCount === 1 ? '' : 's'}`
    : 'Scroll to bottom';

  return { viewport, content, registerRow, getRow, showLatest, unseenMessageCount, unseenButtonLabel,
    hasUnseenButtonCount: unseenMessageCount > 0 && !unseenControlPrimed, setMessageRows, onScroll, interrupt,
    holdPosition, preserveVisiblePosition, scrollBy, scrollToLatest, scrollToLatestFromControl, scrollToNextUnseen, arriveOwnMessages,
    noteUserScroll, reconcileViewportLayout };
}
