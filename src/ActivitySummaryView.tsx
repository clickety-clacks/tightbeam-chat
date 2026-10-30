import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef,
  useSyncExternalStore, type ReactNode } from 'react';
import type { ActivityLine } from './activityTrail';
import { activitySummaryDescriptor, ActivitySummaryViewer, type ActivitySummaryTransport } from './activitySummaries';

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
  const descriptor = activitySummaryDescriptor(entry);
  const key = viewer?.key(entry);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  // The source key owns the subscription; unrelated row-object publications
  // must not become delivery-retry events.
  const subscribe = useCallback((listener: () => void) =>
    viewer?.subscribe(entryRef.current, listener) ?? (() => {}), [viewer, key]);
  const snapshot = useCallback(() => viewer?.snapshot(key), [viewer, key]);
  const display = useSyncExternalStore(viewer ? subscribe : noSubscribe, viewer ? snapshot : noSnapshot, noSnapshot);
  const sourceFallback = entry.originalContent?.trim() ? entry.originalContent :
    entry.accessibleText.trim() ? entry.accessibleText : 'Original activity text is temporarily unavailable.';
  // The filing event identifies an attest but does not carry its note body.
  // Keep its fixed pill text until the existing note read returns readable text.
  const fallback = descriptor?.attestId
    ? (entry.presentation?.text.trim() ? entry.presentation.text : sourceFallback)
    : sourceFallback;
  const note = display?.original?.trim() ? display.original :
    display?.originalLoading && display.state === 'summary' && display.text?.trim() ? display.text : fallback;
  const restoreOriginal = useCallback(() => viewer?.restoreOriginal(entryRef.current), [viewer, key]);
  const text = descriptor
    ? (display?.state === 'summary'
      ? display.text
      : descriptor.attestId ? note : entry.presentation?.text ?? note)
    : undefined;
  useLayoutEffect(() => { viewer?.observe(entry); }, [viewer, entry]);
  useLayoutEffect(() => { if (text) reconcile?.(); }, [text, reconcile]);
  return { presentation: text && entry.presentation ? { ...entry.presentation, text } : entry.presentation,
    original: note, restoreOriginal,
    state: display?.state };
}
