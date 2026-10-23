import { useLayoutEffect, useRef, useState } from 'react';

// About two lines of conversation text. Measure intent before content grows.
const bottomThreshold = 64;
type Anchor = { key: string; top: number; bottom: number };

export function useReadingPosition(ready: boolean, revision: unknown) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const following = useRef(true);
  const animating = useRef(false);
  const target = useRef<number | undefined>(undefined);
  const anchors = useRef<Anchor[]>([]);
  const readingTop = useRef(0);
  const latestReady = useRef(ready);
  const [showLatest, setShowLatest] = useState(false);
  latestReady.current = ready;

  const distance = (box: HTMLElement) => Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop);
  const capture = () => {
    const box = viewport.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top - box.scrollTop;
    const rows = [...box.querySelectorAll<HTMLElement>('[data-scroll-key]')];
    // Measure once per layout, in content coordinates. Scrolling only changes
    // readingTop; it must not measure or allocate an array for the full history.
    anchors.current = rows.map(row => {
      const rect = row.getBoundingClientRect();
      return { key: row.dataset.scrollKey!, top: rect.top - top, bottom: rect.bottom - top };
    });
    readingTop.current = box.scrollTop;
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
      const saved = anchors.current;
      const rows = new Map([...box.querySelectorAll<HTMLElement>('[data-scroll-key]')]
        .map(row => [row.dataset.scrollKey, row]));
      const first = saved.findIndex(anchor => anchor.bottom > readingTop.current);
      let survivor: Anchor | undefined;
      for (let i = first; i >= 0 && i < saved.length; i++) {
        if (rows.has(saved[i].key)) { survivor = saved[i]; break; }
      }
      if (!survivor) {
        for (let i = (first < 0 ? saved.length : first) - 1; i >= 0; i--) {
          if (rows.has(saved[i].key)) { survivor = saved[i]; break; }
        }
      }
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
    readingTop.current = box.scrollTop;
  };

  const interrupt = () => {
    const box = viewport.current;
    if (!box) return;
    if (animating.current) box.scrollTo({ top: box.scrollTop, behavior: 'instant' });
    animating.current = false;
    target.current = undefined;
    following.current = distance(box) <= bottomThreshold;
    readingTop.current = box.scrollTop;
  };
  const holdPosition = () => {
    interrupt();
    following.current = false;
  };
  const scrollToLatest = () => {
    const box = viewport.current;
    if (!box) return;
    // Keep keyboard navigation somewhere useful after its button disappears.
    if (document.activeElement?.getAttribute('data-scroll-latest') === 'true') box.focus({ preventScroll: true });
    moveToLatest(true);
  };

  return { viewport, content, showLatest, onScroll, interrupt, holdPosition, scrollToLatest };
}
