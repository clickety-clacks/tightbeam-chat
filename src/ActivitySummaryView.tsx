import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore,
  useRef, useState, type ReactNode } from 'react';
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
  const originalRef = useRef<{ key?: string; text: string } | undefined>(undefined);
  const [attestNote, setAttestNote] = useState<{ key?: string; text: string } | undefined>(undefined);
  const receiveOriginal = useCallback((text: string) => {
    const value = { key, text };
    originalRef.current = value;
    setAttestNote(value);
  }, [key]);
  const currentOriginal = useCallback(() => {
    const value = originalRef.current;
    return value && value.key === key ? value.text : undefined;
  }, [key]);
  // The source key owns the subscription; unrelated row-object publications
  // must not become delivery-retry events.
  const subscribe = useCallback((listener: () => void) =>
    viewer?.subscribe(entry, listener, receiveOriginal, currentOriginal) ?? (() => {}),
  [viewer, entry, key, receiveOriginal, currentOriginal]);
  const snapshot = useCallback(() => viewer?.snapshot(key), [viewer, key]);
  const display = useSyncExternalStore(viewer ? subscribe : noSubscribe, viewer ? snapshot : noSnapshot, noSnapshot);
  const note = attestNote && attestNote.key === key ? attestNote.text : undefined;
  const text = display?.state === 'summary' ? display.text : note;
  useLayoutEffect(() => { if (text) reconcile?.(); }, [text, reconcile]);
  return { presentation: text && entry.presentation ? { ...entry.presentation, text } : entry.presentation,
    original: note ?? entry.originalContent ?? entry.accessibleText,
    state: display?.state };
}
