import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TightbeamChat, type TightbeamChatProps } from '../src/TightbeamChat';
import { useReadingPosition } from '../src/useReadingPosition';
import { createTightbeamAdapter } from '../src/runtime';
import { createTurnProvenance } from '../src/provenance';
import { type ChangeCallbacks, type ChatTransport, type ConversationPage, type TargetProfile } from '../src/types';
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const message = (id: number): CanonicalMessage => ({ kind: 'message', id: `message-${id}`, sessionKey: 'reading',
  seq: id, rowVersion: 1, role: 'user', sender: 'user:person', content: `Message ${id}`, raw: {} });
const initialRows = Array.from({ length: 20 }, (_, i) => message(i));
function createReconnectFixture() {
  const profile: TargetProfile = { identity: 'fixture:arrival-recovery', label: 'Recovery', capabilities: {
    newestTail: true, stableOlderCursor: true, retainedHistoryAcrossResets: true,
    orderedTransitions: true, snapshotCoverage: true, versionedNotices: true,
    humanSendDedupe: true, authoritativeTurnProvenance: true,
  } };
  const catchUpStarted = deferred<void>();
  const catchUpResponse = deferred<ConversationPage>();
  const recoveryRows = Array.from({ length: 20 }, (_, index) => message(index + 1));
  let callbacks: ChangeCallbacks | undefined;
  let connectionCount = 0;
  const transport: ChatTransport = {
    currentIdentity: () => ({ principalKey: 'person', deviceId: 'browser' }),
    inspectTarget: async () => profile,
    openChanges: async (_key, nextCallbacks) => {
      connectionCount++;
      callbacks = nextCallbacks;
      return { close: () => { if (callbacks === nextCallbacks) callbacks = undefined; } };
    },
    readSession: async (sessionKey) => ({ sessionKey, rowVersion: 1, displayName: 'Assistant', raw: {} }),
    readTail: async () => ({ records: recoveryRows, oldestCursor: recoveryRows[0].id,
      newestCursor: 'after:20', hasOlder: false, hasNewer: false, coverage: 'reading' }),
    readAfter: async (_key, after) => {
      expect(after).toBe('after:20');
      catchUpStarted.resolve();
      return catchUpResponse.promise;
    },
    readOlder: async (sessionKey) => ({ records: [], oldestCursor: null, hasOlder: false, coverage: sessionKey }),
    proveCoverage: () => true,
    sendHuman: async () => ({ outcome: 'accepted' }),
  };
  const runtime = createTightbeamAdapter(transport, profile).open('reading');
  return {
    runtime, catchUpStarted, catchUpResponse, recoveryRows,
    get callbacks() { return callbacks; },
    get connectionCount() { return connectionCount; },
  };
}
let scrollTop = 0;
let clampScrollTopOnRead = false;
let viewportHeight = 300;
let lateLayoutGrowth = 0;
let scrollTo: ReturnType<typeof vi.fn>;
let reducedMotion = false;
let animate: ReturnType<typeof vi.fn>;
let modelActiveCaptionSlot = false;
const resizeCallbacks = new Set<ResizeObserverCallback>();
const resizeTargets = new Map<ResizeObserverCallback, Set<Element>>();
const animationFrames = new Map<number, { callback: FrameRequestCallback; timer: ReturnType<typeof setTimeout> }>();
let nextAnimationFrameId = 0;
const rows = () => [...document.querySelectorAll<HTMLElement>('article[data-record-key]')];
const styleSource = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf8');
const hasStableActiveCaptionSlot =
  /\.tb-chat-message-content\s*\{[^}]*--tb-chat-active-caption-height:\s*1\.1rem;[^}]*padding-block-end:\s*calc\(var\(--tb-chat-active-caption-height\)\s*\+\s*\.8rem\);/s.test(styleSource) &&
  /\.tb-chat-active-caption\s*\{[^}]*position:\s*absolute;[^}]*height:\s*var\(--tb-chat-active-caption-height\);/s.test(styleSource);
const keyboardInset = () => Number.parseFloat(document.querySelector<HTMLElement>('.tb-chat')?.style.getPropertyValue('--tb-chat-keyboard-inset') || '0') || 0;
const followsKeyboardInset = styleSource.includes('max-height: calc(100% - var(--tb-chat-keyboard-inset, 0px));');
let keyboardViewportSimulation = false;
const renderedViewportHeight = () => {
  return Math.max(0, viewportHeight - (keyboardViewportSimulation && followsKeyboardInset ? keyboardInset() : 0));
};
const scrollHeight = () => 32 + rows().length * 92 + lateLayoutGrowth + Number.parseFloat(document.querySelector<HTMLElement>('.tb-chat-viewport')?.style.getPropertyValue('--tb-chat-anchor-space') || '0') +
  (modelActiveCaptionSlot && (hasStableActiveCaptionSlot || document.querySelector('.tb-chat-active-caption')) ? 26 : 0);
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 400, width: 400, height, x: 0, y: top, toJSON() {} });
class TestVisualViewport extends EventTarget {
  offsetTop = 0;
  constructor(public height: number) { super(); }
  resizeTo(height: number) {
    this.height = height;
    this.dispatchEvent(new Event('resize'));
  }
}
let restoreVisualViewport: (() => void) | undefined;
function installVisualViewport(height: number) {
  const previous = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const visualViewport = new TestVisualViewport(height);
  keyboardViewportSimulation = true;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: visualViewport });
  restoreVisualViewport = () => {
    if (previous) Object.defineProperty(window, 'visualViewport', previous);
    else Reflect.deleteProperty(window, 'visualViewport');
    keyboardViewportSimulation = false;
    restoreVisualViewport = undefined;
  };
  return visualViewport;
}
beforeEach(() => {
  scrollTop = 0;
  clampScrollTopOnRead = false;
  viewportHeight = 300;
  lateLayoutGrowth = 0;
  reducedMotion = false;
  modelActiveCaptionSlot = false;
  animationFrames.clear();
  nextAnimationFrameId = 0;
  animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {
      resizeCallbacks.add(callback);
      resizeTargets.set(callback, new Set());
    }
    observe(target: Element) { resizeTargets.get(this.callback)?.add(target); }
    disconnect() { resizeCallbacks.delete(this.callback); resizeTargets.delete(this.callback); }
    unobserve() {}
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const readScrollTop = () => {
      if (clampScrollTopOnRead) scrollTop = Math.max(0, Math.min(scrollTop, scrollHeight() - renderedViewportHeight()));
      return scrollTop;
    };
    if (this.classList.contains('tb-chat')) return rect(0, keyboardViewportSimulation ? viewportHeight : 50);
    if (this.classList.contains('tb-chat-viewport')) return rect(0, renderedViewportHeight());
    const index = this.dataset.testPosition === undefined ? rows().indexOf(this) : Number(this.dataset.testPosition);
    if (index >= 0) return rect(16 + Number.parseFloat(document.querySelector<HTMLElement>('.tb-chat-viewport')?.style.getPropertyValue('--tb-chat-anchor-space') || '0') + index * 92 - readScrollTop(), 80);
    return rect(0, 50);
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('tb-chat-viewport') ? scrollHeight() : 40;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('tb-chat-viewport')) return renderedViewportHeight();
    return this.classList.contains('tb-chat') && keyboardViewportSimulation ? viewportHeight : 300;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => {
    if (clampScrollTopOnRead) scrollTop = Math.max(0, Math.min(scrollTop, scrollHeight() - renderedViewportHeight()));
    return scrollTop;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(value => { scrollTop = Math.max(0, Math.min(value, scrollHeight() - renderedViewportHeight())); });
  scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    // Keep smooth motion pending so intermediate scroll frames can be exercised.
    if (options.behavior !== 'smooth') this.scrollTop = options.top ?? 0;
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextAnimationFrameId;
    const timer = setTimeout(() => {
      if (!animationFrames.delete(id)) return;
      callback(performance.now());
    }, 0);
    animationFrames.set(id, { callback, timer });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    const frame = animationFrames.get(id);
    if (!frame) return;
    clearTimeout(frame.timer);
    animationFrames.delete(id);
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  for (const frame of animationFrames.values()) clearTimeout(frame.timer);
  animationFrames.clear();
  restoreVisualViewport?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resizeCallbacks.clear();
  resizeTargets.clear();
});

function advanceNextFrame(at: number) {
  const first = animationFrames.entries().next().value as [number, { callback: FrameRequestCallback; timer: ReturnType<typeof setTimeout> }] | undefined;
  if (!first) throw new Error('No animation frame is pending.');
  clearTimeout(first[1].timer);
  animationFrames.delete(first[0]);
  act(() => first[1].callback(at));
}

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
  fireEvent(box, new Event('scrollend'));
}
function targetForPreview(): HTMLElement | null {
  const targetId = screen.getByRole('button', { name: 'Jump to user prompt' }).getAttribute('aria-controls');
  return targetId ? document.getElementById(targetId) : null;
}
function notifyResizeObservers() {
  act(() => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });
}
function notifyResizeObserver(target: Element) {
  act(() => {
    for (const callback of resizeCallbacks) {
      if (resizeTargets.get(callback)?.has(target)) callback([], {} as ResizeObserver);
    }
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

  it('glides to the exact latest bottom once for a burst of appended rows', () => {
    const { runtime, box } = setup();
    const startingBottom = box.scrollHeight - box.clientHeight;
    scrollTo.mockClear();

    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    const firstRow = screen.getByText('Message 20').closest('article');
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(firstRow);
    expect(animate).toHaveBeenCalledWith([
      { opacity: 0, transform: 'translateY(18px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    expect(box.scrollTop).toBe(startingBottom);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(animationFrames.size).toBe(1);

    act(() => runtime.publish({ records: [...runtime.state.records, message(21)] }));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animationFrames.size).toBe(1);

    advanceNextFrame(performance.now() + 300);

    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
    expect(animationFrames.size).toBe(0);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('keeps a following reader still for real reconnect catch-up, then animates the next live row', async () => {
    const fixture = createReconnectFixture();
    const { runtime, catchUpStarted, catchUpResponse, recoveryRows } = fixture;
    render(<TightbeamChat sessionKey="reading" adapter={{ open: () => runtime }} />);

    try {
      await screen.findByText('Message 19');
      await waitFor(() => expect(fixture.callbacks).toBeDefined());
      const box = screen.getByRole('log');
      expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
      expect(animate).not.toHaveBeenCalled();
      scrollTo.mockClear();

      const lostConnection = fixture.callbacks!;
      act(() => lostConnection.onDoubt('The live feed lost coverage.'));
      let rebuilding!: Promise<void>;
      act(() => { rebuilding = runtime.rebuild(); });
      await catchUpStarted.promise;
      expect(fixture.connectionCount).toBe(2);
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(runtime.getSnapshot().records).toHaveLength(recoveryRows.length);

      await act(async () => {
        catchUpResponse.resolve({ records: [message(21)], oldestCursor: 'message-21',
          newestCursor: 'after:21', hasOlder: false, hasNewer: false, coverage: 'reading' });
        await rebuilding;
      });

      expect(box.querySelector('[data-record-key="message-21"]')).toBeTruthy();
      expect(animate).not.toHaveBeenCalled();
      expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'instant' });
      expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);

      const liveCallbacks = fixture.callbacks!;
      vi.spyOn(performance, 'now').mockReturnValue(1000);
      act(() => liveCallbacks.onNotice({ operation: 'upsert', record: message(22) }));
      expect(animate).toHaveBeenCalledTimes(1);
      expect(animate.mock.contexts[0]).toBe(screen.getByText('Message 22').closest('article'));
      advanceNextFrame(1300);
      expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
    } finally {
      runtime.dispose();
    }
  });

  it('keeps a scrolled-up reader anchored through real reconnect catch-up', async () => {
    const fixture = createReconnectFixture();
    const { runtime, catchUpStarted, catchUpResponse, recoveryRows } = fixture;
    render(<TightbeamChat sessionKey="reading" adapter={{ open: () => runtime }} />);

    try {
      await screen.findByText('Message 19');
      await waitFor(() => expect(fixture.callbacks).toBeDefined());
      const box = screen.getByRole('log');
      expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
      readAt(box, 460);
      const chosenPosition = box.scrollTop;
      expect(chosenPosition).toBe(460);
      expect(animate).not.toHaveBeenCalled();
      scrollTo.mockClear();

      const lostConnection = fixture.callbacks!;
      act(() => lostConnection.onDoubt('The live feed lost coverage.'));
      let rebuilding!: Promise<void>;
      act(() => { rebuilding = runtime.rebuild(); });
      await catchUpStarted.promise;
      expect(fixture.connectionCount).toBe(2);
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(runtime.getSnapshot().records).toHaveLength(recoveryRows.length);

      await act(async () => {
        catchUpResponse.resolve({ records: [message(21)], oldestCursor: 'message-21',
          newestCursor: 'after:21', hasOlder: false, hasNewer: false, coverage: 'reading' });
        await rebuilding;
      });

      expect(box.querySelector('[data-record-key="message-21"]')).toBeTruthy();
      expect(animate).not.toHaveBeenCalled();
      expect(animationFrames.size).toBe(0);
      expect(scrollTo).not.toHaveBeenCalled();
      expect(box.scrollTop).toBe(chosenPosition);
    } finally {
      runtime.dispose();
    }
  });

  it('lets reader scrolling cancel an arrival and preserve the chosen place', () => {
    const { runtime, box } = setup();
    const startingBottom = box.scrollHeight - box.clientHeight;
    const startedAt = 1000;
    vi.spyOn(performance, 'now').mockReturnValue(startedAt);
    scrollTo.mockClear();

    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    advanceNextFrame(startedAt + 80);
    const movingPosition = box.scrollTop;
    expect(movingPosition).toBeGreaterThan(startingBottom);
    expect(movingPosition).toBeLessThan(box.scrollHeight - box.clientHeight);

    fireEvent.wheel(box, { deltaY: -40 });
    const chosenPosition = Math.max(0, box.scrollTop - 40);
    box.scrollTop = chosenPosition;
    fireEvent.scroll(box);
    expect(animate.mock.results[0].value.cancel).toHaveBeenCalledTimes(1);
    expect(animationFrames.size).toBe(0);

    act(() => runtime.publish({ records: [...runtime.state.records, message(21)] }));

    expect(box.scrollTop).toBe(chosenPosition);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('animates an own message while following and a new activity fold, but leaves a growing fold in place', () => {
    const own = setup();
    const startedAt = 1000;
    const clock = vi.spyOn(performance, 'now').mockReturnValue(startedAt);
    const send = { sessionKey: 'reading', clientMessageId: 'c_arrival', deviceId: 'browser', content: 'My new message',
      status: 'accepted' as const, submittedAt: '2026-10-23T00:00:00Z', reconciled: false,
      hostSend: { lifetimeId: 'host-bridge', attempt: 1 } };
    const ownStartingBottom = own.box.scrollHeight - own.box.clientHeight;
    act(() => own.runtime.publish({ sends: [send] }));
    const ownRow = document.querySelector('[data-scroll-key="local-c_arrival"]');
    expect(ownRow).toBeTruthy();
    expect(animate.mock.contexts[0]).toBe(ownRow);
    expect(own.box.scrollTop).toBe(ownStartingBottom);
    clock.mockReturnValue(startedAt + 44.5);
    act(() => own.runtime.publish({ records: [...initialRows, { ...message(20), content: send.content,
      deviceId: send.deviceId, clientMessageId: send.clientMessageId }] }));
    const canonicalRow = document.querySelector('[data-scroll-key="local-c_arrival"]');
    expect(canonicalRow).toBeTruthy();
    expect(canonicalRow).not.toBe(ownRow);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.contexts[1]).toBe(canonicalRow);
    expect(animate.mock.results[0].value.cancel).toHaveBeenCalledTimes(1);
    expect(animate.mock.results[1].value.currentTime).toBe(44.5);
    advanceNextFrame(startedAt + 300);
    expect(own.box.scrollTop).toBe(own.box.scrollHeight - own.box.clientHeight);
    clock.mockRestore();
    cleanup();
    animate.mockClear();

    const activity = setup();
    const activeOwnerTurn = createTurnProvenance({
      seq: 20, sessionKey: 'reading', messageId: initialRows.at(-1)!.id, origin: 'user:person',
      status: 'running', triggerSource: 'mike', raw: { seq: 20, origin: 'user:person' },
    }, [initialRows.at(-1)!], 'person', 'person');
    const first = { ...message(20), id: 'activity-1', sender: 'process:events', messageType: 'substrate',
      content: 'Quiet for 3 h · Assignment Alpha' };
    const second = { ...message(21), id: 'activity-2', sender: 'process:events', messageType: 'substrate',
      content: 'Quiet for 4 h · Assignment Beta' };
    act(() => activity.runtime.publish({ activityTurnStateAvailable: true, activeTurn: activeOwnerTurn,
      records: [...initialRows, first, second] }));
    const fold = document.querySelector('[data-activity-fold="true"]');
    expect(fold).toBeTruthy();
    expect(animate.mock.contexts.at(-1)).toBe(fold);
    expect(animate).toHaveBeenCalledTimes(2);

    const third = { ...message(22), id: 'activity-3', sender: 'process:events', messageType: 'substrate',
      content: 'Quiet for 5 h · Assignment Gamma' };
    act(() => activity.runtime.publish({ records: [...initialRows, first, second, third] }));
    expect(document.querySelector<HTMLElement>('[data-activity-fold="true"]')?.dataset.scrollKey)
      .toBe((fold as HTMLElement).dataset.scrollKey);
    expect(animate).toHaveBeenCalledTimes(2);
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
    expect(scrollTo).not.toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit short-range upward scroll away through a reconnect publication', () => {
    viewportHeight = 250;
    const { runtime, box } = setup(initialRows.slice(0, 3));
    expect(box.scrollHeight - box.clientHeight).toBe(58);

    readAt(box, 0);

    expect(box.scrollTop).toBe(0);
    scrollTo.mockClear();
    act(() => runtime.publish({ liveError: 'Firehose disconnected (close code 1002).', liveConnectionState: 'connected' }));
    expect(box.scrollTop).toBe(0);
    act(() => runtime.publish({ liveError: undefined, liveConnectionState: 'connected' }));

    expect(box.scrollTop).toBe(0);
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('keeps a short-range keyboard page-up away after its smooth target completes', () => {
    viewportHeight = 250;
    const { runtime, box } = setup(initialRows.slice(0, 3));
    expect(box.scrollHeight - box.clientHeight).toBe(58);

    fireEvent.keyDown(box, { key: 'k', ctrlKey: true });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
    box.scrollTop = 0;
    fireEvent.scroll(box);
    scrollTo.mockClear();

    act(() => runtime.publish({ liveError: 'Firehose disconnected (close code 1002).', liveConnectionState: 'connected' }));

    expect(box.scrollTop).toBe(0);
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
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

  it('keeps an away reader still without entrance motion for appended rows, history, refresh, and Sent rows', () => {
    const { runtime, box } = setup();
    expect(animate).not.toHaveBeenCalled();
    readAt(box, 600);
    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    expect(animate).not.toHaveBeenCalled();
    expect(box.scrollTop).toBe(600);
    expect(scrollTo).not.toHaveBeenCalled();
    act(() => runtime.publish({ records: [message(-1), ...runtime.state.records] }));
    act(() => runtime.publish({ records: runtime.state.records.map(row => ({ ...row, rowVersion: 2 })) }));
    expect(animate).not.toHaveBeenCalled();
    act(() => runtime.publish({ status: 'stale', generation: 2 }));
    act(() => runtime.publish({ status: 'ready', records: [...runtime.state.records, message(21)] }));
    expect(animate).not.toHaveBeenCalled();
    const send = { sessionKey: 'reading', clientMessageId: 'c_sent', deviceId: 'browser', content: 'A sent message',
      status: 'accepted' as const, submittedAt: '2026-10-23T00:00:00Z', reconciled: false };
    act(() => runtime.publish({ sends: [send] }));
    act(() => runtime.publish({ records: [...runtime.state.records, { ...message(22),
      content: send.content, deviceId: send.deviceId, clientMessageId: send.clientMessageId }] }));
    expect(animate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-scroll-key="local-c_sent"]')).toBeTruthy();
    act(() => runtime.publish({ records: [...runtime.state.records, message(23)] }));
    expect(animate).not.toHaveBeenCalled();
  });

  it('animates only canonical human members of a new batch while keeping the latest content in the same frame', () => {
    const { runtime, box } = setup();
    readAt(box, box.scrollHeight - box.clientHeight - 40);
    scrollTo.mockClear();
    const carrier = { ...message(20), isBatchCarrier: true, sender: 'process:notifications', messageType: 'substrate', content: [
      '[batched notices: 2]', '', '[430] source=human sender=user:person cause=notice class=fyi',
      'A new human message', '', '[431] source=other sender=agent:helper session-key cause=notice class=fyi',
      'Nonhuman notice', '', 'coalesced by batch-format (2 notices)',
    ].join('\n') };
    act(() => runtime.publish({ records: [...initialRows, carrier, { ...message(21), content: 'A new human message' }] }));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate.mock.contexts[0]).toBe(box.querySelector('[data-record-key="message-21"]'));
    expect(screen.queryByText('Nonhuman notice')).toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();
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
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(screen.getByText('Message 7')).toBeTruthy();
      offline = false;
      records = [...initialRows, message(20)];
      historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
      visibility = 'visible';
      await act(async () => { fireEvent(document, new Event('visibilitychange')); });
      expect(connect).toHaveBeenCalledTimes(2);
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(screen.queryByText('Message 20')).toBeNull();
      const reconnect = runtime.rebuild();
      await waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
      expect(runtime.getSnapshot().status).toBe('ready');
      await act(async () => { releaseHistory(); await reconnect; });
      expect(runtime.getSnapshot().status).toBe('ready');
      expect(box.querySelector('[data-record-key="message-20"]')).toBeTruthy();
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
      return <div ref={reading.viewport} className="tb-chat-viewport" onScroll={reading.onScroll}
        onWheel={event => { if (event.deltaY !== 0) reading.noteUserScroll(); }}>
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
      fireEvent.wheel(box, { deltaY: 30 });
      box.scrollTop = 90000 + i * 30;
      fireEvent.scroll(box);
      fireEvent(box, new Event('scrollend'));
    }
    expect(measure.mock.calls.length).toBeLessThan(30 * 25);
    expect(query).not.toHaveBeenCalled();
    const anchor = box.querySelector<HTMLElement>('[data-record-key="988"]')!;
    const offset = anchor.getBoundingClientRect().top;
    view.rerender(<History ids={[-2, -1, ...ids]} />);
    expect(anchor.getBoundingClientRect().top).toBe(offset);
  });

  it('applies an older-page layout shift to the reader current scroll position', () => {
    function History({ ids }: { ids: number[] }) {
      const reading = useReadingPosition(true, ids);
      return <div ref={reading.viewport} className="tb-chat-viewport" onScroll={reading.onScroll}
        onWheel={event => { if (event.deltaY !== 0) reading.noteUserScroll(); }}>
        <div ref={reading.content}>{ids.map((id, index) =>
          <article ref={element => reading.registerRow(String(id), element)} key={id} data-record-key={id}
            data-scroll-key={id} data-test-position={index}>{id}</article>)}</div>
      </div>;
    }
    const ids = Array.from({ length: 2000 }, (_, i) => i);
    const view = render(<History ids={ids} />);
    const box = document.querySelector<HTMLElement>('.tb-chat-viewport')!;
    readAt(box, 900);
    const anchor = box.querySelector<HTMLElement>('[data-record-key="10"]')!;
    const previousTop = box.scrollTop;

    // Native scrolling can update scrollTop before its scroll handler runs.
    box.scrollTop = previousTop + 60;
    const readerPosition = anchor.getBoundingClientRect().top;
    view.rerender(<History ids={[-2, -1, ...ids]} />);

    expect(anchor.getBoundingClientRect().top).toBe(readerPosition);
    expect(box.scrollTop).toBe(previousTop + 60 + 2 * 92);
  });

  it('does not treat browser clamping after rows shrink as reader movement', () => {
    const { runtime, box } = setup();
    readAt(box, 1400);
    fireEvent(box, new Event('scrollend'));
    const previousTop = box.scrollTop;
    const anchor = screen.getByText('Message 15').closest<HTMLElement>('[data-scroll-key]')!;
    const viewportTop = box.getBoundingClientRect().top;
    const anchorOffset = anchor.getBoundingClientRect().top - viewportTop;

    // Removing rows above the reader reduces the maximum scroll position.
    // Model the browser clamp before React's layout effect can restore the row.
    clampScrollTopOnRead = true;
    act(() => runtime.publish({ records: runtime.state.records.filter((_, index) => index >= 5) }));
    clampScrollTopOnRead = false;

    expect(anchor.getBoundingClientRect().top - viewportTop).toBe(anchorOffset);
    expect(box.scrollTop).toBe(previousTop - 5 * 92);
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
          expectedRenderedRows: [] },
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

  it.each([0, 40])('keeps the latest content in the same frame when previously %i pixels from bottom', gap => {
    const { runtime, box } = setup();
    readAt(box, box.scrollHeight - box.clientHeight - gap);
    const startingBottom = box.scrollHeight - box.clientHeight;
    scrollTo.mockClear();
    act(() => runtime.publish({ records: [...initialRows, message(20), message(21)] }));
    expect(animate).toHaveBeenCalledTimes(2);
    expect(box.scrollTop).toBe(startingBottom - gap);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(animationFrames.size).toBe(1);
    act(() => runtime.publish({ records: [...runtime.state.records, message(22)] }));
    expect(animate).toHaveBeenCalledTimes(3);
    expect(animationFrames.size).toBe(1);
    advanceNextFrame(performance.now() + 300);
    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('keeps the newest bubble still while the active-activity caption appears and clears', () => {
    modelActiveCaptionSlot = true;
    const { runtime, box } = setup();
    const newest = rows().at(-1)!;
    const originalTop = newest.getBoundingClientRect().top;
    const activeTurn = createTurnProvenance({
      seq: 21, sessionKey: 'reading', messageId: 'activity-trigger', origin: 'agent:other',
      status: 'running', triggerSource: 'agent', raw: { seq: 21, origin: 'agent:other' },
    }, [], 'person', 'person');

    act(() => runtime.publish({ provenanceAvailable: true, activityTurnStateAvailable: true, activeTurn }));
    expect(screen.getByRole('status', { name: 'Active turn: Other activity' })).toBeTruthy();
    expect(newest.getBoundingClientRect().top).toBe(originalTop);

    act(() => runtime.publish({ activeTurn: undefined }));
    expect(screen.queryByRole('status', { name: 'Active turn: Other activity' })).toBeNull();
    expect(newest.getBoundingClientRect().top).toBe(originalTop);
    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
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

  it('tracks the visible viewport through keyboard motion while following the latest message', () => {
    const visualViewport = installVisualViewport(300);
    const { box } = setup();
    expect(styleSource).toContain('max-height: calc(100% - var(--tb-chat-keyboard-inset, 0px));');
    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);

    for (const height of [270, 240, 210, 180]) {
      act(() => visualViewport.resizeTo(height));
      notifyResizeObservers();

      expect(box.clientHeight).toBe(height);
      expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'instant' });
      expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
    }

    act(() => visualViewport.resizeTo(300));
    notifyResizeObservers();
    expect(box.clientHeight).toBe(300);
    expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('keeps the latest message aligned in the frame that applies a keyboard inset', () => {
    viewportHeight = 874;
    const visualViewport = installVisualViewport(874);
    const { box } = setup();
    const oldBottom = box.scrollHeight - box.clientHeight;

    act(() => visualViewport.resizeTo(529));

    const newBottom = box.scrollHeight - box.clientHeight;
    expect(box.clientHeight).toBe(529);
    expect(newBottom - oldBottom).toBe(345);
    expect(box.scrollTop).toBe(newBottom);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('keeps the latest message aligned in the frame the Chat container resizes', () => {
    viewportHeight = 874;
    installVisualViewport(874);
    const { box } = setup();
    const root = box.closest<HTMLElement>('.tb-chat')!;
    const oldBottom = box.scrollHeight - box.clientHeight;

    // Model the host reducing the available view by 345 px, before the
    // transcript's own ResizeObserver is delivered.
    viewportHeight = 529;
    notifyResizeObserver(root);

    const newBottom = box.scrollHeight - box.clientHeight;
    expect(box.clientHeight).toBe(529);
    expect(newBottom - oldBottom).toBe(345);
    expect(box.scrollTop).toBe(newBottom);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('preserves an away reader in the frame the Chat container resizes', () => {
    viewportHeight = 874;
    installVisualViewport(874);
    const { box } = setup();
    const root = box.closest<HTMLElement>('.tb-chat')!;
    readAt(box, 700);
    const anchor = screen.getByText('Message 8').closest('article')!;
    const scrollTopBefore = box.scrollTop;
    const anchorTopBefore = anchor.getBoundingClientRect().top;

    viewportHeight = 529;
    notifyResizeObserver(root);

    expect(box.scrollTop).toBe(scrollTopBefore);
    expect(anchor.getBoundingClientRect().top).toBe(anchorTopBefore);
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();
  });

  it('keeps an away reader anchored while the keyboard moves the visible viewport', () => {
    const visualViewport = installVisualViewport(300);
    const { box } = setup();
    readAt(box, 700);
    const anchor = screen.getByText('Message 8').closest('article')!;
    const before = anchor.getBoundingClientRect().top;

    for (const height of [260, 220, 180]) {
      act(() => visualViewport.resizeTo(height));
      expect(anchor.getBoundingClientRect().top).toBe(before);
      notifyResizeObservers();

      expect(box.clientHeight).toBe(height);
      expect(anchor.getBoundingClientRect().top).toBe(before);
      expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();
    }
  });

  it('keeps following through a delayed inset scroll adjustment without reader input', async () => {
    viewportHeight = 874;
    vi.useFakeTimers();
    const { box } = setup();
    const oldBottom = box.scrollHeight - box.clientHeight;
    fireEvent.scroll(box);
    expect(box.scrollTop).toBe(oldBottom);

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    // A late host inset reduces the viewport by 479 px. Chat sees the resize
    // and moves to the new bottom, then WebKit restores the prior scroll offset.
    viewportHeight = 395;
    notifyResizeObservers();
    const insetBottom = box.scrollHeight - box.clientHeight;
    expect(box.scrollTop).toBe(insetBottom);
    box.scrollTop = oldBottom;
    fireEvent.scroll(box);

    expect(box.scrollTop).toBe(insetBottom);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();
  });

  it('keeps a short touch flick away from latest through post-lift momentum', () => {
    const { box } = setup();
    const bottom = box.scrollHeight - box.clientHeight;

    fireEvent.touchStart(box);
    fireEvent.touchMove(box);
    box.scrollTop = bottom - 40;
    fireEvent.scroll(box);
    expect(screen.queryByRole('button', { name: 'Scroll to latest messages' })).toBeNull();

    fireEvent.touchEnd(box);
    box.scrollTop = bottom - 160;
    fireEvent.scroll(box);

    expect(box.scrollTop).toBe(bottom - 160);
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();

    fireEvent(box, new Event('scrollend'));
  });

  it('preserves a reader scroll without a matching layout-restoration offset', () => {
    const { box } = setup();
    const bottom = box.scrollHeight - box.clientHeight;

    // Let the initial instant scroll settle, then model a browser, assistive
    // technology, find-in-page, or scrollbar move that has no input event.
    fireEvent.scroll(box);
    box.scrollTop = bottom - 180;
    fireEvent.scroll(box);

    expect(box.scrollTop).toBe(bottom - 180);
    expect(screen.getByRole('button', { name: 'Scroll to latest messages' })).toBeTruthy();
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

  it('keeps initial bottom-follow when an unsolicited scroll restoration races automatic history prefetch', async () => {
    const runtime = new ReadingRuntime();
    runtime.state = { ...runtime.state, records: Array.from({ length: 6 }, (_, i) => message(i + 20)), hasOlder: true };
    runtime.loadOlder = async () => {
      runtime.publish({ loadingOlder: true });
      await Promise.resolve();
      runtime.publish({
        records: [...Array.from({ length: 12 }, (_, i) => message(i)), ...runtime.state.records],
        hasOlder: false,
        loadingOlder: false,
      });
    };
    scrollTo.mockImplementation(function (this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
    });
    render(<TightbeamChat sessionKey="reading" adapter={{ open: () => runtime }} />);
    const box = screen.getByRole('log');
    const bottom = () => Math.max(0, box.scrollHeight - box.clientHeight);

    expect(box.scrollTop).toBe(bottom());
    scrollTo.mockClear();
    // WebKit may apply its initial scroll restoration without a reader gesture.
    // The automatic first history prefetch must not turn that into an away reading position.
    box.scrollTop = 0;
    fireEvent.scroll(box);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });

    expect(box.scrollTop).toBe(bottom());
    expect(scrollTo.mock.calls.length).toBeGreaterThan(0);
    expect(scrollTo.mock.calls.every(([options]) => options.behavior === 'instant')).toBe(true);
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

  it('returns to the newest message after submission, clears on acceptance, and leaves a rejected draft alone', () => {
    const { runtime, box, input } = setup();
    readAt(box, 600);
    fireEvent.change(input, { target: { value: 'Send from an earlier message' } });
    runtime.send = vi.fn(() => 'client-send');

    fireEvent.submit(input.closest('form')!);

    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'smooth' });
    expect(input.value).toBe('Send from an earlier message');
    act(() => runtime.publish({ sends: [{
      sessionKey: 'reading', deviceId: 'device', clientMessageId: 'client-send',
      content: 'Send from an earlier message', submittedAt: new Date().toISOString(),
      status: 'accepted', reconciled: false,
    }] }));
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

  it('uses instant placement without row animation for reduced-motion arrivals', () => {
    reducedMotion = true;
    const { runtime, box } = setup();
    act(() => runtime.publish({ records: [...initialRows, message(20)] }));
    expect(animate).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'instant' });
    readAt(box, 600);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to latest messages' }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: box.scrollHeight - box.clientHeight, behavior: 'instant' });
  });

  it('tracks the nearest owner prompt above the visible transcript in both directions without moving the reader', () => {
    const { box } = setup();
    readAt(box, 0);
    expect(screen.queryByRole('button', { name: 'Jump to user prompt' })).toBeNull();

    box.scrollTop = 600;
    const anchor = rows()[3];
    const originalOffset = anchor.getBoundingClientRect().top;
    fireEvent.scroll(box);
    expect(screen.getByRole('button', { name: 'Jump to user prompt' }).textContent).toBe('Message 5');
    expect(targetForPreview()?.dataset.recordKey).toBe('message-5');
    expect(targetForPreview()!.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.getBoundingClientRect().top);
    expect(box.scrollTop).toBe(600);
    expect(anchor.getBoundingClientRect().top).toBe(originalOffset);

    box.scrollTop = 950;
    fireEvent.scroll(box);
    expect(screen.getByRole('button', { name: 'Jump to user prompt' }).textContent).toBe('Message 9');
    expect(targetForPreview()?.dataset.recordKey).toBe('message-9');

    box.scrollTop = 300;
    fireEvent.scroll(box);
    expect(screen.getByRole('button', { name: 'Jump to user prompt' }).textContent).toBe('Message 2');
    expect(targetForPreview()?.dataset.recordKey).toBe('message-2');

    readAt(box, 0);
    expect(screen.queryByRole('button', { name: 'Jump to user prompt' })).toBeNull();
  });

  it('keeps the floating prompt below the system inset and in-chat status on orientation changes', () => {
    const { runtime, box } = setup();
    readAt(box, 600);
    const chat = box.closest<HTMLElement>('.tb-chat')!;
    const anchor = rows()[3];
    const anchorTop = anchor.getBoundingClientRect().top;
    chat.style.setProperty('--tb-chat-safe-area-top', '42px');

    fireEvent(window, new Event('orientationchange'));
    expect(chat.style.getPropertyValue('--tb-chat-floating-prompt-top')).toBe('52px');

    act(() => runtime.publish({ loadingOlder: true }));
    expect(chat.querySelector('.tb-chat-runtime-notice')).not.toBeNull();
    expect(chat.style.getPropertyValue('--tb-chat-floating-prompt-top')).toBe('58px');
    expect(anchor.getBoundingClientRect().top).toBe(anchorTop);
    expect(box.scrollTop).toBe(600);
    expect(screen.getByRole('button', { name: 'Jump to user prompt' }).textContent).toBe('Message 5');
  });

  it('updates the sticky prompt from registered rows without querying the transcript on scroll', () => {
    const { box } = setup();
    readAt(box, 0);
    const chat = box.closest<HTMLElement>('.tb-chat')!;
    const viewportQuery = vi.spyOn(box, 'querySelector');
    const chatQuery = vi.spyOn(chat, 'querySelector');

    box.scrollTop = box.scrollHeight - box.clientHeight;
    fireEvent.scroll(box);

    expect(viewportQuery).not.toHaveBeenCalled();
    expect(chatQuery).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Jump to user prompt' }).textContent).toBe('Message 16');
  });

  it('waits for measurable bounds before showing the prompt miniature', () => {
    let layoutAvailable = false;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!layoutAvailable) return rect(0, 0);
      if (this.classList.contains('tb-chat')) return rect(0, 50);
      if (this.classList.contains('tb-chat-viewport')) return rect(0, renderedViewportHeight());
      const index = rows().indexOf(this);
      if (index >= 0) return rect(16 + index * 92 - scrollTop, 80);
      return rect(0, 50);
    });
    const { box } = setup();

    expect(screen.queryByRole('button', { name: 'Jump to user prompt' })).toBeNull();

    layoutAvailable = true;
    readAt(box, 600);
    expect(screen.getByRole('button', { name: 'Jump to user prompt' }).textContent).toBe('Message 5');
    const target = targetForPreview()!;
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.getBoundingClientRect().top);

    box.scrollTop = 1724;
    fireEvent.scroll(box);
    expect(screen.getByRole('button', { name: 'Jump to user prompt' }).textContent).toBe('Message 16');
    expect(targetForPreview()?.dataset.recordKey).toBe('message-16');
    expect(targetForPreview()!.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.getBoundingClientRect().top);
  });

  it('keeps a dismissed preview hidden while selection changes and restores it only after a new submission', () => {
    const { runtime, box } = setup();
    readAt(box, 600);
    expect(targetForPreview()?.dataset.recordKey).toBe('message-5');
    scrollTo.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss user prompt preview' }));

    expect(box.scrollTop).toBe(600);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(box.querySelector('[data-record-key="message-5"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Jump to user prompt' })).toBeNull();
    act(() => runtime.publish({ agentDisplayName: 'Updated assistant' }));
    expect(screen.queryByRole('button', { name: 'Jump to user prompt' })).toBeNull();
    box.scrollTop = 950;
    fireEvent.scroll(box);
    expect(screen.queryByRole('button', { name: 'Jump to user prompt' })).toBeNull();
    readAt(box, 0);
    expect(screen.queryByRole('button', { name: 'Jump to user prompt' })).toBeNull();

    act(() => runtime.publish({ records: [...runtime.state.records, message(20)] }));
    expect(box.querySelector('[data-record-key="message-20"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Jump to user prompt' })).toBeNull();

    const send = { sessionKey: 'reading', clientMessageId: 'c_new', deviceId: 'browser', content: 'Message 21',
      status: 'accepted' as const, submittedAt: '2026-10-23T00:00:00Z', reconciled: false };
    act(() => runtime.publish({ sends: [send] }));
    expect(screen.queryByRole('button', { name: 'Jump to user prompt' })).toBeNull();

    readAt(box, 600);
    let preview = screen.getByRole('button', { name: 'Jump to user prompt' });
    expect(preview.textContent).toBe('Message 5');
    expect(targetForPreview()?.dataset.recordKey).toBe('message-5');

    box.scrollTop = box.scrollHeight - box.clientHeight;
    fireEvent.scroll(box);
    preview = screen.getByRole('button', { name: 'Jump to user prompt' });
    expect(preview.textContent).toBe('Message 18');
    expect(targetForPreview()?.dataset.recordKey).toBe('message-18');
    expect(targetForPreview()!.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.getBoundingClientRect().top);
    expect(box.querySelector('[data-record-key="local-c_new"]')?.getBoundingClientRect().top)
      .toBeGreaterThanOrEqual(box.getBoundingClientRect().top);
  });

  it('jumps to and focuses the exact older prompt represented by the sticky preview', () => {
    reducedMotion = true;
    const { box } = setup();
    readAt(box, 600);
    const button = screen.getByRole('button', { name: 'Jump to user prompt' });
    const targetId = button.getAttribute('aria-controls');
    const target = targetId ? document.getElementById(targetId) : null;
    expect(target?.dataset.recordKey).toBe('message-5');
    expect(target?.dataset.recordKey).not.toBe('message-19');
    expect(target?.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.getBoundingClientRect().top);
    scrollTo.mockClear();

    fireEvent.click(button);

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'instant' }));
    expect(document.activeElement).toBe(target);
    expect(target!.getBoundingClientRect().top).toBeGreaterThanOrEqual(box.getBoundingClientRect().top);
    expect(target!.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.getBoundingClientRect().bottom);
    expect(screen.getByRole('button', { name: 'Jump to user prompt' }).textContent).toBe('Message 2');
    expect(targetForPreview()?.dataset.recordKey).toBe('message-2');

    reducedMotion = false;
    const previousPrompt = targetForPreview();
    scrollTo.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Jump to user prompt' }));
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'smooth' }));
    expect(document.activeElement).toBe(previousPrompt);
  });
});
