import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef,
  useSyncExternalStore, type ReactNode } from 'react';
import type { ActivityLine } from './activityTrail';
import { ActivitySummaryViewer, type ActivitySummaryTransport } from './activitySummaries';

const SummaryContext = createContext<{
  viewer?: ActivitySummaryViewer; reconcile?: () => void;
}>({});

export function ActivitySummaryProvider({ transport, connected, reconcile, children }: {
  transport?: ActivitySummaryTransport; connected: boolean; reconcile: () => void; children: ReactNode;
}) {
  const viewer = useMemo(() => transport ? new ActivitySummaryViewer(transport) : undefined, [transport]);
  const context = useMemo(() => ({ viewer, reconcile }), [viewer, reconcile]);
  useEffect(() => {
    if (!viewer) return;
    viewer.retain();
    document.addEventListener('visibilitychange', viewer.resume);
    window.addEventListener('online', viewer.resume);
    return () => {
      document.removeEventListener('visibilitychange', viewer.resume);
      window.removeEventListener('online', viewer.resume);
      viewer.release();
    };
  }, [viewer]);
  useEffect(() => { if (connected) viewer?.resume(); }, [viewer, connected]);
  return <SummaryContext.Provider value={context}>{children}</SummaryContext.Provider>;
}

const noSubscribe = () => () => {};
const noSnapshot = () => undefined;
export function useActivitySummary(entry: ActivityLine) {
  const { viewer, reconcile } = useContext(SummaryContext);
  const key = viewer?.key(entry);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  // The source key owns the subscription; unrelated row-object publications
  // must not become delivery-retry events.
  const subscribe = useCallback((listener: () => void) =>
    viewer?.subscribe(entryRef.current, listener) ?? (() => {}), [viewer, key]);
  const snapshot = useCallback(() => viewer?.snapshot(key), [viewer, key]);
  const display = useSyncExternalStore(viewer ? subscribe : noSubscribe, viewer ? snapshot : noSnapshot, noSnapshot);
  const fallback = entry.originalContent?.trim() ? entry.originalContent :
    entry.accessibleText.trim() ? entry.accessibleText : 'Original activity text is temporarily unavailable.';
  const note = display?.original?.trim() ? display.original : fallback;
  const restoreOriginal = useCallback(() => viewer?.restoreOriginal(entryRef.current), [viewer, key]);
  const text = display?.state === 'summary' ? display.text : note;
  useLayoutEffect(() => { viewer?.observe(entry); }, [viewer, entry]);
  useLayoutEffect(() => { if (text) reconcile?.(); }, [text, reconcile]);
  return { presentation: text && entry.presentation ? { ...entry.presentation, text } : entry.presentation,
    original: note, restoreOriginal,
    state: display?.state };
}
