import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// About two lines of conversation text. Measure intent before content grows.
const bottomThreshold = 64;
type Anchor = { key: string; top: number };

export function useReadingPosition(
  ready: boolean,
  revision: unknown,
  shouldKeepInitialSettle: (box: HTMLElement) => boolean = () => false,
) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const following = useRef(true);
  const animating = useRef(false);
  const target = useRef<number | undefined>(undefined);
  const userScrollIntent = useRef(false);
  const userScrollTimeout = useRef<number | undefined>(undefined);
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
  const latestReady = useRef(ready);
  const [showLatest, setShowLatest] = useState(false);
  latestReady.current = ready;

  const distance = (box: HTMLElement) => Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop);
  const viewportResized = (box: HTMLElement) => viewportHeight.current !== undefined && viewportHeight.current !== box.clientHeight;
  const clearUserScrollIntent = () => {
    userScrollIntent.current = false;
    window.clearTimeout(userScrollTimeout.current);
    userScrollTimeout.current = undefined;
  };
  const deferUserScrollIntentExpiry = () => {
    window.clearTimeout(userScrollTimeout.current);
    userScrollTimeout.current = window.setTimeout(clearUserScrollIntent, 250);
  };
  const noteUserScroll = () => {
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
    if (box.clientHeight > 0) viewportHeight.current = box.clientHeight;
    lastKnownScrollTop.current = box.scrollTop;
    lastKnownBottom.current = Math.max(0, box.scrollHeight - box.clientHeight);
    anchors.current = [];
    if (following.current) return;
    const bounds = box.getBoundingClientRect();
    const remembered = new Set<string>();
    // Direct children are vertically ordered. Locate the viewport without
    // enumerating history, then retain visible rows and one neighbor each side.
    let low = 0;
    let high = children.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (children[middle].getBoundingClientRect().bottom <= bounds.top) low = middle + 1;
      else high = middle;
    }
    const remember = (row: HTMLElement, top: number) => {
      const key = row.dataset.scrollKey;
      if (key !== undefined && !remembered.has(key)) {
        remembered.add(key);
        anchors.current.push({ key, top: top - bounds.top + box.scrollTop });
      }
    };
    for (let i = low; i < children.length; i++) {
      const row = children[i] as HTMLElement;
      const rect = row.getBoundingClientRect();
      remember(row, rect.top);
      if (rect.top >= bounds.bottom) break;
    }
    if (low > 0) {
      const previous = children[low - 1] as HTMLElement;
      remember(previous, previous.getBoundingClientRect().top);
    }
    // If filtering removes every row around the reader, retain a distant
    // survivor so its old position can keep the transcript from collapsing.
    for (let i = children.length - 1; i >= 0; i--) {
      const lastRow = children[i] as HTMLElement;
      if (lastRow.dataset.scrollKey === undefined) continue;
      remember(lastRow, lastRow.getBoundingClientRect().top);
      break;
    }
  };

  const moveToLatest = (smooth: boolean): boolean => {
    const box = viewport.current;
    if (!box) return false;
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    following.current = true;
    setShowLatest(false);
    if (Math.abs(box.scrollTop - bottom) < 1) {
      animating.current = false;
      target.current = undefined;
      return false;
    }
    if (animating.current && target.current === bottom) return true;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    animating.current = smooth && !reduceMotion;
    target.current = bottom;
    box.scrollTo({ top: bottom, behavior: animating.current ? 'smooth' : 'instant' });
    return true;
  };

  const updateLayout = () => {
    const box = viewport.current;
    if (!box) return;
    const resized = viewportResized(box);
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    const layoutChanged = lastKnownBottom.current !== undefined && Math.abs(bottom - lastKnownBottom.current) > .5;
    if (following.current && !userScrollIntent.current && (resized || layoutChanged)) recordLayoutRestoreOffsets(box);
    if (!initialized.current) {
      if (!latestReady.current) return;
      initialized.current = true;
      initialSettlePending.current = true;
      if (!moveToLatest(false) && !shouldKeepInitialSettleRef.current(box)) initialSettlePending.current = false;
    } else if (following.current) {
      // Layout corrections run before paint. Smooth-scrolling here exposes a
      // temporary gap whenever a caption, message, or optional tool row changes
      // height while the reader is following the latest content.
      const moved = moveToLatest(false);
      if (initialSettlePending.current && !moved && !shouldKeepInitialSettleRef.current(box)) initialSettlePending.current = false;
    } else {
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
      setShowLatest(distance(box) > bottomThreshold);
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
      clearUserScrollIntent();
    };
  }, []);

  const onScroll = () => {
    const box = viewport.current;
    if (!box) return;
    const readerInitiated = userScrollIntent.current;
    if (readerInitiated) deferUserScrollIntentExpiry();
    const resized = viewportResized(box);
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    const layoutChanged = lastKnownBottom.current !== undefined && Math.abs(bottom - lastKnownBottom.current) > .5;
    if (following.current && !readerInitiated && (resized || layoutChanged)) recordLayoutRestoreOffsets(box);
    const currentDistance = distance(box);
    const reachedTarget = target.current !== undefined && Math.abs(box.scrollTop - target.current) < 1;
    if (reachedTarget) {
      animating.current = false;
      target.current = undefined;
      if (!shouldKeepInitialSettleRef.current(box)) initialSettlePending.current = false;
    } else if (!animating.current) {
      target.current = undefined;
    }
    // Intermediate animation frames are not a user's decision to leave the tail.
    if (resized) {
      if (readerInitiated) {
        initialSettlePending.current = false;
        following.current = currentDistance <= bottomThreshold;
      } else if (following.current) {
        if (!moveToLatest(false) && initialSettlePending.current && !shouldKeepInitialSettleRef.current(box)) initialSettlePending.current = false;
      }
    } else if (!animating.current) {
      if (readerInitiated) {
        initialSettlePending.current = false;
        following.current = currentDistance <= bottomThreshold;
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
          following.current = currentDistance <= bottomThreshold;
        }
      }
    }
    setShowLatest(!following.current);
    capture();
  };

  const interrupt = () => {
    const box = viewport.current;
    if (!box) return;
    const resized = viewportResized(box);
    if (animating.current) box.scrollTo({ top: box.scrollTop, behavior: 'instant' });
    animating.current = false;
    target.current = undefined;
    if (resized) {
      if (following.current) moveToLatest(false);
    } else if (userScrollIntent.current) {
      initialSettlePending.current = false;
      following.current = distance(box) <= bottomThreshold;
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
    if (animating.current) box.scrollTo({ top: box.scrollTop, behavior: 'instant' });
    animating.current = false;
    target.current = undefined;
    // Expanding an activity run is not reader intent to leave the latest edge.
    setShowLatest(distance(box) > bottomThreshold);
    capture();
  };
  const scrollBy = (amount: number) => {
    const box = viewport.current;
    if (!box || !Number.isFinite(amount) || amount === 0) return;
    initialSettlePending.current = false;
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    // Repeat events build on the pending destination, so held keys continue
    // moving instead of repeatedly resetting the same smooth scroll.
    const origin = animating.current && target.current !== undefined ? target.current : box.scrollTop;
    const destination = Math.max(0, Math.min(bottom, origin + amount));
    if (Math.abs(destination - origin) < 1) {
      if (!animating.current) {
        following.current = distance(box) <= bottomThreshold;
        setShowLatest(!following.current);
        capture();
      }
      return;
    }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    animating.current = !reduceMotion;
    target.current = animating.current ? destination : undefined;
    following.current = bottom - destination <= bottomThreshold;
    setShowLatest(!following.current);
    box.scrollTo({ top: destination, behavior: animating.current ? 'smooth' : 'instant' });
    if (!animating.current) {
      following.current = distance(box) <= bottomThreshold;
      setShowLatest(!following.current);
    }
    capture();
  };
  const scrollToLatest = () => {
    const box = viewport.current;
    if (!box) return;
    initialSettlePending.current = false;
    // Keep keyboard navigation somewhere useful after its button disappears.
    if (document.activeElement?.getAttribute('data-scroll-latest') === 'true') box.focus({ preventScroll: true });
    moveToLatest(true);
  };

  return { viewport, content, registerRow, showLatest, onScroll, interrupt, holdPosition,
    preserveVisiblePosition, scrollBy, scrollToLatest, noteUserScroll, reconcileViewportLayout };
}
