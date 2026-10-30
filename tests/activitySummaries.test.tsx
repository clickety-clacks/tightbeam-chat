import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { memo, StrictMode } from 'react';
import { ActivitySummaryViewer, activitySummaryDescriptor, createActivitySummaryTransport,
  type ActivitySummaryTransport, type SummaryAnswer, type SummarySource } from '../src/activitySummaries';
import { ActivitySummaryProvider, useActivitySummary } from '../src/ActivitySummaryView';
import { activityPillPresentation } from '../src/activityPresentation';
import type { ActivityLine } from '../src/activityTrail';

const line = (id: string, content: string, kind: 'agent' | 'substrate' | 'rail' = 'agent'): ActivityLine => ({
  kind, id, runKey: 'run', anchorSeq: 1, position: { sequence: 1, phase: 1, order: 0 }, gist: content,
  accessibleText: content, originalContent: content,
  presentation: activityPillPresentation({ kind, gist: content, content }),
});
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function transportFixture() {
  const calls: { sources: readonly SummarySource[]; receive: (answer: SummaryAnswer) => void; end: () => void; fail: () => void }[] = [];
  const transport: ActivitySummaryTransport = {
    stream: vi.fn((sources: readonly SummarySource[], receive: (answer: SummaryAnswer) => void, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      calls.push({ sources: sources.map(source => ({ ...source })), receive, end: resolve,
        fail: () => reject(new Error('Disconnected')) });
      signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    })),
  };
  return { calls, transport };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('activity summary sources', () => {
  it('keeps event identity, full wake/question bodies and decision prefixes, excluding fixed wording', () => {
    const question = 'Can the change ship?\n\nThere are two choices.';
    const request = line('message:request', `Question dr_12345678 from session:helper\n${question}`, 'substrate');
    const answer = line('member:answer', `Question dr_12345678 was answered by user:person.\nYou asked: ${question}\nAnswer: Yes.`, 'substrate');
    expect(activitySummaryDescriptor(request)).toMatchObject({ lineId: 'request', sourceText: question, prefix: 'Needs a response · ' });
    expect(activitySummaryDescriptor(answer)).toMatchObject({ lineId: 'answer', sourceText: question, prefix: 'Answered · ' });
    expect(activitySummaryDescriptor(line('message:wake', '[woke: fallback]\nFirst paragraph.\n\nSecond paragraph.', 'substrate')))
      .toMatchObject({ sourceText: 'First paragraph.\n\nSecond paragraph.' });
    expect(activitySummaryDescriptor(line('message:note', 'Attest att_12345678 (verdict) was filed on assignment asg_12345678.', 'substrate')))
      .toMatchObject({ lineId: 'att_12345678', attestId: 'att_12345678' });
    for (const text of ['[woke: fallback]', 'Wait finished on its assignment', 'Decision request dr_12345678 was ruled',
      '[assignment: asg_12345678]\nNew work', '[turn failed]\nFailure reason', 'Quiet for 3 h · Work']) {
      expect(activitySummaryDescriptor(line('message:fixed', text, 'substrate')), text).toBeUndefined();
    }
  });
});

describe('summary answer delivery', () => {
  it('keeps page cache entries source-free while retaining the weak source for delivery recovery', async () => {
    const { calls, transport } = transportFixture();
    const viewer = new ActivitySummaryViewer(transport);
    const body = 'A long activity body that must not remain in viewer cache. '.repeat(200);
    const entry = line('message:large', body);
    viewer.subscribe(entry, () => {});
    await flush();

    expect(calls[0].sources).toEqual([{ lineId: 'large', sourceText: body.trim() }]);
    const key = viewer.key(entry)!;
    expect(key).not.toContain(body);
    const cached = [...(viewer as unknown as { entries: Map<string, unknown> }).entries.values()][0] as Record<string, unknown>;
    expect(cached).not.toHaveProperty('descriptor');
    expect(cached).not.toHaveProperty('source');
    expect(cached.line).toBeInstanceOf(WeakRef);

    calls[0].receive({ index: 0, state: 'summary', summary: 'The activity completed.' });
    expect(viewer.snapshot(key)).toEqual({ text: 'The activity completed.', state: 'summary' });
    expect(JSON.stringify([...((viewer as unknown as { entries: Map<string, unknown> }).entries)]))
      .not.toContain(body);
    viewer.dispose();
  });

  it('batches loaded lines once, targets listeners, keeps revisions separate and never polls', async () => {
    vi.useFakeTimers();
    const { calls, transport } = transportFixture();
    const viewer = new ActivitySummaryViewer(transport);
    const a = line('message:a', 'Full A'), b = line('message:b', 'Full B');
    const onA = vi.fn(), onB = vi.fn();
    viewer.subscribe(a, onA); viewer.subscribe(b, onB);
    await flush();
    expect(calls).toHaveLength(1);
    calls[0].receive({ index: 0, state: 'pending' });
    calls[0].receive({ index: 1, state: 'waiting' });
    onA.mockClear(); onB.mockClear();
    calls[0].receive({ index: 0, state: 'summary', summary: 'A completed.' });
    expect(onA).toHaveBeenCalledTimes(1); expect(onB).not.toHaveBeenCalled();
    viewer.subscribe(a, () => {});
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(1);
    const revised = line('message:a', 'Revised A');
    viewer.subscribe(revised, () => {});
    expect(viewer.snapshot(viewer.key(revised)).text).toBeUndefined();
    await flush();
    expect(calls[1].sources).toEqual([{ lineId: 'a', sourceText: 'Revised A' }]);
    viewer.dispose();
  });

  it('reopens a lost stream once immediately, then only on recovery events, and never after terminal closure', async () => {
    vi.useFakeTimers();
    const { calls, transport } = transportFixture();
    let available = true;
    const viewer = new ActivitySummaryViewer(transport, () => available);
    viewer.subscribe(line('message:a', 'Original'), () => {});
    await flush();
    calls[0].receive({ index: 0, state: 'pending' }); calls[0].fail(); await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].sources).toEqual([{ lineId: 'a', sourceText: 'Original' }]);
    calls[1].fail(); await flush();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toHaveLength(2);
    viewer.resume(); await flush();
    expect(calls).toHaveLength(3);
    calls[2].receive({ index: 0, state: 'waiting' }); available = false; calls[2].end(); await flush();
    viewer.resume(); await flush(); expect(calls).toHaveLength(3);
    available = true; viewer.resume(); await flush(); expect(calls).toHaveLength(4);
    calls[3].receive({ index: 0, state: 'summary', summary: 'Finished.' }); calls[3].end(); await flush();
    viewer.resume(); await flush(); expect(calls).toHaveLength(4);
    viewer.dispose();
  });

  it('reads attest notes once and silently leaves unreadable notes alone', async () => {
    const { calls, transport } = transportFixture();
    transport.readAttestNote = vi.fn(async id => id === 'att_12345678' ? 'Seven review findings.\nFull original note.' : undefined);
    const viewer = new ActivitySummaryViewer(transport);
    const note = line('message:notice', 'Attest att_12345678 (verdict) was filed on assignment asg_12345678.', 'substrate');
    const originals: string[] = [];
    viewer.subscribe(note, () => {}, value => originals.push(value));
    viewer.subscribe({ ...note, id: 'member:another' }, () => {}, value => originals.push(value));
    viewer.subscribe(line('message:missing', 'Attest att_99999999 (verdict) was filed on assignment asg_12345678.', 'substrate'), () => {});
    await flush();
    expect(transport.readAttestNote).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].sources).toEqual([{ lineId: 'att_12345678', sourceText: 'Seven review findings.\nFull original note.' }]);
    expect(originals).toEqual(['Seven review findings.\nFull original note.', 'Seven review findings.\nFull original note.']);
    expect(viewer.snapshot(viewer.key(note))).not.toHaveProperty('original');
    viewer.dispose();
  });

  it('parses chunked streamed states and reads an authorized attest response', async () => {
    const encoder = new TextEncoder();
    const fetcher = vi.fn(async (url: string, _init: RequestInit) => url.includes('/attests/')
      ? new Response(JSON.stringify({ attest: { note: 'Readable note' } }))
      : new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode('{"index":0,"state":"pend'));
        controller.enqueue(encoder.encode('ing"}\n{"index":0,"state":"summary","summary":"Done."}\n'));
        controller.close();
      } })));
    const transport = createActivitySummaryTransport(fetcher, 'https://chat.example/__chat');
    const receive = vi.fn();
    await transport.stream([{ lineId: 'event', sourceText: 'Whole source' }], receive, new AbortController().signal);
    expect(receive.mock.calls.map(([value]) => value.state)).toEqual(['pending', 'summary']);
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).toEqual([{ lineId: 'event', sourceText: 'Whole source' }]);
    expect(await transport.readAttestNote?.('att_note', new AbortController().signal)).toBe('Readable note');
    expect(fetcher.mock.calls[0][0]).toBe('https://chat.example/__chat/summaries');
  });
});

describe('row-local rendering', () => {
  it('keeps other rows untouched, shows originals on stored-answer reload and switches folded members independently', async () => {
    const { calls, transport } = transportFixture();
    const renders = new Map<string, number>();
    const Row = memo(function Row({ entry }: { entry: ActivityLine }) {
      renders.set(entry.id, (renders.get(entry.id) ?? 0) + 1);
      const result = useActivitySummary(entry);
      return <div data-testid={entry.id} title={result.original} data-state={result.state}>{result.presentation?.text}</div>;
    });
    const a = line('message:a', 'Original A'), b = line('message:b', 'Original B');
    const view = (latest: ActivityLine) => <StrictMode><ActivitySummaryProvider transport={transport} connected reconcile={() => {}}>
      <Row entry={latest} /><Row entry={b} />
    </ActivitySummaryProvider></StrictMode>;
    const rendered = render(view(a));
    await act(flush);
    expect(screen.getByTestId(a.id).textContent).toBe('Original A');
    expect(screen.getByTestId(a.id).dataset.state).toBeUndefined();
    const nodeB = screen.getByTestId(b.id), renderedB = renders.get(b.id);
    await act(async () => { calls[0].receive({ index: 0, state: 'summary', summary: 'A done.' }); });
    expect(screen.getByTestId(a.id).textContent).toBe('A done.');
    expect(screen.getByTestId(a.id).title).toBe('Original A');
    expect(screen.getByTestId(b.id)).toBe(nodeB);
    expect(renders.get(b.id)).toBe(renderedB);
    const newer = line('member:new', 'Newest member');
    rendered.rerender(view(newer)); await act(flush);
    expect(screen.getByTestId(newer.id).textContent).toBe('Newest member');
    expect(calls[1].sources).toEqual([{ lineId: 'new', sourceText: 'Newest member' }]);
    await act(async () => { calls[1].receive({ index: 0, state: 'waiting' }); });
    expect(screen.getByTestId(newer.id).dataset.state).toBe('waiting');
  });

  it('does not request or shimmer without a summary transport', () => {
    function Row() { const result = useActivitySummary(line('message:a', 'Original')); return <div data-state={result.state}>{result.presentation?.text}</div>; }
    render(<ActivitySummaryProvider connected reconcile={() => {}}><Row /></ActivitySummaryProvider>);
    expect(screen.getByText('Original').dataset.state).toBeUndefined();
  });

  it('shows an attest note locally as the original and keeps it available on hover after summarizing', async () => {
    const { calls, transport } = transportFixture();
    transport.readAttestNote = vi.fn(async () => 'The full attest note remains readable.');
    const note: ActivityLine = { ...line('message:attest', 'Filed a review note.', 'substrate'), sourceRecord: {},
      presentation: { label: 'Attest', tone: 'amber', icon: 'attest', text: 'Filed a review note.', attestId: 'note-reference' } };
    function Row() {
      const result = useActivitySummary(note);
      return <div data-testid="attest" title={result.original} data-state={result.state}>{result.presentation?.text}</div>;
    }
    const view = (entry: ActivityLine, show = true) => <ActivitySummaryProvider transport={transport} connected reconcile={() => {}}>
      {show && <Row entry={entry} />}
    </ActivitySummaryProvider>;
    const rendered = render(view(note));
    await act(flush);
    expect(screen.getByTestId('attest').textContent).toBe('The full attest note remains readable.');
    expect(screen.getByTestId('attest').title).toBe('The full attest note remains readable.');
    await act(async () => { calls[0].receive({ index: 0, state: 'summary', summary: 'Three findings were filed.' }); });
    expect(screen.getByTestId('attest').textContent).toBe('Three findings were filed.');
    expect(screen.getByTestId('attest').title).toBe('The full attest note remains readable.');
    rendered.rerender(view(note, false));
    rendered.rerender(view({ ...note }));
    expect(screen.getByTestId('attest').textContent).toBe('Three findings were filed.');
    expect(screen.getByTestId('attest').title).toBe('The full attest note remains readable.');
    expect(transport.readAttestNote).toHaveBeenCalledTimes(1);
  });
});

it('resumes a previously displayed folded member when it is displayed again after delivery closed', async () => {
  const { calls, transport } = transportFixture();
  const viewer = new ActivitySummaryViewer(transport);
  const entry = line('member:retained', 'Original member');
  const stop = viewer.subscribe(entry, () => {});
  await flush();
  calls[0].receive({ index: 0, state: 'waiting' });
  stop(); calls[0].end(); await flush();
  expect(calls).toHaveLength(1);
  viewer.subscribe(entry, () => {}); await flush();
  expect(calls).toHaveLength(2);
  calls[1].receive({ index: 0, state: 'summary', summary: 'Completed.' });
  expect(viewer.snapshot(viewer.key(entry)).text).toBe('Completed.');
  viewer.dispose();
});
