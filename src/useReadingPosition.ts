import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// About two lines of conversation text. Measure intent before content grows.
const bottomThreshold = 64;
type Anchor = { key: string; top: number };

export function useReadingPosition(ready: boolean, revision: unknown) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const following = useRef(true);
  const animating = useRef(false);
  const target = useRef<number | undefined>(undefined);
  const anchors = useRef<Anchor[]>([]);
  const registeredRows = useRef(new Map<string, HTMLElement>());
  const registerRow = useCallback((key: string, element: HTMLElement | null) => {
    if (element) registeredRows.current.set(key, element);
    else registeredRows.current.delete(key);
  }, []);
  const readingTop = useRef(0);
  const latestReady = useRef(ready);
  const [showLatest, setShowLatest] = useState(false);
  latestReady.current = ready;

  const distance = (box: HTMLElement) => Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop);
  const capture = () => {
    const box = viewport.current;
    const children = content.current?.children;
    if (!box || !children) return;
    readingTop.current = box.scrollTop;
    anchors.current = [];
    if (following.current) return;
    const bounds = box.getBoundingClientRect();
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
      if (row.dataset.scrollKey !== undefined) anchors.current.push({
        key: row.dataset.scrollKey, top: top - bounds.top + box.scrollTop,
      });
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
  };

  const moveToLatest = (smooth: boolean) => {
    const box = viewport.current;
    if (!box) return;
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    following.current = true;
    setShowLatest(false);
    if (Math.abs(box.scrollTop - bottom) < 1) {
      animating.current = false;
      target.current = undefined;
      return;
    }
    if (animating.current && target.current === bottom) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    animating.current = smooth && !reduceMotion;
    target.current = bottom;
    box.scrollTo({ top: bottom, behavior: animating.current ? 'smooth' : 'instant' });
  };

  const updateLayout = () => {
    const box = viewport.current;
    if (!box) return;
    if (!initialized.current) {
      if (!latestReady.current) return;
      initialized.current = true;
      moveToLatest(false);
    } else if (following.current) {
      moveToLatest(true);
    } else {
      const rows = registeredRows.current;
      const survivor = anchors.current.find(anchor => rows.has(anchor.key));
      if (survivor) {
        // Retain the next visible row if filtering removed the original anchor.
        box.style.removeProperty('--tb-chat-anchor-space');
        const offset = rows.get(survivor.key)!.getBoundingClientRect().top - box.getBoundingClientRect().top;
        const wanted = box.scrollTop + offset - (survivor.top - readingTop.current);
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

  useLayoutEffect(updateLayout, [revision]);
  useLayoutEffect(() => {
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => currentUpdate.current());
    if (content.current) observer?.observe(content.current);
    if (viewport.current) observer?.observe(viewport.current);
    return () => observer?.disconnect();
  }, []);

  const onScroll = () => {
    const box = viewport.current;
    if (!box) return;
    if (animating.current && distance(box) < 1) {
      animating.current = false;
      target.current = undefined;
    }
    // Intermediate animation frames are not a user's decision to leave the tail.
    if (!animating.current) following.current = distance(box) <= bottomThreshold;
    setShowLatest(!following.current);
    capture();
  };

  const interrupt = () => {
    const box = viewport.current;
    if (!box) return;
    if (animating.current) box.scrollTo({ top: box.scrollTop, behavior: 'instant' });
    animating.current = false;
    target.current = undefined;
    following.current = distance(box) <= bottomThreshold;
    capture();
  };
  const holdPosition = () => {
    interrupt();
    following.current = false;
    capture();
  };
  const scrollToLatest = () => {
    const box = viewport.current;
    if (!box) return;
    // Keep keyboard navigation somewhere useful after its button disappears.
    if (document.activeElement?.getAttribute('data-scroll-latest') === 'true') box.focus({ preventScroll: true });
    moveToLatest(true);
  };

  return { viewport, content, registerRow, showLatest, onScroll, interrupt, holdPosition, scrollToLatest };
}
