import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TightbeamChat, type TightbeamChatProps } from '../src/TightbeamChat';
import { useReadingPosition } from '../src/useReadingPosition';
import { createTightbeamAdapter } from '../src/runtime';
import { type ChatTransport, type TargetProfile } from '../src/types';
import type { CanonicalMessage, ChatRuntime, ConversationRecord, RuntimeState } from '../src/types';

class ReadingRuntime implements ChatRuntime {
  listeners = new Set<() => void>();
  state: RuntimeState = { sessionKey: 'reading', principalKey: 'person', generation: 1, status: 'ready', targetLabel: 'Example', records: [],
    provenanceAvailable: false, hasOlder: false, loadingOlder: false, sends: [], agentDisplayName: 'Assistant' };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  publish(patch: Partial<RuntimeState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  loadOlder = async () => {};
  rebuild = async () => {};
  send: ChatRuntime['send'] = () => null;
  retrySend = async () => {};
  observeHostSend = () => () => {};
  refreshHostSend = async () => 'absent' as const;
  retryHostSend = () => {};
  recordHostSendOutcome = () => {};
  markHostSendUncertain = () => {};
  dispose = () => {};
}
const message = (id: number): CanonicalMessage => ({ kind: 'message', id: `message-${id}`, sessionKey: 'reading',
  seq: id, rowVersion: 1, role: 'user', sender: 'user:person', content: `Message ${id}`, raw: {} });
const initialRows = Array.from({ length: 20 }, (_, i) => message(i));
let scrollTop = 0;
let viewportHeight = 300;
let lateLayoutGrowth = 0;
let scrollTo: ReturnType<typeof vi.fn>;
let reducedMotion = false;
let animate: ReturnType<typeof vi.fn>;
const resizeCallbacks = new Set<ResizeObserverCallback>();
const rows = () => [...document.querySelectorAll<HTMLElement>('article[data-record-key]')];
const scrollHeight = () => 32 + rows().length * 92 + lateLayoutGrowth + Number.parseFloat(document.querySelector<HTMLElement>('.tb-chat-viewport')?.style.getPropertyValue('--tb-chat-anchor-space') || '0');
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 400, width: 400, height, x: 0, y: top, toJSON() {} });
beforeEach(() => {
  scrollTop = 0;
  viewportHeight = 300;
  lateLayoutGrowth = 0;
  reducedMotion = false;
  animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) { resizeCallbacks.add(callback); }
    observe() {}
    disconnect() { resizeCallbacks.delete(this.callback); }
    unobserve() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('tb-chat-viewport')) return rect(0, viewportHeight);
    const index = this.dataset.testPosition === undefined ? rows().indexOf(this) : Number(this.dataset.testPosition);
    if (index >= 0) return rect(16 + Number.parseFloat(document.querySelector<HTMLElement>('.tb-chat-viewport')?.style.getPropertyValue('--tb-chat-anchor-space') || '0') + index * 92 - scrollTop, 80);
    return rect(0, 50);
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('tb-chat-viewport') ? scrollHeight() : 40;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('tb-chat-viewport') ? viewportHeight : 300;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => scrollTop);
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(value => { scrollTop = Math.max(0, Math.min(value, scrollHeight() - viewportHeight)); });
  scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    // Keep smooth motion pending so intermediate scroll frames can be exercised.
    if (options.behavior !== 'smooth') this.scrollTop = options.top ?? 0;
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resizeCallbacks.clear(); });

function setup(records = initialRows, renderMessage?: TightbeamChatProps['renderMessage']) {
  const runtime = new ReadingRuntime();
  runtime.state = { ...runtime.state, records };
  render(<TightbeamChat sessionKey="reading" adapter={{ open: () => runtime }} renderMessage={renderMessage} />);
  scrollTo.mockClear();
  return { runtime, box: screen.getByRole('log'), input: screen.getByRole('textbox') as HTMLTextAreaElement };
}
function readAt(box: HTMLElement, position: number) {
  fireEvent.wheel(box, { deltaY: -100 });
  box.scrollTop = position;
  fireEvent.scroll(box);
}
function notifyResizeObservers() {
  act(() => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });
}

describe('conversation reading position', () => {
  it('uses Tab from outside the composer to focus it at the end of the draft and leaves Tab inside alone', () => {
    const { box, input } = setup();
    fireEvent.change(input, { target: { value: 'preserve this draft' } });
    input.setSelectionRange(3, 3);
    box.focus();

    expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(input.value).toBe('preserve this draft');

    input.setSelectionRange(4, 4);
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(4);
    expect(input.value).toBe('preserve this draft');
  });

  it('handles navigation from an unfocused standalone page and after focus returns to the body', () => {
    const { box, input } = setup();
    box.closest('.tb-chat')!.parentElement!.setAttribute('data-chat-standalone', '');
    expect(document.activeElement).toBe(document.body);
    const bottom = box.scrollHeight - box.clientHeight;

    expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(false);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: bottom - 72, behavior: 'smooth' });
    expect(document.activeElement).toBe(document.body);
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'body focus keeps the draft' } });
    input.blur();
    expect(document.activeElement).toBe(document.body);
    expect(fireEvent.keyDown(document.body, { key: 'j', ctrlKey: true })).toBe(false);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: bottom, behavior: 'smooth' });
    expect(input.value).toBe('body focus keeps the draft');
  });

  it('does not take body shortcuts from an embedded host until interaction is inside Chat', () => {
    const runtime = new ReadingRuntime();
    runtime.state = { ...runtime.state, records: initialRows };
    const view = render(<><button type="button">Host action</button>
      <TightbeamChat sessionKey="reading" adapter={{ open: () => runtime }} /></>);
    scrollTo.mockClear();
    expect(document.activeElement).toBe(document.body);

    expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();

    fireEvent.pointerDown(view.container.querySelector('.tb-chat')!);
    expect(fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })).toBe(false);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Host action' }));
    expect(fireEvent.keyDown(document.body, { key: 'j', ctrlKey: true })).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('leaves reverse Tab native while sending forward Tab to the composer', () => {
    const { box, input } = setup();
    const hostLink = document.createElement('a');
    hostLink.href = '#host';
    document.body.insertBefore(hostLink, box.closest('.tb-chat')!.parentElement);
    box.focus();

    expect(fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(box);
    expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(input);
    hostLink.remove();
  });

  for (const focusTarget of ['transcript', 'composer'] as const) {
    it.each([
      ['j', 72], ['k', -72], ['u', -255], ['d', 255],
    ] as const)(`handles Ctrl+%s with focus in the ${focusTarget} without changing the draft`, (key, amount) => {
      const { box, input } = setup();
      readAt(box, 600);
      fireEvent.change(input, { target: { value: 'keyboard scrolling keeps this' } });
      const target = focusTarget === 'composer' ? input : box;
      target.focus();
      const start = box.scrollTop;
      const expected = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, start + amount));

      expect(fireEvent.keyDown(target, { key, ctrlKey: true })).toBe(false);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: expected, behavior: 'smooth' });
      expect(input.value).toBe('keyboard scrolling keeps this');
    });
  }

  it('continues repeated Ctrl+K movement from the pending smooth-scroll destination', () => {
    const { box, input } = setup();
    readAt(box, 900);
    fireEvent.change(input, { target: { value: 'repeat without editing' } });
    input.focus();
    const start = box.scrollTop;

    fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'k', ctrlKey: true, repeat: true });

    expect(scrollTo).toHaveBeenNthCalledWith(1, { top: start - 72, behavior: 'smooth' });
    expect(scrollTo).toHaveBeenNthCalledWith(2, { top: start - 144, behavior: 'smooth' });
    expect(input.value).toBe('repeat without editing');
  });

  it('stops bottom-follow while scrolling up and resumes it after a page reaches the bottom', () => {
    const { runtime, box, input } = setup();
    const bottom = box.scrollHeight - box.clientHeight;
    fireEvent.keyDown(box, { key: 'k', ctrlKey: true });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: bottom - 72, behavior: 'smooth' });
    box.scrollTop = bottom - 72;
    fireEvent.scroll(box);
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();

    scrollTo.mockClear();
    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(box.scrollTop).toBe(bottom - 72);

    fireEvent.change(input, { target: { value: 'paging leaves the draft alone' } });
    input.focus();
    const newBottom = box.scrollHeight - box.clientHeight;
    fireEvent.keyDown(input, { key: 'd', ctrlKey: true });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: newBottom, behavior: 'smooth' });
    box.scrollTop = newBottom;
    fireEvent.scroll(box);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
    expect(input.value).toBe('paging leaves the draft alone');

    scrollTo.mockClear();
    act(() => runtime.publish({ records: [...runtime.state.records, message(21)] }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'smooth' });
  });

  it('releases a finished entrance without replaying it on ordinary rerenders', () => {
    const { runtime } = setup();
    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    const animation = animate.mock.results[0].value;
    act(() => animation.onfinish());
    act(() => runtime.publish({ agentDisplayName: 'Updated assistant' }));
    act(() => runtime.publish({ records: runtime.state.records.map(row => ({ ...row, rowVersion: 2 })) }));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Message 20')).toBeTruthy();
    cleanup();
    expect(animation.cancel).not.toHaveBeenCalled();
  });

  it('cancels an unfinished entrance when its row unmounts', () => {
    const { runtime } = setup();
    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    const animation = animate.mock.results[0].value;
    act(() => runtime.publish({ records: initialRows }));
    expect(animation.cancel).toHaveBeenCalledTimes(1);
  });

  it('fades new rows without moving an away reader or replaying history, refresh, and Sent rows', () => {
    const { runtime, box } = setup();
    expect(animate).not.toHaveBeenCalled();
    readAt(box, 600);
    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(screen.getByText('Message 20').closest('article'));
    expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    expect(box.scrollTop).toBe(600);
    expect(scrollTo).not.toHaveBeenCalled();
    act(() => runtime.publish({ records: [message(-1), ...runtime.state.records] }));
    act(() => runtime.publish({ records: runtime.state.records.map(row => ({ ...row, rowVersion: 2 })) }));
    expect(animate).toHaveBeenCalledTimes(1);
    act(() => runtime.publish({ status: 'stale', generation: 2 }));
    act(() => runtime.publish({ status: 'ready', records: [...runtime.state.records, message(21)] }));
    expect(animate).toHaveBeenCalledTimes(1);
    const send = { sessionKey: 'reading', clientMessageId: 'c_sent', deviceId: 'browser', content: 'A sent message',
      status: 'accepted' as const, submittedAt: '2026-10-23T00:00:00Z', reconciled: false };
    act(() => runtime.publish({ sends: [send] }));
    act(() => runtime.publish({ records: [...runtime.state.records, { ...message(22),
      content: send.content, deviceId: send.deviceId, clientMessageId: send.clientMessageId }] }));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-scroll-key="local-c_sent"]')).toBeTruthy();
    act(() => runtime.publish({ records: [...runtime.state.records, message(23)] }));
    expect(animate).toHaveBeenCalledTimes(2);
  });

  it('animates only canonical human members of a new batch while smoothly following from near bottom', () => {
    const { runtime, box } = setup();
    readAt(box, box.scrollHeight - box.clientHeight - 40);
    const carrier = { ...message(20), isBatchCarrier: true, sender: 'process:notifications', messageType: 'substrate', content: [
      '[batched notices: 2]', '', '[430] source=human sender=user:person cause=notice class=fyi',
      'A new human message', '', '[431] source=other sender=agent:helper session-key cause=notice class=fyi',
      'Nonhuman notice', '', 'coalesced by batch-format (2 notices)',
    ].join('\n') };
    act(() => runtime.publish({ records: [...initialRows, carrier, { ...message(21), content: 'A new human message' }] }));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(screen.getByText('A new human message').closest('article'));
    expect(screen.queryByText('Nonhuman notice')).toBeNull();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'smooth' });
    act(() => runtime.publish({ records: [...initialRows, { ...carrier, rowVersion: 2 }, { ...message(21), content: 'A new human message' }] }));
    expect(animate).toHaveBeenCalledTimes(1);
  });
  it('preserves the reader and draft through reconnect without rebuilding on a foreground return', async () => {
    const profile: TargetProfile = { identity: 'fixture:recovery', label: 'Recovery', capabilities: {
      newestTail: true, stableOlderCursor: true, retainedHistoryAcrossResets: true,
      orderedTransitions: true, snapshotCoverage: true, versionedNotices: true,
      humanSendDedupe: true, authoritativeTurnProvenance: true,
    } };
    let offline = false;
    let historyGate: Promise<void> | undefined;
    let releaseHistory = () => {};
    let records = initialRows;
    const connect = vi.fn(async () => {
      if (offline) throw new Error('Connection unavailable');
      return { close() {} };
    });
    const transport: ChatTransport = {
      currentIdentity: () => ({ principalKey: 'person', deviceId: 'browser' }),
      inspectTarget: async () => profile, openChanges: connect,
      readSession: async () => ({ sessionKey: 'reading', rowVersion: 1, displayName: 'Assistant', raw: {} }),
      readTail: async () => { await historyGate; return { records, hasOlder: false, oldestCursor: null, coverage: 'reading' }; },
      readOlder: async () => ({ records: [], hasOlder: false, oldestCursor: null, coverage: 'reading' }),
      proveCoverage: () => true,
      sendHuman: async () => { throw new Error('No send expected'); },
    };
    const runtime = createTightbeamAdapter(transport, profile).open('reading');
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    try {
      render(<TightbeamChat sessionKey="reading" adapter={{ open: () => runtime }} />);
      await act(async () => { await runtime.rebuild(); });
      const box = screen.getByRole('log');
      readAt(box, 600);
      const anchor = screen.getByText('Message 7').closest('article')!;
      const offset = anchor.getBoundingClientRect().top;
      const input = screen.getByRole('textbox') as HTMLTextAreaElement;
      input.focus();
      fireEvent.change(input, { target: { value: 'Keep this unsent draft' } });
      input.setSelectionRange(5, 5);
      visibility = 'hidden';
      fireEvent(document, new Event('visibilitychange'));
      offline = true;
      await act(async () => { await runtime.rebuild(); });
      expect(runtime.getSnapshot().status).toBe('error');
      offline = false;
      records = [...initialRows, message(20)];
      historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
      visibility = 'visible';
      await act(async () => { fireEvent(document, new Event('visibilitychange')); });
      expect(connect).toHaveBeenCalledTimes(2);
      expect(runtime.getSnapshot().status).toBe('error');
      expect(screen.queryByText('Message 20')).toBeNull();
      const reconnect = runtime.rebuild();
      await waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
      expect(runtime.getSnapshot().status).toBe('stale');
      await act(async () => { releaseHistory(); await reconnect; });
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(screen.getByText('Message 20')).toBeTruthy();
      expect(anchor.getBoundingClientRect().top).toBe(offset);
      expect(input.value).toBe('Keep this unsent draft');
      expect(input.selectionStart).toBe(5);
      expect(document.activeElement).toBe(input);
    } finally {
      runtime.dispose();
      if (original) Object.defineProperty(document, 'visibilityState', original);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('bounds scroll measurements to the viewport neighborhood in a long history and preserves position when older rows arrive', () => {
    function History({ ids }: { ids: number[] }) {
      const reading = useReadingPosition(true, ids);
      return <div ref={reading.viewport} className="tb-chat-viewport" onScroll={reading.onScroll}>
        <div ref={reading.content}>{ids.map((id, index) =>
          <article ref={element => reading.registerRow(String(id), element)} key={id} data-record-key={id} data-scroll-key={id} data-test-position={index}>{id}</article>)}</div>
      </div>;
    }
    const ids = Array.from({ length: 2000 }, (_, i) => i);
    const view = render(<History ids={ids} />);
    const box = document.querySelector<HTMLElement>('.tb-chat-viewport')!;
    const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    const query = vi.spyOn(box, 'querySelectorAll');
    measure.mockClear();
    for (let i = 0; i < 30; i++) {
      box.scrollTop = 90000 + i * 30;
      fireEvent.scroll(box);
    }
    expect(measure.mock.calls.length).toBeLessThan(30 * 25);
    expect(query).not.toHaveBeenCalled();
    const anchor = box.querySelector<HTMLElement>('[data-record-key="988"]')!;
    const offset = anchor.getBoundingClientRect().top;
    view.rerender(<History ids={[-2, -1, ...ids]} />);
    expect(anchor.getBoundingClientRect().top).toBe(offset);
  });

  it.each([40, 2000])('bounds anchor work across message, status and send updates with %i loaded rows', count => {
    const renderMessage = vi.fn((record: ConversationRecord) => record.kind === 'message' ? record.content : undefined);
    const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    measure.mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('tb-chat-viewport')) return rect(0, 300);
      const id = this.dataset.scrollKey;
      if (id?.startsWith('message-')) return rect(16 + Number(id.slice(8)) * 92 - scrollTop, 80);
      return rect(-scrollTop, 0);
    });
    const { runtime, box } = setup(Array.from({ length: count }, (_, i) => message(i)), renderMessage);
    readAt(box, 1000);
    const anchor = screen.getByText('Message 11').closest('article')!;
    const offset = anchor.getBoundingClientRect().top;
    const query = vi.spyOn(box, 'querySelectorAll');
    for (let i = 0; i < 4; i++) {
      for (const { patch, expectedRenderedRows } of [
        { patch: { status: i % 2 ? 'ready' as const : 'stale' as const },
          expectedRenderedRows: i >= 2 && i % 2 === 0 ? [`message-${count + i - 1}`] : [] },
        { patch: { sends: [] }, expectedRenderedRows: [] },
        { patch: { records: [...runtime.state.records, message(count + i)] },
          expectedRenderedRows: [`message-${count + i}`] },
      ]) {
        const rendersBeforeUpdate = renderMessage.mock.calls.length;
        measure.mockClear();
        act(() => runtime.publish(patch));
        // Binary search plus visible rows, not one measurement per loaded row.
        expect(measure.mock.calls.length).toBeLessThan(35);
        expect(query).not.toHaveBeenCalled();
        expect(anchor.getBoundingClientRect().top).toBe(offset);
        expect(renderMessage.mock.calls.slice(rendersBeforeUpdate).map(([record]) => record.id))
          .toEqual(expectedRenderedRows);
      }
    }
  });

  it('keeps the same visible row while content arrives below and exposes a latest-messages control', () => {
    const { runtime, box, input } = setup();
    readAt(box, 600);
    const anchor = screen.getByText('Message 7').closest('article')!;
    const offset = anchor.getBoundingClientRect().top;
    input.focus();
    fireEvent.change(input, { target: { value: 'Draft stays here' } });
    input.setSelectionRange(5, 5);
    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    expect(box.scrollTop).toBe(600);
    expect(anchor.getBoundingClientRect().top).toBe(offset);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();
    expect(input.value).toBe('Draft stays here');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(5);
  });

  it.each([0, 40])('smoothly follows new content when previously %i pixels from bottom', gap => {
    const { runtime, box } = setup();
    readAt(box, box.scrollHeight - box.clientHeight - gap);
    act(() => runtime.publish({ records: [...initialRows, message(20), message(21)] }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'smooth' });
    // Animation frames are not mistaken for the user leaving the bottom.
    box.scrollTop += 20;
    fireEvent.scroll(box);
    act(() => runtime.publish({ records: [...runtime.state.records, message(22)] }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'smooth' });
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('lets the reader interrupt following, then uses the button to return to the latest content', () => {
    const { runtime, box } = setup();
    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    readAt(box, 500);
    scrollTo.mockClear();
    act(() => runtime.publish({ records: [...runtime.state.records, message(21)] }));
    expect(box.scrollTop).toBe(500);
    expect(scrollTo).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Scroll to latest messages' });
    button.focus();
    fireEvent.click(button);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'smooth' });
    expect(document.activeElement).toBe(box);
    box.scrollTop = box.scrollHeight;
    fireEvent.scroll(box);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('keeps the latest message above the composer when the viewport shrinks after Latest messages', () => {
    const { box } = setup();
    readAt(box, 0);
    const button = screen.getByRole('button', { name: 'Scroll to latest messages' });
    fireEvent.click(button);
    const oldBottom = box.scrollHeight - box.clientHeight;

    // The smooth scroll reaches its old target as the iOS keyboard resizes the viewport.
    box.scrollTop = oldBottom;
    viewportHeight = 220;
    fireEvent.scroll(box);

    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('keeps following after a hand-scroll to the bottom when the viewport shrinks', () => {
    const { box } = setup();
    readAt(box, box.scrollHeight - box.clientHeight);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();

    viewportHeight = 220;
    fireEvent.scroll(box);

    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('keeps following through a viewport resize observed before scroll events', () => {
    const { box } = setup();
    readAt(box, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to latest messages' }));
    box.scrollTop = box.scrollHeight - box.clientHeight;
    fireEvent.scroll(box);

    viewportHeight = 220;
    notifyResizeObservers();

    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'instant' });
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('preserves an away reader position when the viewport resizes', () => {
    const { box } = setup();
    readAt(box, 600);

    viewportHeight = 220;
    notifyResizeObservers();

    expect(box.scrollTop).toBe(600);
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();
  });

  it('opens and reloads a ready conversation at the newest message', () => {
    const first = setup();
    expect(first.box.scrollTop).toBe(first.box.scrollHeight - first.box.clientHeight);
    readAt(first.box, 600);
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();

    cleanup();
    const { box } = setup();

    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('stays at the latest message when initial content grows before its scroll event arrives', () => {
    const runtime = new ReadingRuntime();
    runtime.state = { ...runtime.state, status: 'loading', records: [] };
    render(<TightbeamChat sessionKey="reading" adapter={{ open: () => runtime }} />);
    const box = screen.getByRole('log');

    scrollTo.mockClear();
    act(() => runtime.publish({ status: 'ready', records: initialRows }));
    const initialBottom = box.scrollHeight - box.clientHeight;
    expect(box.scrollTop).toBe(initialBottom);

    // A late layout change can land before the scroll event from the initial
    // instant scroll. That event must not be interpreted as a reader leaving the tail.
    lateLayoutGrowth = 1760;
    fireEvent.scroll(box);

    const settledBottom = box.scrollHeight - box.clientHeight;
    expect(scrollTo).toHaveBeenLastCalledWith({ top: settledBottom, behavior: 'instant' });
    expect(box.scrollTop).toBe(settledBottom);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('keeps following through cold-launch history loading and later layout growth', async () => {
    const runtime = new ReadingRuntime();
    runtime.state = { ...runtime.state, records: [message(20)], hasOlder: true };
    runtime.loadOlder = async () => {
      runtime.publish({ loadingOlder: true });
      await Promise.resolve();
      runtime.publish({
        records: [...Array.from({ length: 12 }, (_, i) => message(i)), ...runtime.state.records],
        hasOlder: false,
        loadingOlder: false,
      });
    };
    render(<TightbeamChat sessionKey="reading" adapter={{ open: () => runtime }} />);
    const box = screen.getByRole('log');
    const bottom = () => Math.max(0, box.scrollHeight - box.clientHeight);
    scrollTo.mockImplementation(function (this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
    });

    expect(box.scrollTop).toBe(bottom());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(box.scrollTop).toBe(bottom());

    lateLayoutGrowth = 960;
    notifyResizeObservers();

    expect(box.scrollTop).toBe(bottom());
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('preserves an away reader anchor through older history loading and layout growth', async () => {
    const runtime = new ReadingRuntime();
    runtime.state = { ...runtime.state, records: initialRows, hasOlder: true };
    let releaseOlder!: () => void;
    const olderPage = new Promise<void>(resolve => { releaseOlder = resolve; });
    runtime.loadOlder = async () => {
      runtime.publish({ loadingOlder: true });
      await olderPage;
      runtime.publish({
        records: [...Array.from({ length: 12 }, (_, i) => message(i - 12)), ...runtime.state.records],
        hasOlder: false,
        loadingOlder: false,
      });
    };
    render(<TightbeamChat sessionKey="reading" adapter={{ open: () => runtime }} />);
    const box = screen.getByRole('log');
    const anchor = screen.getByText('Message 1').closest('article')!;
    readAt(box, 0);
    const anchorTop = anchor.getBoundingClientRect().top;

    await act(async () => { releaseOlder(); await olderPage; });

    expect(anchor.getBoundingClientRect().top).toBe(anchorTop);
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();
    lateLayoutGrowth = 960;
    notifyResizeObservers();
    expect(anchor.getBoundingClientRect().top).toBe(anchorTop);
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();
  });

  it('returns to the newest message after a successful send but leaves a rejected draft alone', () => {
    const { runtime, box, input } = setup();
    readAt(box, 600);
    fireEvent.change(input, { target: { value: 'Send from an earlier message' } });
    runtime.send = vi.fn(() => 'client-send');

    fireEvent.submit(input.closest('form')!);

    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'smooth' });
    expect(input.value).toBe('');

    readAt(box, 600);
    fireEvent.change(input, { target: { value: 'Keep when send is rejected' } });
    runtime.send = vi.fn(() => null);
    scrollTo.mockClear();

    fireEvent.submit(input.closest('form')!);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(input.value).toBe('Keep when send is rejected');
  });

  it('preserves the reader across refresh notices and filtering that replaces row keys above them', () => {
    const { runtime, box, input } = setup();
    readAt(box, 950);
    const offset = screen.getByText('Message 11').closest('article')!.getBoundingClientRect().top;
    fireEvent.change(input, { target: { value: 'Unsent draft' } });
    act(() => runtime.publish({ status: 'stale' }));
    act(() => runtime.publish({ status: 'ready', records: initialRows.map((record, index) =>
      index < 5 ? { ...record, sender: 'agent:other', messageType: 'agent' } : record) }));
    expect(screen.getByText('Message 11').closest('article')!.getBoundingClientRect().top).toBe(offset);
    expect(input.value).toBe('Unsent draft');
    expect(runtime.state.records).toHaveLength(20);
  });

  it('preserves a surviving row when the original anchor disappears on an older-page refresh', () => {
    const { runtime, box } = setup();
    readAt(box, 20);
    const offset = screen.getByText('Message 1').closest('article')!.getBoundingClientRect().top;
    act(() => runtime.publish({ records: initialRows.slice(1) }));
    expect(screen.getByText('Message 1').closest('article')!.getBoundingClientRect().top).toBe(offset);
    expect(box.scrollTop).toBe(0);
  });

  it('respects reduced motion when explicitly returning to the bottom', () => {
    reducedMotion = true;
    const { runtime, box } = setup();
    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    expect(animate).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'instant' });
    readAt(box, 600);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to latest messages' }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'instant' });
  });
});
