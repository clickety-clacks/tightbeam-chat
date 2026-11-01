import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActivitySummaryTransport, SummaryAnswer, SummarySource } from '../src/activitySummaries';
import { getIndex, putIndex } from '../src/recordIndex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TightbeamChat, workingStateOpacity } from '../src/TightbeamChat';
import type { RenderContext } from '../src/TightbeamChat';
import { createTurnProvenance } from '../src/provenance';
import { decodePublic019Message } from '../src/public019';
import type {
  ToolCallIndex, ToolCallRecord, CanonicalMessage, CanonicalTurn, ChatRuntime, ConversationRecord, LocalSend, RuntimeState,
  TightbeamAdapter, TurnProvenance,
} from '../src/types';

afterEach(() => {
  cleanup();
  document.querySelectorAll('style[data-chat-component-test]').forEach(style => style.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function row(sessionKey: string, id: string, content: string, extra: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return { kind: 'message', sessionKey, id, seq: 1, rowVersion: 1, role: 'assistant', content,
    raw: { source: 'fixture', id }, ...extra };
}

function turn(seq: number, sessionKey: string, messageId: string, origin: string, status = 'completed'): CanonicalTurn {
  return { seq, sessionKey, messageId, origin, status, raw: { seq, origin } };
}

function provenance(seq: number, sessionKey: string, messageId: string, origin: string,
  trigger?: CanonicalMessage, _displayName?: string, status = 'completed'): TurnProvenance {
  return createTurnProvenance({ ...turn(seq, sessionKey, messageId, origin, status), triggerSource: 'other' }, trigger ? [trigger] : [], 'person', 'person');
}

interface OlderPage {
  readonly records: readonly CanonicalMessage[];
  readonly provenance: readonly TurnProvenance[];
  readonly hasOlder: boolean;
}

class FakeRuntime implements ChatRuntime {
  listeners = new Set<() => void>();
  disposed = false;
  sent: string[] = [];
  sendResult: string | null = 'fixture-send';
  retried: string[] = [];
  loadOlderCalls = 0;
  rebuildCalls = 0;
  rebuildOptions: Array<{ restart?: boolean } | undefined> = [];
  olderPages: OlderPage[] = [];
  rebuildSnapshots: Partial<RuntimeState>[] = [];
  state: RuntimeState;

  constructor(sessionKey: string, patch: Partial<RuntimeState> = {}) {
    this.state = { sessionKey, principalKey: 'person', generation: 1, status: 'ready', records: [], provenance: [],
      hasOlder: false, loadingOlder: false, sends: [], targetLabel: 'Fixture',
      agentDisplayName: 'Research assistant', targetGateway: 'https://gateway.example',
      session: { sessionKey, rowVersion: 1, displayName: 'Research assistant', model: 'Model A', harness: 'Harness A', raw: { ownerUserId: 'person' } },
      ...patch };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { for (const listener of this.listeners) listener(); }
  loadOlder = async () => {
    this.loadOlderCalls++;
    const page = this.olderPages.shift();
    if (!page) return;
    this.state = { ...this.state, loadingOlder: true };
    this.publish();
    await Promise.resolve();
    this.state = { ...this.state, records: [...page.records, ...this.state.records],
      provenance: [...(page.provenance || []), ...(this.state.provenance || [])],
      hasOlder: page.hasOlder, loadingOlder: false };
    this.publish();
  };
  update = (patch: Partial<RuntimeState>) => { this.state = { ...this.state, ...patch }; this.publish(); };
  send = (text: string, clientMessageId?: string) => { this.sent.push(text); return clientMessageId ?? this.sendResult; };
  retrySend = async (id: string) => { this.retried.push(id); };
  observeHostSend = () => () => {};
  refreshHostSend = async () => 'absent' as const;
  retryHostSend = (id: string, content: string) => { this.retried.push(`${id}:${content}`); };
  recordHostSendOutcome = () => {};
  markReadPosition = vi.fn(async () => {});
  markHostSendUncertain = () => {};
  rebuild = async (options?: { restart?: boolean }) => { this.rebuildCalls++; this.rebuildOptions.push(options); const snapshot = this.rebuildSnapshots.shift(); if (snapshot) this.update(snapshot); };
  setToolCallsEnabled = (enabled: boolean) => this.update({ toolCallsEnabled: enabled });
  dispose = () => { this.disposed = true; this.listeners.clear(); };
}

function adapterFor(runtime: FakeRuntime): TightbeamAdapter { return { open: () => runtime }; }

function setDocumentVisibility(initial: DocumentVisibilityState) {
  const previous = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const set = (value: DocumentVisibilityState) => Object.defineProperty(document, 'visibilityState', {
    configurable: true, value,
  });
  set(initial);
  return {
    set,
    restore() {
      if (previous) Object.defineProperty(document, 'visibilityState', previous);
      else Reflect.deleteProperty(document, 'visibilityState');
    },
  };
}

function installViewportLayout(viewport: HTMLElement, trailingSpace = 200,
  rowHeightOverride?: (row: Element) => number | undefined, summaryHeightChange = false,
  frame: { readonly width?: number; readonly height?: number; readonly top?: number; readonly promptPreviewHeight?: number } = {}) {
  const content = viewport.querySelector<HTMLElement>('.tb-chat-message-content')!;
  const width = frame.width ?? 320;
  const height = frame.height ?? 180;
  const top = frame.top ?? 100;
  const rowHeight = 92;
  const activityDetailHeight = 32;
  const heightOf = (row: Element): number => {
    const explicitHeight = Number.parseFloat((row as HTMLElement).style.height);
    if (Number.isFinite(explicitHeight)) return explicitHeight;
    const override = rowHeightOverride?.(row);
    if (override !== undefined) return override;
    const activityRows = row.querySelector('.tb-chat-activity-run-rows')?.children.length ?? 0;
    const toolDetails = row.querySelector('.tb-chat-tool-detail-rail[aria-hidden="false"]')?.querySelectorAll('section').length ?? 0;
    const attachmentDetails = row.querySelector('.tb-chat-attachment-content[aria-hidden="false"] pre') ? 2 : 0;
    const baseHeight = summaryHeightChange && row.querySelector('.tb-chat-summary-marker') ? 40 : rowHeight;
    return baseHeight + (activityRows + toolDetails + attachmentDetails) * activityDetailHeight;
  };
  const rowsHeight = () => [...content.children].reduce((height, row) => height + heightOf(row), 0);
  let scrollTop = 0;
  const anchorSpace = () => Number.parseFloat(viewport.style.getPropertyValue('--tb-chat-anchor-space')) || 0;
  const scrollHeight = () => 32 + rowsHeight() + anchorSpace() + trailingSpace;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => height },
    scrollHeight: { configurable: true, get: scrollHeight },
    scrollTop: {
      configurable: true, get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight() - height)); },
    },
  });
  Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: (options: ScrollToOptions) => {
    viewport.scrollTop = options.top ?? 0;
  } });
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === viewport) return new DOMRect(0, top, width, height);
    if (this.classList.contains('tb-chat-latest-user-prompt') && frame.promptPreviewHeight) {
      return new DOMRect(0, top + 10, width, frame.promptPreviewHeight);
    }
    if (this.classList.contains('tb-chat-scroll-latest')) return new DOMRect(0, top + height - 120, width, 40);
    if (this.classList.contains('tb-chat-composer')) return new DOMRect(0, top + height - 60, width, 60);
    const index = [...content.children].indexOf(this);
    if (index >= 0) {
      const offset = [...content.children].slice(0, index).reduce((height, row) => height + heightOf(row), 0);
      return new DOMRect(0, top + 16 + anchorSpace() + offset - scrollTop, width, heightOf(this) - 12);
    }
    return originalBounds.call(this);
  });
  return {
    offset(element: HTMLElement) { return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top; },
    get scrollTop() { return scrollTop; },
    get anchorSpace() { return anchorSpace(); },
    setScrollTop(value: number) { viewport.scrollTop = value; },
    restore() { bounds.mockRestore(); },
  };
}

it.each([
  { label: 'phone', width: 390, height: 844 },
  { label: 'desktop', width: 1440, height: 900 },
])('keeps the answered prompt tail uncovered above a tall reply with intervening rows on $label', ({ width, height }) => {
  const sessionKey = `prompt-tail-${width}`;
  const prompts = Array.from({ length: 12 }, (_, index) => row(sessionKey, `prompt-${index + 1}`, `Question ${index + 1}`, {
    seq: index + 1, role: 'user', sender: 'user:person', messageType: 'chat',
    createdAt: new Date((index + 1) * 1000).toISOString(),
  }));
  const answeredPrompt = prompts.at(-1)!;
  const runtime = new FakeRuntime(sessionKey, { records: prompts, toolCallsEnabled: true });
  const restoreMotion = installMotionPreference(true);
  const frames: FrameRequestCallback[] = [];
  const priorFrame = Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame');
  const priorCancelFrame = Object.getOwnPropertyDescriptor(window, 'cancelAnimationFrame');
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  } });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
  const viewport = screen.getByRole('log');
  const layout = installViewportLayout(viewport, 200, element => {
    if (element.matches('[data-scroll-key="assistant-reply"]')) return height * 0.95;
    if (element.matches('.tb-chat-activity-tool')) return 48;
    if (element.matches('.tb-chat-activity-pill-row')) return 40;
    return undefined;
  },
  false, { width, height, top: 0, promptPreviewHeight: 60 });

  try {
    layout.setScrollTop(viewport.scrollHeight - viewport.clientHeight);
    fireEvent.scroll(viewport);

    const reply = row(sessionKey, 'assistant-reply', 'Here is the answer', {
      seq: 14, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: answeredPrompt.id, turnSeq: 3,
      createdAt: new Date(15000).toISOString(),
    });
    const toolCall: ToolCallRecord = { id: 'read-call', seq: 1, sessionKey, turnSeq: 3, afterMessageSeq: answeredPrompt.seq,
      harnessToolCallId: 'read-file', title: 'Read a file', kind: 'read', toolName: 'read_file', status: 'completed',
      rawInput: null, rawOutput: null, content: null, truncated: [], startedAt: 12500, endedAt: 12600, rowVersion: 1 };
    const event = { eventId: 'update-example', sessionKey, at: 14000, kind: 'work_item.filed',
      record: { type: 'work item', id: 'example', detail: '/api/work-items/example' }, actorSessionKey: sessionKey,
      tiedAs: ['creator'], cause: { turnSeq: 3, messageId: answeredPrompt.id }, noticeMessageIds: [] };
    act(() => runtime.update({ records: [...prompts, reply], toolCalls: [toolCall], recordEvents: [event] }));

    const flushFrames = () => {
      for (let pass = 0; pass < 4 && frames.length; pass++) {
        const pending = frames.splice(0);
        act(() => pending.forEach(callback => callback(performance.now() + 300 + pass * 300)));
      }
    };
    flushFrames();
    fireEvent.scroll(viewport);
    flushFrames();

    const answeredPromptRow = viewport.querySelector<HTMLElement>(`[data-scroll-key="${answeredPrompt.id}"]`)!;
    const replyRow = viewport.querySelector<HTMLElement>('[data-scroll-key="assistant-reply"]')!;
    const preview = screen.queryByRole('button', { name: 'Jump to user prompt' });
    const previewBottom = preview?.getBoundingClientRect().bottom ?? viewport.getBoundingClientRect().top;
    const visibleBottom = screen.getByRole('button', { name: 'Scroll to bottom' }).getBoundingClientRect().top;
    const visibleHeight = visibleBottom - viewport.getBoundingClientRect().top;

    expect(viewport.querySelector('[data-record-key="tool-read-call"]')).not.toBeNull();
    expect(viewport.querySelector('[data-record-key="record-event:update-example"]')).not.toBeNull();
    expect(answeredPromptRow.getBoundingClientRect().bottom - previewBottom).toBeGreaterThanOrEqual(4);
    expect(answeredPromptRow.getBoundingClientRect().bottom).toBeLessThan(replyRow.getBoundingClientRect().top);
    expect(replyRow.getBoundingClientRect().top).toBeLessThanOrEqual(viewport.getBoundingClientRect().top + visibleHeight / 2);
    if (preview) expect(preview.textContent).toContain(answeredPrompt.content);

    layout.setScrollTop(layout.scrollTop + height / 2);
    fireEvent.scroll(viewport);
    const restoredPreview = screen.getByRole('button', { name: 'Jump to user prompt' });
    expect(restoredPreview.textContent).toContain(answeredPrompt.content);
    expect(restoredPreview.getAttribute('aria-controls')).toBe(answeredPromptRow.id);
  } finally {
    view.unmount();
    layout.restore();
    restoreMotion();
    if (priorFrame) Object.defineProperty(window, 'requestAnimationFrame', priorFrame);
    else Reflect.deleteProperty(window, 'requestAnimationFrame');
    if (priorCancelFrame) Object.defineProperty(window, 'cancelAnimationFrame', priorCancelFrame);
    else Reflect.deleteProperty(window, 'cancelAnimationFrame');
  }
});

function installFoldAnimationMock() {
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  const animations: Array<{
    readonly element: HTMLElement;
    readonly keyframes: Keyframe[] | PropertyIndexedKeyframes;
    readonly options: number | KeyframeAnimationOptions | undefined;
    finish(): void;
  }> = [];
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: function (this: HTMLElement, keyframes: Keyframe[] | PropertyIndexedKeyframes,
      options?: number | KeyframeAnimationOptions) {
      const animation = { cancel: vi.fn(), onfinish: null } as unknown as Animation;
      animations.push({ element: this, keyframes, options, finish: () => {
        animation.onfinish?.call(animation, {} as AnimationPlaybackEvent);
      } });
      return animation;
    },
  });
  return {
    animations,
    restore() {
      if (previous) Object.defineProperty(HTMLElement.prototype, 'animate', previous);
      else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    },
  };
}

function installMotionPreference(reduced: boolean) {
  const previous = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: reduced, media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }),
  });
  return () => {
    if (previous) Object.defineProperty(window, 'matchMedia', previous);
    else Reflect.deleteProperty(window, 'matchMedia');
  };
}

function installResizeObserverMock() {
  const observers: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  class TestResizeObserver {
    private readonly entry: { callback: ResizeObserverCallback; targets: Set<Element> };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set() };
      observers.push(this.entry);
    }
    observe(target: Element) { this.entry.targets.add(target); }
    unobserve(target: Element) { this.entry.targets.delete(target); }
    takeRecords() { return []; }
    disconnect() {
      this.entry.targets.clear();
      const index = observers.indexOf(this.entry);
      if (index >= 0) observers.splice(index, 1);
    }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: TestResizeObserver });
  return {
    notify(target: Element) {
      for (const { callback, targets } of observers) {
        if (targets.has(target)) callback([], {} as ResizeObserver);
      }
    },
    restore() {
      if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous);
      else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    },
  };
}

function visibilityMix(sessionKey: string, prefix: string): readonly CanonicalMessage[] {
  const human = row(sessionKey, `${prefix}-human`, `Human exchange ${prefix}`, {
    role: 'user', sender: 'user:person', turnSeq: 1, messageType: 'chat',
  });
  const humanReply = row(sessionKey, `${prefix}-human-reply`, `Reply to human ${prefix}`, {
    sender: 'assistant-service', messageType: 'assistant', turnSeq: 1, replyToMessageId: human.id,
  });
  const batch = row(sessionKey, `${prefix}-batch`, [
    '[batched notices: 1]', '',
    `[1] source=process sender=user:person cause=fixture class=fyi`,
    `Extracted question ${prefix}`, '', 'coalesced by notices',
  ].join('\n'), {
    role: 'user', sender: 'process:notifications', messageType: 'substrate', isBatchCarrier: true, turnSeq: 2,
  });
  const batchReply = row(sessionKey, `${prefix}-batch-reply`, `Reply to batch ${prefix}`, {
    sender: 'assistant-service', messageType: 'assistant', replyToMessageId: batch.id, turnSeq: 2, turnIncludesHuman: true,
  });
  const marker = row(sessionKey, `${prefix}-marker`, `Hidden assistant substrate marker ${prefix}`, {
    sender: 'process:notifications', messageType: 'substrate', turnSeq: 77,
  });
  const agentWake = row(sessionKey, `${prefix}-agent-wake`, `Hidden agent wake ${prefix}`, {
    role: 'user', sender: 'agent:external', messageType: 'agent', turnSeq: 3,
  });
  const agentReply = row(sessionKey, `${prefix}-agent-reply`, `Hidden reply to agent wake ${prefix}`, {
    sender: 'assistant-service', messageType: 'assistant', replyToMessageId: agentWake.id, turnSeq: 3,
  });
  const processNotice = row(sessionKey, `${prefix}-process`, `Hidden process notice ${prefix}`, {
    role: 'user', sender: 'process:notifications', messageType: 'chat', turnSeq: 4,
  });
  const processReply = row(sessionKey, `${prefix}-process-reply`, `Hidden reply to process notice ${prefix}`, {
    sender: 'assistant-service', messageType: 'assistant', replyToMessageId: processNotice.id, turnSeq: 4,
  });
  const member = row(sessionKey, `${prefix}-member`, `Extracted question ${prefix}`, { role: 'user', sender: 'user:person', turnSeq: 2 });
  return [human, humanReply, batch, member, batchReply, marker, agentWake, agentReply, processNotice, processReply];
}

function expectVisibilityMix(log: HTMLElement, prefix: string): void {
  for (const label of [
    `Human exchange ${prefix}`, `Reply to human ${prefix}`,
    `Reply to batch ${prefix}`,
  ]) expect(within(log).getByText(label)).toBeTruthy();
  const batchBubble = within(log).getByText(`Extracted question ${prefix}`).closest('article');
  expect(batchBubble?.classList.contains('tb-chat-bubble-human')).toBe(true);
  expect(batchBubble?.textContent).not.toContain('coalesced by');
  for (const label of [
    `Hidden assistant substrate marker ${prefix}`, `Hidden agent wake ${prefix}`,
    `Hidden process notice ${prefix}`,
  ]) {
    const renderedAsBubble = [...log.querySelectorAll<HTMLElement>('.tb-chat-bubble')]
      .some(element => element.textContent?.includes(label));
    expect(renderedAsBubble).toBe(false);
    expect(within(log).queryByText(label)).toBeNull();
  }
  for (const label of [
    `Hidden reply to agent wake ${prefix}`, `Hidden reply to process notice ${prefix}`,
  ]) expect(within(log).queryByText(label)).toBeNull();
}

function expectActivityText(log: HTMLElement, label: string): void {
  const rows = [...log.querySelectorAll<HTMLElement>('.tb-chat-activity-line')]
    .filter(element => element.textContent?.includes(label));
  expect(rows).toHaveLength(1);
  expect(rows[0].closest('.tb-chat-bubble')).toBeNull();
}

describe('conversation surface', () => {
  it('marks once when each opened runtime first becomes ready', () => {
    const visibility = setDocumentVisibility('visible');
    try {
      const runtime = new FakeRuntime('read-marker-open', { status: 'loading' });
      const mark = vi.fn(async () => {});
      runtime.markReadPosition = mark;
      const view = render(<TightbeamChat sessionKey="read-marker-open" adapter={adapterFor(runtime)} />);

      expect(mark).not.toHaveBeenCalled();
      act(() => runtime.update({ status: 'ready' }));
      expect(mark).toHaveBeenCalledTimes(1);

      act(() => runtime.update({ records: [row('read-marker-open', 'reply', 'New reply')], status: 'ready' }));
      act(() => runtime.update({ status: 'stale' }));
      act(() => runtime.update({ status: 'ready' }));
      expect(mark).toHaveBeenCalledTimes(1);

      view.unmount();
      const reopened = new FakeRuntime('read-marker-open', { status: 'ready' });
      const markReopened = vi.fn(async () => {});
      reopened.markReadPosition = markReopened;
      render(<TightbeamChat sessionKey="read-marker-open" adapter={adapterFor(reopened)} />);
      expect(markReopened).toHaveBeenCalledTimes(1);
    } finally {
      visibility.restore();
    }
  });

  it('marks reader scroll but keeps both unseen-control steps local to the view', () => {
    const visibility = setDocumentVisibility('visible');
    const sessionKey = 'read-marker-reader-actions';
    const runtime = new FakeRuntime(sessionKey, { records: [
      row(sessionKey, 'first', 'First', { seq: 1 }),
      row(sessionKey, 'second', 'Second', { seq: 2 }),
      row(sessionKey, 'third', 'Third', { seq: 3 }),
    ] });
    const mark = runtime.markReadPosition;
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const viewport = screen.getByRole('log');
    const layout = installViewportLayout(viewport);
    try {
      mark.mockClear();
      layout.setScrollTop(viewport.scrollHeight - viewport.clientHeight);
      fireEvent.scroll(viewport);

      vi.useFakeTimers();
      fireEvent.wheel(viewport, { deltaY: -1000 });
      layout.setScrollTop(0);
      fireEvent.scroll(viewport);
      expect(mark).toHaveBeenCalledTimes(1);

      mark.mockClear();
      vi.advanceTimersByTime(251);
      act(() => runtime.update({ records: [...runtime.state.records, row(sessionKey, 'reply', 'Reply', { seq: 4 })] }));
      expect(mark).not.toHaveBeenCalled();

      // Start a new reader-scroll intent without moving the viewport. Each
      // control step must keep its own programmatic movement out of the marker.
      fireEvent.wheel(viewport, { deltaY: -1 });
      fireEvent.click(screen.getByRole('button', { name: /^\d+ unseen messages?$/ }));
      expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeTruthy();
      expect(mark).not.toHaveBeenCalled();

      fireEvent.wheel(viewport, { deltaY: -1 });
      fireEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));
      expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).toBeNull();
      expect(mark).not.toHaveBeenCalled();

      fireEvent.wheel(viewport, { deltaY: -100 });
      layout.setScrollTop(layout.scrollTop - 100);
      fireEvent.scroll(viewport);
      expect(mark).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      layout.restore();
      visibility.restore();
    }
  });

  it('does not mark a hidden conversation until it returns to visible Chat', () => {
    const visibility = setDocumentVisibility('hidden');
    const sessionKey = 'read-marker-visible-return';
    const runtime = new FakeRuntime(sessionKey, { records: [row(sessionKey, 'existing', 'Existing', { seq: 8 })] });
    const mark = runtime.markReadPosition;
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    try {
      expect(mark).not.toHaveBeenCalled();
      act(() => runtime.update({ records: [...runtime.state.records, row(sessionKey, 'reply', 'Reply', { seq: 9 })] }));
      expect(mark).not.toHaveBeenCalled();

      visibility.set('visible');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(mark).toHaveBeenCalledTimes(1);
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(mark).toHaveBeenCalledTimes(1);
    } finally {
      view.unmount();
      visibility.restore();
    }
  });

  it('swaps five activity summaries without moving an away reader, changing pills or discarding the draft', async () => {
    const sessionKey = 'summary-reading';
    const human = row(sessionKey, 'question', 'Question', { seq: 1, role: 'user', sender: 'user:person', turnSeq: 1 });
    const activity = [1, 2, 3, 4, 5].map(index => row(sessionKey, `remedy-${index}`, `Full original remedy ${index}`, {
      seq: index + 1, role: 'user', sender: 'remedy:needs-review', messageType: 'substrate', turnSeq: 1,
    }));
    const answer = row(sessionKey, 'answer', 'First answer', { seq: 7, sender: 'assistant-service', replyToMessageId: human.id, turnSeq: 1 });
    const later = Array.from({ length: 12 }, (_, index) => row(sessionKey, `later-${index}`, `Later text ${index}`, {
      seq: index + 10, role: 'user', sender: 'user:person',
    }));
    const runtime = new FakeRuntime(sessionKey, { records: [human, ...activity, answer, ...later] });
    let receive!: (answer: SummaryAnswer) => void;
    let sources: readonly SummarySource[] = [];
    const activitySummaries: ActivitySummaryTransport = { stream: vi.fn((batch, callback, signal) => {
      sources = batch; receive = callback;
      return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    }) };
    render(<TightbeamChat sessionKey={sessionKey} adapter={{ ...adapterFor(runtime), activitySummaries }} />);
    await act(async () => { await Promise.resolve(); });
    expect(sources).toHaveLength(5);
    const viewport = screen.getByRole('log');
    const layout = installViewportLayout(viewport, 200, undefined, true);
    try {
      act(() => runtime.update({}));
      const anchor = screen.getByText('Full original remedy 5').closest<HTMLElement>('[data-scroll-key]')!;
      fireEvent.wheel(viewport, { deltaY: -1 });
      layout.setScrollTop(layout.scrollTop + layout.offset(anchor));
      fireEvent.scroll(viewport);
      const before = layout.offset(anchor);
      expect(before).toBeCloseTo(0, 0);
      const field = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(field, { target: { value: 'Retained draft' } }); field.focus(); field.setSelectionRange(3, 7);
      const pills = [...viewport.querySelectorAll('.tb-chat-activity-pill')];
      const neighbor = screen.getByText('Later text 2').closest('article');
      for (let index = 0; index < 5; index++) {
        await act(async () => { receive({ index, state: 'summary', summary: `Correction ${index + 1} requested.` }); });
        expect(Math.abs(layout.offset(anchor) - before)).toBeLessThanOrEqual(1);
      }
      expect([...viewport.querySelectorAll('.tb-chat-activity-pill')]).toEqual(pills);
      expect(screen.getByText('Later text 2').closest('article')).toBe(neighbor);
      expect(anchor.title).toBe('Full original remedy 5');
      expect(screen.getAllByText('summarized')).toHaveLength(5);
      expect(screen.queryByText('summarizing')).toBeNull();
      expect(field.value).toBe('Retained draft'); expect(document.activeElement).toBe(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([3, 7]);
      expect(activitySummaries.stream).toHaveBeenCalledTimes(1);
    } finally { layout.restore(); }
  });

  it('shows the plain empty state after loading when all loaded messages are hidden and older history remains', () => {
    const sessionKey = 'hidden-loaded-history';
    const hiddenReply = row(sessionKey, 'hidden-reply', 'A reply excluded by the loaded visibility evidence', {
      seq: 1, sender: 'assistant-service', messageType: 'assistant', turnSeq: 1, turnIncludesHuman: false,
    });
    const runtime = new FakeRuntime(sessionKey, { status: 'loading', records: [hiddenReply], hasOlder: true });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const log = screen.getByRole('log');
    expect(within(log).queryByText('No messages yet.')).toBeNull();
    expect(within(log).queryByText('A reply excluded by the loaded visibility evidence')).toBeNull();

    act(() => runtime.update({ status: 'ready' }));

    expect(within(log).getByText('No messages yet.')).toBeTruthy();
    expect(within(log).queryByText('A reply excluded by the loaded visibility evidence')).toBeNull();
  });

  it('renders late canonical rows in sequence order without dropping a human message', () => {
    const sessionKey = 'out-of-order-conversation';
    const first = row(sessionKey, 'first', 'First canonical message', {
      seq: 10, role: 'user', sender: 'user:person', messageType: 'chat',
    });
    const middle = row(sessionKey, 'middle', 'Middle canonical message', {
      seq: 20, role: 'user', sender: 'user:person', messageType: 'chat',
    });
    const last = row(sessionKey, 'last', 'Last canonical message', {
      seq: 30, role: 'user', sender: 'user:person', messageType: 'chat',
    });
    const runtime = new FakeRuntime(sessionKey, { records: [last, middle] });
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const renderedKeys = () => Array.from(view.container.querySelectorAll<HTMLElement>(
      '.tb-chat-message-content article[data-scroll-key]'), (article) => article.dataset.scrollKey);

    expect(renderedKeys()).toEqual(['middle', 'last']);
    // The earlier row arrives after rows with higher server sequence numbers.
    act(() => runtime.update({ records: [last, first, middle] }));

    expect(renderedKeys()).toEqual(['first', 'middle', 'last']);
    expect(within(screen.getByRole('log')).getByText('First canonical message')).toBeTruthy();
  });

  it('renders the full body of a canonical user message after its attribution wrapper', () => {
    const sessionKey = 'complete-message-body';
    const content = [
      '[from user:account]',
      '',
      '[assignment: task-123]',
      '',
      'Review the test results and summarize the failures.',
    ].join('\n');
    const canonical = decodePublic019Message({
      id: 'complete-message', seq: 10, rowVersion: 10, sessionKey, role: 'user', sender: 'user:person',
      messageType: 'chat', content, assignmentId: 'task-123', at: Date.parse('2026-10-30T00:00:00Z'), attachments: [],
    }, sessionKey);
    const runtime = new FakeRuntime(sessionKey, { records: [canonical] });

    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const log = screen.getByRole('log');
    const message = within(log).getByText('Review the test results and summarize the failures.')
      .closest<HTMLElement>('.tb-chat-bubble');
    expect(message?.getAttribute('aria-label')).toBe('Message from Assigned task');
    expect(message?.querySelector('.tb-chat-bubble-sender')?.textContent).toBe('Assigned task');
    expect(log.textContent).toContain('[from user:account]');
    expect(log.textContent).toContain('[assignment: task-123]');
    expect(log.textContent).toContain('Review the test results and summarize the failures.');
  });

  it('preserves the agent label when an agent reply carries assignment context', () => {
    const sessionKey = 'assignment-agent-reply';
    const humanMessage = decodePublic019Message({
      id: 'assigned-prompt', seq: 10, rowVersion: 10, sessionKey, role: 'user', sender: 'user:person',
      messageType: 'chat', content: 'Review the requested changes.', assignmentId: 'task-123', turnSeq: 7,
      at: Date.parse('2026-10-30T00:00:00Z'), attachments: [],
    }, sessionKey);
    const agentReply = decodePublic019Message({
      id: 'assigned-reply', seq: 11, rowVersion: 11, sessionKey, role: 'assistant', sender: 'assistant-service',
      messageType: 'assistant', content: 'The changes are ready.', assignmentId: 'task-123', turnSeq: 7,
      replyToMessageId: 'assigned-prompt', at: Date.parse('2026-10-30T00:01:00Z'), attachments: [],
    }, sessionKey);
    const runtime = new FakeRuntime(sessionKey, { records: [humanMessage, agentReply] });

    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const reply = within(screen.getByRole('log')).getByText('The changes are ready.')
      .closest<HTMLElement>('.tb-chat-bubble');
    expect(reply?.getAttribute('aria-label')).toBe('Message from Research assistant');
  });

  it('preserves assignment attribution while hiding provenance only in displayed bodies', () => {
    const sessionKey = 'assigned-provenance-display';
    const marker = '<engram-src id="123e4567-e89b-12d3-a456-426614174000"/>';
    const humanContent = `[from user:account]\n\n${marker}\n\nReview this assigned message.`;
    const replyContent = `${marker}\n\nThe assigned reply is ready.`;
    const human = decodePublic019Message({
      id: 'assigned-marked-prompt', seq: 10, rowVersion: 10, sessionKey, role: 'user', sender: 'user:person',
      messageType: 'chat', content: humanContent, assignmentId: 'task-123', turnSeq: 7,
      at: Date.parse('2026-10-30T00:00:00Z'), attachments: [],
    }, sessionKey);
    const reply = decodePublic019Message({
      id: 'assigned-marked-reply', seq: 11, rowVersion: 11, sessionKey, role: 'assistant', sender: 'assistant-service',
      messageType: 'assistant', content: replyContent, assignmentId: 'task-123', turnSeq: 7,
      replyToMessageId: human.id, at: Date.parse('2026-10-30T00:01:00Z'), attachments: [],
    }, sessionKey);
    const runtime = new FakeRuntime(sessionKey, { records: [human, reply] });

    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const log = screen.getByRole('log');
    expect(within(log).getByText('[from user:account] Review this assigned message.').closest('.tb-chat-bubble')
      ?.getAttribute('aria-label')).toBe('Message from Assigned task');
    expect(within(log).getByText('The assigned reply is ready.').closest('.tb-chat-bubble')
      ?.getAttribute('aria-label')).toBe('Message from Research assistant');
    expect(log.textContent).not.toContain('<engram-src');
    expect(human.content).toBe(humanContent);
    expect(reply.content).toBe(replyContent);
  });

  it('does not rebuild the transcript on a foreground return', () => {
    const sessionKey = 'background-resume-session';
    const runtime = new FakeRuntime(sessionKey);
    const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    try {
      render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
      const changeVisibility = (next: DocumentVisibilityState) => act(() => {
        visibility = next;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      for (const status of ['ready', 'stale', 'error', 'loading'] as const) {
        runtime.state = { ...runtime.state, status };
        changeVisibility('hidden');
        changeVisibility('visible');
      }
      expect(runtime.rebuildOptions).toEqual([]);
      changeVisibility('visible');
      expect(runtime.rebuildCalls).toBe(0);
      for (const status of ['unsupported', 'unauthorized'] as const) {
        runtime.state = { ...runtime.state, status };
        changeVisibility('hidden');
        changeVisibility('visible');
      }
      expect(runtime.rebuildCalls).toBe(0);
    } finally {
      if (original) Object.defineProperty(document, 'visibilityState', original);
      else Reflect.deleteProperty(document, 'visibilityState');
    }
  });

  it('keeps owner-scoped activity pills while filtering other history and rendering safe Markdown', async () => {
    const sessionKey = 'conversation-a';
    const human = row(sessionKey, 'human-trigger', 'Could you explain this?', { seq: 1, role: 'user', sender: 'user:person', turnSeq: 1 });
    const outsideOwnerMarker = row(sessionKey, 'outside-owner-marker',
      'A non-owner system marker after the owner exchange', {
        seq: 11, role: 'assistant', sender: 'process:notifications', messageType: 'substrate', turnSeq: 77,
      });
    const unprovenHuman = row(sessionKey, 'unproven-human', 'A user row with no sender stays visible', { seq: 8, role: 'user' });
    const mismatchedHuman = row(sessionKey, 'mismatched-human', 'A differently marked user row stays visible', {
      seq: 9, role: 'user', sender: 'user:another-person', messageType: 'chat',
    });
    const answer = row(sessionKey, 'selected-answer', [
      '## A **useful** answer', '', '- first item', '- second item', '',
      '[Reference](https://example.com)', '', '`inline code`', '',
      '```ts', 'const value = 1;', '```', '', '> A quotation', '',
      '```mermaid', 'const fallback = 2;', '```', '',
      '```', 'plain = 3', '```', '',
      '```html', '<script>window.codeCompromised = true</script>', '```', '',
      '| Name | Value |', '| --- | --- |', '| count | 2 |', '',
      '<script>window.compromised = true</script>',
    ].join('\n'), { seq: 2, sender: 'assistant-service', turnSeq: 1, messageType: 'assistant', replyToMessageId: human.id });
    const otherTrigger = row(sessionKey, 'other-trigger', 'An agent sent a wake', {
      seq: 5, role: 'user', sender: 'agent:external', messageType: 'agent', turnSeq: 2,
    });
    const otherAnswer = row(sessionKey, 'other-answer', 'Must remain hidden', { seq: 6,
      turnSeq: 2, messageType: 'assistant', replyToMessageId: otherTrigger.id,
    });
    const substrateMarker = row(sessionKey, 'substrate-marker', 'A system event marker', {
      seq: 10, role: 'assistant', sender: 'process:notifications', messageType: 'substrate',
    });
    const batchText = [
      '[batched notices: 2]',
      '',
      '[1] source=event-a sender=user:person cause=reply class=input-needed',
      'Batch question from the person',
      '',
      '[2] source=event-b sender=process:maintenance cause=refresh class=fyi',
      'A process notice in the batch',
      '',
      'coalesced by notice-batching-v1',
    ].join('\n');
    const batch = row(sessionKey, 'batch-trigger', batchText, {
      seq: 3, role: 'user', sender: 'process:maintenance', messageType: 'substrate', turnSeq: 3, isBatchCarrier: true,
    });
    const batchAnswer = row(sessionKey, 'batch-answer', 'Answer to the batch question', { seq: 4,
      sender: 'assistant-service', turnSeq: 3, turnIncludesHuman: true, messageType: 'assistant', replyToMessageId: batch.id,
    });
    const runtime = new FakeRuntime(sessionKey, {
      records: [human, answer, otherTrigger, otherAnswer, batch,
        row(sessionKey, 'batch-member', 'Batch question from the person', { seq: 3, role: 'user', sender: 'user:person', turnSeq: 3 }),
        batchAnswer, unprovenHuman, mismatchedHuman, substrateMarker, outsideOwnerMarker],
      provenanceAvailable: false,
      activityTurnStateAvailable: true,
    });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const log = screen.getByRole('log');
    expect(within(log).getByText('Could you explain this?')).toBeTruthy();
    expect(within(log).getByRole('heading', { level: 2, name: 'A useful answer' })).toBeTruthy();
    expect(within(log).getByText('first item')).toBeTruthy();
    expect(within(log).getByRole('link', { name: 'Reference' }).getAttribute('target')).toBe('_blank');
    expect(within(log).getByText('inline code')).toBeTruthy();
    const recognizedCode = log.querySelector('code.language-ts');
    expect(recognizedCode?.textContent?.trimEnd()).toBe('const value = 1;');
    expect(recognizedCode?.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(recognizedCode?.closest('.tb-chat-code-scroll')).toBeTruthy();
    const unknownCode = log.querySelector('code.language-mermaid');
    expect(unknownCode?.textContent).toContain('const fallback = 2;');
    expect(unknownCode?.querySelector('[class*="hljs-"]')).toBeNull();
    const untaggedCode = [...log.querySelectorAll('.tb-chat-code-scroll code')]
      .find(code => ![...code.classList].some(className => className.startsWith('language-')));
    expect(untaggedCode?.textContent).toContain('plain = 3');
    expect(untaggedCode?.querySelector('[class*="hljs-"]')).toBeNull();
    const selection = window.getSelection();
    const codeRange = document.createRange();
    codeRange.selectNodeContents(recognizedCode!);
    selection?.removeAllRanges();
    selection?.addRange(codeRange);
    expect(selection?.toString()).toContain('const value = 1;');
    selection?.removeAllRanges();
    const htmlCode = log.querySelector('code.language-html');
    expect(htmlCode?.textContent).toContain('<script>window.codeCompromised = true</script>');
    expect(within(log).getByText('A quotation')).toBeTruthy();
    expect(within(log).getByRole('table')).toBeTruthy();
    const batchBubble = within(log).getByText('Batch question from the person').closest('article');
    expect(batchBubble?.classList.contains('tb-chat-bubble-human')).toBe(true);
    expect(batchBubble?.getAttribute('aria-label')).toBe('Message from You');
    expect(batchBubble?.textContent).not.toContain('coalesced by');
    const substrateLine = within(log).getByRole('note', { name: 'Notice: A process notice in the batch' });
    expect(substrateLine.classList.contains('tb-chat-activity-substrate')).toBe(true);
    expect(substrateLine.querySelector('.tb-chat-activity-pill-blue svg')).toBeTruthy();
    expect(substrateLine.querySelector('.tb-chat-activity-bullet')).toBeNull();
    expect(substrateLine.textContent).not.toContain('•');
    expect(substrateLine.textContent).not.toMatch(/[\[\]]/);
    expect(substrateLine.closest('article')?.classList.contains('tb-chat-bubble')).not.toBe(true);
    expect(batch.content).toBe(batchText);
    expect(within(log).getByText('Answer to the batch question')).toBeTruthy();
    expect(within(log).queryByText('A system event marker')).toBeNull();
    expect(within(log).queryByText('A non-owner system marker after the owner exchange')).toBeNull();
    expect(within(log).queryByText('An agent sent a wake')).toBeNull();
    expectActivityText(log, 'A process notice in the batch');
    expect(within(log).queryByText('Must remain hidden')).toBeNull();
    const unmarkedBubble = within(log).getByText('A user row with no sender stays visible').closest('article');
    expect(unmarkedBubble?.getAttribute('aria-label')).toBe('Message from User');
    const mismatchedBubble = within(log).getByText('A differently marked user row stays visible').closest('article');
    expect(mismatchedBubble?.getAttribute('aria-label')).toBe('Message from User');
    expect(document.querySelector('script, img')).toBeNull();
    expect(within(log).queryByRole('status', { name: /Active turn:/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /load earlier/i })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message to Research assistant' }).getAttribute('placeholder'))
      .toBe('Research assistant');

    const visibleActivity = () => [...log.querySelectorAll<HTMLElement>('.tb-chat-activity-pill-row')].map((element) => ({
      record: element.dataset.recordKey, run: element.dataset.activityRun, text: element.textContent,
    }));
    const liveActivity = visibleActivity();
    expect(liveActivity.map(row => row.record)).toContain('member:batch-trigger:member:2');
  });

  it('opens complete pill messages in place for standalone and grouped rows', () => {
    const sessionKey = 'activity-pill-details';
    const prompt = row(sessionKey, 'prompt', 'Question', {
      seq: 1, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 1,
    });
    const standaloneContent = [
      'A complete notice message',
      'The first stored detail remains readable.',
      'The second line remains selectable too.',
    ].join('\n');
    const standalone = row(sessionKey, 'standalone-pill', standaloneContent, {
      seq: 2, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const firstAgentContent = 'Review update: first line\nSecond stored line from the review.';
    const firstAgent = row(sessionKey, 'agent-pill-1', firstAgentContent, {
      seq: 3, role: 'user', sender: 'agent:helper', messageType: 'agent', turnSeq: 1,
    });
    const secondAgent = row(sessionKey, 'agent-pill-2', 'Another update', {
      seq: 4, role: 'user', sender: 'agent:helper', messageType: 'agent', turnSeq: 1,
    });
    const answer = row(sessionKey, 'answer', 'Answer', {
      seq: 5, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: prompt.id, turnSeq: 1,
    });
    const laterMessages: CanonicalMessage[] = [];
    for (let index = 2; index <= 8; index++) {
      const laterPrompt = row(sessionKey, `later-prompt-${index}`, `Later question ${index}`, {
        seq: index * 10, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: index,
      });
      const laterAnswer = row(sessionKey, `later-answer-${index}`, `Later answer ${index}`, {
        seq: index * 10 + 1, sender: 'assistant-service', messageType: 'assistant',
        replyToMessageId: laterPrompt.id, turnSeq: index,
      });
      laterMessages.push(laterPrompt, laterAnswer);
    }
    const runtime = new FakeRuntime(sessionKey, {
      records: [prompt, standalone, firstAgent, secondAgent, answer, ...laterMessages],
      provenanceAvailable: false, activityTurnStateAvailable: true, activeTurn: undefined,
    });
    const componentStyles = document.createElement('style');
    componentStyles.dataset.chatComponentTest = 'true';
    componentStyles.textContent = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf8')
      .replace("@import './theme.css';", '');
    document.head.append(componentStyles);
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const viewport = screen.getByRole('log');
    const layout = installViewportLayout(viewport, 200, element =>
      element.querySelector('[data-activity-message-content]') ? 180 : undefined);
    try {
      act(() => runtime.update({}));
      const anchor = screen.getByText('Later answer 5').closest<HTMLElement>('[data-scroll-key]')!;
      fireEvent.wheel(viewport, { deltaY: -1 });
      layout.setScrollTop(Math.max(0, layout.scrollTop + layout.offset(anchor) - 120));
      fireEvent.scroll(viewport);
      const anchorBefore = layout.offset(anchor);
      expect(anchorBefore).toBeCloseTo(120, 0);

      const standaloneRow = viewport.querySelector<HTMLElement>('[data-record-key="message:standalone-pill"]')!;
      const standaloneToggle = within(standaloneRow).getByRole('button', { name: /Show full message/ });
      expect(standaloneToggle.tagName).toBe('SUMMARY');
      standaloneToggle.focus();
      expect(document.activeElement).toBe(standaloneToggle);
      expect(standaloneToggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(standaloneToggle);
      expect(standaloneToggle.getAttribute('aria-expanded')).toBe('true');
      const standaloneBody = standaloneRow.querySelector<HTMLElement>('[data-activity-message-content]')!;
      expect(standaloneBody.textContent).toBe(standaloneContent);
      const standaloneRail = standaloneBody.closest<HTMLElement>('.tb-chat-tool-detail-rail')!;
      expect(getComputedStyle(standaloneRail).getPropertyValue('border-inline-start')).toContain('2px solid');
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(standaloneBody);
      selection?.removeAllRanges();
      selection?.addRange(range);
      expect(selection?.toString()).toBe(standaloneContent);
      selection?.removeAllRanges();
      fireEvent.click(standaloneToggle);
      expect(standaloneToggle.getAttribute('aria-expanded')).toBe('false');
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);

      const groupToggle = screen.getByRole('button', { name: /Expand agent activity run, 2 entries/ });
      fireEvent.click(groupToggle);
      expect(groupToggle.getAttribute('aria-expanded')).toBe('true');
      const groupedRow = viewport.querySelector<HTMLElement>(
        '.tb-chat-activity-run-rows > [data-record-key="message:agent-pill-1"]')!;
      const groupedToggle = within(groupedRow).getByRole('button', { name: /Show full message/ });
      fireEvent.click(groupedToggle);
      expect(groupedToggle.getAttribute('aria-expanded')).toBe('true');
      const groupedBody = groupedRow.querySelector<HTMLElement>('[data-activity-message-content]')!;
      expect(groupedBody.textContent).toBe(firstAgentContent);
      const groupedRail = groupedBody.closest<HTMLElement>('.tb-chat-tool-detail-rail')!;
      expect(getComputedStyle(groupedRail).getPropertyValue('border-inline-start')).toContain('2px solid');
      expect(groupToggle.getAttribute('aria-expanded')).toBe('true');
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);

      fireEvent.click(groupedToggle);
      expect(groupedToggle.getAttribute('aria-expanded')).toBe('false');
      expect(groupToggle.getAttribute('aria-expanded')).toBe('true');
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);
      fireEvent.click(groupToggle);
      expect(groupToggle.getAttribute('aria-expanded')).toBe('false');
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);
    } finally {
      layout.restore();
    }
  });

  it('hides provenance markup in message and pill display without changing source text', () => {
    const sessionKey = 'provenance-display';
    const tag = '<engram-src id="123e4567-e89b-42d3-a456-426614174000"/>';
    const promptContent = `${tag}\n\nA normal message.`;
    const onBehalfContent = `${tag}\n\nA message shown on your behalf.`;
    const agentContent = `${tag}\n\nAn agent update with useful detail.`;
    const prompt = row(sessionKey, 'prompt', promptContent, {
      seq: 1, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 1,
    });
    const carrierContent = [
      '[batched notices: 2]',
      '[1] source=process:notifications sender=user:person cause=notice class=fyi',
      onBehalfContent,
      '',
      '[2] source=agent:example:role sender=agent:example:role cause=notice class=fyi',
      agentContent,
      '',
      'coalesced by notices',
    ].join('\n');
    const carrier = row(sessionKey, 'carrier', carrierContent, {
      seq: 2, role: 'user', sender: 'process:notifications', messageType: 'substrate', turnSeq: 1,
    });
    const answer = row(sessionKey, 'answer', 'Answer', {
      seq: 3, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: prompt.id, turnSeq: 1,
      turnIncludesHuman: true,
    });
    const toolInput = `${tag} tool input remains verbatim`;
    const toolResult = `${tag} tool result remains verbatim`;
    const toolCall: ToolCallRecord = { id: 'tc-provenance', seq: 40, sessionKey, turnSeq: 1, afterMessageSeq: 3,
      harnessToolCallId: 'call-provenance', title: 'Read marked content', kind: 'read', toolName: 'read_file',
      status: 'completed', rawInput: toolInput, rawOutput: toolResult, content: null,
      truncated: [], startedAt: 1000, endedAt: 1100, rowVersion: 1 };
    const runtime = new FakeRuntime(sessionKey, { records: [prompt, carrier, answer], toolCallsEnabled: true,
      toolCalls: [toolCall], provenanceAvailable: false, activityTurnStateAvailable: true, activeTurn: undefined,
      activitySenderDisplayNames: new Map([['agent:example:role', 'Research helper']]) });
    const receivedRecords: ConversationRecord[] = [];
    const renderMessage = vi.fn((record: ConversationRecord) => {
      receivedRecords.push(record);
      return undefined;
    });
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} renderMessage={renderMessage} />);

    const promptBubble = view.container.querySelector<HTMLElement>('[data-record-key="prompt"]')!;
    expect(promptBubble.querySelector('.tb-chat-bubble-body')?.textContent).toBe('A normal message.');
    const onBehalfBubble = view.container.querySelector<HTMLElement>('[data-record-key="carrier:member:1"]')!;
    expect(onBehalfBubble.querySelector('.tb-chat-bubble-body')?.textContent).toBe('A message shown on your behalf.');
    expect(receivedRecords.find(record => record.id === prompt.id)?.content).toBe(promptContent);
    expect(receivedRecords.find(record => record.id === 'carrier:member:1')?.content).toBe(onBehalfContent);

    const pillRow = view.container.querySelector<HTMLElement>('.tb-chat-activity-pill-row')!;
    expect(pillRow.textContent).toContain('Research helper');
    expect(pillRow.getAttribute('aria-label'))
      .toBe('Research helper: An agent update with useful detail.');
    expect(pillRow.textContent).toContain('An agent update with useful detail.');
    expect(pillRow.textContent).not.toContain(tag);
    expect(pillRow.title).not.toContain(tag);
    const pillToggle = within(pillRow).getByRole('button', { name: /Show full message/ });
    fireEvent.click(pillToggle);
    expect(pillRow.querySelector('[data-activity-message-content]')?.textContent)
      .toBe('An agent update with useful detail.');

    const toolRow = view.container.querySelector<HTMLElement>('[data-record-key="tool-tc-provenance"]')!;
    fireEvent.click(toolRow.querySelector('summary')!);
    expect(toolRow.textContent).toContain(toolInput);
    expect(toolRow.textContent).toContain(toolResult);

    expect(runtime.getSnapshot().records.find(record => record.id === prompt.id)?.content).toBe(promptContent);
    expect(runtime.getSnapshot().records.find(record => record.id === carrier.id)?.content).toBe(carrierContent);
    const sendContent = `${tag}\n\nSend the original bytes.`;
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to Research assistant' }), { target: { value: sendContent } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runtime.sent).toEqual([sendContent]);
    act(() => runtime.update({ sends: [{ sessionKey, deviceId: 'device', clientMessageId: 'fixture-send',
      content: sendContent, submittedAt: new Date().toISOString(), status: 'accepted', reconciled: false }] }));
    const localBubble = view.container.querySelector<HTMLElement>('.tb-chat-local')!;
    expect(localBubble.querySelector('.tb-chat-bubble-body')?.textContent).toBe('Send the original bytes.');
    expect(localBubble.textContent).not.toContain(tag);
  });

  it('keeps direct agent names accessible and leaves message text visible on narrow screens', () => {
    const sessionKey = 'direct-agent-pill-label';
    const tag = '<engram-src id="123e4567-e89b-42d3-a456-426614174000"/>';
    const agentContent = `${tag}\n\nA direct agent update.`;
    const senderDisplayName = 'Review — helper with a deliberately long display name';
    const prompt = row(sessionKey, 'prompt', 'Please review this.', {
      seq: 1, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 1,
    });
    const agent = row(sessionKey, 'direct-agent', agentContent, {
      seq: 2, role: 'user', sender: 'agent:helper', messageType: 'agent', turnSeq: 1,
      raw: { source: 'fixture', id: 'direct-agent', senderDisplayName },
    });
    const answer = row(sessionKey, 'answer', 'Answer', {
      seq: 3, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: prompt.id, turnSeq: 1,
      turnIncludesHuman: true,
    });
    const runtime = new FakeRuntime(sessionKey, { records: [prompt, agent, answer], provenanceAvailable: false });
    const componentStyles = document.createElement('style');
    componentStyles.textContent = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf8')
      .replace("@import './theme.css';", '');
    document.head.append(componentStyles);
    try {
      const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

      const pill = view.container.querySelector<HTMLElement>('[data-record-key="message:direct-agent"]')!;
      expect(pill.getAttribute('aria-label')).toBe(`${senderDisplayName}: A direct agent update.`);
      const senderChip = pill.querySelector<HTMLElement>('.tb-chat-activity-pill-sender')!;
      const senderName = senderChip.querySelector<HTMLElement>('.tb-chat-activity-pill-sender-name')!;
      expect(senderName.textContent).toBe(senderDisplayName);
      const rules = Array.from(componentStyles.sheet!.cssRules);
      const senderRule = rules.find(rule => rule.cssText.startsWith('.tb-chat-activity-pill-sender-name')) as CSSStyleRule;
      const narrowRule = rules.find(rule => rule.cssText.startsWith('@media (max-width: 540px)') &&
        rule.cssText.includes('tb-chat-activity-pill-sender-name')) as CSSMediaRule;
      const narrowSenderRule = Array.from(narrowRule.cssRules)
        .find(rule => rule.cssText.startsWith('.tb-chat-activity-pill-sender-name')) as CSSStyleRule;
      const messageRule = rules.find(rule => rule.cssText.startsWith('.tb-chat-activity-pill-text')) as CSSStyleRule;
      expect(senderRule.style.textOverflow).toBe('ellipsis');
      expect(senderRule.style.whiteSpace).toBe('nowrap');
      expect(narrowSenderRule.style.maxWidth).toBe('min(36vw, 12rem)');
      expect(messageRule.style.flex).toBe('1 1 auto');
      expect(messageRule.style.minWidth).toBe('0');
      expect(pill.querySelector('.tb-chat-activity-pill-indigo svg')).toBeTruthy();
      expect(pill.querySelector('.tb-chat-activity-pill-meta')).toBeNull();
      expect(pill.querySelector('.tb-chat-activity-pill-text')?.textContent).toBe('A direct agent update.');
      expect(pill.textContent).not.toContain(tag);

      fireEvent.click(within(pill).getByRole('button', { name: /Show full message/ }));
      expect(pill.querySelector('[data-activity-message-content]')?.textContent).toBe('A direct agent update.');
      expect(runtime.getSnapshot().records.find(record => record.id === agent.id)?.content).toBe(agentContent);
    } finally {
      componentStyles.remove();
    }
  });

  it('keeps owner-scoped activity while preserving human exchanges across pages, live updates, and reconnects', async () => {
    const sessionKey = 'conversation-without-provenance';
    const firstPage = visibilityMix(sessionKey, 'first-page');
    const unprovenAgent = row(sessionKey, 'unproven-agent', 'An unproven assistant reply', {
      role: 'assistant', sender: 'agent:external', messageType: 'chat', turnSeq: 10,
    });
    const unprovenSelectedReply = row(sessionKey, 'unproven-selected-reply', 'A selected reply without a provable trigger', {
      role: 'assistant', messageType: 'assistant', turnSeq: 12,
    });
    const unlinkedSelectedReply = row(sessionKey, 'unlinked-selected-reply', 'A selected reply without a parent link', {
      role: 'assistant', sender: 'assistant-service', messageType: 'assistant', turnSeq: 13,
    });
    const unprovenHuman = row(sessionKey, 'unproven-human', 'An unproven user row', {
      role: 'user', messageType: 'chat',
    });
    const olderPage = visibilityMix(sessionKey, 'older-page');
    const runtime = new FakeRuntime(sessionKey, {
      records: [...firstPage, unprovenAgent, unprovenSelectedReply, unlinkedSelectedReply, unprovenHuman],
      provenanceAvailable: false,
    });
    runtime.olderPages.push({ records: olderPage, provenance: [], hasOlder: false });

    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const log = screen.getByRole('log');
    expectVisibilityMix(log, 'first-page');
    expect(within(log).queryByText('Hidden assistant substrate marker first-page')).toBeNull();
    expect(within(log).queryByText('Hidden agent wake first-page')).toBeNull();
    expect(within(log).queryByText('Hidden process notice first-page')).toBeNull();
    expect(within(log).queryByText('An unproven assistant reply')).toBeNull();
    expect(within(log).getByText('A selected reply without a provable trigger')).toBeTruthy();
    expect(within(log).getByText('A selected reply without a parent link')).toBeTruthy();
    expect(within(log).getByText('An unproven user row')).toBeTruthy();
    expect(within(log).getByText('An unproven user row').closest('article')?.getAttribute('aria-label'))
      .toBe('Message from User');

    act(() => runtime.update({ hasOlder: true }));
    await waitFor(() => expect(within(log).getByText('Human exchange older-page')).toBeTruthy());
    expectVisibilityMix(log, 'older-page');

    const liveUpdate = visibilityMix(sessionKey, 'live-update');
    act(() => runtime.update({ records: [...runtime.getSnapshot().records, ...liveUpdate] }));
    expectVisibilityMix(log, 'live-update');

    act(() => runtime.update({ status: 'stale', generation: 2 }));
    const reconnect = visibilityMix(sessionKey, 'reconnect');
    runtime.rebuildSnapshots.push({
      status: 'ready', generation: 3, provenanceAvailable: false, provenance: [], activeTurn: undefined,
      records: [...runtime.getSnapshot().records, ...reconnect],
    });
    await act(async () => runtime.rebuild());
    expect(runtime.rebuildCalls).toBe(1);
    expectVisibilityMix(log, 'reconnect');
    expect(within(log).getByText('An unproven user row')).toBeTruthy();
    expect(within(log).getByText('Human exchange first-page')).toBeTruthy();
    expect(within(log).getByText('Human exchange older-page')).toBeTruthy();
    expect(within(log).getByText('Human exchange live-update')).toBeTruthy();
    expect(runtime.getSnapshot().records.map((record) => record.id)).toEqual(expect.arrayContaining([
      'first-page-marker', 'first-page-agent-wake', 'first-page-agent-reply', 'first-page-batch',
      'older-page-marker', 'older-page-agent-wake', 'older-page-agent-reply', 'older-page-batch',
      'live-update-marker', 'live-update-agent-wake', 'live-update-agent-reply', 'live-update-batch',
      'reconnect-marker', 'reconnect-agent-wake', 'reconnect-agent-reply', 'reconnect-batch',
    ]));
  });

  it('keeps unmarked user rows and unresolved replies visible while older history loads', async () => {
    const sessionKey = 'unresolved-reply-parent';
    const exactSenderHuman = row(sessionKey, 'exact-sender-human', 'A message with an exact principal sender', {
      role: 'user', sender: 'user:person', messageType: 'chat',
    });
    const nullSenderHuman = row(sessionKey, 'null-sender-human', 'A human message with a null sender', {
      role: 'user', messageType: 'chat', raw: { source: 'fixture', id: 'null-sender-human', sender: null },
    });
    const unknownSender = row(sessionKey, 'unknown-sender', 'An absent sender stays visible without identity proof', {
      role: 'user', messageType: 'chat',
      clientMessageId: 'client-unknown', deviceId: 'unknown-device',
    });
    const nullLinkReply = row(sessionKey, 'null-link-reply', 'A reply without a parent link', {
      role: 'assistant', sender: 'assistant-service', messageType: 'assistant', replyToMessageId: undefined,
    });
    const unloadedParentReply = row(sessionKey, 'unloaded-parent-reply', 'A reply whose parent is not loaded', {
      role: 'assistant', sender: 'assistant-service', messageType: 'assistant', replyToMessageId: 'older-agent-trigger', turnSeq: 50,
    });
    const runtime = new FakeRuntime(sessionKey, {
      records: [exactSenderHuman, nullSenderHuman, unknownSender, nullLinkReply, unloadedParentReply],
      hasOlder: true,
    });
    runtime.olderPages = [{ records: [row(sessionKey, 'older-agent-trigger', 'An older agent wake', {
      role: 'user', sender: 'agent:external', messageType: 'agent', turnSeq: 50,
    })], provenance: [], hasOlder: false }];

    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const log = screen.getByRole('log');
    expect(within(log).getByText('A human message with a null sender')).toBeTruthy();
    const unmarkedBubble = within(log).getByText('A human message with a null sender').closest('article')!;
    expect(unmarkedBubble.getAttribute('aria-label')).toBe('Message from User');
    expect(within(unmarkedBubble).getByText('User')).toBeTruthy();
    const exactBubble = within(log).getByText('A message with an exact principal sender').closest('article')!;
    expect(exactBubble.getAttribute('aria-label')).toBe('Message from You');
    expect(within(exactBubble).getByText('You')).toBeTruthy();
    expect(within(log).getByText('An absent sender stays visible without identity proof')).toBeTruthy();
    expect(within(log).getByText('A reply without a parent link')).toBeTruthy();
    expect(within(log).getByText('A reply whose parent is not loaded')).toBeTruthy();

    await waitFor(() => expect(runtime.getSnapshot().hasOlder).toBe(false));
    expect(runtime.loadOlderCalls).toBe(1);
    expect(within(log).queryByText('An older agent wake')).toBeNull();
    expect(within(log).queryByText('A reply whose parent is not loaded')).toBeNull();
    expect(within(log).getByText('A human message with a null sender')).toBeTruthy();
    expect(within(log).getByText('An absent sender stays visible without identity proof')).toBeTruthy();
    expect(within(log).getByText('A reply without a parent link')).toBeTruthy();
    expect(runtime.getSnapshot().records.map((record) => record.id)).toContain('unloaded-parent-reply');
  });

  it.each([
    { scenario: 'the anchored reply survives its human parent loading', excluded: false, visibleOlder: false },
    { scenario: 'an agent reply is classified after its parent loads alongside visible history', excluded: true, visibleOlder: true },
    { scenario: 'an agent reply is classified after its parent loads on a hidden-only page', excluded: true, visibleOlder: false },
  ])('preserves the reading viewport when $scenario', async ({ excluded, visibleOlder }) => {
    const sessionKey = 'reading-anchor';
    const parent = row(sessionKey, 'parent', 'The previously unloaded trigger', {
      seq: 40, turnSeq: 40, role: 'user', sender: excluded ? 'agent:external' : 'user:person',
      messageType: excluded ? 'agent' : 'chat',
    });
    const reply = row(sessionKey, 'anchored-reply', 'The first visible reply', {
      seq: 50, turnSeq: 40, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: parent.id,
    });
    const sequences: Record<string, number> = { earlier: 5, 'older-a': 10, 'older-b': 20, 'older-c': 30, reading: 60, following: 70, newest: 80 };
    const human = (id: string) => row(sessionKey, id, `Human message ${id}`, {
      seq: sequences[id], role: 'user', sender: 'user:person', messageType: 'chat',
    });
    const runtime = new FakeRuntime(sessionKey, {
      records: [reply, human('reading'), human('following'), human('newest')],
      provenanceAvailable: false,
      hasOlder: true,
    });
    runtime.olderPages.push({
      records: [...(visibleOlder ? [human('older-a'), human('older-b'), human('older-c')] : []), parent],
      provenance: [], hasOlder: false,
    });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const log = screen.getByRole('log');
    const reading = within(log).getByText('Human message reading').closest('article')!;
    const following = within(log).getByText('Human message following').closest('article')!;
    expect(within(log).getByText('The first visible reply')).toBeTruthy();

    // jsdom has no layout: model normal stacked rows, padding, and the browser's
    // scroll range. In particular, a negative scrollTop cannot preserve a row.
    const rows = () => [...log.querySelectorAll<HTMLElement>(':scope > .tb-chat-message-content > [data-record-key]')];
    const topSpace = () => Number.parseFloat(log.style.getPropertyValue('--tb-chat-anchor-space')) || 0;
    const height = () => 16 + topSpace() + rows().length * 92 + 200;
    let scrollTop = 20;
    Object.defineProperties(log, {
      clientHeight: { configurable: true, get: () => 180 },
      scrollHeight: { configurable: true, get: height },
      scrollTop: {
        configurable: true, get: () => scrollTop,
        set: (value: number) => { scrollTop = Math.max(0, Math.min(value, height() - 180)); },
      },
    });
    Object.defineProperty(log, 'scrollTo', { configurable: true, value: (options: ScrollToOptions) => { log.scrollTop = options.top ?? 0; } });
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === log) return new DOMRect(0, 100, 320, 180);
      const index = rows().indexOf(this);
      if (index >= 0) return new DOMRect(0, 100 + 16 + topSpace() + index * 92 - scrollTop, 320, 80);
      return originalBounds.call(this);
    });
    const viewportOffset = (element: HTMLElement) => element.getBoundingClientRect().top - log.getBoundingClientRect().top;
    try {
      fireEvent.wheel(log, { deltaY: -100 });
      fireEvent.scroll(log);
      const readingBefore = viewportOffset(reading);
      const followingBefore = viewportOffset(following);
      await waitFor(() => {
        expect(runtime.getSnapshot().records).toContain(parent);
        expect(runtime.getSnapshot().loadingOlder).toBe(false);
      });
      if (!excluded) expect(within(log).getByText('The first visible reply')).toBeTruthy();
      else expect(within(log).queryByText('The first visible reply')).toBeNull();
      expect(viewportOffset(reading)).toBe(readingBefore);
      expect(viewportOffset(following)).toBe(followingBefore);
      expect(log.scrollTop).toBeGreaterThanOrEqual(0);
      expect(runtime.getSnapshot().records).toContain(reply);

      if (excluded && !visibleOlder) {
        // The newly visible provisional row is removed when its nonhuman parent arrives.
        // Compensating space preserves the reading anchor when scrollTop is clamped.
        expect(topSpace()).toBeGreaterThan(0);
        // A later visible page can be read without reclassifying shown content.
        runtime.olderPages.push({ records: [human('earlier')], provenance: [], hasOlder: false });
        act(() => runtime.update({ hasOlder: true }));
        fireEvent.scroll(log);
        await within(log).findByText('Human message earlier');
        expect(topSpace()).toBe(0);
        expect(viewportOffset(reading)).toBe(readingBefore);
        expect(viewportOffset(following)).toBe(followingBefore);
      }
    } finally {
      bounds.mockRestore();
    }
  });

  it('shows unresolved replies immediately and preserves the reading anchor as older provenance settles', async () => {
    const sessionKey = 'history-reclassification';
    const parents = Array.from({ length: 14 }, (_, index) => row(
      sessionKey, `agent-parent-${index + 1}`, `Hidden activity ${index + 1}`,
      { seq: index + 1, turnSeq: index + 1, role: 'user', sender: 'agent:external', messageType: 'agent' },
    ));
    const replies = parents.map((parent, index) => row(
      sessionKey, `provisional-reply-${index + 1}`, `Provisional reply ${index + 1}`,
      { seq: 30 + index, turnSeq: index + 1, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: parent.id },
    ));
    const reading = row(sessionKey, 'reading', 'Human message at the end of filtered history', {
      seq: 80, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 80,
    });
    const following = row(sessionKey, 'following', 'Human message following filtered history', {
      seq: 90, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 90,
    });
    const latest = row(sessionKey, 'latest', 'Latest human message', {
      seq: 100, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 100,
    });
    const runtime = new FakeRuntime(sessionKey, { records: [...replies, reading, following, latest], hasOlder: true });
    const page = { records: parents, provenance: [] as TurnProvenance[], hasOlder: false };
    let releasePage!: () => void;
    const pageGate = new Promise<void>(resolve => { releasePage = resolve; });
    let pageComplete: Promise<void> | undefined;
    runtime.loadOlder = () => {
      runtime.loadOlderCalls++;
      pageComplete = (async () => {
        runtime.update({ loadingOlder: true });
        await pageGate;
        runtime.update({ records: [...page.records, ...runtime.getSnapshot().records], hasOlder: page.hasOlder, loadingOlder: false });
      })();
      return pageComplete;
    };
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const log = screen.getByRole('log');
    const layout = installViewportLayout(log);
    const newest = within(log).getByText('Latest human message').closest('article')!;
    expect(within(log).getByText('Provisional reply 1')).toBeTruthy();
    layout.setScrollTop(0);
    const newestBefore = layout.offset(newest);

    try {
      fireEvent.wheel(log, { deltaY: -100 });
      fireEvent.scroll(log);
      await waitFor(() => expect(runtime.loadOlderCalls).toBe(1));
      await waitFor(() => expect(runtime.getSnapshot().loadingOlder).toBe(true));

      await act(async () => {
        releasePage();
        await pageComplete;
      });
      await waitFor(() => expect(runtime.getSnapshot().loadingOlder).toBe(false));

      expect(within(log).queryByText('Provisional reply 1')).toBeNull();
      expect(layout.offset(newest)).toBe(newestBefore);
      expect(layout.scrollTop).toBe(0);
      // Removing the provisional rows above the reader needs compensation when
      // the browser cannot use a negative scrollTop.
      expect(layout.anchorSpace).toBeGreaterThan(0);
      expect(runtime.getSnapshot().records).toContain(replies[0]);
      expect(runtime.getSnapshot().hasOlder).toBe(false);
    } finally {
      releasePage();
      layout.restore();
    }
  });

  it('keeps the reader anchored when a truthful provenance alert appears', async () => {
    const sessionKey = 'alert-anchor';
    const parent = row(sessionKey, 'human-parent', 'Human request', {
      seq: 10, turnSeq: 7, role: 'user', sender: 'user:person', messageType: 'chat',
    });
    const reply = row(sessionKey, 'conflicting-reply', 'Reply with conflicting provenance', {
      seq: 20, turnSeq: 7, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: parent.id,
      turnIncludesHuman: false,
    });
    const reading = row(sessionKey, 'alert-reading', 'Message being read', {
      seq: 30, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 30,
    });
    const following = row(sessionKey, 'alert-following', 'Message after reading', {
      seq: 40, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 40,
    });
    const runtime = new FakeRuntime(sessionKey, { records: [reply, reading, following], hasOlder: true });
    runtime.olderPages = [{ records: [parent], provenance: [], hasOlder: false }];
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const log = screen.getByRole('log');
    const layout = installViewportLayout(log);
    const anchor = within(log).getByText('Message being read').closest('article')!;
    layout.setScrollTop(10);
    const anchorBefore = layout.offset(anchor);

    try {
      fireEvent.wheel(log, { deltaY: -100 });
      fireEvent.scroll(log);
      await waitFor(() => expect(runtime.getSnapshot().records).toContain(parent));

      expect(within(log).getByText('Some message sources could not be interpreted. Conversation filtering is incomplete.'))
        .toBeTruthy();
      expect(within(log).getByRole('alert').classList.contains('tb-chat-caption-danger')).toBe(true);
      expect(within(log).getByText('Reply with conflicting provenance')).toBeTruthy();
      expect(layout.offset(anchor)).toBe(anchorBefore);
    } finally {
      layout.restore();
    }
  });

  it('does not revisit loaded message rows while typing with a production-sized history', async () => {
    const sessionKey = 'long-conversation';
    const messages = Array.from({ length: 1200 }, (_, index) => row(
      sessionKey, `message-${index + 1}`, `Message ${index + 1}`,
      { seq: index + 1, rowVersion: index + 1, role: 'user', sender: 'user:person', turnSeq: index + 1 },
    ));
    const provenanceRows = messages.map((message, index) => provenance(
      index + 1, sessionKey, message.id, 'user:person', message,
    ));
    const runtime = new FakeRuntime(sessionKey, { records: messages, provenance: provenanceRows });
    const renderMessage = vi.fn(() => undefined);
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} renderMessage={renderMessage} />);

    const composer = await screen.findByRole('textbox', { name: 'Message to Research assistant' });
    expect(await within(screen.getByRole('log')).findByText('Message 1200')).toBeTruthy();
    expect(renderMessage).toHaveBeenCalledTimes(messages.length);

    fireEvent.change(composer, { target: { value: 'a' } });
    fireEvent.change(composer, { target: { value: 'a draft' } });
    fireEvent.change(composer, { target: { value: 'a draft in progress' } });

    expect(renderMessage).toHaveBeenCalledTimes(messages.length);
    expect(composer).toHaveProperty('value', 'a draft in progress');
  });

  it('keeps focus, selection, and draft across stale refreshes while hiding exact target details in notices', () => {
    const sessionKey = 'selected-session';
    const human = row(sessionKey, 'human', 'Initial question', { role: 'user', sender: 'user:person', turnSeq: 4 });
    const answer = row(sessionKey, 'answer', 'Initial reply', { turnSeq: 4, messageType: 'assistant', replyToMessageId: human.id });
    const humanTurn = provenance(4, sessionKey, human.id, 'user:person', human);
    const runtime = new FakeRuntime(sessionKey, { records: [human, answer], provenance: [humanTurn] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    composer.focus();
    fireEvent.change(composer, { target: { value: 'keep this draft' } });
    composer.setSelectionRange(5, 5);

    const nextHuman = row(sessionKey, 'new-human', 'A new question', { role: 'user', sender: 'user:person', turnSeq: 5 });
    const nextReply = row(sessionKey, 'new-answer', 'A new answer', {
      turnSeq: 5, messageType: 'assistant', replyToMessageId: nextHuman.id,
    });
    const nextTurn = provenance(5, sessionKey, nextHuman.id, 'user:person', nextHuman);
    act(() => {
      runtime.state = { ...runtime.state, status: 'stale', statusDetail: `Selected ${sessionKey} at https://gateway.example`,
        records: [...runtime.state.records, nextHuman, nextReply], provenance: [...(runtime.state.provenance || []), nextTurn] };
      for (const listener of runtime.listeners) listener();
    });

    const log = screen.getByRole('log');
    expect(within(log).getByText('A new question')).toBeTruthy();
    expect(within(log).getByText('A new answer')).toBeTruthy();
    expect(screen.queryByText(/Reconnecting|conversation may be out of date/)).toBeNull();
    const reconnectingButton = screen.getByRole('button', { name: 'Connection status: Reconnecting. Show details' });
    expect(reconnectingButton.querySelector('.tb-chat-status-dot')?.classList.contains('tb-chat-status-stale')).toBe(true);
    expect(screen.queryByText(/selected-session|gateway\.example/)).toBeNull();
    expect(composer.disabled).toBe(false);
    expect(composer.value).toBe('keep this draft');
    expect(composer.selectionStart).toBe(5);
    expect(document.activeElement).toBe(composer);
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false);

    act(() => {
      runtime.state = { ...runtime.state, status: 'ready', statusDetail: undefined };
      for (const listener of runtime.listeners) listener();
    });
    const connectedButton = screen.getByRole('button', { name: 'Connection status: Connected. Show details' });
    expect(connectedButton.querySelector('.tb-chat-status-dot')?.classList.contains('tb-chat-status-ready')).toBe(true);
    expect(screen.queryByText(/Reconnecting|conversation may be out of date/)).toBeNull();
    expect(composer.value).toBe('keep this draft');
    expect(composer.selectionStart).toBe(5);
    expect(document.activeElement).toBe(composer);
  });

  it('keeps exact connection identity in the accessible popup and offers reconnect only when disconnected', () => {
    const runtime = new FakeRuntime('exact-session');
    render(<TightbeamChat sessionKey="exact-session" adapter={adapterFor(runtime)} />);
    const statusButton = screen.getByRole('button', { name: 'Connection status: Connected. Show details' });
    fireEvent.click(statusButton);
    const connected = screen.getByRole('dialog', { name: 'Connection details' });
    expect(within(connected).getByText('https://gateway.example')).toBeTruthy();
    expect(within(connected).getByText('exact-session')).toBeTruthy();
    expect(within(connected).getByText('Model A')).toBeTruthy();
    expect(within(connected).getByText('Harness A')).toBeTruthy();
    expect(within(connected).queryByRole('button', { name: 'Reconnect' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Connection details' })).toBeNull();
    expect(document.activeElement).toBe(statusButton);

    act(() => {
      runtime.state = { ...runtime.state, status: 'error', statusDetail: 'Connection lost for exact-session' };
      for (const listener of runtime.listeners) listener();
    });
    expect(screen.queryByText(/Disconnected|Connecting|Reconnecting/)).toBeNull();
    expect(screen.queryByText(/exact-session/)).toBeNull();
    const disconnectedButton = screen.getByRole('button', { name: 'Connection status: Disconnected. Show details' });
    expect(disconnectedButton.querySelector('.tb-chat-status-dot')?.classList.contains('tb-chat-status-error')).toBe(true);
    fireEvent.click(disconnectedButton);
    const disconnected = screen.getByRole('dialog', { name: 'Connection details' });
    expect(within(disconnected).queryByText('Disconnected')).toBeNull();
    expect(within(disconnected).queryByText('Connection lost for exact-session')).toBeNull();
    fireEvent.click(within(disconnected).getByRole('button', { name: 'Reconnect' }));
    expect(runtime.rebuildOptions).toEqual([{ restart: true }]);
  });

  it('shows live-feed reconnecting, sustained failure, and recovery through the status dot', () => {
    const runtime = new FakeRuntime('feed-status', { status: 'ready', liveError: 'Changes socket closed',
      liveConnectionState: 'reconnecting' });
    render(<TightbeamChat sessionKey="feed-status" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'keep this draft while the feed reconnects' } });

    const reconnectingButton = screen.getByRole('button', { name: 'Connection status: Reconnecting. Show details' });
    expect(reconnectingButton.querySelector('.tb-chat-status-dot')?.classList.contains('tb-chat-status-stale')).toBe(true);
    expect(screen.queryByText(/Reconnecting|Live updates are reconnecting|conversation may be out of date/)).toBeNull();
    fireEvent.click(reconnectingButton);
    const details = screen.getByRole('dialog', { name: 'Connection details' });
    expect(within(details).queryByText(/Changes socket closed|Live updates:/)).toBeNull();
    expect(within(details).getByRole('button', { name: 'Reconnect' })).toBeTruthy();

    act(() => runtime.update({ liveError: undefined, liveConnectionState: 'disconnected' }));
    const disconnectedButton = screen.getByRole('button', { name: 'Connection status: Disconnected. Show details' });
    expect(disconnectedButton.querySelector('.tb-chat-status-dot')?.classList.contains('tb-chat-status-error')).toBe(true);
    expect(within(details).getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(composer.value).toBe('keep this draft while the feed reconnects');
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false);

    act(() => runtime.update({ liveError: undefined, liveConnectionState: 'connected' }));
    const connectedButton = screen.getByRole('button', { name: 'Connection status: Connected. Show details' });
    expect(connectedButton.querySelector('.tb-chat-status-dot')?.classList.contains('tb-chat-status-ready')).toBe(true);
    expect(screen.queryByText(/Reconnecting|Live updates are reconnecting|conversation may be out of date/)).toBeNull();
    expect(composer.value).toBe('keep this draft while the feed reconnects');
  });

  it('keeps the authorization-loss explanation with the red connection dot', () => {
    const runtime = new FakeRuntime('unauthorized-status', { status: 'unauthorized' });
    render(<TightbeamChat sessionKey="unauthorized-status" adapter={adapterFor(runtime)} />);

    expect(screen.getByRole('alert').textContent).toContain('Chat is no longer authorized. The message was not sent.');
    const disconnectedButton = screen.getByRole('button', {
      name: 'Connection status: Chat is no longer authorized. The message was not sent. Show details',
    });
    expect(disconnectedButton.querySelector('.tb-chat-status-dot')?.classList.contains('tb-chat-status-unauthorized')).toBe(true);
    expect(screen.queryByText(/^Disconnected$/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry message' })).toBeNull();
  });

  it('renders only typed live activity with principal proof and clears captions at turn end', () => {
    const sessionKey = 'caption-session';
    const human = row(sessionKey, 'human', 'A question', { role: 'user', sender: 'user:person', turnSeq: 20 });
    const runtime = new FakeRuntime(sessionKey, { records: [human] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Draft remains' } });
    field.focus(); field.setSelectionRange(3, 5);
    const show = (patch: Partial<CanonicalTurn>, records: ConversationRecord[] = [human]) => {
      const active = createTurnProvenance({ ...turn(20, sessionKey, human.id, 'user:unrelated', 'running'), ...patch }, records, 'person', 'person');
      act(() => runtime.update({ activeTurn: active, activityTurnStateAvailable: true }));
    };
    show({ triggerSource: 'mike' });
    const activeCaption = screen.getByRole('status', { name: 'Active turn: Replying to you' });
    expect(activeCaption.classList.contains('tb-chat-caption-neutral')).toBe(true);
    expect(activeCaption.querySelector('.tb-chat-active-caption-icon svg')).toBeTruthy();
    expect(activeCaption.textContent).toContain('Replying to you');
    show({ triggerSource: 'mike', messageId: 'unloaded' }, []);
    expect(screen.getByRole('status', { name: 'Active turn: Replying to you' })).toBeTruthy();
    show({ triggerSource: 'batch', batchMemberCount: 2 });
    expect(screen.getByRole('status', { name: 'Active turn: Processing message batch' })).toBeTruthy();
    show({ triggerSource: 'batch', batchMemberCount: 1 });
    expect(screen.getByRole('status', { name: 'Active turn: Replying to you' })).toBeTruthy();
    show({ triggerSource: 'batch', batchMemberCount: 1, messageId: 'unloaded' }, []);
    expect(screen.queryByRole('status', { name: /^Active turn:/ })).toBeNull();
    for (const triggerSource of ['agent', 'process', 'other', undefined] as const) {
      show({ triggerSource });
      expect(screen.getByRole('status', { name: 'Active turn: Other activity' })).toBeTruthy();
    }
    const agentTrigger = row(sessionKey, 'agent-trigger', 'A task', { role: 'user', sender: 'agent:researcher',
      messageType: 'agent', raw: { senderDisplayName: 'Researcher' } });
    const namedAgent = createTurnProvenance({ ...turn(21, sessionKey, agentTrigger.id, 'untrusted-origin', 'running'),
      triggerSource: 'agent' }, [agentTrigger], 'person', 'person');
    act(() => runtime.update({ activeTurn: namedAgent }));
    expect(screen.getByRole('status', { name: 'Active turn: Researcher' })).toBeTruthy();
    const processTrigger = row(sessionKey, 'process-trigger', 'An event', { role: 'user', sender: 'process:events',
      messageType: 'queue.waiting' });
    const typedProcess = createTurnProvenance({ ...turn(22, sessionKey, processTrigger.id, 'untrusted-origin', 'running'),
      triggerSource: 'process' }, [processTrigger], 'person', 'person');
    act(() => runtime.update({ activeTurn: typedProcess }));
    expect(screen.getByRole('status', { name: 'Active turn: queue waiting' })).toBeTruthy();
    const genericProcess = { ...processTrigger, messageType: 'substrate' };
    const untypedProcess = createTurnProvenance({ ...turn(23, sessionKey, genericProcess.id, 'untrusted-origin', 'running'),
      triggerSource: 'process' }, [genericProcess], 'person', 'person');
    act(() => runtime.update({ activeTurn: untypedProcess }));
    expect(screen.getByRole('status', { name: 'Active turn: Other activity' })).toBeTruthy();
    for (const status of ['queued', 'completed', 'failed', 'canceled']) {
      show({ triggerSource: 'mike', status });
      expect(screen.queryByRole('status', { name: /^Active turn:/ })).toBeNull();
    }
    expect(field.value).toBe('Draft remains');
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([3, 5]);
  });

  it('uses a five-second working pulse with a dim floor and a steady reduced-motion state', () => {
    expect(workingStateOpacity(0)).toBeCloseTo(0.4, 3);
    expect(workingStateOpacity(850)).toBeCloseTo(0.7, 3);
    expect(workingStateOpacity(1700)).toBeCloseTo(1, 3);
    expect(workingStateOpacity(1800)).toBeCloseTo(1, 3);
    expect(workingStateOpacity(3200)).toBeCloseTo(0.7, 3);
    expect(workingStateOpacity(4700)).toBeCloseTo(0.4, 3);
    expect(workingStateOpacity(5000)).toBeCloseTo(0.4, 3);

    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({
      matches: true, addEventListener() {}, removeEventListener() {},
    }) });
    try {
      const sessionKey = 'reduced-motion-caption';
      const human = row(sessionKey, 'human', 'A question', { role: 'user', sender: 'user:person', turnSeq: 1 });
      const activeTurn = createTurnProvenance({ ...turn(1, sessionKey, human.id, 'user:person', 'running'),
        triggerSource: 'mike' }, [human], 'person', 'person');
      const runtime = new FakeRuntime(sessionKey, { records: [human], activeTurn, activityTurnStateAvailable: true });
      render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
      expect(screen.getByRole('status', { name: 'Active turn: Replying to you' }).style.opacity).toBe('1');
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('renders every delivered non-tool activity kind as a typed pill', () => {
    const sessionKey = 'activity-pill-layout';
    const human = row(sessionKey, 'human', 'Question', {
      seq: 1, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 1,
    });
    // This fixture has a filing notice but no readable attest note or stored summary.
    const attest = row(sessionKey, 'attest-notice',
      'Attest att_12345678-1111-4111-8111-123456789abc (completion) was filed on assignment asg_abcdef12-1111-4111-8111-123456789abc.', {
        seq: 2, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
      });
    const assignment = row(sessionKey, 'assignment-notice',
      '[assignment: asg_23456789-1111-4111-8111-123456789abc]\nReview the next change', {
        seq: 3, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
      });
    const child = row(sessionKey, 'child-notice', [
      'terminal-child-owner-notification',
      'source_kind="attest"', 'source_token="att_12345678"', 'assignment_id="asg_abcdef12"',
      'work_item_id=null', 'child_session_key="agent:helper s_34567890-1111-4111-8111-123456789abc"',
      'outcome="completed"', 'terminal_at=12',
    ].join('\n'), { seq: 4, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1 });
    const wake = row(sessionKey, 'wake-notice', '[woke: fallback deadline]\nReview the result', {
      seq: 5, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const reminder = row(sessionKey, 'quiet-reminder', 'Quiet for 3 h · Background assignment', {
      seq: 6, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const inactiveAssignment = row(sessionKey, 'inactive-assignment',
      'Assignment asg_456789ab-1111-4111-8111-123456789abc (Background task) has had no recorded activity since 12', {
      seq: 7, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const decision = row(sessionKey, 'decision',
      'Question dr_12345678-1111-4111-8111-123456789abc from session:agent:helper\nCan the change ship?', {
      seq: 8, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const answeredDecision = row(sessionKey, 'answered-decision',
      'Question dr_23456789-1111-4111-8111-123456789abc was answered by user:person.\nYou asked: Can it ship?\nAnswer: Yes.', {
      seq: 9, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const expiredDecision = row(sessionKey, 'expired-decision', 'Decision request dr_34567890-1111-4111-8111-123456789abc expired', {
      seq: 10, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const workItem = row(sessionKey, 'work-item',
      'route it or icebox it — work item wi_456789ab-1111-4111-8111-123456789abc: Improve the transcript', {
      seq: 11, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const sessionNotice = row(sessionKey, 'session-notice', 'Session agent:helper s_56789abc-1111-4111-8111-123456789abc was retired', {
      seq: 12, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const turnFailure = row(sessionKey, 'turn-failure', '[turn failed]\nThe agent could not complete the reply', {
      seq: 13, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 13,
    });
    const remedy = row(sessionKey, 'remedy', 'Review requested changes for asg_6789abcd-1111-4111-8111-123456789abc', {
      seq: 14, role: 'user', sender: 'remedy:completion-requires-review', messageType: 'substrate', turnSeq: 1,
    });
    const unknownActivity = row(sessionKey, 'unknown-activity', 'A notice whose kind is not known', {
      seq: 15, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const processActivity = row(sessionKey, 'process-activity', 'A process event', {
      seq: 16, role: 'user', sender: 'process:events', messageType: 'process', turnSeq: 1,
    });
    const sourceActivity = row(sessionKey, 'source-activity', 'An update from another agent', {
      seq: 17, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
      raw: { source: 'agent:helper', id: 'source-activity' },
    });
    const agent = row(sessionKey, 'agent-note', 'A short update', {
      seq: 18, role: 'user', sender: 'agent:helper', messageType: 'agent', turnSeq: 1,
      raw: { source: 'fixture', id: 'agent-note', senderDisplayName: 'Review helper' },
    });
    const agentFollowup = row(sessionKey, 'agent-followup', 'The review is ready', {
      seq: 19, role: 'user', sender: 'agent:helper', messageType: 'agent', turnSeq: 1,
      raw: { source: 'fixture', id: 'agent-followup', senderDisplayName: 'Review helper' },
    });
    const answer = row(sessionKey, 'answer', 'Answer', {
      seq: 20, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: human.id, turnSeq: 1,
    });
    const runtime = new FakeRuntime(sessionKey, { records: [human, attest, assignment, child, wake, reminder,
      inactiveAssignment, decision, answeredDecision, expiredDecision, workItem, sessionNotice, turnFailure,
      remedy, unknownActivity, processActivity, sourceActivity, agent, agentFollowup, answer], provenanceAvailable: false,
      liveRailDenials: [{ id: 'denial-1', sessionKey, principal: `session:${sessionKey}`, verb: 'attest',
        rule: 'completion-requires-verification', origin: 'chat', payload: { verb: 'attest',
          rule: 'completion-requires-verification' }, tailEligibleAtArrival: true, occurredAt: 1,
        afterMessageSeq: 1, arrivalOrder: 1 }],
      historyRailDenials: [{ id: 'history-denial-1', sessionKey, principal: `session:${sessionKey}`,
        verb: 'attest', rule: 'completion-requires-verification', origin: 'chat',
        payload: { rule: 'completion-requires-verification', verb: 'attest' }, occurredAt: 1, afterMessageSeq: 1 }] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const log = screen.getByRole('log');
    fireEvent.click(within(log).getByRole('button', { name: 'Show earlier activity' }));
    const pillFor = (text: string) => within(log).getByRole('note', { name: text });
    const attestRow = pillFor('Attest: Filed completion on assignment asg_abcd, att_1234');
    expect(attestRow.classList.contains('tb-chat-activity-pill-row')).toBe(true);
    expect(attestRow.querySelector('.tb-chat-activity-pill')?.textContent).toContain('Attest');
    expect(attestRow.textContent).toContain('Filed completion on assignment asg_abcd');
    expect(attestRow.querySelector('.tb-chat-summary-marker')).toBeNull();

    const assignmentRow = pillFor('Assignment: New · Review the next change, asg_2345');
    expect(assignmentRow.querySelector('.tb-chat-activity-pill')?.textContent).toContain('Assignment');
    expect(assignmentRow.textContent).toContain('New · Review the next change');

    const childRow = pillFor('Assignment: Child finished, s_3456');
    expect(childRow.textContent).toContain('Child finished');
    expect(childRow.textContent).toContain('s_3456');

    expect(pillFor('Wake: Review the result, fallback').querySelector('.tb-chat-activity-pill-purple')).toBeTruthy();
    const reminderFold = within(log).getByRole('button', {
      name: /Expand substrate activity run, 2 entries\. Latest: Assignment: No recent activity · Background task, asg_4567/,
    });
    expect(reminderFold.textContent).toContain('No recent activity · Background task');
    expect(reminderFold.querySelector('.tb-chat-activity-pill-amber')).toBeTruthy();
    expect(reminderFold.querySelector('.tb-chat-activity-bullet')).toBeNull();
    expect(reminderFold.querySelector('.tb-chat-tool-terminal-icon')).toBeNull();
    expect(reminderFold.classList.contains('tb-chat-activity-tool-run-toggle')).toBe(false);
    expect(reminderFold.firstElementChild?.classList.contains('tb-chat-activity-run-chevron')).toBe(true);
    expect(reminderFold.tagName).toBe('BUTTON');
    expect(reminderFold.getAttribute('aria-expanded')).toBe('false');
    expect(reminderFold.textContent).not.toContain('•');
    expect(reminderFold.textContent).not.toMatch(/[\[\]]/);
    expect(reminderFold.getAttribute('aria-label')).not.toMatch(/asg_456789ab/);
    expect(reminderFold.getAttribute('title')).toBe(
      'Assignment asg_456789ab-1111-4111-8111-123456789abc (Background task) has had no recorded activity since 12');
    fireEvent.click(reminderFold);
    expect(reminderFold.getAttribute('aria-expanded')).toBe('true');
    expect(reminderFold.firstElementChild?.classList.contains('tb-chat-activity-run-chevron')).toBe(true);
    expect(pillFor('Assignment: Quiet for 3 h · Background assignment').querySelector('.tb-chat-activity-pill-amber')).toBeTruthy();
    expect(pillFor('Assignment: No recent activity · Background task, asg_4567')).toBeTruthy();
    expect(pillFor('Decision: Needs a response · Can the change ship?, dr_1234')).toBeTruthy();
    expect(pillFor('Decision: Answered · Can it ship?, dr_2345').querySelector('.tb-chat-activity-pill-green')).toBeTruthy();
    expect(pillFor('Decision: Expired, dr_3456').querySelector('.tb-chat-activity-pill-slate')).toBeTruthy();
    expect(pillFor('Work item: Needs routing · Improve the transcript, wi_4567')).toBeTruthy();
    expect(pillFor('Session: Retired, s_5678')).toBeTruthy();
    expect(pillFor('Turn: The agent could not complete the reply, turn 13')).toBeTruthy();
    const remedyRow = within(log).getByRole('note', {
      name: 'Remedy: Review requested changes for asg_6789, asg_6789',
    });
    expect(remedyRow.querySelector('.tb-chat-activity-pill-orange')).toBeTruthy();
    const unknownRow = pillFor('Notice: A notice whose kind is not known');
    expect(unknownRow.querySelector('.tb-chat-activity-pill-blue svg')).toBeTruthy();
    expect(pillFor('System: A process event').querySelector('.tb-chat-activity-pill-purple svg')).toBeTruthy();
    expect(pillFor('Message: An update from another agent').querySelector('.tb-chat-activity-pill-indigo svg')).toBeTruthy();

    const agentFold = within(log).getByRole('button', { name: /Expand agent activity run, 2 entries/ });
    expect(agentFold.classList.contains('tb-chat-activity-pill-toggle')).toBe(true);
    expect(agentFold.querySelector('.tb-chat-activity-pill')?.textContent).toContain('Review helper');
    expect(agentFold.getAttribute('aria-label')).toContain('Latest: Review helper: The review is ready');
    expect(agentFold.textContent).toContain('The review is ready');
    fireEvent.click(agentFold);
    const agentRow = pillFor('Review helper: A short update');
    expect(agentRow.querySelector('.tb-chat-activity-pill')?.textContent).toBe('Review helper');
    expect(agentRow.querySelector('.tb-chat-activity-pill-indigo svg')).toBeTruthy();
    expect(agentRow.querySelector('.tb-chat-activity-pill-meta')).toBeNull();

    const refusedRow = pillFor('Refused: Completion needs a recorded verification first');
    expect(refusedRow.querySelector('.tb-chat-activity-pill-red')).toBeTruthy();
    expect(within(log).getAllByRole('note', { name: 'Refused: Completion needs a recorded verification first' }))
      .toHaveLength(1);

    for (const pill of within(log).getAllByRole('note').filter(note =>
      note.classList.contains('tb-chat-activity-pill-row'))) {
      expect(pill.querySelector('.tb-chat-activity-bullet')).toBeNull();
      expect(pill.textContent).not.toContain('•');
      expect(pill.textContent).not.toMatch(/[\[\]]/);
      expect(pill.textContent).not.toMatch(/\b(?:wi|asg|dr|att|s|w|c|tc)_[a-f0-9]{8}-/i);
    }
  });

  it('renders delivered outcome notices with distinct icons, tones and short wording', () => {
    const sessionKey = 'delivered-outcome-notices';
    const human = row(sessionKey, 'prompt', 'Review these changes', {
      seq: 1, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 1,
    });
    const notice = (id: string, seq: number, content: string) => row(sessionKey, id,
      `[from process:tightbeam]\n\n${content}`, {
      seq, role: 'assistant', sender: 'process:tightbeam', messageType: 'substrate', turnSeq: 1,
    });
    const reviewedClean = notice('reviewed-clean', 2,
      '[verdict filed: reviewed-clean on asg_12345678-1111-4111-8111-123456789abc: The change is ready]');
    const changesRequested = notice('changes-requested', 3,
      '[verdict filed: changes-requested on asg_23456789-1111-4111-8111-123456789abc: Correct the missing case]');
    const verificationFailed = notice('verification-failed', 4,
      '[verdict filed: verification-failed on asg_23456789-1111-4111-8111-123456789abc: The result did not verify]');
    const waitChallenged = notice('wait-challenged', 5,
      '[verdict filed: wait-challenged on asg_23456789-1111-4111-8111-123456789abc: The wait condition needs review]');
    const completion = notice('completion', 6,
      '[completion filed on asg_34567890-1111-4111-8111-123456789abc: Completed after the focused review]');
    const opened = notice('assignment-opened', 7,
      '[assignment opened: asg_456789ab-1111-4111-8111-123456789abc]');
    const closed = notice('assignment-closed', 8,
      '[assignment closed: asg_56789abc-1111-4111-8111-123456789abc — completed]');
    const reopened = notice('assignment-reopened', 9,
      '[assignment reopened: asg_67890abc-1111-4111-8111-123456789abc by session:agent:helper — Another review was requested]');
    const answer = row(sessionKey, 'answer', 'The change is ready', {
      seq: 10, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: human.id, turnSeq: 1,
    });
    const runtime = new FakeRuntime(sessionKey, {
      records: [human, reviewedClean, changesRequested, verificationFailed, waitChallenged,
        completion, opened, closed, reopened, answer],
      provenanceAvailable: false,
    });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const log = screen.getByRole('log');
    fireEvent.click(within(log).getByRole('button', { name: 'Show earlier activity' }));
    const pillFor = (name: string) => within(log).getByRole('note', { name });
    const cleanPill = pillFor('Verdict: Reviewed clean · The change is ready, asg_1234');
    const adversePill = pillFor('Verdict: Changes requested · Correct the missing case, asg_2345');
    const verificationFailedPill = pillFor('Verdict: Verification failed · The result did not verify, asg_2345');
    const waitChallengedPill = pillFor('Verdict: Wait challenged · The wait condition needs review, asg_2345');
    const completionPill = pillFor('Completion: Completed after the focused review, asg_3456');
    const openedPill = pillFor('Assignment opened: Opened, asg_4567');
    const closedPill = pillFor('Assignment closed: Completed, asg_5678');
    const reopenedPill = pillFor('Assignment reopened: Reopened · Another review was requested, asg_6789');

    expect(cleanPill.querySelector('.tb-chat-activity-pill-green')).toBeTruthy();
    expect(adversePill.querySelector('.tb-chat-activity-pill-red')).toBeTruthy();
    expect(verificationFailedPill.querySelector('.tb-chat-activity-pill-red')).toBeTruthy();
    expect(waitChallengedPill.querySelector('.tb-chat-activity-pill-red')).toBeTruthy();
    expect(completionPill.querySelector('.tb-chat-activity-pill-purple')).toBeTruthy();
    expect(openedPill.querySelector('.tb-chat-activity-pill-blue')).toBeTruthy();
    expect(closedPill.querySelector('.tb-chat-activity-pill-slate')).toBeTruthy();
    expect(reopenedPill.querySelector('.tb-chat-activity-pill-indigo')).toBeTruthy();
    const categoryIcons = [cleanPill, completionPill, openedPill, closedPill, reopenedPill]
      .map(pill => pill.querySelector('.tb-chat-activity-pill svg')?.innerHTML);
    expect(new Set(categoryIcons).size).toBe(4);
    expect(`${cleanPill.textContent} ${adversePill.textContent} ${verificationFailedPill.textContent} ` +
      `${waitChallengedPill.textContent} ${completionPill.textContent} ${openedPill.textContent} ` +
      `${closedPill.textContent} ${reopenedPill.textContent}`).not.toMatch(/[\[\]]/);
  });

  it('renders settled and released process notices as distinct blocker pills', () => {
    const sessionKey = 'blocker-outcome-notices';
    const human = row(sessionKey, 'prompt', 'Please review this action', {
      seq: 1, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 1,
    });
    const notice = (id: string, seq: number, line: string) => row(sessionKey, id,
      `[from process:tightbeam]\n\n${line}`, {
        seq, role: 'assistant', sender: 'process:tightbeam', messageType: 'substrate', turnSeq: 1,
      });
    const settled = notice('blocker-settled', 2, '[cannot-proceed settled by opener answer]');
    const released = notice('blocker-released', 3,
      '[cannot-proceed released: asg_67890abc-1111-4111-8111-123456789abc by example-kind/example-scope]');
    const answer = row(sessionKey, 'answer', 'The action is ready', {
      seq: 4, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: human.id, turnSeq: 1,
    });
    const runtime = new FakeRuntime(sessionKey, {
      records: [human, settled, released, answer],
      provenanceAvailable: false,
    });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const log = screen.getByRole('log');
    const settledPill = within(log).getByRole('note', {
      name: 'Blocker cleared: Cleared by the opener’s answer',
    });
    const releasedPill = within(log).getByRole('note', {
      name: 'Blocker released: Released, asg_6789',
    });
    expect(settledPill.querySelector('.tb-chat-activity-pill-green')).toBeTruthy();
    expect(releasedPill.querySelector('.tb-chat-activity-pill-green')).toBeTruthy();
    expect(`${settledPill.textContent} ${releasedPill.textContent}`).not.toMatch(/[\[\]]/);
  });

  it('updates only a growing activity fold and preserves an away reader', () => {
    const sessionKey = 'activity-fold-row-local-update';
    const question = row(sessionKey, 'question', 'Question', {
      seq: 1, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 1,
    });
    const first = row(sessionKey, 'reminder-1', 'Quiet for 3 h · First reminder', {
      seq: 2, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const second = row(sessionKey, 'reminder-2', 'Quiet for 4 h · Second reminder', {
      seq: 3, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
    });
    const reply = row(sessionKey, 'reply', 'Answer', {
      seq: 10, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: question.id, turnSeq: 1,
    });
    const laterQuestion = row(sessionKey, 'later-question', 'Later question', {
      seq: 20, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 2,
    });
    const laterReply = row(sessionKey, 'later-reply', 'Later answer', {
      seq: 21, sender: 'assistant-service', messageType: 'assistant',
      replyToMessageId: laterQuestion.id, turnSeq: 2,
    });
    let records = [question, first, second, reply, laterQuestion, laterReply];
    const runtime = new FakeRuntime(sessionKey, { records, activityTurnStateAvailable: true, activeTurn: undefined });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const viewport = screen.getByRole('log');
    const layout = installViewportLayout(viewport);
    const observer = new MutationObserver(() => {});
    try {
      act(() => runtime.update({}));

      const anchor = screen.getByText('Later answer').closest<HTMLElement>('[data-scroll-key]')!;
      fireEvent.wheel(viewport, { deltaY: -1 });
      layout.setScrollTop(Math.max(0, layout.scrollTop + layout.offset(anchor) - 120));
      fireEvent.scroll(viewport);
      const anchorBefore = layout.offset(anchor);
      expect(anchorBefore).toBeCloseTo(120, 0);

      const toggle = within(viewport).getByRole('button', { name: /2 entries\. Latest: Assignment: Quiet for 4 h/ });
      expect(toggle.textContent).toContain('×2');
      const fold = toggle.closest<HTMLElement>('.tb-chat-activity-run')!;
      const content = viewport.querySelector<HTMLElement>('.tb-chat-message-content')!;
      observer.observe(content, { subtree: true, childList: true, attributes: true, characterData: true });

      const incoming = row(sessionKey, 'reminder-3', 'Quiet for 5 h · Newest reminder', {
        seq: 4, role: 'user', sender: 'process:events', messageType: 'substrate', turnSeq: 1,
      });
      records = [question, first, second, incoming, reply, laterQuestion, laterReply];
      act(() => runtime.update({ records }));

      const updatedToggle = within(viewport).getByRole('button', { name: /3 entries\. Latest: Assignment: Quiet for 5 h/ });
      expect(updatedToggle.textContent).toContain('×3');
      expect(updatedToggle.textContent).toContain('Newest reminder');
      expect(updatedToggle.closest('.tb-chat-activity-run')).toBe(fold);
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);
      const mutations = observer.takeRecords();
      expect(mutations.length).toBeGreaterThan(0);
      expect(mutations.every(mutation => fold.contains(mutation.target))).toBe(true);
    } finally {
      observer.disconnect();
      layout.restore();
    }
  });

  it('folds activity to its newest line and preserves an away reader through growth, expansion, and collapse', () => {
    const sessionKey = 'activity-run-reading-position';
    const question = row(sessionKey, 'question-1', 'Question 1', {
      seq: 1, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 1,
    });
    const activity = [1, 2, 3, 4, 5, 6].map((index) => row(sessionKey, `reminder-${index}`,
      `Quiet for ${index} min · Background activity ${index}`, {
      seq: index + 1, role: 'user', sender: 'process:events', messageType: 'substrate',
    }));
    const firstReply = row(sessionKey, 'reply-1', 'Idle answer 1', {
      seq: 10, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: question.id, turnSeq: 1,
    });
    const laterMessages: CanonicalMessage[] = [];
    for (let index = 2; index <= 8; index++) {
      const human = row(sessionKey, `question-${index}`, `Question ${index}`, {
        seq: index * 10, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: index,
      });
      const reply = row(sessionKey, `reply-${index}`, `Idle answer ${index}`, {
        seq: index * 10 + 1, sender: 'assistant-service', messageType: 'assistant',
        replyToMessageId: human.id, turnSeq: index,
      });
      laterMessages.push(human, reply);
    }
    let records = [question, ...activity, firstReply, ...laterMessages];
    const runtime = new FakeRuntime(sessionKey, {
      records, activityTurnStateAvailable: true, activeTurn: undefined,
    });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const viewport = screen.getByRole('log');
    const layout = installViewportLayout(viewport);
    try {
      act(() => runtime.update({}));

      const anchor = screen.getByText('Idle answer 5').closest<HTMLElement>('[data-scroll-key]')!;
      fireEvent.wheel(viewport, { deltaY: -1 });
      layout.setScrollTop(Math.max(0, layout.scrollTop + layout.offset(anchor) - 120));
      fireEvent.scroll(viewport);
      const anchorBefore = layout.offset(anchor);
      expect(anchorBefore).toBeCloseTo(120, 0);

      let toggle = screen.getByRole('button', { name: /6 entries\. Latest: Assignment: Quiet for .*Background activity 6/ });
      expect(toggle.textContent).toContain('×6');
      expect(screen.queryByRole('button', { name: 'Show earlier activity' })).toBeNull();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle);
      toggle = screen.getByRole('button', { name: /6 entries\. Latest: Assignment: Quiet for .*Background activity 6/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getAllByRole('note').map(note => note.querySelector('.tb-chat-activity-pill-text')?.textContent)).toEqual([
        'Quiet for 1 min · Background activity 1', 'Quiet for 2 min · Background activity 2',
        'Quiet for 3 min · Background activity 3', 'Quiet for 4 min · Background activity 4',
        'Quiet for 5 min · Background activity 5', 'Quiet for 6 min · Background activity 6',
      ]);
      const expandedRun = toggle.closest<HTMLElement>('.tb-chat-activity-run')!;
      expect(expandedRun.firstElementChild).toBe(toggle);
      expect(expandedRun.lastElementChild?.classList.contains('tb-chat-activity-run-content')).toBe(true);
      expect(expandedRun.lastElementChild?.firstElementChild?.classList.contains('tb-chat-activity-run-rows')).toBe(true);
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);

      const incoming = row(sessionKey, 'reminder-7', 'Quiet for 7 min · Background activity 7', {
        seq: 8, role: 'user', sender: 'process:events', messageType: 'substrate',
      });
      records = [question, ...activity, incoming, firstReply, ...laterMessages];
      act(() => runtime.update({ records }));
      toggle = screen.getByRole('button', { name: /7 entries\. Latest: Assignment: Quiet for 7 min .*Background activity 7/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);

      fireEvent.click(toggle);
      toggle = screen.getByRole('button', { name: /7 entries\. Latest: Assignment: Quiet for 7 min .*Background activity 7/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);

      const finalReminder = row(sessionKey, 'reminder-8', 'Quiet for 8 min · Background activity 8', {
        seq: 9, role: 'user', sender: 'process:events', messageType: 'substrate',
      });
      records = [question, ...activity, incoming, finalReminder, firstReply, ...laterMessages];
      act(() => runtime.update({ records }));
      toggle = screen.getByRole('button', { name: /8 entries\. Latest: Assignment: Quiet for 8 min .*Background activity 8/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);
    } finally {
      layout.restore();
    }
  });

  it('expands one activity gap in place and keeps it expanded for later entries', () => {
    const sessionKey = 'activity-expansion';
    const prompt = row(sessionKey, 'prompt', 'Question', { role: 'user', sender: 'user:person', seq: 1, turnSeq: 1 });
    const activity = Array.from({ length: 8 }, (_, index) => row(sessionKey, `notice-${index + 1}`,
      `Quiet for ${index + 1} min · Background event ${index + 1}`,
      { role: 'user', sender: 'process:events', messageType: 'substrate', seq: index + 2 }));
    const boundary: ConversationRecord = { kind: 'transition', id: 'boundary', seq: 6, rowVersion: 1,
      sessionKey, transition: 'compaction', content: 'Context compacted', raw: {} };
    const reply = row(sessionKey, 'reply', 'Answer', { role: 'assistant', sender: 'assistant-service',
      replyToMessageId: prompt.id, turnSeq: 1, seq: 20 });
    const runtime = new FakeRuntime(sessionKey, { records: [prompt, ...activity, boundary, reply] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const viewport = screen.getByRole('log');
    const layout = installViewportLayout(viewport);
    act(() => runtime.update({}));
    const replyRow = screen.getByText('Answer').closest('[data-record-key]') as HTMLElement;
    const before = layout.offset(replyRow);
    const composer = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Unsent draft' } });
    composer.focus();
    composer.setSelectionRange(2, 6);
    expect(screen.getByRole('separator', { name: 'Transition: Context compacted' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show earlier activity' })).toBeNull();
    expect(screen.getByText('Context compacted')).toBeTruthy();
    expect(Math.abs(layout.offset(replyRow) - before)).toBeLessThanOrEqual(1);
    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe('Unsent draft');
    expect([composer.selectionStart, composer.selectionEnd]).toEqual([2, 6]);

    const laterRun = screen.getByRole('button', { name: /4 entries\. Latest: Assignment: Quiet for 8 min .*Background event 8/ });
    fireEvent.click(laterRun);
    expect(laterRun.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('note')).toHaveLength(4);
    expect(Math.abs(layout.offset(replyRow) - before)).toBeLessThanOrEqual(1);

    const later = row(sessionKey, 'notice-later', 'A later background event', {
      role: 'user', sender: 'process:events', messageType: 'substrate', seq: 15,
    });
    const laterReminder = { ...later, content: 'Quiet for 9 min · A later background event' };
    act(() => runtime.update({ records: [prompt, ...activity, boundary, laterReminder, reply] }));
    const updatedRun = screen.getByRole('button', { name: /5 entries\. Latest: Assignment: Quiet for 9 min .*A later background event/ });
    expect(updatedRun.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('note')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: 'Show earlier activity' })).toBeNull();
    expect(Math.abs(layout.offset(replyRow) - before)).toBeLessThanOrEqual(1);
    expect(composer.value).toBe('Unsent draft');
    expect([composer.selectionStart, composer.selectionEnd]).toEqual([2, 6]);
    layout.restore();
  });

  it('shows a friendly timestamp for recent messages and a fallback when time is missing', () => {
    const sessionKey = 'timestamp-session';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 5);
    const samples = [today, yesterday];
    const messages = samples.map((sample, index) => row(sessionKey, `time-${index}`, `Message ${index}`, {
      role: 'user', sender: 'user:person', turnSeq: index + 1, createdAt: sample.toISOString(),
    }));
    messages.push(row(sessionKey, 'time-unavailable', 'Message without a recorded time', {
      role: 'user', sender: 'user:person', turnSeq: samples.length + 1,
    }));
    const provenanceRows = messages.map((message, index) => provenance(index + 1, sessionKey,
      message.id, 'user:person', message));
    const runtime = new FakeRuntime(sessionKey, { records: messages, provenance: provenanceRows });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const timestamps = [...document.querySelectorAll('time.tb-chat-time')].map((element) => element.textContent);
    expect(timestamps).toHaveLength(3);
    expect(timestamps[0]).toBeTruthy();
    expect(timestamps[0]).not.toBe('Time unavailable');
    expect(timestamps[1]).toMatch(/^Yesterday\b/);
    expect(timestamps[2]).toBe('Time unavailable');
  });

  it('renders model, harness, reset, and compaction transitions as labeled separators', () => {
    const sessionKey = 'transition-boundaries';
    const human = row(sessionKey, 'prompt', 'Question', { role: 'user', sender: 'user:person', seq: 1 });
    const transitions: ConversationRecord[] = [
      { kind: 'transition', id: 'model', sessionKey, seq: 2, rowVersion: 1, transition: 'model',
        from: 'Model A', to: 'Model B', content: 'Model changed', raw: {} },
      { kind: 'transition', id: 'harness', sessionKey, seq: 3, rowVersion: 1, transition: 'harness',
        from: 'Harness A', to: 'Harness B', content: 'Harness changed', raw: {} },
      { kind: 'transition', id: 'reset', sessionKey, seq: 4, rowVersion: 1, transition: 'restart',
        content: 'Reset', raw: {} },
      { kind: 'transition', id: 'compaction', sessionKey, seq: 5, rowVersion: 1, transition: 'compaction',
        content: 'Compacted', raw: {} },
    ];
    const runtime = new FakeRuntime(sessionKey, { records: [human, ...transitions] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    expect(screen.getAllByRole('separator').map((element) => element.getAttribute('aria-label'))).toEqual([
      'Transition: Model settings changed: Model A → Model B',
      'Transition: Harness changed: Harness A → Harness B',
      'Transition: Context reset',
      'Transition: Context compacted',
    ]);
    expect(screen.queryByRole('article', { name: /transition/i })).toBeNull();
  });

  it('automatically follows hidden-only older pages until a displayable human message arrives', async () => {
    const sessionKey = 'paged-session';
    const hiddenTrigger = row(sessionKey, 'other-trigger', 'Another agent activity', { role: 'user', sender: 'agent:other', messageType: 'agent', turnSeq: 7 });
    const hiddenReply = row(sessionKey, 'hidden-reply', 'Not a human conversation', { turnSeq: 7, replyToMessageId: hiddenTrigger.id });
    const hiddenTurn = provenance(7, sessionKey, hiddenTrigger.id, 'agent:other', hiddenTrigger, 'Other agent');
    const olderHuman = row(sessionKey, 'older-human', 'Older human message', {
      role: 'user', sender: 'user:person', turnSeq: 8,
    });
    const olderTurn = provenance(8, sessionKey, olderHuman.id, 'user:person', olderHuman);
    const runtime = new FakeRuntime(sessionKey, { hasOlder: true });
    runtime.olderPages = [
      { records: [hiddenTrigger, hiddenReply], provenance: [hiddenTurn], hasOlder: true },
      { records: [olderHuman], provenance: [olderTurn], hasOlder: false },
    ];
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    expect(await within(screen.getByRole('log')).findByText('Older human message')).toBeTruthy();
    await waitFor(() => expect(runtime.loadOlderCalls).toBe(2));
    expect(screen.queryByText('Not a human conversation')).toBeNull();
    expect(screen.queryByRole('button', { name: /load earlier/i })).toBeNull();
  });

  it('stops paging when the remaining history contains only hidden rows and reaches its start', async () => {
    const sessionKey = 'history-start';
    const hiddenFirst = row(sessionKey, 'hidden-first', 'Earlier activity', {
      role: 'user', sender: 'agent:other', messageType: 'agent', turnSeq: 1,
    });
    const hiddenSecond = row(sessionKey, 'hidden-second', 'Earlier reply', {
      sender: 'assistant-service', messageType: 'assistant', turnSeq: 1, replyToMessageId: hiddenFirst.id,
    });
    const older = row(sessionKey, 'older-activity', 'Oldest activity', {
      role: 'user', sender: 'agent:other', messageType: 'agent', turnSeq: 2,
    });
    const runtime = new FakeRuntime(sessionKey, { hasOlder: true });
    runtime.olderPages = [
      { records: [hiddenFirst, hiddenSecond], provenance: [], hasOlder: true },
      { records: [older], provenance: [], hasOlder: false },
    ];

    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    await waitFor(() => expect(runtime.getSnapshot().hasOlder).toBe(false));
    expect(runtime.loadOlderCalls).toBe(2);
    expect(screen.queryByText('Earlier activity')).toBeNull();
    expect(screen.queryByText('Earlier reply')).toBeNull();
    expect(screen.queryByText('Oldest activity')).toBeNull();
  });

  it('prefetches older history before the reader reaches the top and holds the visible row', async () => {
    const sessionKey = 'history-prefetch';
    const messages = Array.from({ length: 8 }, (_, index) => row(sessionKey, `message-${index + 1}`, `Message ${index + 1}`, {
      seq: index + 1, role: 'user', sender: 'user:person', messageType: 'chat',
    }));
    const older = row(sessionKey, 'older-message', 'Older message', {
      seq: 0, role: 'user', sender: 'user:person', messageType: 'chat',
    });
    const runtime = new FakeRuntime(sessionKey, { records: messages });
    runtime.loadOlder = async () => {
      runtime.loadOlderCalls++;
      runtime.update({ loadingOlder: true, historyError: undefined });
      await Promise.resolve();
      runtime.update({ records: [older, ...runtime.getSnapshot().records], hasOlder: false,
        loadingOlder: false, historyError: undefined });
    };
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const log = screen.getByRole('log');
    const layout = installViewportLayout(log);
    const anchor = within(log).getByText('Message 5').closest('article')!;

    try {
      fireEvent.wheel(log, { deltaY: -1 });
      layout.setScrollTop(300);
      fireEvent.scroll(log);
      act(() => runtime.update({ hasOlder: true }));
      expect(runtime.loadOlderCalls).toBe(0);

      // At 265 px from the top, the old 80 px trigger would still be idle.
      layout.setScrollTop(265);
      const anchorBefore = layout.offset(anchor);
      fireEvent.scroll(log);
      await waitFor(() => expect(runtime.loadOlderCalls).toBe(1));
      await waitFor(() => expect(runtime.getSnapshot().records).toContain(older));

      expect(within(log).getByText('Older message')).toBeTruthy();
      expect(layout.offset(anchor)).toBe(anchorBefore);
      expect(layout.scrollTop).toBe(357);
    } finally {
      layout.restore();
    }
  });

  it('retracts a failed history load without moving the reader and retries on the next upward scroll', async () => {
    const sessionKey = 'history-retry-on-scroll';
    const messages = Array.from({ length: 8 }, (_, index) => row(sessionKey, `message-${index + 1}`, `Message ${index + 1}`, {
      seq: index + 1, role: 'user', sender: 'user:person', messageType: 'chat',
    }));
    const older = row(sessionKey, 'older-message', 'Older message after retry', {
      seq: 0, role: 'user', sender: 'user:person', messageType: 'chat',
    });
    const runtime = new FakeRuntime(sessionKey, { records: messages });
    let finishFailure!: () => void;
    const failure = new Promise<void>((resolve) => { finishFailure = resolve; });
    runtime.loadOlder = async () => {
      runtime.loadOlderCalls++;
      const attempt = runtime.loadOlderCalls;
      runtime.update({ loadingOlder: true, historyError: undefined });
      if (attempt === 1) {
        await failure;
        runtime.update({ loadingOlder: false, historyError: 'The request failed' });
        return;
      }
      await Promise.resolve();
      runtime.update({ records: [older, ...runtime.getSnapshot().records], hasOlder: false,
        loadingOlder: false, historyError: undefined });
    };
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const log = screen.getByRole('log');
    const layout = installViewportLayout(log);
    const anchor = within(log).getByText('Message 5').closest('article')!;

    try {
      fireEvent.wheel(log, { deltaY: -1 });
      layout.setScrollTop(300);
      fireEvent.scroll(log);
      act(() => runtime.update({ hasOlder: true }));
      layout.setScrollTop(265);
      fireEvent.scroll(log);
      await waitFor(() => expect(runtime.loadOlderCalls).toBe(1));
      await waitFor(() => expect(runtime.getSnapshot().loadingOlder).toBe(true));
      const anchorBeforeFailure = layout.offset(anchor);

      await act(async () => {
        finishFailure();
        await failure;
      });
      await waitFor(() => expect(runtime.getSnapshot().historyError).toBe('The request failed'));
      expect(log.querySelector('.tb-chat-history-loading')).toBeNull();
      expect(within(log).getByRole('alert').textContent).toContain('Earlier messages could not be loaded');
      expect(layout.offset(anchor)).toBe(anchorBeforeFailure);

      const afterFailure = layout.scrollTop;
      layout.setScrollTop(afterFailure + 8);
      fireEvent.scroll(log);
      expect(runtime.loadOlderCalls).toBe(1);

      layout.setScrollTop(afterFailure + 2);
      const anchorBeforeRetry = layout.offset(anchor);
      fireEvent.scroll(log);
      await waitFor(() => expect(runtime.loadOlderCalls).toBe(2));
      await waitFor(() => expect(runtime.getSnapshot().records).toContain(older));

      expect(within(log).getByText('Older message after retry')).toBeTruthy();
      expect(runtime.getSnapshot().historyError).toBeUndefined();
      expect(layout.offset(anchor)).toBe(anchorBeforeRetry);
    } finally {
      finishFailure();
      layout.restore();
    }
  });

  it('keeps the older-page status outside the scrollable message layout', () => {
    const runtime = new FakeRuntime('loading-status', { loadingOlder: true });
    render(<TightbeamChat sessionKey="loading-status" adapter={adapterFor(runtime)} />);

    const viewport = screen.getByRole('log');
    const status = viewport.querySelector<HTMLElement>('.tb-chat-history-loading');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.classList.contains('tb-chat-caption-neutral')).toBe(true);
    expect(status?.classList.contains('tb-chat-runtime-notice')).toBe(true);
    expect(status?.textContent).toBe('Loading earlier messages…');
    expect(status?.parentElement).toBe(viewport);
    expect(viewport.querySelector('.tb-chat-message-content')?.contains(status)).toBe(false);
  });

  it('keeps Retry loading messages on the history error caption', async () => {
    const runtime = new FakeRuntime('history-retry', { hasOlder: true, historyError: 'The request failed' });
    runtime.olderPages = [{ records: [], provenance: [], hasOlder: false }];
    render(<TightbeamChat sessionKey="history-retry" adapter={adapterFor(runtime)} />);

    const alert = screen.getByRole('alert');
    expect(alert.classList.contains('tb-chat-caption-danger')).toBe(true);
    expect(alert.classList.contains('tb-chat-runtime-notice')).toBe(true);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry loading messages' }));
    await waitFor(() => expect(runtime.loadOlderCalls).toBe(1));
  });

  it('keeps linked-target recovery reachable without a Tool calls control or shifting history', () => {
    const sessionKey = 'linked-target-error-controls';
    const records = Array.from({ length: 6 }, (_, index) => row(sessionKey, `message-${index + 1}`,
      `History message ${index + 1}`, { seq: index + 1 }));
    const runtime = new FakeRuntime(sessionKey, {
      records,
      toolCallsEnabled: true,
      toolCallsLoading: true,
    });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)}
      configuredConversationHref="/" />);

    const viewport = screen.getByRole('log');
    act(() => runtime.update({ loadingOlder: true }));
    expect(viewport.querySelector('.tb-chat-history-loading')?.textContent).toBe('Loading earlier messages…');
    expect(viewport.querySelector('.tb-chat-tool-history-status-placeholder')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tool calls' })).toBeNull();
    act(() => runtime.update({ loadingOlder: false }));

    const layout = installViewportLayout(viewport);
    try {
      const anchor = screen.getByText('History message 4').closest<HTMLElement>('[data-scroll-key]')!;
      fireEvent.wheel(viewport, { deltaY: -1 });
      layout.setScrollTop(250);
      fireEvent.scroll(viewport);
      const before = layout.offset(anchor);

      act(() => runtime.update({ conversationError: 'The linked target is unavailable.' }));

      expect(layout.offset(anchor)).toBeCloseTo(before, 0);
      const alert = screen.getByRole('alert');
      const reconnect = within(alert).getByRole('button', { name: 'Reconnect' });
      const recovery = within(alert).getByRole('link', { name: 'Open the configured conversation' });
      expect(alert.classList.contains('tb-chat-runtime-notice-with-tool-history')).toBe(true);
      expect(recovery.getAttribute('href')).toBe('/');
      expect(screen.queryByRole('button', { name: 'Tool calls' })).toBeNull();
      expect(screen.queryByText('Tool calls')).toBeNull();
      expect(within(alert).getByText('Loading tool history…')).toBeTruthy();
      expect(viewport.querySelector('.tb-chat-tool-history-status-placeholder')?.getAttribute('aria-hidden')).toBe('true');
      expect(screen.getByText('History message 4')).toBeTruthy();

      fireEvent.click(reconnect);
      expect(runtime.rebuildCalls).toBe(1);

      act(() => runtime.update({ conversationError: undefined }));

      expect(layout.offset(anchor)).toBeCloseTo(before, 0);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Open the configured conversation' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Tool calls' })).toBeNull();
    } finally {
      layout.restore();
    }
  });

  it('keeps tool history loading and retry notices without a Tool calls control', () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime('tool-history-caption', { toolCallsEnabled: true, toolCallsLoading: true });
    const view = render(<TightbeamChat sessionKey="tool-history-caption" adapter={adapterFor(runtime)} />);

    expect(screen.queryByRole('button', { name: 'Tool calls' })).toBeNull();
    expect(screen.queryByText('Tool calls')).toBeNull();
    const loading = screen.getByText('Loading tool history…');
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.classList.contains('tb-chat-caption-neutral')).toBe(true);

    act(() => runtime.update({ toolCallsLoading: false, toolCallsError: 'Connection unavailable' }));
    expect(view.container.querySelector('.tb-chat-tool-history-status > .tb-chat-caption-danger')).toBeNull();
    act(() => { vi.advanceTimersByTime(1000); });
    const status = view.container.querySelector<HTMLElement>('.tb-chat-tool-history-status > .tb-chat-caption-danger');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toBe('Tool history is not current: Connection unavailable Retry tool history');
    const retry = within(status!).getByRole('button', { name: 'Retry tool history' });
    expect(retry).toBeTruthy();
    expect(retry.closest('.tb-chat-caption-body')).toBeTruthy();
  });

  it('does not render a tool-history warning for a subsecond feed blip that recovers', () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime('tool-history-blip', { toolCallsEnabled: true, toolCallsLoading: false });
    const view = render(<TightbeamChat sessionKey="tool-history-blip" adapter={adapterFor(runtime)} />);

    act(() => runtime.update({ toolCallsError: 'Firehose disconnected (close code 1000).' }));
    expect(view.container.querySelector('.tb-chat-tool-history-status > .tb-chat-caption-danger')).toBeNull();
    act(() => { vi.advanceTimersByTime(350); });
    act(() => runtime.update({ toolCallsError: undefined }));
    act(() => { vi.advanceTimersByTime(1000); });

    expect(view.container.querySelector('.tb-chat-tool-history-status > .tb-chat-caption-danger')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry tool history' })).toBeNull();
  });

  it('keeps the transcript usable when tool-call support is absent', () => {
    const runtime = new FakeRuntime('tool-history-unavailable', {
      records: [row('tool-history-unavailable', 'visible-message', 'Visible conversation message')],
      toolCallsEnabled: undefined,
      toolCallsLoading: false,
    });
    const view = render(<TightbeamChat sessionKey="tool-history-unavailable" adapter={adapterFor(runtime)} />);

    expect(screen.getByText('Visible conversation message')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tool calls' })).toBeNull();
    expect(screen.queryByText('Tool calls')).toBeNull();
    expect(view.container.querySelector('.tb-chat-tool-controls')).toBeNull();
    expect(view.container.querySelector('.tb-chat-tool-history-status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry tool history' })).toBeNull();
    expect(screen.queryByText(/Tool history is not current/)).toBeNull();
  });

  it('renders and copies canonical human member rows without exposing a carrier or sibling', () => {
    const sessionKey = 'member-rendering';
    const carrier = row(sessionKey, 'carrier', 'Hidden wrapper and nonhuman content', {
      seq: 5, role: 'user', sender: 'process:notifications', isBatchCarrier: true });
    const member = row(sessionKey, 'member', 'Individual human body', {
      seq: 6, role: 'user', sender: 'user:person', turnSeq: 5 });
    const runtime = new FakeRuntime(sessionKey, { records: [carrier, member] });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const renderer = vi.fn((record: ConversationRecord, context: RenderContext) =>
      record.kind === 'message' ? <div>{record.content}<button onClick={() => void context.copyText()}>Copy message</button></div> : undefined);
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} renderMessage={renderer} />);
    expect(renderer.mock.calls[0][0]).toBe(member);
    expect(view.container.textContent).not.toContain('Hidden wrapper');
    expect(view.container.querySelector('article')?.dataset.scrollKey).toBe(member.id);
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenCalledWith(member.content);
    act(() => runtime.update({ records: [{ ...carrier, rowVersion: 2 }, member] }));
    expect(view.container.querySelector('article')?.dataset.scrollKey).toBe(member.id);
    expect((runtime.getSnapshot().records[0] as CanonicalMessage).content).toBe(carrier.content);
  });

  it('keeps local selection isolated and preserves canonical metadata for a host renderer', async () => {
    const runtimes: FakeRuntime[] = [];
    const adapter: TightbeamAdapter = { open: (key) => {
      const runtime = new FakeRuntime(key);
      const human = row(key, `${key}-human`, 'A question', { role: 'user', sender: 'user:person', turnSeq: 1 });
      runtime.state = { ...runtime.state, records: [human],
        provenance: [provenance(1, key, human.id, 'user:person', human)] };
      runtimes.push(runtime);
      return runtime;
    } };
    const renderMessage = vi.fn((record: ConversationRecord, context: RenderContext) =>
      record.kind === 'message' && record.sessionKey === 'B' ? <em data-record-key={context.recordKey}>Custom B</em> : undefined);
    const view = render(<TightbeamChat sessionKey="A" adapter={adapter} renderMessage={renderMessage} />);
    await within(screen.getByRole('log')).findByText('A question');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to Research assistant' }), { target: { value: 'draft A' } });
    view.rerender(<TightbeamChat sessionKey="B" adapter={adapter} renderMessage={renderMessage} />);
    expect(await within(screen.getByRole('log')).findByText('Custom B')).toBeTruthy();
    expect(runtimes[0].disposed).toBe(true);
    expect(runtimes[0].listeners.size).toBe(0);
    expect(screen.queryByText('draft A')).toBeNull();
    expect(renderMessage.mock.calls.some(([record, context]) => record.raw.source === 'fixture' &&
      context.recordKey === 'B-human'))
      .toBe(true);
  });

  it('keeps submitted whitespace intact and allows local Settings while normal sends are locked', () => {
    const runtime = new FakeRuntime('send-session');
    render(<TightbeamChat sessionKey="send-session" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' });
    fireEvent.change(composer, { target: { value: '  exact  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runtime.sent).toEqual(['  exact  ']);
    expect(composer).toHaveProperty('value', '  exact  ');
    act(() => runtime.update({ sends: [{
      sessionKey: 'send-session', deviceId: 'device', clientMessageId: 'fixture-send', content: '  exact  ',
      submittedAt: new Date().toISOString(), status: 'accepted', reconciled: false,
    }] }));
    expect(composer).toHaveProperty('value', '');

    act(() => {
      runtime.state = { ...runtime.state, status: 'unauthorized' };
      for (const listener of runtime.listeners) listener();
    });
    expect(composer).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', true);
  });

  it('moves a browser submission from older history to the visible newest prompt', async () => {
    const sessionKey = 'prompt-submit-scroll';
    const history = Array.from({ length: 6 }, (_, index) => row(
      sessionKey, `history-${index + 1}`, `History message ${index + 1}`,
      { seq: index + 1, role: 'user', sender: 'user:person', messageType: 'chat' },
    ));
    const runtime = new FakeRuntime(sessionKey, { records: history });
    runtime.send = (content, clientMessageId) => {
      runtime.sent.push(content);
      const id = clientMessageId ?? runtime.sendResult;
      if (!id) return null;
      const send: LocalSend = {
        sessionKey, deviceId: 'device', clientMessageId: id, content,
        submittedAt: new Date().toISOString(), status: 'pending', reconciled: false,
      };
      runtime.update({ sends: [...runtime.state.sends, send] });
      return id;
    };
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const log = screen.getByRole('log');
    const layout = installViewportLayout(log, 0);
    const anchor = within(log).getByText('History message 1').closest('article')!;
    layout.setScrollTop(0);
    fireEvent.wheel(log, { deltaY: -100 });
    fireEvent.scroll(log);
    await screen.findByRole('button', { name: /^(?:\d+ unseen messages?|Scroll to bottom)$/ });
    const anchorBeforeDraft = layout.offset(anchor);

    try {
      const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' });
      fireEvent.change(composer, { target: { value: 'New browser prompt' } });
      expect(layout.scrollTop).toBe(0);
      expect(layout.offset(anchor)).toBe(anchorBeforeDraft);
      fireEvent.submit(composer.closest('form')!);

      await waitFor(() => expect(layout.scrollTop).toBeGreaterThan(0));
      const prompt = within(log).getByText('New browser prompt').closest('article')!;
      expect(prompt.classList.contains('tb-chat-bubble-human')).toBe(true);
      expect(layout.offset(prompt)).toBeGreaterThanOrEqual(0);
      expect(layout.offset(prompt)).toBeLessThan(180);
      expect(screen.queryByRole('button', { name: /^(?:\d+ unseen messages?|Scroll to bottom)$/ })).toBeNull();
      expect(runtime.sent).toEqual(['New browser prompt']);
    } finally {
      layout.restore();
    }
  });

  it('opens Settings from the composer while disconnected, clears the draft and restores focus on close', async () => {
    const runtime = new FakeRuntime('local-settings', { status: 'stale' });
    render(<TightbeamChat sessionKey="local-settings" adapter={adapterFor(runtime)} />);
    runtime.markReadPosition.mockClear();
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: '  /settings\n' } });

    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(runtime.sent).toEqual([]);
    expect(runtime.markReadPosition).not.toHaveBeenCalled();
    expect(composer.value).toBe('');
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Release notes' }));
    expect(screen.getByRole('dialog', { name: 'Release notes' })).toBeTruthy();
    expect(screen.getByText('v0.1.27')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(composer);
  });

  it('opens Settings from Return without sending a message', async () => {
    const runtime = new FakeRuntime('return-settings');
    render(<TightbeamChat sessionKey="return-settings" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' });
    fireEvent.change(composer, { target: { value: '/settings' } });

    expect(fireEvent.keyDown(composer, { key: 'Enter' })).toBe(false);
    expect(runtime.sent).toEqual([]);
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  it.each(['/Settings', '/settings now', '/compact', 'settings'])('sends %s unchanged', (text) => {
    const runtime = new FakeRuntime('other-slash');
    render(<TightbeamChat sessionKey="other-slash" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' });
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(runtime.sent).toEqual([text]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a reader anchor in place while Settings opens and closes', async () => {
    const sessionKey = 'settings-reader-anchor';
    const question = row(sessionKey, 'reader-anchor', 'Reader anchor', {
      role: 'user', sender: 'user:person', turnSeq: 1, messageType: 'chat',
    });
    const runtime = new FakeRuntime(sessionKey, {
      records: [question], provenance: [provenance(1, sessionKey, question.id, 'user:person', question)],
    });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const viewport = screen.getByRole('log');
    await within(viewport).findByText('Reader anchor');
    const layout = installViewportLayout(viewport);
    try {
      const anchor = within(viewport).getByText('Reader anchor').closest('article')!;
      layout.setScrollTop(70);
      const before = layout.offset(anchor);
      const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' });
      fireEvent.change(composer, { target: { value: '/settings' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }));

      expect(layout.offset(anchor)).toBe(before);
      expect(layout.scrollTop).toBe(70);
    } finally {
      layout.restore();
    }
  });

  it('sends plain Return through the existing button path and keeps composer focus', () => {
    const runtime = new FakeRuntime('keyboard-eligibility');
    render(<TightbeamChat sessionKey="keyboard-eligibility" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' });
    fireEvent.change(composer, { target: { value: 'plain Return draft' } });
    composer.focus();

    expect(fireEvent.keyDown(composer, { key: 'Enter' })).toBe(false);
    expect(runtime.sent).toEqual(['plain Return draft']);
    expect(composer).toHaveProperty('value', 'plain Return draft');
    act(() => runtime.update({ sends: [{
      sessionKey: 'keyboard-eligibility', deviceId: 'device', clientMessageId: 'fixture-send',
      content: 'plain Return draft', submittedAt: new Date().toISOString(),
      status: 'accepted', reconciled: false,
    }] }));
    expect(composer).toHaveProperty('value', '');
    expect(document.activeElement).toBe(composer);
  });

  it.each(['failed', 'uncertain'] as const)('retains the submitted draft when delivery is %s', (status) => {
    const runtime = new FakeRuntime(`send-${status}`);
    render(<TightbeamChat sessionKey={`send-${status}`} adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Keep this text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    act(() => runtime.update({ sends: [{
      sessionKey: `send-${status}`, deviceId: 'device', clientMessageId: 'fixture-send',
      content: 'Keep this text', submittedAt: new Date().toISOString(), status, reconciled: false,
    }] }));
    expect(composer.value).toBe('Keep this text');
  });

  it('keeps edits made after submission even when the text later matches the submitted text', () => {
    const runtime = new FakeRuntime('newer-edit');
    render(<TightbeamChat sessionKey="newer-edit" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    fireEvent.change(composer, { target: { value: 'Draft changed' } });
    fireEvent.change(composer, { target: { value: 'Draft' } });
    act(() => runtime.update({ sends: [{
      sessionKey: 'newer-edit', deviceId: 'device', clientMessageId: 'fixture-send',
      content: 'Draft', submittedAt: new Date().toISOString(), status: 'accepted', reconciled: false,
    }] }));
    expect(composer.value).toBe('Draft');
  });

  it('uses native textarea content sizing without a synchronous scroll-height read per edit', () => {
    vi.stubGlobal('CSS', { supports: (property: string, value: string) =>
      property === 'field-sizing' && value === 'content' });
    const runtime = new FakeRuntime('native-sizing');
    render(<TightbeamChat sessionKey="native-sizing" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    let scrollHeightReads = 0;
    Object.defineProperty(composer, 'scrollHeight', { configurable: true, get: () => {
      scrollHeightReads++;
      return 100;
    } });
    for (const value of ['a', 'ab', 'abc', 'abcd']) fireEvent.change(composer, { target: { value } });
    expect(composer.value).toBe('abcd');
    composer.focus();
    composer.setSelectionRange(2, 2);
    fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true });
    expect(composer.value).toBe('ab\ncd');
    expect(composer.selectionStart).toBe(3);
    expect(scrollHeightReads).toBe(0);
  });

  it.each([
    ['Shift+Return', { shiftKey: true }],
    ['Ctrl+Return', { ctrlKey: true }],
  ] as const)('%s inserts a newline at the caret without sending', (shortcut, modifiers) => {
    const runtime = new FakeRuntime(`newline-${shortcut}`);
    render(<TightbeamChat sessionKey={runtime.state.sessionKey} adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'beforeafter' } });
    composer.focus();
    composer.setSelectionRange(6, 6);

    expect(fireEvent.keyDown(composer, { key: 'Enter', ...modifiers })).toBe(false);
    expect(runtime.sent).toEqual([]);
    expect(composer.value).toBe('before\nafter');
    expect(composer.selectionStart).toBe(7);
    expect(document.activeElement).toBe(composer);
  });

  it('does not submit during IME composition and preserves the draft when send fails or is ineligible', () => {
    const runtime = new FakeRuntime('keyboard-eligibility');
    render(<TightbeamChat sessionKey="keyboard-eligibility" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' });
    fireEvent.change(composer, { target: { value: 'keep this draft' } });

    expect(fireEvent.keyDown(composer, { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(runtime.sent).toEqual([]);
    expect(composer).toHaveProperty('value', 'keep this draft');

    runtime.sendResult = null;
    expect(fireEvent.keyDown(composer, { key: 'Enter' })).toBe(false);
    expect(runtime.sent).toEqual(['keep this draft']);
    expect(composer).toHaveProperty('value', 'keep this draft');

    act(() => {
      runtime.state = { ...runtime.state, status: 'unauthorized' };
      for (const listener of runtime.listeners) listener();
    });
    expect(fireEvent.keyDown(composer, { key: 'Enter' })).toBe(false);
    expect(runtime.sent).toEqual(['keep this draft']);
    expect(composer).toHaveProperty('value', 'keep this draft');
  });

  it('keeps unconfirmed messages ghosted without status prose and retries only refusals', () => {
    const sessionKey = 'send-recovery';
    const runtime = new FakeRuntime(sessionKey, { sends: [
      { sessionKey, deviceId: 'device', clientMessageId: 'failed-id', content: 'Failed text',
        submittedAt: '2026-10-20T09:05:00.000Z', status: 'failed', reconciled: false,
        reason: 'private target detail' },
      { sessionKey, deviceId: 'device', clientMessageId: 'accepted-id', content: 'Accepted text',
        submittedAt: '2026-10-20T09:05:30.000Z', status: 'accepted', reconciled: false },
      { sessionKey, deviceId: 'device', clientMessageId: 'uncertain-id', content: 'Uncertain text',
        submittedAt: '2026-10-20T09:06:00.000Z', status: 'uncertain', reconciled: false,
        reason: 'private session detail' },
      { sessionKey, deviceId: 'device', clientMessageId: 'unreachable-id', content: 'Offline text',
        submittedAt: '2026-10-20T09:07:00.000Z', status: 'pending', reconciled: false,
        reason: 'unreachable' },
    ] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    expect(screen.getByText('Failed text')).toBeTruthy();
    expect(screen.getByText('Accepted text')).toBeTruthy();
    expect(screen.getByText('Uncertain text')).toBeTruthy();
    expect(within(screen.getByRole('log')).getByText('Offline text')).toBeTruthy();
    expect(document.querySelectorAll('.tb-chat-send-spinner')).toHaveLength(3);
    const failed = screen.getByText('Failed text').closest('article');
    expect(failed?.getAttribute('data-send-state')).toBe('refused');
    expect(failed?.getAttribute('aria-label')).toBe('Your message was not sent. Reason: private target detail');
    const refusalAnnouncement = failed?.querySelector('[role="alert"]');
    expect(refusalAnnouncement?.textContent).toContain('Your message was not sent. Reason: private target detail');
    expect(refusalAnnouncement?.classList.contains('tb-chat-sr-only')).toBe(true);
    const acceptedInitially = screen.getByText('Accepted text').closest('article');
    expect(acceptedInitially?.getAttribute('data-send-state')).toBe('ghosted');
    expect(acceptedInitially?.getAttribute('aria-label')).toBe('Your message is sending.');
    const sendingAnnouncement = acceptedInitially?.querySelector('[role="status"]');
    expect(sendingAnnouncement?.textContent).toContain('Your message is sending.');
    expect(sendingAnnouncement?.classList.contains('tb-chat-sr-only')).toBe(true);
    expect(screen.queryByText(/Not connected to the server|retrying…/)).toBeNull();
    expect(screen.queryByText(/Sending…|Sent|Delivery is uncertain|Accepted; checking conversation history/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry message' }));
    expect(runtime.retried).toEqual(['failed-id']);
    expect(screen.getAllByRole('button', { name: 'Restore text to the composer' })).toHaveLength(1);
    act(() => runtime.update({ sends: runtime.state.sends.map((send) => send.clientMessageId === 'accepted-id'
      ? { ...send, reconciled: true } : send) }));
    const accepted = screen.getByText('Accepted text').closest('article');
    expect(accepted?.getAttribute('data-send-state')).toBe('solid');
    expect(accepted?.getAttribute('aria-label')).toBe('Your message is in the conversation.');
    expect(accepted?.querySelector('[role="status"]')?.textContent).toContain('Your message is in the conversation.');
    expect(accepted?.querySelector('.tb-chat-send-spinner')).toBeNull();
  });

  it('keeps an unconfirmed send ghosted when safe re-asking is unavailable', () => {
    const sessionKey = 'unsupported-send-recovery';
    const runtime = new FakeRuntime(sessionKey, { status: 'ready', sends: [{
      sessionKey, deviceId: 'device', clientMessageId: 'unsupported-retry-id',
      content: 'Check this message before retrying', submittedAt: '2026-10-25T09:00:00.000Z',
      status: 'uncertain', reconciled: false, reason: 'retry-unavailable',
    }] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    expect(screen.getByText('Check this message before retrying').closest('[data-send-state]')?.getAttribute('data-send-state')).toBe('ghosted');
    expect(document.querySelector('.tb-chat-send-spinner')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore text to the composer' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to Research assistant' }), { target: { value: 'new message' } });
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false);
  });

  it('places a retried local send at its authoritative history position and keeps its reading key through reconciliation', () => {
    const sessionKey = 'chronological-send';
    const submittedAt = '2026-10-23T09:00:00.000Z';
    const prompt = row(sessionKey, 'retried-prompt', 'Original prompt', {
      seq: 3, role: 'user', sender: undefined, createdAt: submittedAt, clientMessageId: 'retry-id', deviceId: 'device',
    });
    const laterPrompt = row(sessionKey, 'later-prompt', 'Later question', {
      seq: 8, role: 'user', sender: 'user:person', createdAt: '2026-10-23T09:05:00.000Z',
    });
    const laterReply = row(sessionKey, 'later-reply', 'Later reply', {
      seq: 9, turnSeq: 2, createdAt: '2026-10-23T09:06:00.000Z',
    });
    const laterTurn = provenance(2, sessionKey, laterPrompt.id, 'user:person', laterPrompt);
    const send: LocalSend = {
      sessionKey, deviceId: 'device', clientMessageId: 'retry-id', content: 'Original prompt',
      submittedAt, status: 'accepted', reconciled: true,
    };
    const runtime = new FakeRuntime(sessionKey, {
      records: [prompt, laterPrompt, laterReply], provenance: [laterTurn], sends: [send],
    });
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const messageRows = () => [...view.container.querySelectorAll<HTMLElement>('.tb-chat-bubble')];
    const order = () => messageRows().map((element) => element.textContent ?? '');
    expect(order().findIndex((text) => text.includes('Original prompt')))
      .toBeLessThan(order().findIndex((text) => text.includes('Later question')));
    expect(order().findIndex((text) => text.includes('Later question')))
      .toBeLessThan(order().findIndex((text) => text.includes('Later reply')));
    expect(screen.getAllByText('Original prompt')).toHaveLength(1);
    const originalRow = messageRows().find((element) => element.textContent?.includes('Original prompt'));
    expect(originalRow?.dataset.scrollKey).toBe('local-retry-id');
    expect(originalRow?.getAttribute('aria-label')).toBe('Message from User');

    const originalTurn = provenance(1, sessionKey, prompt.id, 'user:person', prompt);
    act(() => {
      runtime.state = { ...runtime.state, provenance: [originalTurn, laterTurn] };
      for (const listener of runtime.listeners) listener();
    });

    expect(order().findIndex((text) => text.includes('Original prompt')))
      .toBeLessThan(order().findIndex((text) => text.includes('Later question')));
    expect(order().findIndex((text) => text.includes('Later question')))
      .toBeLessThan(order().findIndex((text) => text.includes('Later reply')));
    expect(screen.getAllByText('Original prompt')).toHaveLength(1);
    expect(messageRows().find((element) => element.textContent?.includes('Original prompt'))?.dataset.scrollKey)
      .toBe('local-retry-id');
  });

  it('inserts an unmatched send by its original submission time instead of pinning it below later history', () => {
    const sessionKey = 'unmatched-send-order';
    const otherDevicePrompt = row(sessionKey, 'other-device-prompt', 'Other device message', {
      seq: 2, role: 'user', sender: 'user:person', createdAt: '2026-10-23T08:55:00.000Z',
      clientMessageId: 'retry-id', deviceId: 'other-device',
    });
    const laterPrompt = row(sessionKey, 'later-prompt', 'Later question', {
      seq: 8, role: 'user', sender: 'user:person', createdAt: '2026-10-23T09:05:00.000Z',
    });
    const laterReply = row(sessionKey, 'later-reply', 'Later reply', {
      seq: 9, turnSeq: 2, createdAt: '2026-10-23T09:06:00.000Z',
    });
    const laterTurn = provenance(2, sessionKey, laterPrompt.id, 'user:person', laterPrompt);
    const otherDeviceTurn = provenance(1, sessionKey, otherDevicePrompt.id, 'user:person', otherDevicePrompt);
    const runtime = new FakeRuntime(sessionKey, {
      records: [otherDevicePrompt, laterPrompt, laterReply], provenance: [otherDeviceTurn, laterTurn], sends: [{
        sessionKey, deviceId: 'device', clientMessageId: 'retry-id', content: 'Original prompt',
        submittedAt: '2026-10-23T09:00:00.000Z', status: 'accepted', reconciled: false,
      }],
    });
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const order = [...view.container.querySelectorAll<HTMLElement>('.tb-chat-bubble')]
      .map((element) => element.textContent ?? '');
    expect(order.findIndex((text) => text.includes('Other device message')))
      .toBeLessThan(order.findIndex((text) => text.includes('Original prompt')));
    expect(order.findIndex((text) => text.includes('Original prompt')))
      .toBeLessThan(order.findIndex((text) => text.includes('Later question')));
    expect(order.findIndex((text) => text.includes('Later question')))
      .toBeLessThan(order.findIndex((text) => text.includes('Later reply')));
    expect(screen.getAllByText('Original prompt')).toHaveLength(1);
  });

  it('keeps many retained sends interleaved throughout a long chronological history', () => {
    const sessionKey = 'long-chronological-history';
    const start = Date.parse('2026-10-23T00:00:00.000Z');
    const history = Array.from({ length: 120 }, (_, index) => row(sessionKey, `history-${index}`,
      `History ${index}`, { seq: index + 1, createdAt: new Date(start + index * 120_000).toISOString() }));
    const sends: LocalSend[] = Array.from({ length: history.length - 1 }, (_, index) => ({
      sessionKey, deviceId: 'device', clientMessageId: `retained-${index}`, content: `Retained ${index}`,
      submittedAt: new Date(start + (index * 2 + 1) * 60_000).toISOString(),
      status: 'accepted', reconciled: false,
    }));
    const runtime = new FakeRuntime(sessionKey, { records: history, provenanceAvailable: false, sends });
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const rows = [...view.container.querySelectorAll<HTMLElement>('.tb-chat-bubble')]
      .map((element) => element.textContent ?? '');
    const expected: string[] = [];
    for (let index = 0; index < history.length; index++) {
      expected.push(`History ${index}`);
      if (index < sends.length) expected.push(`Retained ${index}`);
    }
    expect(rows).toHaveLength(expected.length);
    for (let index = 0; index < expected.length; index++) expect(rows[index]).toContain(expected[index]);
  });
});

describe('tool-call and transition display', () => {
  it('animates only capped earlier activity into view while keeping the reader anchor and reduced-motion path', () => {
    let index: ToolCallIndex | undefined;
    const names = ['Bash', 'Read', 'Grep', 'Edit', 'Search', 'Write', 'Copy', 'Move'];
    for (let seq = 1; seq <= names.length; seq++) {
      const toolName = names[seq - 1];
      const call: ToolCallRecord = { id: `group-${seq}`, seq, sessionKey: 'tool-groups', turnSeq: 1,
        afterMessageSeq: 1, harnessToolCallId: `call-${seq}`, title: `${toolName} ${seq}`, kind: 'read', toolName,
        status: 'completed', rawInput: null, rawOutput: null, content: null, truncated: [], startedAt: seq,
        endedAt: seq + 1, rowVersion: 1 };
      const group = putIndex(getIndex(index, call.afterMessageSeq), call.seq, call, call.startedAt);
      index = putIndex(index, call.afterMessageSeq, group, group.maxTime);
    }
    const human = row('tool-groups', 'human', 'A question', { seq: 1, role: 'user', sender: 'user:person' });
    const answer = row('tool-groups', 'answer', 'The answer', {
      seq: 10, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: human.id, turnSeq: 1,
    });
    const resize = installResizeObserverMock();
    try {
      for (const reduced of [false, true]) {
        const animations = installFoldAnimationMock();
        const restoreMotion = installMotionPreference(reduced);
        let layout: ReturnType<typeof installViewportLayout> | undefined;
        let view: ReturnType<typeof render> | undefined;
        try {
          const runtime = new FakeRuntime('tool-groups', { records: [human, answer], toolCallsEnabled: true, toolCallIndex: index });
          view = render(<TightbeamChat sessionKey="tool-groups" adapter={adapterFor(runtime)} />);
          const viewport = screen.getByRole('log');
          const content = viewport.querySelector<HTMLElement>('.tb-chat-message-content')!;
          layout = installViewportLayout(viewport, 200, rowElement => {
            if (rowElement.matches('.tb-chat-activity-overflow')) return 24;
            if (rowElement.matches('.tb-chat-activity-tool')) return 48;
            return undefined;
          });

          const visibleRows = () => view!.container.querySelectorAll('details.tb-chat-activity-line.tb-chat-activity-tool');
          expect(view!.container.querySelectorAll('.tb-chat-activity-overflow')).toHaveLength(1);
          expect(visibleRows()).toHaveLength(5);
          expect([...visibleRows()].map(element => element.getAttribute('data-record-key')))
            .toEqual(['tool-group-4', 'tool-group-5', 'tool-group-6', 'tool-group-7', 'tool-group-8']);
          const anchor = screen.getByText('The answer').closest('article') as HTMLElement;
          fireEvent.wheel(viewport, { deltaY: 1 });
          layout.setScrollTop(200);
          fireEvent.scroll(viewport);
          expect(screen.getByRole('button', { name: /^(?:\d+ unseen messages?|Scroll to bottom)$/ })).toBeTruthy();
          const anchorBefore = layout.offset(anchor);

          const animationStart = animations.animations.length;
          fireEvent.click(screen.getByRole('button', { name: 'Show earlier activity' }));
          expect(view!.container.querySelectorAll('.tb-chat-activity-overflow')).toHaveLength(0);
          expect(visibleRows()).toHaveLength(8);
          const revealedRows = ['tool-group-1', 'tool-group-2', 'tool-group-3'];
          expect([...visibleRows()].map(element => element.getAttribute('data-record-key')))
            .toEqual([...revealedRows, 'tool-group-4', 'tool-group-5', 'tool-group-6', 'tool-group-7', 'tool-group-8']);
          const revealAnimations = animations.animations.slice(animationStart);
          if (reduced) expect(revealAnimations).toHaveLength(0);
          else {
            expect(revealAnimations).toHaveLength(3);
            expect(revealAnimations.map(animation => animation.element.dataset.recordKey)).toEqual(revealedRows);
            for (const animation of revealAnimations) {
              expect((animation.keyframes as Keyframe[])[0]).toMatchObject({ height: '0px', opacity: 0 });
              expect(animation.options).toMatchObject({ duration: 180, fill: 'forwards' });
            }
          }
          expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);

          if (!reduced) {
            const heights = revealAnimations.map(animation =>
              Number.parseFloat(String((animation.keyframes as Keyframe[])[1].height)));
            act(() => {
              revealAnimations.forEach((animation, i) => {
                animation.element.style.height = `${heights[i] / 2}px`;
              });
              resize.notify(content);
            });
            expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);
            act(() => {
              revealAnimations.forEach((animation, i) => {
                animation.element.style.height = `${heights[i]}px`;
              });
              resize.notify(content);
              revealAnimations.forEach(animation => animation.finish());
            });
            expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);
            for (const key of revealedRows) {
              expect(view!.container.querySelector(`[data-record-key="${key}"]`)?.getAttribute('style') ?? '')
                .not.toMatch(/height:|opacity:|overflow:/);
            }
          }
          expect(visibleRows()).toHaveLength(8);
          expect([...view!.container.querySelectorAll<HTMLElement>('.tb-chat-activity-tool')]
            .filter(element => !revealedRows.includes(element.dataset.recordKey ?? ''))).toHaveLength(5);
        } finally {
          view?.unmount();
          layout?.restore();
          restoreMotion();
          animations.restore();
        }
      }
    } finally {
      resize.restore();
    }
  });

  it('caps a large tool run and expands its retained details in place', () => {
    let inspected = 0;
    let index: ToolCallIndex | undefined;
    const tool = (seq: number): ToolCallRecord => ({ id: 'tc_' + seq, seq, sessionKey: 'indexed',
      turnSeq: 1, afterMessageSeq: 1, harnessToolCallId: 'call-' + seq, title: 'Read source ' + seq,
      kind: 'read', toolName: 'read_file', status: 'in_progress', rawInput: { path: 'file.ts' },
      rawOutput: null, content: null, truncated: [], startedAt: seq, endedAt: null, rowVersion: 1 });
    const insert = (call: ToolCallRecord) => {
      const group = putIndex(getIndex(index, call.afterMessageSeq), call.seq, call, call.startedAt);
      index = putIndex(index, call.afterMessageSeq, group, group.maxTime);
    };
    for (let seq = 1; seq <= 2000; seq++) {
      const call = tool(seq);
      insert({ ...call, get title() { inspected++; return call.title; } });
    }
    const human = row('indexed', 'human', 'Read source', { seq: 1, role: 'user', sender: 'user:person' });
    const runtime = new FakeRuntime('indexed', { records: [human], toolCallsEnabled: true, toolCallIndex: index });
    const view = render(<TightbeamChat sessionKey="indexed" adapter={adapterFor(runtime)} />);
    expect(inspected).toBeLessThan(100);
    expect(view.container.querySelectorAll('.tb-chat-activity-run.tb-chat-activity-tool')).toHaveLength(1);
    expect(view.container.querySelectorAll('details.tb-chat-activity-line.tb-chat-activity-tool')).toHaveLength(0);
    const foldedRun = screen.getByRole('button', { name: /2000 entries\. Latest: Read source 2000/ });
    foldedRun.focus();
    expect(screen.queryByRole('button', { name: 'Show earlier activity' })).toBeNull();
    expect(foldedRun.getAttribute('aria-expanded')).toBe('false');
    expect(foldedRun.tagName).toBe('BUTTON');
    expect(foldedRun.classList.contains('tb-chat-activity-tool-run-toggle')).toBe(true);
    expect(foldedRun.querySelector('.tb-chat-activity-gist')?.textContent).toBe('Read source 2000 · running');
    expect(foldedRun.querySelector('.tb-chat-activity-run-count')?.textContent).toBe('×2000');
    expect(foldedRun.getAttribute('aria-label')).toMatch(/^Expand tool activity run, 2000 entries\./);
    expect(foldedRun.firstElementChild?.matches('svg.tb-chat-tool-terminal-icon')).toBe(true);
    expect(foldedRun.querySelector('.tb-chat-activity-bullet')).toBeNull();
    expect(foldedRun.querySelectorAll('.tb-chat-activity-run-chevron')).toHaveLength(1);
    expect(foldedRun.lastElementChild?.classList.contains('tb-chat-activity-run-chevron')).toBe(true);
    fireEvent.click(foldedRun);
    expect(foldedRun.getAttribute('aria-expanded')).toBe('true');
    expect(foldedRun.querySelector('.tb-chat-activity-run-chevron')?.classList.contains('is-expanded')).toBe(true);
    expect(foldedRun.querySelectorAll('.tb-chat-activity-run-chevron')).toHaveLength(1);
    expect(foldedRun.lastElementChild?.classList.contains('tb-chat-activity-run-chevron')).toBe(true);
    expect(view.container.querySelectorAll('details.tb-chat-activity-line.tb-chat-activity-tool')).toHaveLength(2000);
    expect(view.container.querySelectorAll('details.tb-chat-activity-line.tb-chat-activity-tool svg.tb-chat-tool-terminal-icon'))
      .toHaveLength(2000);
    const expandedToolTitles = [...view.container.querySelectorAll('.tb-chat-activity-run-rows .tb-chat-activity-gist')]
      .map(element => element.textContent);
    expect(expandedToolTitles).toEqual(Array.from({ length: 2000 }, (_, index) =>
      `Read source ${index + 1} · running`));
    expect(view.container.querySelector('[data-record-key="tool-tc_1"]')?.getAttribute('aria-label'))
      .toBe('Tool call: Read source 1 · running');
    const retained = view.container.querySelector<HTMLDetailsElement>('[data-record-key="tool-tc_1000"]')!;
    fireEvent.click(retained.querySelector('summary')!);
    insert(tool(2001));
    act(() => runtime.update({ toolCallIndex: index }));
    const retainedAfterAppend = view.container.querySelector<HTMLDetailsElement>('[data-record-key="tool-tc_1000"]')!;
    expect(retainedAfterAppend.open).toBe(true);
    expect(view.container.querySelectorAll('details.tb-chat-activity-line.tb-chat-activity-tool')).toHaveLength(2001);
  });

  it('keeps each collapsed tool group titled by its newest call as calls arrive', () => {
    let index: ToolCallIndex | undefined;
    const insert = (seq: number, title: string, toolName = 'read_file') => {
      const call: ToolCallRecord = { id: `title-${seq}`, seq, sessionKey: 'latest-tool-title', turnSeq: 1,
        afterMessageSeq: 1, harnessToolCallId: `call-${seq}`, title, kind: 'read', toolName,
        status: 'in_progress', rawInput: null, rawOutput: null, content: null, truncated: [],
        startedAt: seq, endedAt: null, rowVersion: 1 };
      const group = putIndex(getIndex(index, call.afterMessageSeq), call.seq, call, call.startedAt);
      index = putIndex(index, call.afterMessageSeq, group, group.maxTime);
    };
    insert(201, 'Read first file');
    insert(202, 'Read second file');

    const human = row('latest-tool-title', 'human', 'Keep this message visible', {
      role: 'user', sender: 'user:person', seq: 1,
    });
    const runtime = new FakeRuntime('latest-tool-title', {
      records: [human], toolCallsEnabled: true, toolCallIndex: index,
    });
    const view = render(<TightbeamChat sessionKey="latest-tool-title" adapter={adapterFor(runtime)} />);
    const foldedRun = screen.getByRole('button', {
      name: /2 entries\. Latest: Read second file · running/,
    });
    const foldKey = foldedRun.closest('[data-activity-fold]')?.getAttribute('data-record-key');
    expect(foldedRun.querySelector('.tb-chat-activity-gist')?.textContent).toBe('Read second file · running');
    expect(foldedRun.getAttribute('aria-expanded')).toBe('false');
    expect(foldedRun.firstElementChild?.matches('svg.tb-chat-tool-terminal-icon')).toBe(true);
    expect(foldedRun.querySelector('.tb-chat-activity-bullet')).toBeNull();
    expect(foldedRun.querySelectorAll('.tb-chat-activity-run-chevron')).toHaveLength(1);

    insert(203, 'Read third file');
    act(() => runtime.update({ toolCallIndex: index }));
    const updatedFold = screen.getByRole('button', {
      name: /3 entries\. Latest: Read third file · running/,
    });
    expect(updatedFold.closest('[data-activity-fold]')?.getAttribute('data-record-key')).toBe(foldKey);
    expect(updatedFold.querySelector('.tb-chat-activity-gist')?.textContent).toBe('Read third file · running');

    insert(204, 'List files', 'list_files');
    act(() => runtime.update({ toolCallIndex: index }));
    const readFoldAfterBoundary = screen.getByRole('button', { name: /3 entries\. Latest: Read third file · running/ });
    expect(readFoldAfterBoundary.closest('[data-activity-fold]')?.getAttribute('data-record-key')).toBe(foldKey);
    expect(view.container.querySelectorAll('.tb-chat-activity-run.tb-chat-activity-tool')).toHaveLength(1);
    expect(view.container.querySelectorAll('details.tb-chat-activity-line.tb-chat-activity-tool')).toHaveLength(1);

    fireEvent.click(updatedFold);
    expect(updatedFold.getAttribute('aria-expanded')).toBe('true');
    const expandedRun = view.container.querySelector<HTMLElement>(
      `[data-activity-fold][data-record-key="${foldKey}"]`,
    );
    expect(expandedRun?.getAttribute('data-run-expanded')).toBe('true');
    expect([...view.container.querySelectorAll(
      `[data-activity-fold][data-record-key="${foldKey}"] .tb-chat-activity-run-rows .tb-chat-activity-gist`,
    )]
      .map(element => element.textContent)).toEqual([
      'Read first file · running', 'Read second file · running', 'Read third file · running',
    ]);
    expect(screen.getByText('List files · running')).toBeTruthy();
    expect(within(screen.getByRole('log')).getByText('Keep this message visible')).toBeTruthy();
  });

  it('keeps an unmatched send at submission time among tools, then uses its canonical anchor with the same scroll key', () => {
    let index: ToolCallIndex | undefined;
    for (const [seq, startedAt] of [[201, 2000], [202, 4000]]) {
      const call: ToolCallRecord = { id: 'tc_' + seq, seq, sessionKey: 'ordered-tools', turnSeq: 1,
        afterMessageSeq: 10, harnessToolCallId: 'call-' + seq, title: 'Tool ' + seq, kind: 'read',
        toolName: 'read_file', status: 'in_progress', rawInput: null, rawOutput: null, content: null,
        truncated: [], startedAt, endedAt: null, rowVersion: 1 };
      const group = putIndex(getIndex(index, 10), seq, call, startedAt);
      index = putIndex(index, 10, group, group.maxTime);
    }
    const human = row('ordered-tools', 'human', 'First prompt', { seq: 10, role: 'user', sender: 'user:person', createdAt: new Date(1000).toISOString() });
    const reply = row('ordered-tools', 'reply', 'Answer', { seq: 12, createdAt: new Date(5000).toISOString(), replyToMessageId: human.id });
    const send: LocalSend = { sessionKey: 'ordered-tools', deviceId: 'device', clientMessageId: 'c_pending',
      content: 'Follow-up', submittedAt: new Date(3000).toISOString(), status: 'pending', reconciled: false };
    const runtime = new FakeRuntime('ordered-tools', { records: [human, reply], sends: [send], toolCallsEnabled: true, toolCallIndex: index });
    const view = render(<TightbeamChat sessionKey="ordered-tools" adapter={adapterFor(runtime)} />);
    const keys = () => [...view.container.querySelectorAll('[data-scroll-key]')].map(node => node.getAttribute('data-scroll-key'));
    expect(keys()).toEqual(['human', 'tool-tc_201', 'local-c_pending', 'tool-tc_202', 'reply']);
    const canonical = row('ordered-tools', 'canonical-send', send.content, { seq: 11, role: 'user', sender: 'user:person',
      createdAt: send.submittedAt, clientMessageId: send.clientMessageId, deviceId: send.deviceId });
    act(() => runtime.update({ records: [human, canonical, reply], sends: [{ ...send, reconciled: true, status: 'accepted' }] }));
    expect(keys()).toEqual(['human', 'tool:tc_201', 'local-c_pending', 'reply']);
    expect(screen.getByRole('button', { name: /2 entries\. Latest: Tool 202/ })).toBeTruthy();
    expect(within(screen.getByRole('log')).getAllByText('Follow-up')).toHaveLength(1);
  });

  it('displays served tool calls automatically and keeps their details and the draft intact', async () => {
    const call: ToolCallRecord = { id: 'tc_read', seq: 500, sessionKey: 'tools', turnSeq: 7, afterMessageSeq: 1,
      harnessToolCallId: 'read-1', title: 'Read the source file', kind: 'read', toolName: 'read_file',
      status: 'in_progress', rawInput: { path: 'source.ts' }, rawOutput: null, content: null,
      truncated: [], startedAt: 1000, endedAt: null, rowVersion: 1 };
    const human = row('tools', 'human', 'Please read the source', { role: 'user', sender: 'user:person', seq: 1 });
    const reply = row('tools', 'reply', 'Read complete', { seq: 3, replyToMessageId: human.id });
    const laterMessages = Array.from({ length: 5 }, (_, index) => row('tools', `later-${index + 1}`,
      `Later message ${index + 1}`, { seq: index + 4, role: 'user', sender: 'user:person' }));
    const marker: ConversationRecord = { kind: 'transition', id: 'boundary', seq: 2, rowVersion: 1,
      sessionKey: 'tools', transition: 'unknown', from: 'old', to: 'new', content: 'A new boundary kind', raw: {} };
    const runtime = new FakeRuntime('tools', { records: [human, marker, reply, ...laterMessages], toolCallsEnabled: true, toolCalls: [call] });
    const view = render(<TightbeamChat sessionKey="tools" adapter={adapterFor(runtime)} />);
    const viewport = screen.getByRole('log');
    const layout = installViewportLayout(viewport);
    const anchor = screen.getByText('Read complete').closest<HTMLElement>('[data-scroll-key]')!;
    layout.setScrollTop(304);
    fireEvent.scroll(viewport);
    const anchorBefore = layout.offset(anchor);
    try {
      expect(screen.queryByRole('button', { name: 'Tool calls' })).toBeNull();
      expect(screen.queryByText('Tool calls')).toBeNull();
      expect([...view.container.querySelectorAll('[data-record-key]')].slice(0, 4).map(node => node.getAttribute('data-record-key')))
        .toEqual(['human', 'tool-tc_read', 'boundary', 'reply']);
      expect(screen.getByText('A new boundary kind')).toBeTruthy();
      expect(screen.getByText('A new boundary kind').closest('.tb-chat-transition-marker')?.getAttribute('role')).toBe('separator');
      expect(screen.queryByText('source.ts')).toBeNull();
      const details = view.container.querySelector('details')!;
      const terminalIcon = details.querySelector<SVGSVGElement>('summary > .tb-chat-tool-terminal-icon');
      expect(terminalIcon?.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(terminalIcon?.getAttribute('aria-hidden')).toBe('true');
      expect(terminalIcon?.getAttribute('focusable')).toBe('false');
      expect(terminalIcon?.querySelector('rect')?.getAttribute('fill')).toBe('currentColor');
      expect([...(terminalIcon?.querySelectorAll('path') ?? [])].map(path => path.getAttribute('stroke')))
        .toEqual(['var(--tb-chat-background)', 'var(--tb-chat-background)']);
      expect([...(terminalIcon?.querySelectorAll('path') ?? [])].map(path => path.getAttribute('stroke-linecap')))
        .toEqual(['round', 'round']);
      expect([...(terminalIcon?.querySelectorAll('path') ?? [])].map(path => path.getAttribute('stroke-linejoin')))
        .toEqual(['round', null]);
      expect(details.querySelector('.tb-chat-activity-bullet')).toBeNull();
      expect(details.classList.contains('tb-chat-activity-tool')).toBe(true);
      expect(details.getAttribute('aria-label')).toBe('Tool call: Read the source file · running');
      expect(details.querySelector('summary')?.getAttribute('aria-label'))
        .toBe('Tool call: Read the source file · running. Show input and result');
      fireEvent.click(details.querySelector('summary')!);
      await screen.findByText(/source.ts/);
      expect(screen.getByText('Waiting for result…')).toBeTruthy();
      const rail = details.querySelector('.tb-chat-tool-detail-rail')!;
      expect(rail.getAttribute('aria-hidden')).toBe('false');
      expect(rail.querySelectorAll('section').length).toBe(2);
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);
      const editor = screen.getByRole('textbox');
      fireEvent.change(editor, { target: { value: 'draft kept' } });
      act(() => runtime.update({ toolCalls: [{ ...call, status: 'completed', rowVersion: 2,
        rawOutput: '{"prefix":', truncated: [{ field: 'rawOutput', originalBytes: 20000 }], endedAt: 2000 }] }));
      expect(screen.getByText('Read the source file · done')).toBeTruthy();
      expect(screen.getByText('Result truncated — original size 20000 bytes.')).toBeTruthy();
      expect(screen.getByText('{"prefix":')).toBeTruthy();
      expect(screen.getByText('A new boundary kind')).toBeTruthy();
      expect((editor as HTMLTextAreaElement).value).toBe('draft kept');
      expect(screen.getByText('Read the source file · done')).toBeTruthy();
      fireEvent.click(details.querySelector('summary')!);
      expect(details.open).toBe(false);
      expect(layout.offset(anchor)).toBeCloseTo(anchorBefore, 0);
    } finally {
      layout.restore();
    }
  });

  it('animates tool, activity, and attachment disclosures and skips motion when requested', () => {
    const sessionKey = 'fold-motion';
    const human = row(sessionKey, 'question', 'Read these files', {
      seq: 1, role: 'user', sender: 'user:person', turnSeq: 1, attachments: [{ name: 'notes.txt' }],
    });
    const activity = Array.from({ length: 6 }, (_, index) => row(sessionKey, `notice-${index + 1}`,
      `Quiet for ${index + 1} min · Background activity ${index + 1}`, {
      seq: index + 2, role: 'user', sender: 'process:events', messageType: 'substrate',
    }));
    const reply = row(sessionKey, 'reply', 'Here is the result', {
      seq: 12, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: human.id, turnSeq: 1,
    });
    const call: ToolCallRecord = { id: 'tc_read', seq: 13, sessionKey, turnSeq: 1, afterMessageSeq: 1,
      harnessToolCallId: 'read-1', title: 'Read notes', kind: 'read', toolName: 'read_file',
      status: 'completed', rawInput: { path: 'notes.txt' }, rawOutput: 'Done', content: null,
      truncated: [], startedAt: 1000, endedAt: 1200, rowVersion: 1 };

    for (const reduced of [false, true]) {
      const animations = installFoldAnimationMock();
      const restoreMotion = installMotionPreference(reduced);
      try {
        const runtime = new FakeRuntime(sessionKey, { records: [human, ...activity, reply],
          activityTurnStateAvailable: true, toolCallsEnabled: true, toolCalls: [call] });
        const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
        const finishLatest = (from: number) => act(() => {
          animations.animations.slice(from).forEach(animation => animation.finish());
        });

        const attachment = screen.getByText('1 attachment detail').closest('details')!;
        const attachmentStart = animations.animations.length;
        fireEvent.click(attachment.querySelector('summary')!);
        expect(attachment.open).toBe(true);
        const attachmentContent = attachment.querySelector('.tb-chat-attachment-content')!;
        expect(attachmentContent.getAttribute('aria-hidden')).toBe('false');
        if (reduced) expect(animations.animations.length).toBe(attachmentStart);
        else {
          expect(animations.animations.length).toBeGreaterThan(attachmentStart);
          expect(animations.animations[attachmentStart].element).toBe(attachmentContent);
          expect(animations.animations[attachmentStart].options).toMatchObject({ duration: 180 });
          finishLatest(attachmentStart);
        }

        const tool = view.container.querySelector<HTMLDetailsElement>('.tb-chat-activity-tool')!;
        const toolStart = animations.animations.length;
        fireEvent.click(tool.querySelector('summary')!);
        expect(tool.open).toBe(true);
        const rail = tool.querySelector('.tb-chat-tool-detail-rail')!;
        expect(rail.classList.contains('tb-chat-fold-content')).toBe(true);
        expect(rail.querySelectorAll('section')).toHaveLength(2);
        if (reduced) expect(animations.animations.length).toBe(toolStart);
        else {
          expect(animations.animations.length).toBeGreaterThan(toolStart);
          expect(animations.animations[toolStart].element).toBe(rail);
          expect((animations.animations[toolStart].keyframes as Keyframe[])[0]).toMatchObject({ height: '0px', opacity: 0 });
          expect(animations.animations[toolStart].options).toMatchObject({ duration: 180 });
          finishLatest(toolStart);
        }

        const fold = screen.getByRole('button', { name: /Expand substrate activity run, 6 entries/ });
        const foldStart = animations.animations.length;
        fireEvent.click(fold);
        expect(fold.getAttribute('aria-expanded')).toBe('true');
        const rows = fold.closest('.tb-chat-activity-run')?.querySelector('.tb-chat-activity-run-rows')!;
        expect(rows.children).toHaveLength(6);
        if (reduced) expect(animations.animations.length).toBe(foldStart);
        else {
          expect(animations.animations.length).toBeGreaterThan(foldStart);
          expect(animations.animations[foldStart].element.classList.contains('tb-chat-activity-run-content')).toBe(true);
          expect((animations.animations[foldStart].keyframes as Keyframe[])[0]).toMatchObject({ height: '0px', opacity: 0 });
          finishLatest(foldStart);
        }

        const pillRow = rows.querySelector<HTMLElement>('.tb-chat-activity-pill-row')!;
        const pillSummary = pillRow.querySelector('summary')!;
        const pillStart = animations.animations.length;
        fireEvent.click(pillSummary);
        expect(pillSummary.getAttribute('aria-expanded')).toBe('true');
        const pillRail = pillRow.querySelector<HTMLElement>('.tb-chat-tool-detail-rail')!;
        expect(pillRail.classList.contains('tb-chat-fold-content')).toBe(true);
        if (reduced) expect(animations.animations.length).toBe(pillStart);
        else {
          expect(animations.animations.length).toBeGreaterThan(pillStart);
          expect(animations.animations[pillStart].element).toBe(pillRail);
          expect((animations.animations[pillStart].keyframes as Keyframe[])[0]).toMatchObject({ height: '0px', opacity: 0 });
          expect(animations.animations[pillStart].options).toMatchObject({ duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
          finishLatest(pillStart);
        }
        const pillCloseStart = animations.animations.length;
        fireEvent.click(pillSummary);
        expect(pillSummary.getAttribute('aria-expanded')).toBe('false');
        if (reduced) {
          expect(animations.animations.length).toBe(pillCloseStart);
          expect(pillRow.querySelector('.tb-chat-tool-detail-rail')).toBeNull();
        } else {
          expect(animations.animations.length).toBeGreaterThan(pillCloseStart);
          expect((animations.animations[pillCloseStart].keyframes as Keyframe[])[1]).toMatchObject({ height: '0px', opacity: 0 });
          finishLatest(pillCloseStart);
          expect(pillRow.querySelector('.tb-chat-tool-detail-rail')).toBeNull();
        }

        const foldCloseStart = animations.animations.length;
        fireEvent.click(fold);
        expect(fold.getAttribute('aria-expanded')).toBe('false');
        if (reduced) {
          expect(animations.animations.length).toBe(foldCloseStart);
          expect(fold.closest('.tb-chat-activity-run')?.querySelector('.tb-chat-activity-run-content')).toBeNull();
        } else {
          expect(animations.animations.length).toBeGreaterThan(foldCloseStart);
          const content = fold.closest('.tb-chat-activity-run')?.querySelector('.tb-chat-activity-run-content')!;
          expect(content.getAttribute('aria-hidden')).toBe('true');
          expect((animations.animations[foldCloseStart].keyframes as Keyframe[])[1]).toMatchObject({ height: '0px', opacity: 0 });
          finishLatest(foldCloseStart);
          expect(fold.closest('.tb-chat-activity-run')?.querySelector('.tb-chat-activity-run-content')).toBeNull();
        }

        const closeStart = animations.animations.length;
        fireEvent.click(tool.querySelector('summary')!);
        if (reduced) {
          expect(tool.open).toBe(false);
          expect(animations.animations.length).toBe(closeStart);
        } else {
          expect(tool.open).toBe(true);
          expect(tool.querySelector('.tb-chat-tool-detail-rail')?.getAttribute('aria-hidden')).toBe('true');
          expect(tool.querySelector('.tb-chat-tool-detail-rail')?.hasAttribute('inert')).toBe(true);
          expect((animations.animations[closeStart].keyframes as Keyframe[])[1]).toMatchObject({ height: '0px', opacity: 0 });
          finishLatest(closeStart);
          expect(tool.open).toBe(false);
        }
        expect(view.container.querySelector('[data-record-key="tool-tc_read"]')).toBe(tool);
        expect(tool.querySelector('summary')?.getAttribute('aria-label')).toContain('Read notes · done');
        view.unmount();
      } finally {
        cleanup();
        restoreMotion();
        animations.restore();
      }
    }
  });
});

it('reopens waiting summary delivery on live-feed recovery while conversation status remains ready', async () => {
  const sessionKey = 'summary-recovery';
  const human = row(sessionKey, 'question', 'Question', { seq: 1, role: 'user', sender: 'user:person', turnSeq: 1 });
  const activity = row(sessionKey, 'agent-note', 'Original activity', { seq: 2, role: 'user', sender: 'agent:helper', turnSeq: 1 });
  const reply = row(sessionKey, 'reply', 'Reply', { seq: 3, sender: 'assistant-service', replyToMessageId: human.id, turnSeq: 1 });
  const runtime = new FakeRuntime(sessionKey, { records: [human, activity, reply], liveConnectionState: 'connected' });
  const calls: { receive: (answer: SummaryAnswer) => void; close: () => void }[] = [];
  const activitySummaries: ActivitySummaryTransport = { stream: (_sources, receive, signal) => new Promise<void>(resolve => {
    calls.push({ receive, close: resolve });
    signal.addEventListener('abort', () => resolve(), { once: true });
  }) };
  render(<TightbeamChat sessionKey={sessionKey} adapter={{ ...adapterFor(runtime), activitySummaries }} />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { calls[0].receive({ index: 0, state: 'waiting' }); calls[0].close(); });
  expect(calls).toHaveLength(2);
  await act(async () => { calls[1].close(); });
  act(() => runtime.update({}));
  expect(calls).toHaveLength(2);
  act(() => runtime.update({ liveConnectionState: 'reconnecting' }));
  await act(async () => { runtime.update({ liveConnectionState: 'connected' }); });
  expect(runtime.state.status).toBe('ready');
  expect(calls).toHaveLength(3);
  await act(async () => { calls[2].receive({ index: 0, state: 'summary', summary: 'Completed activity.' }); calls[2].close(); });
  expect(screen.getByText('Completed activity.')).toBeTruthy();
  expect(screen.queryByText('summarizing')).toBeNull();
});

it('places durable pills at record time after a tied tool, and lets an exact notice replace only the pill without losing the draft', () => {
  const sessionKey = 'record-events';
  const human = row(sessionKey, 'question', 'Hello', { role: 'user', sender: 'user:person', seq: 1,
    createdAt: new Date(100).toISOString() });
  const answer = row(sessionKey, 'answer', 'Answer', { seq: 2, createdAt: new Date(300).toISOString() });
  const call: ToolCallRecord = { id: 'tool-example', seq: 1, sessionKey, turnSeq: 1, afterMessageSeq: 1,
    harnessToolCallId: 'h1', title: 'Create a work item', kind: 'command', toolName: 'create', status: 'completed',
    rawInput: {}, rawOutput: {}, content: null, truncated: [], startedAt: 200, endedAt: 200, rowVersion: 1 };
  const event = { eventId: 'work_item.filed:example', kind: 'work_item.filed', sessionKey, at: 200,
    record: { type: 'work item', id: 'example', detail: '/api/work-items/example' },
    actorSessionKey: sessionKey, tiedAs: ['creator'], cause: { turnSeq: 1, messageId: null }, noticeMessageIds: [] };
  const runtime = new FakeRuntime(sessionKey, { records: [human, answer], toolCallsEnabled: true,
    toolCalls: [call], recordEvents: [event] });
  const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
  const keys = () => [...view.container.querySelectorAll('[data-record-key]')].map(element => element.getAttribute('data-record-key'));
  expect(keys().indexOf('record-event:' + event.eventId)).toBeGreaterThan(keys().indexOf('tool-tool-example'));
  expect(keys().indexOf('record-event:' + event.eventId)).toBeLessThan(keys().indexOf('answer'));
  const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(textbox, { target: { value: 'Unsent draft' } });
  textbox.focus();
  textbox.setSelectionRange(3, 7);
  const notice = row(sessionKey, 'notice', '[assignment opened: assignment-example]', {
    seq: 3, sender: 'process:events', messageType: 'substrate', recordEventIds: [event.eventId],
    createdAt: new Date(400).toISOString(), turnSeq: 1 });
  act(() => runtime.update({ records: [human, answer, notice] }));
  expect(keys()).not.toContain('record-event:' + event.eventId);
  expect(keys()).toContain('tool-tool-example');
  expect(screen.getByText(/assignment opened: assignment-example/i)).toBeTruthy();
  expect(document.activeElement).toBe(textbox);
  expect(textbox.value).toBe('Unsent draft');
  expect([textbox.selectionStart, textbox.selectionEnd]).toEqual([3, 7]);
  // A notice's same text or resource reference alone must not hide another occurrence.
  act(() => runtime.update({ recordEvents: [{ ...event, eventId: 'work_item.filed:other' }] }));
  expect(keys()).toContain('record-event:work_item.filed:other');
});

it('keeps a covering notice visible without a human span, including notice-first arrival and multiple covered events', () => {
  const sessionKey = 'notice-first';
  const coverage = ['assignment.opened:first', 'attest.filed:second'];
  const notice = row(sessionKey, 'notice-first-row', 'Both requested records are now available', {
    role: 'user', sender: 'agent:another', seq: 1, recordEventIds: coverage,
  });
  const runtime = new FakeRuntime(sessionKey, { records: [notice] });
  const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
  const pill = screen.getByText('Both requested records are now available').closest('[role="note"]');
  expect(pill).not.toBeNull();
  expect(pill?.getAttribute('title')).toBe(notice.content);
  const events = coverage.map((eventId, at) => ({ eventId, sessionKey, at, kind: eventId.split(':')[0],
    record: { type: 'assignment', id: eventId, detail: '/api/assignments/example' },
    actorSessionKey: 'another', tiedAs: ['holder'], cause: null, noticeMessageIds: [] }));
  act(() => runtime.update({ recordEvents: events }));
  expect(view.container.querySelectorAll('[data-record-key^="record-event:"]')).toHaveLength(0);
  expect(view.container.querySelectorAll('[data-record-key="message:notice-first-row"]')).toHaveLength(1);
});
