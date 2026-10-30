import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore,
  type ReactNode } from 'react';
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
  const subscribe = useCallback((listener: () => void) => viewer?.subscribe(entry, listener) ?? (() => {}), [viewer, key, entry]);
  const snapshot = useCallback(() => viewer?.snapshot(key), [viewer, key]);
  const display = useSyncExternalStore(viewer ? subscribe : noSubscribe, viewer ? snapshot : noSnapshot, noSnapshot);
  useLayoutEffect(() => { if (display?.text) reconcile?.(); }, [display, reconcile]);
  return { presentation: display?.text && entry.presentation ? { ...entry.presentation, text: display.text } : entry.presentation,
    original: display?.original ?? entry.originalContent ?? entry.accessibleText,
    state: display?.state };
}
