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
import { AttachmentPreparationError } from '../src/types';
import type {
  AttachmentInput, AttachmentReference, ToolCallIndex, ToolCallRecord, CanonicalMessage, CanonicalTurn, ChatRuntime, ConversationRecord, LocalSend, RuntimeState,
  TightbeamAdapter, TurnProvenance, TurnEventRecord,
} from '../src/types';

afterEach(() => {
  cleanup();
  document.querySelectorAll('style[data-chat-component-test]').forEach(style => style.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const restore of propertyRestores.splice(0)) restore();
});

const propertyRestores: Array<() => void> = [];

function stubProperty(target: object, key: PropertyKey, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  propertyRestores.push(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  });
}

function mockObjectUrls(create: (blob: Blob) => string = () => 'blob:composer-preview') {
  const createObjectURL = vi.fn(create);
  const revokeObjectURL = vi.fn();
  stubProperty(URL, 'createObjectURL', createObjectURL);
  stubProperty(URL, 'revokeObjectURL', revokeObjectURL);
  return { createObjectURL, revokeObjectURL };
}

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
  attachmentSendResult: string | null = 'fixture-attachment-send';
  attachmentSubmissions: Array<{ content: string; inputs: readonly { id: string; filename: string; bytes: Blob }[] }> = [];
  confirmedAttachmentSends: string[] = [];
  cancelledAttachmentSends: string[] = [];
  readAttachment?: ChatRuntime['readAttachment'];
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
  prepareAttachmentInputs = async (inputs: readonly AttachmentInput[]) => inputs;
  sendAttachments = (content: string, inputs: readonly { id: string; filename: string; bytes: Blob }[]) => {
    this.attachmentSubmissions.push({ content, inputs });
    return this.attachmentSendResult;
  };
  confirmAttachmentSend = (id: string) => { this.confirmedAttachmentSends.push(id); return true; };
  cancelAttachmentSend = (id: string) => { this.cancelledAttachmentSends.push(id); return true; };
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

function dispatchClipboardPaste(input: HTMLTextAreaElement, clipboardData: {
  readonly items?: readonly { readonly kind: string; readonly type: string; getAsFile(): File | null }[];
  readonly files?: readonly File[];
  getData(type: string): string;
}): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: {
    items: clipboardData.items ?? [], files: clipboardData.files ?? [], getData: clipboardData.getData,
  } });
  act(() => { input.dispatchEvent(event); });
  return event;
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
    if ((this.classList.contains('tb-chat-latest-user-prompt') ||
      this.classList.contains('tb-chat-latest-user-prompt-measurement')) && frame.promptPreviewHeight) {
      return new DOMRect(0, top + 10, width, frame.promptPreviewHeight);
    }
    if (this.classList.contains('tb-chat-bubble-body')) {
      const row = this.closest<HTMLElement>('article[data-record-key]');
      if (row) {
        const rowBounds = row.getBoundingClientRect();
        const bodyTop = rowBounds.top + 12;
        const bodyBottom = rowBounds.bottom - 29;
        return new DOMRect(0, bodyTop, width, Math.max(0, bodyBottom - bodyTop));
      }
    }
    if (this.classList.contains('tb-chat-scroll-latest')) return new DOMRect(0, top + height - 120, width, 44);
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
  const prompts = Array.from({ length: 12 }, (_, index) => row(sessionKey, `prompt-${index + 1}`,
    index === 11 ? 'Short answered prompt'
      : index % 2 === 0 ? `Long previous prompt ${index + 1} ${'earlier context '.repeat(18)}`
        : `Short previous prompt ${index + 1}`, {
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
    const measurement = viewport.parentElement?.querySelector<HTMLElement>('.tb-chat-latest-user-prompt-measurement');
    expect(measurement).toBeTruthy();
    expect(measurement?.querySelector('.tb-chat-latest-user-prompt-text')?.textContent)
      .toMatch(/Long previous prompt|Short previous prompt|Short answered prompt/);
    Object.defineProperty(measurement, 'getBoundingClientRect', { configurable: true, value: () => {
      const text = measurement!.querySelector('.tb-chat-latest-user-prompt-text')?.textContent ?? '';
      return new DOMRect(0, 10, width, text.startsWith('Long previous prompt') ? 70 : 30);
    } });
    fireEvent.scroll(viewport);
    flushFrames();

    expect(screen.queryByText('The conversation could not be displayed. Its history is still available.')).toBeNull();
    expect(viewport.parentElement?.querySelector('.tb-chat-latest-user-prompt-measurement')).toBeNull();
    const answeredPromptRow = viewport.querySelector<HTMLElement>(`[data-scroll-key="${answeredPrompt.id}"]`)!;
    const replyRow = viewport.querySelector<HTMLElement>('[data-scroll-key="assistant-reply"]')!;
    const promptBody = answeredPromptRow.querySelector<HTMLElement>('.tb-chat-bubble-body')!;
    const preview = screen.queryByRole('button', { name: 'Jump to user prompt' });
    const previewBottom = preview?.getBoundingClientRect().bottom ?? viewport.getBoundingClientRect().top;
    const visibleBottom = screen.getByRole('button', { name: 'Scroll to bottom' }).getBoundingClientRect().top;
    const visibleHeight = visibleBottom - viewport.getBoundingClientRect().top;

    expect(viewport.querySelector('[data-record-key="tool-read-call"]')).not.toBeNull();
    expect(viewport.querySelector('[data-record-key="record-event:update-example"]')).not.toBeNull();
    expect(answeredPromptRow.getBoundingClientRect().bottom - previewBottom).toBeGreaterThanOrEqual(4);
    expect(promptBody.getBoundingClientRect().bottom - previewBottom).toBeGreaterThanOrEqual(12);
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
    `Hidden assistant substrate marker ${prefix}`,
    `Hidden process notice ${prefix}`,
  ]) {
    const renderedAsBubble = [...log.querySelectorAll<HTMLElement>('.tb-chat-bubble')]
      .some(element => element.textContent?.includes(label));
    expect(renderedAsBubble).toBe(false);
    expect(within(log).queryByText(label)).toBeNull();
  }
  const agentRow = log.querySelector<HTMLElement>(`[data-record-key="message:${prefix}-agent-wake"]`);
  expect(agentRow?.classList.contains('tb-chat-activity-agent')).toBe(true);
  expect(agentRow?.closest('.tb-chat-bubble')).toBeNull();
  expect(agentRow?.textContent).toContain(`Hidden agent wake ${prefix}`);
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
      const unseenButton = screen.getByRole('button', { name: /^\d+ unseen messages?$/ });
      expect(unseenButton.textContent).toBe('');
      expect(unseenButton.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
      fireEvent.click(unseenButton);
      const latestButton = screen.getByRole('button', { name: 'Scroll to bottom' });
      expect(latestButton.textContent).toBe('');
      expect(latestButton.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
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

  it('renders ordered transcript image references with enlargement for user and agent messages', async () => {
    const sessionKey = 'transcript-image-references';
    const userBefore = { assetId: 'user-file-before', mimeType: 'application/pdf', filename: 'before.pdf', size: 21 };
    const userImage: AttachmentReference = {
      assetId: 'user-image', mimeType: 'image/png', filename: 'user-photo.png', size: 32,
    };
    const userAfter = { assetId: 'user-file-after', mimeType: 'application/pdf', filename: 'after.pdf', size: 23 };
    const agentImage: AttachmentReference = {
      assetId: 'agent-image', mimeType: 'image/jpeg', filename: 'agent-photo.jpg', size: 34,
    };
    const userMessage = decodePublic019Message({
      id: 'user-image-message', seq: 10, rowVersion: 10, sessionKey, role: 'user', sender: 'user:person',
      messageType: 'chat', content: 'Here is a photo.', assignmentId: 'task-123', turnSeq: 7,
      at: Date.parse('2026-11-04T00:00:00Z'), attachments: [userBefore, userImage, userAfter],
    }, sessionKey);
    const agentMessage = decodePublic019Message({
      id: 'agent-image-message', seq: 11, rowVersion: 11, sessionKey, role: 'assistant', sender: 'assistant-service',
      messageType: 'assistant', content: 'I have attached the result.', assignmentId: 'task-123', turnSeq: 7,
      replyToMessageId: userMessage.id, at: Date.parse('2026-11-04T00:01:00Z'), attachments: [agentImage],
    }, sessionKey);
    const runtime = new FakeRuntime(sessionKey, { records: [userMessage, agentMessage] });
    const readAttachment = vi.fn(async (reference: AttachmentReference, _signal: AbortSignal) =>
      new Blob(['image bytes'], { type: reference.mimeType }));
    runtime.readAttachment = readAttachment;
    let objectUrlNumber = 0;
    const objectUrls = mockObjectUrls(() => `blob:transcript-image-${++objectUrlNumber}`);

    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    expect(await screen.findByRole('img', { name: 'Image: user-photo.png' })).toBeTruthy();
    expect(await screen.findByRole('img', { name: 'Image: agent-photo.jpg' })).toBeTruthy();
    expect(readAttachment).toHaveBeenCalledWith(userImage, expect.any(AbortSignal));
    expect(readAttachment).toHaveBeenCalledWith(agentImage, expect.any(AbortSignal));

    const userRow = screen.getByText('Here is a photo.').closest<HTMLElement>('.tb-chat-bubble')!;
    const genericDisclosures = within(userRow).getAllByText('1 attachment detail')
      .map(summary => summary.closest('details')!);
    const userPreview = within(userRow).getByRole('button', { name: 'Enlarge Image: user-photo.png' });
    expect(genericDisclosures).toHaveLength(2);
    expect(genericDisclosures[0].compareDocumentPosition(userPreview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(userPreview.compareDocumentPosition(genericDisclosures[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    genericDisclosures.forEach(disclosure => fireEvent.click(disclosure.querySelector('summary')!));
    await waitFor(() => expect(userRow.querySelectorAll('pre')).toHaveLength(2));
    expect(userRow.querySelectorAll('pre')[0].textContent).toContain('user-file-before');
    expect(userRow.querySelectorAll('pre')[0].textContent).not.toContain('user-image');
    expect(userRow.querySelectorAll('pre')[1].textContent).toContain('user-file-after');

    fireEvent.click(userPreview);
    const enlarged = screen.getByRole('dialog');
    expect(within(enlarged).getByRole('img', { name: 'Image: user-photo.png' })).toBeTruthy();
    expect(objectUrls.createObjectURL).toHaveBeenCalled();

    const agentRow = screen.getByText('I have attached the result.').closest<HTMLElement>('.tb-chat-bubble')!;
    expect(within(agentRow).getByRole('button', { name: 'Enlarge Image: agent-photo.jpg' })).toBeTruthy();
    expect(agentRow.querySelector('details.tb-chat-attachments')).toBeNull();
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
    const agentRow = log.querySelector<HTMLElement>('[data-record-key="message:other-trigger"]');
    expect(agentRow?.classList.contains('tb-chat-activity-agent')).toBe(true);
    expect(agentRow?.closest('.tb-chat-bubble')).toBeNull();
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

  it('renders Markdown image links through the shared enlarge view while keeping raw HTML inert', () => {
    const sessionKey = 'markdown-image-preview';
    const imageUrl = 'https://images.example/chart.png';
    const content = [
      `![A chart](${imageUrl})`,
      '',
      '<script>window.markdownImageCompromised = true</script>',
      '<img src="https://images.example/raw-html.png" onerror="window.markdownImageCompromised = true">',
    ].join('\n');
    const message = row(sessionKey, 'markdown-image', content, {
      role: 'user', sender: 'user:person', messageType: 'chat',
    });
    const runtime = new FakeRuntime(sessionKey, { records: [message] });

    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const log = screen.getByRole('log');
    const thumbnail = within(log).getByRole('img', { name: 'A chart' }) as HTMLImageElement;
    expect(thumbnail.getAttribute('src')).toBe(imageUrl);
    const frame = thumbnail.closest('.tb-chat-markdown-image');
    const bubble = thumbnail.closest('.tb-chat-bubble');
    const layout = installViewportLayout(log);
    try {
      layout.setScrollTop(52);
      fireEvent.load(thumbnail);
      expect(layout.scrollTop).toBe(52);
      expect(thumbnail.closest('.tb-chat-markdown-image')).toBe(frame);
      expect(thumbnail.closest('.tb-chat-bubble')).toBe(bubble);
    } finally {
      layout.restore();
    }

    const enlarge = screen.getByRole('button', { name: 'Enlarge A chart' });
    fireEvent.click(enlarge);
    expect(screen.getByRole('dialog', { name: 'A chart' }).querySelector('img')?.getAttribute('src')).toBe(imageUrl);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(enlarge);

    expect(log.querySelector('script')).toBeNull();
    expect(log.querySelector('img[src="https://images.example/raw-html.png"]')).toBeNull();
    expect((window as Window & { markdownImageCompromised?: boolean }).markdownImageCompromised).toBeUndefined();
  });

  it('shows a broken-image fallback labeled with Markdown alt text after the image fails', async () => {
    const sessionKey = 'markdown-image-failure';
    const message = row(sessionKey, 'markdown-image-failure', '![A broken chart](https://images.example/missing.png)', {
      role: 'user', sender: 'user:person', messageType: 'chat',
    });
    const runtime = new FakeRuntime(sessionKey, { records: [message] });

    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const log = screen.getByRole('log');
    const thumbnail = within(log).getByRole('img', { name: 'A broken chart' });
    const frame = thumbnail.closest('.tb-chat-markdown-image');
    const bubble = thumbnail.closest('.tb-chat-bubble');
    const layout = installViewportLayout(log);
    try {
      layout.setScrollTop(52);
      fireEvent.error(thumbnail);

      const unavailable = await within(log).findByRole('img', {
        name: 'A broken chart; preview unavailable',
      });
      expect(within(log).getByText('Preview unavailable')).toBeTruthy();
      expect(layout.scrollTop).toBe(52);
      expect(unavailable.closest('.tb-chat-markdown-image')).toBe(frame);
      expect(unavailable.closest('.tb-chat-bubble')).toBe(bubble);
    } finally {
      layout.restore();
    }
  });

  it('shortens IDs in messages and activity details without changing source, copy, or link targets', () => {
    const sessionKey = 's_12345678-1111-4111-8111-123456789abc';
    const workItemId = 'wi_12345678-1111-4111-8111-123456789abc';
    const assignmentId = 'asg_abcdef12-1111-4111-8111-123456789abc';
    const artifactId = 'art_b322d95e';
    const wakeId = 'wake_87654321-1111-4111-8111-123456789abc';
    const longHex = 'a'.repeat(64);
    const mediumHex = 'c'.repeat(40);
    const harklightWakeId = 'w_harklight_12345678-9abc-4def-8abc-123456789abc_0123456789abcdef0123';
    const storedWakeIds = [
      `w_nb_${longHex}`, `w_terminal_${longHex}`, `w_terminal_action_${longHex}`,
      `w_${'b'.repeat(32)}`, `nbt_${mediumHex}`, `pfe_${mediumHex}`, harklightWakeId,
    ];
    const shortStoredWakeIds = [
      'w_nb_aaaa', 'w_terminal_aaaa', 'w_terminal_action_aaaa', 'w_bbbb', 'nbt_cccc', 'pfe_cccc', 'w_harklight_1234',
    ];
    const additionalStoredIds = [
      'rev_abcdef12-1111-4111-8111-123456789abc',
      'cp_abcdef12-1111-4111-8111-123456789abc',
      'hhi_abcd1234', 'hho_abcd1234', 'crc_abcd1234', 'w_rule_' + longHex,
      'tra_abcdef12-1111-4111-8111-123456789abc',
      'ara_abcdef12-1111-4111-8111-123456789abc',
      'trp_abcdef12-1111-4111-8111-123456789abc',
      'nbm_abcdef12-1111-4111-8111-123456789abc',
      'tcf_abcdef12-1111-4111-8111-123456789abc',
      'tcfo_abcdef12-1111-4111-8111-123456789abc', 'hhore_abcd1234',
      'progressatt_12345678records', 's_f5017fc8-wi_b63e7584-verification.md',
      'progressatt_12345678-1111-4111-8111-123456789abcrecords',
    ];
    const shortAdditionalIds = [
      'rev_abcd', 'cp_abcd', 'hhi_abcd', 'hho_abcd', 'crc_abcd', 'w_rule_aaaa',
      'tra_abcd', 'ara_abcd', 'trp_abcd', 'nbm_abcd', 'tcf_abcd', 'tcfo_abcd', 'hhore_abcd',
      'progressatt_1234records', 's_f501-wi_b63e-verification.md', 'progressatt_1234records',
    ];
    const prompt = row(sessionKey, 'prompt', `Please inspect ${workItemId}.`, {
      seq: 1, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 1,
    });
    const noticeContent = [
      '[from process:tightbeam]',
      '',
      '[batched notices: 1]',
      `batchId=nb_12345678 wake ${storedWakeIds[0]} token=${storedWakeIds[4]}`,
      `[1] source=${storedWakeIds[1]} sender=process:tightbeam cause=wake class=fyi`,
      `[2] source=${storedWakeIds[2]} sender=process:tightbeam cause=wake class=fyi`,
      `[3] source=${storedWakeIds[3]} token=${storedWakeIds[5]} sender=process:tightbeam cause=wake class=fyi`,
      `[4] source=${harklightWakeId}-verification.md sender=process:tightbeam cause=wake class=fyi`,
      `[verdict filed: reviewed-clean on ${assignmentId}: See ${artifactId} and ${workItemId}-verification.md]`,
      '[5] condition ' + additionalStoredIds[1] + ' source_token="' + additionalStoredIds[0] + '"',
      '[6] source=' + additionalStoredIds[5] + ' sender=remedy:policy cause=wake class=fyi',
      '[7] stored IDs ' + additionalStoredIds.slice(2).join(' '),
    ].join('\n');
    const notice = row(sessionKey, 'notice', noticeContent, {
      seq: 2, role: 'user', sender: 'process:tightbeam', messageType: 'substrate', turnSeq: 1,
    });
    const agentContent = `Evidence ${artifactId}; follow wake ${wakeId}.`;
    const agent = row(sessionKey, 'agent-message', agentContent, {
      seq: 3, role: 'user', sender: 'agent:helper', messageType: 'agent', turnSeq: 1,
    });
    const answerContent = `See [${artifactId}](https://example.test/${artifactId}) and \`${workItemId}\`.`;
    const answer = row(sessionKey, 'answer', answerContent, {
      seq: 4, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: prompt.id, turnSeq: 1,
      attachments: [{ assetId: artifactId, mimeType: 'application/pdf', filename: 'artifact.pdf', size: 42 }],
    });
    const toolCall: ToolCallRecord = { id: 'tc-visible', seq: 1, sessionKey, turnSeq: 1, afterMessageSeq: 1,
      harnessToolCallId: 'read-visible', title: `Read ${artifactId}`, kind: 'read', toolName: 'read_file',
      status: 'completed', rawInput: { artifactId }, rawOutput: { wakeId }, content: null,
      truncated: [], startedAt: 150, endedAt: 200, rowVersion: 1 };
    const recordEvent = { eventId: 'work_item.filed:visible', sessionKey, at: 250, kind: 'work_item.filed',
      record: { type: 'work item', id: artifactId, detail: '/api/work-items/visible' }, actorSessionKey: sessionKey,
      tiedAs: ['creator'], cause: { turnSeq: 1, messageId: prompt.id }, noticeMessageIds: [] };
    const runtime = new FakeRuntime(sessionKey, { records: [prompt, notice, agent, answer],
      provenanceAvailable: false, activityTurnStateAvailable: true, toolCallsEnabled: true,
      toolCalls: [toolCall], recordEvents: [recordEvent] });
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const renderMessage = (_record: ConversationRecord, context: RenderContext) =>
      _record.kind === 'message' && _record.id === answer.id
        ? <>{context.defaultRender()}<button onClick={() => void context.copyText()}>Copy full message</button></>
        : undefined;
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} renderMessage={renderMessage} />);

    const log = screen.getByRole('log');
    expect(within(log).getByText('Please inspect wi_1234.')).toBeTruthy();
    const answerBubble = view.container.querySelector<HTMLElement>('[data-record-key="answer"]')!;
    expect(answerBubble.textContent).toContain('art_b322');
    expect(answerBubble.textContent).toContain('wi_1234');
    expect(answerBubble.textContent).not.toContain(artifactId);
    expect(answerBubble.textContent).not.toContain(workItemId);
    expect(answerBubble.querySelector('a')?.getAttribute('href')).toBe(`https://example.test/${artifactId}`);
    fireEvent.click(within(answerBubble).getByRole('button', { name: 'Copy full message' }));
    expect(writeText).toHaveBeenCalledWith(answerContent);

    const pillForContent = (needle: string) => [...view.container.querySelectorAll<HTMLElement>('.tb-chat-activity-pill-row')]
      .find(pill => pill.textContent?.includes(needle));
    const noticePill = pillForContent('Reviewed clean');
    expect(noticePill).toBeTruthy();
    expect(noticePill?.textContent).toContain('art_b322');
    expect(noticePill?.getAttribute('aria-label')).not.toContain(assignmentId);
    expect(noticePill?.title).not.toContain(artifactId);
    for (const id of shortStoredWakeIds) {
      expect(noticePill?.title).toContain(id);
      expect(noticePill?.title).not.toContain(storedWakeIds[shortStoredWakeIds.indexOf(id)]);
    }
    for (let index = 0; index < shortAdditionalIds.length; index++) {
      expect(noticePill?.title).toContain(shortAdditionalIds[index]);
      expect(noticePill?.title).not.toContain(additionalStoredIds[index]);
    }
    expect(noticePill?.title).toContain('w_harklight_1234-verification.md');
    expect(noticePill?.title).toContain('wi_1234-verification.md');
    fireEvent.click(within(noticePill!).getByRole('button', { name: /Show full message/ }));
    const noticeBody = noticePill!.querySelector('[data-activity-message-content]')!;
    expect(noticeBody.textContent).toContain('asg_abcd');
    expect(noticeBody.textContent).toContain('art_b322');
    expect(noticeBody.textContent).toContain('wi_1234');
    expect(noticeBody.textContent).not.toContain(assignmentId);
    expect(noticeBody.textContent).not.toContain(artifactId);
    expect(noticeBody.textContent).not.toContain(workItemId);
    for (let index = 0; index < shortStoredWakeIds.length; index++) {
      expect(noticeBody.textContent).toContain(shortStoredWakeIds[index]);
      expect(noticeBody.textContent).not.toContain(storedWakeIds[index]);
    }
    for (let index = 0; index < shortAdditionalIds.length; index++) {
      expect(noticeBody.textContent).toContain(shortAdditionalIds[index]);
      expect(noticeBody.textContent).not.toContain(additionalStoredIds[index]);
    }
    expect(noticeBody.textContent).toContain('w_harklight_1234-verification.md');
    expect(noticeBody.textContent).toContain('wi_1234-verification.md');

    const agentPill = pillForContent('Evidence art_b322');
    expect(agentPill).toBeTruthy();
    expect(agentPill?.textContent).toContain('wake_8765');
    fireEvent.click(within(agentPill!).getByRole('button', { name: /Show full message/ }));
    const agentBody = agentPill!.querySelector('[data-activity-message-content]')!;
    expect(agentBody.textContent).toBe('Evidence art_b322; follow wake wake_8765.');
    expect(runtime.getSnapshot().records.find(record => record.id === agent.id)?.content).toBe(agentContent);
    expect(runtime.getSnapshot().records.find(record => record.id === notice.id)?.content).toBe(noticeContent);
    expect(runtime.getSnapshot().records.find(record => record.id === answer.id)?.content).toBe(answerContent);

    const toolRow = view.container.querySelector<HTMLElement>('[data-record-key="tool-tc-visible"]')!;
    fireEvent.click(toolRow.querySelector('summary')!);
    expect(toolRow.textContent).toContain('art_b322');
    expect(toolRow.textContent).toContain('wake_8765');
    expect(toolRow.textContent).not.toContain(artifactId);
    expect(toolRow.textContent).not.toContain(wakeId);

    const eventPill = view.container.querySelector<HTMLElement>('[data-record-key="record-event:work_item.filed:visible"]')!;
    expect(eventPill.textContent).toContain('art_b322');
    expect(eventPill.getAttribute('aria-label')).toContain('art_b322');
    expect(eventPill.getAttribute('title')).toContain('art_b322');
    expect(eventPill.getAttribute('aria-label')).not.toContain(artifactId);
    expect(eventPill.getAttribute('title')).not.toContain(artifactId);

    const attachmentDisclosure = answerBubble.querySelector<HTMLDetailsElement>('.tb-chat-attachments')!;
    fireEvent.click(attachmentDisclosure.querySelector('summary')!);
    expect(attachmentDisclosure.textContent).toContain('art_b322');
    expect(attachmentDisclosure.textContent).not.toContain(artifactId);

    fireEvent.click(screen.getByRole('button', { name: /Connection status:/ }));
    expect(view.container.querySelector('.tb-chat-status-popup')?.textContent).toContain('s_1234');
    expect(view.container.querySelector('.tb-chat-status-popup')?.textContent).not.toContain(sessionKey);
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
    const unquotedTag = '<engram-src id=123e4567-e89b-42d3-a456-426614174000/>';
    const promptContent = `${tag}\n\nA normal message.`;
    const onBehalfContent = `${tag}\n\nA message shown on your behalf.`;
    const agentContent = `${tag}\n${unquotedTag}\n\nAn agent update with useful detail.`;
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
    expect(pillRow.textContent).not.toContain(unquotedTag);
    expect(pillRow.title).not.toContain(tag);
    expect(pillRow.title).not.toContain(unquotedTag);
    const pillToggle = within(pillRow).getByRole('button', { name: /Show full message/ });
    fireEvent.click(pillToggle);
    expect(pillRow.querySelector('[data-activity-message-content]')?.textContent)
      .toBe('An agent update with useful detail.');

    const toolRow = view.container.querySelector<HTMLElement>('[data-record-key="tool-tc-provenance"]')!;
    fireEvent.click(toolRow.querySelector('summary')!);
    expect(toolRow.textContent).toContain('<engram-src id="123e"/> tool input remains verbatim');
    expect(toolRow.textContent).toContain('<engram-src id="123e"/> tool result remains verbatim');
    expect(toolCall.rawInput).toBe(toolInput);
    expect(toolCall.rawOutput).toBe(toolResult);

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
    const messageText = 'A direct agent update with enough content to be clipped after the sender remains readable.';
    const agentContent = `[from agent:helper]\n\n[assignment: review task]\n\n${tag}\n\n${messageText}`;
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
      expect(pill.getAttribute('aria-label')).toBe(`${senderDisplayName}: ${messageText}`);
      const senderChip = pill.querySelector<HTMLElement>('.tb-chat-activity-pill-sender')!;
      const senderName = senderChip.querySelector<HTMLElement>('.tb-chat-activity-pill-sender-name')!;
      expect(senderName.textContent).toBe(senderDisplayName);
      const rules = Array.from(componentStyles.sheet!.cssRules);
      const senderChipRule = rules.find(rule => rule instanceof CSSStyleRule &&
        rule.selectorText === '.tb-chat-activity-pill-sender') as CSSStyleRule;
      const senderRule = rules.find(rule => rule instanceof CSSStyleRule &&
        rule.selectorText === '.tb-chat-activity-pill-sender-name') as CSSStyleRule;
      const narrowRule = rules.find(rule => rule.cssText.startsWith('@media (max-width: 540px)') &&
        rule.cssText.includes('tb-chat-activity-pill-sender-name')) as CSSMediaRule;
      const narrowSenderRule = Array.from(narrowRule.cssRules)
        .find(rule => rule.cssText.startsWith('.tb-chat-activity-pill-sender-name')) as CSSStyleRule;
      const messageRule = rules.find(rule => rule.cssText.startsWith('.tb-chat-activity-pill-text')) as CSSStyleRule;
      expect(senderChipRule.style.flex).toBe('0 0 auto');
      expect(senderRule.style.maxWidth).toBe('min(32vw, 18rem)');
      expect(senderRule.style.textOverflow).toBe('ellipsis');
      expect(senderRule.style.whiteSpace).toBe('nowrap');
      expect(narrowSenderRule.style.maxWidth).toBe('min(36vw, 12rem)');
      expect(messageRule.style.flex).toBe('1 1 auto');
      expect(messageRule.style.minWidth).toBe('0');
      expect(messageRule.style.overflow).toBe('hidden');
      expect(messageRule.style.textOverflow).toBe('ellipsis');
      expect(pill.querySelector('.tb-chat-activity-pill-indigo svg')).toBeTruthy();
      expect(pill.querySelector('.tb-chat-activity-pill-meta')).toBeNull();
      expect(pill.querySelectorAll('.tb-chat-activity-pill-sender-name')).toHaveLength(1);
      expect(pill.querySelector('.tb-chat-activity-pill-text')?.textContent).toBe(messageText);
      expect(pill.textContent?.split(senderDisplayName).length).toBe(2);
      expect(pill.textContent).not.toContain(tag);
      expect(pill.textContent).not.toContain('assignment:');
      expect(pill.title).not.toContain('[from agent:');

      fireEvent.click(within(pill).getByRole('button', { name: /Show full message/ }));
      expect(pill.querySelector('[data-activity-message-content]')?.textContent).toBe(messageText);
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
    expect(log.querySelector('[data-record-key="message:first-page-agent-wake"]')).toBeTruthy();
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
    const agentRow = log.querySelector<HTMLElement>('[data-record-key="message:older-agent-trigger"]');
    expect(agentRow?.classList.contains('tb-chat-activity-agent')).toBe(true);
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
        // The direct agent row replaces the provisional reply, so the row count
        // stays level and does not need compensating space.
        expect(log.querySelector('[data-record-key="message:parent"]')).toBeTruthy();
        expect(topSpace()).toBe(0);
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
    const history = [row('feed-status', 'retained-feed-row', 'Existing conversation text')];
    const runtime = new FakeRuntime('feed-status', { records: history, status: 'ready', liveError: 'Changes socket closed',
      liveConnectionState: 'reconnecting' });
    render(<TightbeamChat sessionKey="feed-status" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'keep this draft while the feed reconnects' } });
    expect(screen.getByText('Existing conversation text')).toBeTruthy();

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
    expect(screen.getByText('Existing conversation text')).toBeTruthy();
    expect(composer.value).toBe('keep this draft while the feed reconnects');
  });

  it('keeps a message visible and its reading position when its renderer fails', async () => {
    const sessionKey = 'message-render-failure';
    const records = [
      row(sessionKey, 'before', 'Earlier message', { seq: 1 }),
      row(sessionKey, 'broken', 'Stored message text remains available', { seq: 2, rowVersion: 1 }),
      row(sessionKey, 'reading-anchor', 'Reading position stays here', { seq: 3 }),
      row(sessionKey, 'after', 'Later message', { seq: 4 }),
    ];
    let shouldThrow = false;
    const renderMessage = vi.fn((record: ConversationRecord) => {
      if (record.kind === 'message' && record.id === 'broken') {
        if (shouldThrow) throw new Error('must not log conversation content');
        return <div>Custom message rendering</div>;
      }
      return undefined;
    });
    const runtime = new FakeRuntime(sessionKey, { records });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} renderMessage={renderMessage} />);

    const viewport = screen.getByRole('log');
    const layout = installViewportLayout(viewport, 200, element => {
      if (element instanceof HTMLElement && element.dataset.scrollKey === 'broken') {
        return element.querySelector('[data-chat-render-failure]') ? 92 : 220;
      }
      return undefined;
    });
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'draft survives render recovery' } });
    composer.setSelectionRange(7, 7);
    fireEvent.wheel(viewport, { deltaY: -1 });
    layout.setScrollTop(320);
    fireEvent.scroll(viewport);
    const readingAnchor = viewport.querySelector<HTMLElement>('[data-scroll-key="reading-anchor"]')!;
    const originalOffset = layout.offset(readingAnchor);
    const failedRow = viewport.querySelector<HTMLElement>('[data-scroll-key="broken"]')!;

    try {
      shouldThrow = true;
      act(() => runtime.update({ records: [records[0], { ...records[1], rowVersion: 2 }, ...records.slice(2)] }));

      const failure = view.container.querySelector<HTMLElement>('[data-chat-render-failure="message"]');
      expect(failure?.getAttribute('role')).toBe('alert');
      expect(failure?.textContent).toContain('Stored message text remains available');
      expect(viewport.querySelector('[data-scroll-key="broken"]')).toBe(failedRow);
      expect(screen.getByText('Earlier message')).toBeTruthy();
      expect(screen.getByText('Reading position stays here')).toBeTruthy();
      expect(screen.getByText('Later message')).toBeTruthy();
      expect(layout.offset(readingAnchor)).toBeCloseTo(originalOffset, 0);
      expect(composer.value).toBe('draft survives render recovery');
      expect(composer.selectionStart).toBe(7);
      expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false);

      shouldThrow = false;
      fireEvent.click(screen.getByRole('button', { name: 'Try formatting again' }));
      expect(await screen.findByText('Custom message rendering')).toBeTruthy();
      expect(runtime.rebuildOptions).toEqual([{ restart: true }]);
      expect(layout.offset(readingAnchor)).toBeCloseTo(originalOffset, 0);
      expect(composer.value).toBe('draft survives render recovery');
      expect(composer.selectionStart).toBe(7);

      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      expect(runtime.sent).toEqual(['draft survives render recovery']);
      const diagnostic = errorLog.mock.calls.find(([label]) => label === '[Chat] transcript render failed')?.[1];
      expect(diagnostic).toEqual(expect.objectContaining({ errorName: 'Error' }));
      expect(diagnostic).not.toHaveProperty('message');
    } finally {
      layout.restore();
      errorLog.mockRestore();
    }
  });

  it('shows recoverable Chat state and restores the draft and reading position after a body failure', async () => {
    const sessionKey = 'chat-body-render-failure';
    const records = [
      row(sessionKey, 'before', 'Earlier message', { seq: 1 }),
      row(sessionKey, 'anchor', 'Reading position stays here', { seq: 2 }),
      row(sessionKey, 'after', 'Later message', { seq: 3 }),
    ];
    const runtime = new FakeRuntime(sessionKey, { records });
    const getSnapshot = runtime.getSnapshot;
    let shouldThrow = false;
    runtime.getSnapshot = () => {
      if (shouldThrow) throw new Error('body snapshot failed');
      return getSnapshot();
    };
    const adapter = adapterFor(runtime);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapter} />);
    let originalLayout: ReturnType<typeof installViewportLayout> | undefined;
    let recoveredLayout: ReturnType<typeof installViewportLayout> | undefined;

    try {
      const viewport = screen.getByRole('log');
      originalLayout = installViewportLayout(viewport, 200);
      const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
      fireEvent.change(composer, { target: { value: 'keep this draft through body recovery' } });
      fireEvent.wheel(viewport, { deltaY: -1 });
      originalLayout.setScrollTop(230);
      fireEvent.scroll(viewport);
      const originalScrollTop = originalLayout.scrollTop;
      const originalAnchorOffset = originalLayout.offset(viewport.querySelector<HTMLElement>('[data-scroll-key="anchor"]')!);
      originalLayout.restore();
      originalLayout = undefined;

      shouldThrow = true;
      view.rerender(<TightbeamChat sessionKey={sessionKey} adapter={adapter} className="failure-trigger" />);
      expect(view.container.querySelector('[data-chat-render-failure="chat"]')?.textContent)
        .toContain('Its history is still available.');
      expect(screen.getByRole('button', { name: 'Reconnect and try again' })).toBeTruthy();

      shouldThrow = false;
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect and try again' }));
      expect(await screen.findByText('Reading position stays here')).toBeTruthy();
      const restoredComposer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
      expect(restoredComposer.value).toBe('keep this draft through body recovery');
      const restoredViewport = screen.getByRole('log');
      expect(restoredViewport.scrollTop).toBe(originalScrollTop);
      recoveredLayout = installViewportLayout(restoredViewport, 200);
      recoveredLayout.setScrollTop(originalScrollTop);
      expect(recoveredLayout.offset(restoredViewport.querySelector<HTMLElement>('[data-scroll-key="anchor"]')!))
        .toBeCloseTo(originalAnchorOffset, 0);

      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      expect(runtime.sent).toEqual(['keep this draft through body recovery']);
    } finally {
      originalLayout?.restore();
      recoveredLayout?.restore();
      errorLog.mockRestore();
    }
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
    show({ triggerSource: 'human' });
    const activeCaption = screen.getByRole('status', { name: 'Active turn: Replying to you' });
    expect(activeCaption.classList.contains('tb-chat-caption-neutral')).toBe(true);
    expect(activeCaption.querySelector('.tb-chat-active-caption-icon svg')).toBeTruthy();
    expect(activeCaption.textContent).toContain('Replying to you');
    show({ triggerSource: 'human', messageId: 'unloaded' }, []);
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
      show({ triggerSource: 'human', status });
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
        triggerSource: 'human' }, [human], 'person', 'person');
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
      raw: { source: 'fixture', id: 'agent-note' },
    });
    const agentFollowup = row(sessionKey, 'agent-followup', 'The review is ready', {
      seq: 19, role: 'user', sender: 'agent:helper', messageType: 'agent', turnSeq: 1,
      raw: { source: 'fixture', id: 'agent-followup' },
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
      'Assignment asg_4567 (Background task) has had no recorded activity since 12');
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
    expect(agentFold.querySelector('.tb-chat-activity-pill')?.textContent).toContain('Agent helper');
    expect(agentFold.querySelector('.tb-chat-activity-pill-sender-name')?.textContent).toBe('Agent helper');
    expect(agentFold.getAttribute('aria-label')).toContain('Latest: Agent helper: The review is ready');
    expect(agentFold.textContent).toContain('The review is ready');
    fireEvent.click(agentFold);
    const agentRow = pillFor('Agent helper: A short update');
    expect(agentRow.querySelector('.tb-chat-activity-pill')?.textContent).toBe('Agent helper');
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
      expect(pill.textContent).not.toMatch(/\b(?:[a-z][a-z0-9]*_)+[a-f0-9]{8}(?:-[a-f0-9-]+)?\b/i);
    }
  });

  it('renders a history-backed refusal without a stored position as a pill', () => {
    const sessionKey = 'history-refusal-layout';
    const prompt = row(sessionKey, 'history-refusal-prompt', 'Question', {
      seq: 1, role: 'user', sender: 'user:fixture', messageType: 'chat', turnSeq: 1,
      createdAt: '2026-10-12T00:00:00.000Z',
    });
    const denial = { id: 'history-refusal-1001', sessionKey, principal: `session:${sessionKey}`,
      origin: 'user:fixture-owner', verb: 'send', rule: 'fixture-owner-policy',
      payload: { detail: 'Fixture refusal', rule: 'fixture-owner-policy', verb: 'send' },
      occurredAt: Date.parse('2026-10-12T00:00:01Z') };
    const runtime = new FakeRuntime(sessionKey, {
      records: [prompt], historyRailDenials: [denial], provenanceAvailable: false,
    });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const pill = within(screen.getByRole('log')).getByRole('note', {
      name: 'Refused: send was not allowed',
    });
    expect(pill.classList.contains('tb-chat-activity-pill-row')).toBe(true);
    expect(pill.querySelector('.tb-chat-activity-pill-text')?.textContent).toBe('send was not allowed');
    expect(pill.getAttribute('title')).toBe('send refused by fixture-owner-policy');
  });

  it('shows a live refusal with no human history and still shows ordinary conversation after reload', () => {
    const sessionKey = 'empty-human-history';
    const liveDenial = { id: 'arrival-denial', sessionKey, principal: `session:${sessionKey}`,
      origin: 'chat', verb: 'send', rule: 'fixture-owner-policy',
      payload: { detail: 'Fixture refusal', rule: 'fixture-owner-policy', verb: 'send' },
      occurredAt: Date.parse('2026-11-06T12:00:00Z'), afterMessageSeq: 0,
      tailEligibleAtArrival: false, arrivalOrder: 1 };
    const liveRuntime = new FakeRuntime(sessionKey, { provenanceAvailable: false });
    const liveView = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(liveRuntime)} />);
    act(() => liveRuntime.update({ liveRailDenials: [liveDenial] }));
    const livePill = within(screen.getByRole('log')).getByRole('note', {
      name: 'Refused: send was not allowed',
    });
    expect(livePill.classList.contains('tb-chat-activity-pill-row')).toBe(true);
    liveView.unmount();

    const historyDenial = { ...liveDenial, id: 'history-denial' };
    const reloadedRuntime = new FakeRuntime(sessionKey, { provenanceAvailable: false,
      historyRailDenials: [historyDenial] });
    const reloadedView = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(reloadedRuntime)} />);
    expect(within(screen.getByRole('log')).getByRole('note', {
      name: 'Refused: send was not allowed',
    }).classList.contains('tb-chat-activity-pill-row')).toBe(true);
    reloadedView.unmount();

    const prompt = row(sessionKey, 'ordinary-prompt', 'A normal prompt', {
      seq: 1, role: 'user', sender: 'user:fixture', messageType: 'chat', turnSeq: 1,
    });
    const ordinaryRuntime = new FakeRuntime(sessionKey, { records: [prompt], provenanceAvailable: false });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(ordinaryRuntime)} />);
    expect(screen.getByText('A normal prompt')).toBeTruthy();
    expect(within(screen.getByRole('log')).queryByRole('note', {
      name: 'Refused: send was not allowed',
    })).toBeNull();
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

  it('stops paging once an older agent message becomes a visible row', async () => {
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
    await waitFor(() => expect(runtime.loadOlderCalls).toBe(1));
    expect(runtime.getSnapshot().hasOlder).toBe(true);
    expect(screen.getByRole('log').querySelector('[data-record-key="message:hidden-first"]')).toBeTruthy();
    expect(screen.queryByText('Earlier reply')).toBeNull();
    expect(runtime.getSnapshot().records.some(record => record.id === 'older-activity')).toBe(false);
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

  it.each([100, 110, 120, 130])(
    'keeps sticky prompt selection stable across a shorter prompt preview at scrollTop %i', (scrollTop) => {
    const sessionKey = `prompt-preview-history-measurement-${scrollTop}`;
    const promptA = row(sessionKey, 'prompt-a', `Long prompt A ${'earlier context '.repeat(18)}`, {
      seq: 1, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 1,
    });
    const replyA = row(sessionKey, 'reply-a', 'Reply A', {
      seq: 2, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: promptA.id, turnSeq: 1,
    });
    const promptB = row(sessionKey, 'prompt-b', 'Short prompt B', {
      seq: 3, role: 'user', sender: 'user:person', messageType: 'chat', turnSeq: 2,
    });
    const replyB = row(sessionKey, 'reply-b', 'Reply B', {
      seq: 4, sender: 'assistant-service', messageType: 'assistant', replyToMessageId: promptB.id, turnSeq: 2,
    });
    const runtime = new FakeRuntime(sessionKey, { records: [promptA, replyA, promptB, replyB] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const log = screen.getByRole('log');
    const layout = installViewportLayout(log, 200, (element) => {
      const key = (element as HTMLElement).dataset.recordKey;
      if (key === 'prompt-a') return 92;
      if (key === 'reply-a') return 48;
      if (key === 'prompt-b') return 32;
      return 92;
    }, false, { width: 390, height: 180, top: 100 });

    try {
      fireEvent.wheel(log, { deltaY: -1 });
      layout.setScrollTop(scrollTop);
      fireEvent.scroll(log);
      const promptARow = within(log).getByText(/Long prompt A/).closest<HTMLElement>('[data-scroll-key]')!;
      const promptBRow = within(log).getByText('Short prompt B').closest<HTMLElement>('[data-scroll-key]')!;
      expect(promptARow.getBoundingClientRect().bottom).toBeLessThanOrEqual(110);
      expect(promptBRow.getBoundingClientRect().bottom).toBe(276 - scrollTop);
      expect(promptBRow.getBoundingClientRect().bottom).toBeGreaterThan(140);
      expect(promptBRow.getBoundingClientRect().bottom).toBeLessThanOrEqual(180);
      const measurement = log.parentElement?.querySelector<HTMLElement>('.tb-chat-latest-user-prompt-measurement');
      expect(measurement).toBeTruthy();
      const measuredPrompts: string[] = [];
      Object.defineProperty(measurement, 'getBoundingClientRect', { configurable: true, value: () => {
        const text = measurement!.querySelector('.tb-chat-latest-user-prompt-text')?.textContent ?? '';
        measuredPrompts.push(text.startsWith('Long prompt A') ? 'A' : 'B');
        return new DOMRect(0, 110, 390, text.startsWith('Long prompt A') ? 70 : 30);
      } });

      fireEvent.scroll(log);

      expect(screen.queryByText('The conversation could not be displayed. Its history is still available.')).toBeNull();
      expect(screen.queryByRole('log')).toBeTruthy();
      expect(measuredPrompts.length).toBeGreaterThan(0);
      expect(measuredPrompts.length).toBeLessThan(10);
      const measurementChanges = measuredPrompts.slice(1)
        .filter((prompt, index) => prompt !== measuredPrompts[index]).length;
      expect(measurementChanges).toBeLessThanOrEqual(1);
    } finally {
      layout.restore();
    }
  });

  it('keeps a retained message reachable after repeated older-history scrolling', async () => {
    const sessionKey = 'long-older-history';
    const pageSize = 50;
    const pageCount = 20;
    const firstSequence = 17;
    const pageAt = (first: number) => [
      ...Array.from({ length: 5 }, (_, index) => {
        const seq = first + index;
        const isPrompt = index === 0;
        const content = seq === firstSequence ? 'Older target remains reachable'
          : isPrompt ? `Prompt ${seq}: ${'older context '.repeat(seq % 5 + 1)}` : `History ${seq}`;
        return row(sessionKey, `history-${seq}`, content, {
          seq, role: isPrompt ? 'user' : 'assistant', sender: isPrompt ? 'user:person' : 'assistant-service',
          messageType: isPrompt ? 'chat' : 'assistant',
        });
      }),
      ...Array.from({ length: pageSize - 5 }, (_, index) => {
        const seq = first + index + 5;
        return row(sessionKey, `hidden-${seq}`, `Hidden agent activity ${seq}`, {
          seq, role: 'user', sender: 'agent:external', messageType: 'agent', turnSeq: seq,
        });
      }),
    ];
    const latest = pageAt(firstSequence + pageCount * pageSize);
    const runtime = new FakeRuntime(sessionKey, { records: latest, provenanceAvailable: false });
    runtime.olderPages = Array.from({ length: pageCount }, (_, index) => ({
      records: pageAt(firstSequence + (pageCount - index - 1) * pageSize), provenance: [],
      hasOlder: index < pageCount - 1,
    }));

    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const log = screen.getByRole('log');
    const layout = installViewportLayout(log, 200, undefined, false, { promptPreviewHeight: 60 });

    try {
      layout.setScrollTop(500);
      fireEvent.scroll(log);
      const measurement = log.parentElement?.querySelector<HTMLElement>('.tb-chat-latest-user-prompt-measurement');
      expect(measurement).toBeTruthy();
      Object.defineProperty(measurement, 'getBoundingClientRect', { configurable: true, value: () => {
        const text = measurement!.querySelector('.tb-chat-latest-user-prompt-text')?.textContent ?? '';
        const height = Math.min(110, 32 + Math.ceil(text.length / 36) * 18);
        return new DOMRect(0, 110, 320, height);
      } });
      act(() => runtime.update({ hasOlder: true }));

      for (let page = 0; page < pageCount; page++) {
        layout.setScrollTop(layout.scrollTop + 500);
        fireEvent.scroll(log);
        layout.setScrollTop(250);
        fireEvent.scroll(log);

        await waitFor(() => expect(runtime.loadOlderCalls).toBe(page + 1));
        await waitFor(() => expect(runtime.getSnapshot().records).toHaveLength(latest.length + (page + 1) * pageSize));
        expect(log.querySelector('[data-chat-render-failure="transcript"]')).toBeNull();
      }

      const target = within(log).getByText('Older target remains reachable').closest<HTMLElement>('[data-scroll-key]')!;
      fireEvent.wheel(log, { deltaY: -1 });
      layout.setScrollTop(layout.scrollTop + layout.offset(target));
      fireEvent.scroll(log);

      expect(layout.offset(target)).toBeGreaterThanOrEqual(0);
      expect(layout.offset(target)).toBeLessThan(log.clientHeight);
      expect(log.querySelector('[data-chat-render-failure="transcript"]')).toBeNull();
    } finally {
      layout.restore();
    }
  }, 15000);

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

  it('keeps recovery controls in the initial notice before tool history arrives', () => {
    const runtime = new FakeRuntime('initial-phone-recovery', {
      conversationError: 'The linked target is unavailable.',
      recordEventsError: 'Activity history request failed',
    });
    render(<TightbeamChat sessionKey="initial-phone-recovery" adapter={adapterFor(runtime)}
      configuredConversationHref="/" />);

    const alert = screen.getByRole('alert');
    const content = screen.getByRole('log').querySelector('.tb-chat-message-content');
    expect(alert.classList.contains('tb-chat-runtime-notice-with-tool-history')).toBe(false);
    expect(content?.classList.contains('tb-chat-runtime-notice-reserved')).toBe(true);
    expect(content?.querySelector('[role="status"]')?.textContent).toContain('Activity history is unavailable.');
    const reconnect = within(alert).getByRole('button', { name: 'Reconnect' });
    const recovery = within(alert).getByRole('link', { name: 'Open the configured conversation' });
    expect(recovery.getAttribute('href')).toBe('/');
    expect(screen.queryByText('Loading tool history…')).toBeNull();

    act(() => runtime.update({ toolCallsEnabled: true, toolCallsLoading: true }));

    expect(alert.classList.contains('tb-chat-runtime-notice-with-tool-history')).toBe(true);
    expect(content?.classList.contains('tb-chat-runtime-notice-reserved')).toBe(true);
    expect(within(alert).getByRole('button', { name: 'Reconnect' })).toBe(reconnect);
    expect(within(alert).getByRole('link', { name: 'Open the configured conversation' })).toBe(recovery);
    expect(within(alert).getByText('Loading tool history…')).toBeTruthy();
  });

  it('reserves the full phone recovery notice above activity-history retry', () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime('phone-recovery-notice', {
      conversationError: 'The linked target is unavailable.',
      toolCallsEnabled: true,
      toolCallsError: 'Connection unavailable',
      recordEventsError: 'Activity history request failed',
    });
    render(<TightbeamChat sessionKey="phone-recovery-notice" adapter={adapterFor(runtime)}
      configuredConversationHref="/" />);

    act(() => { vi.advanceTimersByTime(1000); });

    const viewport = screen.getByRole('log');
    const alert = screen.getByRole('alert');
    expect(alert.classList.contains('tb-chat-runtime-notice-with-tool-history')).toBe(true);
    expect(within(alert).getByRole('button', { name: 'Reconnect' })).toBeTruthy();
    expect(within(alert).getByRole('link', { name: 'Open the configured conversation' })).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Retry tool history' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry activity history' })).toBeTruthy();

    const content = viewport.querySelector<HTMLElement>('.tb-chat-message-content');
    expect(content?.classList.contains('tb-chat-runtime-notice-reserved')).toBe(true);
    const noticeBounds = vi.spyOn(alert, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 10, top: 10, right: 368, bottom: 172, left: 22, width: 346, height: 162,
      toJSON: () => ({}),
    } as DOMRect);
    try {
      fireEvent(window, new Event('resize'));
      expect(content?.style.getPropertyValue('--tb-chat-runtime-notice-height')).toBe('162px');
    } finally {
      noticeBounds.mockRestore();
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

  it('offers photo and file selection, shows previews and named file tiles, and retains the selected bytes', async () => {
    mockObjectUrls(() => 'blob:photo-preview');
    const runtime = new FakeRuntime('composer-attachments');
    const view = render(<TightbeamChat sessionKey="composer-attachments" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'draft text' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    expect(screen.getByRole('group', { name: 'Add to message' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Photo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'File' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Camera' })).toBeTruthy();

    const photo = new File(['original photo bytes'], 'photo.png', { type: 'image/png' });
    const pdf = new File(['original pdf bytes'], 'report.pdf', { type: 'application/pdf' });
    const photoPicker = view.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"]')!;
    const filePicker = view.container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    fireEvent.change(photoPicker, { target: { files: [photo] } });
    expect(await screen.findByRole('img', { name: 'Preview of photo.png' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Preview of photo.png' }).getAttribute('src')).toBe('blob:photo-preview');
    fireEvent.change(filePicker, { target: { files: [pdf] } });
    await screen.findByRole('img', { name: 'Preview of photo.png' });
    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(screen.getByText('PDF file')).toBeTruthy();
    expect(composer.value).toBe('draft text');

    // A picker cancellation emits no selected files; existing draft content stays put.
    fireEvent.change(photoPicker, { target: { files: [] } });
    expect(screen.getByRole('button', { name: 'Remove photo.png' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove report.pdf' })).toBeTruthy();
    expect(composer.value).toBe('draft text');

    await screen.findByRole('img', { name: 'Preview of photo.png' });
    fireEvent.error(screen.getByRole('img', { name: 'Preview of photo.png' }));
    expect(screen.getByText(/Preview unavailable\. The converted image remains attached\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove photo.png' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove report.pdf' }));
    expect(screen.queryByRole('button', { name: 'Remove report.pdf' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove photo.png' })).toBeTruthy();
    expect(composer.value).toBe('draft text');
    await screen.findByRole('img', { name: 'Preview of photo.png' });

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runtime.attachmentSubmissions).toHaveLength(1);
    expect(runtime.attachmentSubmissions[0].content).toBe('draft text');
    expect(runtime.attachmentSubmissions[0].inputs).toHaveLength(1);
    expect(runtime.attachmentSubmissions[0].inputs[0].bytes).toBe(photo);
    expect(runtime.sent).toEqual([]);
    expect(composer.value).toBe('');
    expect(screen.queryByRole('button', { name: 'Remove photo.png' })).toBeNull();
  });

  it('preflights the ordered selection before enabling Send and previews the exact prepared image bytes', async () => {
    const previewed: Blob[] = [];
    const objectUrls = mockObjectUrls(blob => {
      previewed.push(blob);
      return `blob:prepared-preview-${previewed.length}`;
    });
    const runtime = new FakeRuntime('prepared-composer-attachments');
    const converted = new Blob(['converted jpeg bytes'], { type: 'image/jpeg' });
    const image = new File(['source heic bytes'], 'camera.HEIC', { type: 'image/heic' });
    const documentFile = new File(['original pdf bytes'], 'report.pdf', { type: 'application/pdf' });
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'diagram.svg', { type: 'image/svg+xml' });
    let resolvePreparation!: (items: readonly AttachmentInput[]) => void;
    let selected: readonly AttachmentInput[] = [];
    let preparedSnapshot: readonly AttachmentInput[] | null = null;
    runtime.prepareAttachmentInputs = vi.fn((inputs: readonly AttachmentInput[]) => {
      selected = inputs;
      return new Promise<readonly AttachmentInput[]>(resolve => { resolvePreparation = resolve; });
    });
    const view = render(<TightbeamChat sessionKey="prepared-composer-attachments" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'caption' } });
    const filePicker = view.container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    fireEvent.change(filePicker, { target: { files: [image, documentFile, svg] } });

    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send).toHaveProperty('disabled', true);
    await waitFor(() => expect(selected).toHaveLength(3));
    expect(selected.map(item => item.filename)).toEqual(['camera.HEIC', 'report.pdf', 'diagram.svg']);
    expect(screen.getByText('SVG file')).toBeTruthy();
    expect(screen.queryByRole('img', { name: /diagram\.svg/ })).toBeNull();
    expect(runtime.attachmentSubmissions).toEqual([]);

    preparedSnapshot = Object.freeze(selected.map(item => item.filename === 'camera.HEIC'
      ? Object.freeze({ ...item, filename: 'camera.jpg', bytes: converted }) : item));
    resolvePreparation(preparedSnapshot);
    const imagePreview = await screen.findByRole('img', { name: 'Preview of camera.jpg' });
    expect(imagePreview.getAttribute('src')).toBe('blob:prepared-preview-1');
    expect(objectUrls.createObjectURL).toHaveBeenCalledWith(converted);
    expect(previewed).toEqual([converted]);
    await waitFor(() => expect(send).toHaveProperty('disabled', false));

    fireEvent.click(send);
    expect(runtime.attachmentSubmissions).toHaveLength(1);
    const sent = runtime.attachmentSubmissions[0].inputs;
    expect(sent).toBe(preparedSnapshot);
    expect(sent.map(item => item.filename)).toEqual(['camera.jpg', 'report.pdf', 'diagram.svg']);
    expect(sent[0].bytes).toBe(converted);
    expect(sent[1].bytes).toBe(documentFile);
    expect(sent[2].bytes).toBe(svg);
    expect(composer.value).toBe('');
  });

  it('shows an undecodable image before upload and lets the remaining ordered draft proceed after removal', async () => {
    const runtime = new FakeRuntime('unreadable-composer-image');
    const photo = new File(['unreadable image'], 'broken.heic', { type: 'image/heic' });
    const documentFile = new File(['original document'], 'notes.pdf', { type: 'application/pdf' });
    runtime.prepareAttachmentInputs = vi.fn(async (inputs: readonly AttachmentInput[]): Promise<readonly AttachmentInput[]> => {
      const failedIndex = inputs.findIndex(item => item.filename === 'broken.heic');
      if (failedIndex >= 0) throw new AttachmentPreparationError(failedIndex, 'image-unreadable',
        'Cannot read broken.heic in its image format on this device.');
      return inputs;
    });
    const view = render(<TightbeamChat sessionKey="unreadable-composer-image" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'keep this text' } });
    const filePicker = view.container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    fireEvent.change(filePicker, { target: { files: [photo, documentFile] } });

    expect(await screen.findByText(/Cannot read broken\.heic in its image format on this device/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', true);
    expect(runtime.attachmentSubmissions).toEqual([]);
    expect(composer.value).toBe('keep this text');
    expect(screen.getByRole('button', { name: 'Remove notes.pdf' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry attachment preparation' }));
    await waitFor(() => expect(runtime.prepareAttachmentInputs).toHaveBeenCalledTimes(2));
    expect(runtime.attachmentSubmissions).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove broken.heic' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runtime.attachmentSubmissions).toHaveLength(1);
    expect(runtime.attachmentSubmissions[0].inputs).toHaveLength(1);
    expect(runtime.attachmentSubmissions[0].inputs[0].filename).toBe('notes.pdf');
    expect(runtime.attachmentSubmissions[0].inputs[0].bytes).toBe(documentFile);
  });

  it('shows runtime-owned attachment progress and item errors, and retries the same send ID', async () => {
    mockObjectUrls(() => 'blob:pending-send-preview');
    const runtime = new FakeRuntime('attachment-send-progress');
    const clientMessageId = 'c_attachment-send-progress';
    const source = new File(['original bytes'], 'large-photo.png', { type: 'image/png' });
    const makeSend = (status: LocalSend['status'], attachmentStatus: 'pending' | 'uploading' | 'ready' | 'failed',
      reason?: string, itemError?: string, attachmentPhase?: 'preparing' | 'failed' | 'posted'): LocalSend => ({
      sessionKey: 'attachment-send-progress', deviceId: 'device', clientMessageId,
      content: 'photo caption', submittedAt: new Date().toISOString(), status, reconciled: false,
      attachmentItems: [{ id: 'photo-item', filename: 'large-photo.png', bytes: source,
        status: attachmentStatus, ...(itemError ? { error: itemError } : {}) }],
      attachmentPhase: attachmentPhase ?? (status === 'failed' ? 'failed' : 'preparing'), ...(reason ? { reason } : {}),
    } as unknown as LocalSend);
    runtime.sendAttachments = (content, inputs) => {
      runtime.attachmentSubmissions.push({ content, inputs });
      runtime.update({ sends: [makeSend('pending', 'pending')] });
      return clientMessageId;
    };
    render(<TightbeamChat sessionKey="attachment-send-progress" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'photo caption' } });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [source] },
    });
    await screen.findByRole('img', { name: 'Preview of large-photo.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Preparing attachments…')).toBeTruthy();
    expect(screen.getByText('large-photo.png')).toBeTruthy();
    expect(screen.getByText('Waiting to upload')).toBeTruthy();
    expect(screen.queryByText(/^Sent$/)).toBeNull();
    expect(composer.value).toBe('');
    expect(runtime.attachmentSubmissions[0].inputs[0].bytes).toBe(source);

    runtime.update({ sends: [makeSend('pending', 'ready', undefined, undefined, 'posted')] });
    expect(await screen.findByText('Sending message…')).toBeTruthy();
    expect(screen.getByText('Uploaded; message not confirmed')).toBeTruthy();
    expect(screen.queryByText(/^Sent$/)).toBeNull();

    const transportReason = 'HTTP 413: attachment exceeds the transport limit';
    const submissionReason = 'Upload rejected by the current transport';
    runtime.update({ sends: [makeSend('failed', 'failed', submissionReason, transportReason, 'failed')] });
    expect(await screen.findByText('Attachment send failed')).toBeTruthy();
    expect(screen.getByText(transportReason)).toBeTruthy();
    expect(screen.getByText(`Submission reason: ${submissionReason}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry attachment send' }));
    expect(runtime.retried).toEqual([clientMessageId]);
  });

  it('shows the pre-send delivery warning and offers an explicit proceed action', () => {
    const sessionKey = 'attachment-assessment-confirmation';
    const clientMessageId = 'c_assessment-confirmation';
    const reference: AttachmentReference = { assetId: 'asset-zip', mimeType: 'application/zip',
      filename: 'results.zip', size: 64 };
    const runtime = new FakeRuntime(sessionKey, { sends: [{
      sessionKey, deviceId: 'device', clientMessageId, content: 'inspect this', submittedAt: new Date().toISOString(),
      status: 'pending', reconciled: false, attachments: [reference], attachmentPhase: 'confirmation',
      attachmentAssessment: { sessionKey, clientMessageId, maxDeliverableAttachmentBytes: 25_000_000,
        attachments: [{ assetId: reference.assetId, assessment: 'will-not-deliver',
          reason: { code: 'unsupported-delivery', message: 'This file will not reach the agent.' } }] },
      attachmentItems: [{ id: 'zip-item', filename: reference.filename, bytes: new Blob(['zip']),
        status: 'ready', reference }],
    } as unknown as LocalSend] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    expect(screen.getByText('Review attachment delivery')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('This file will not reach the agent.');
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
    expect(runtime.confirmedAttachmentSends).toEqual([clientMessageId]);
  });

  it('does not offer proceed for a known over-limit assessment', () => {
    const sessionKey = 'attachment-assessment-over-limit';
    const clientMessageId = 'c_assessment-over-limit';
    const reference: AttachmentReference = { assetId: 'asset-large', mimeType: 'application/zip',
      filename: 'large.zip', size: 128 };
    const runtime = new FakeRuntime(sessionKey, { sends: [{
      sessionKey, deviceId: 'device', clientMessageId, content: 'inspect this', submittedAt: new Date().toISOString(),
      status: 'failed', reconciled: false, reason: 'This file exceeds the delivery limit.', attachmentPhase: 'failed',
      attachments: [reference],
      attachmentAssessment: { sessionKey, clientMessageId, maxDeliverableAttachmentBytes: 25_000_000,
        attachments: [{ assetId: reference.assetId, assessment: 'will-not-deliver',
          reason: { code: 'over-limit', message: 'This file exceeds the delivery limit.' } }] },
      attachmentItems: [{ id: 'large-item', filename: reference.filename, bytes: new Blob(['large']),
        status: 'ready', reference }],
    } as unknown as LocalSend] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    expect(screen.getByText('Attachment exceeds the Gateway delivery limit')).toBeTruthy();
    expect(screen.getByText('large.zip exceeds Gateway’s delivery limit of 25,000,000 bytes.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore draft to the composer' })).toBeTruthy();
  });

  it('keeps a post-time over-limit refusal plain and non-retryable', () => {
    const sessionKey = 'attachment-post-over-limit';
    const clientMessageId = 'c_post-over-limit';
    const reference: AttachmentReference = { assetId: 'asset-large', mimeType: 'application/zip',
      filename: 'large.zip', size: 25_000_001 };
    const runtime = new FakeRuntime(sessionKey, { sends: [{
      sessionKey, deviceId: 'device', clientMessageId, content: 'inspect this', submittedAt: new Date().toISOString(),
      status: 'failed', reconciled: false, reason: 'attachment_over_limit', attachmentPhase: 'posted',
      attachments: [reference], postSubmitted: true,
      attachmentLimitRefusal: { offendingAssetIds: [reference.assetId], maxDeliverableAttachmentBytes: 25_000_000 },
      attachmentItems: [{ id: 'large-item', filename: reference.filename, bytes: new Blob(['large']),
        status: 'ready', reference }],
    } as unknown as LocalSend] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    expect(screen.getByText('Attachment exceeds the Gateway delivery limit')).toBeTruthy();
    expect(screen.getByText('large.zip exceeds Gateway’s delivery limit of 25,000,000 bytes.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry message' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore draft to the composer' })).toBeTruthy();
  });

  it('restores a failed attachment send with its original Blob and filename', async () => {
    mockObjectUrls(() => 'blob:restored-failed-photo');
    const sessionKey = 'restore-failed-attachment';
    const source = new File(['original failed image bytes'], 'failed-photo.png', { type: 'image/png' });
    const failedSend = {
      sessionKey, deviceId: 'device', clientMessageId: 'failed-send-with-photo',
      content: 'recover this photo', submittedAt: '2026-10-30T09:00:00.000Z',
      status: 'failed', reconciled: false, reason: 'upload-failed', attachmentPhase: 'failed',
      attachmentItems: [{ id: 'failed-photo-item', filename: 'failed-photo.png', bytes: source,
        status: 'failed', error: 'HTTP 413: attachment exceeds the transport limit' }],
    } as unknown as LocalSend;
    const runtime = new FakeRuntime(sessionKey, { sends: [failedSend] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore draft to the composer' }));
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    expect(composer.value).toBe('recover this photo');
    expect((await screen.findByRole('img', { name: 'Preview of failed-photo.png' })).getAttribute('src'))
      .toBe('blob:restored-failed-photo');
    expect(screen.getByRole('button', { name: 'Remove failed-photo.png' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runtime.attachmentSubmissions).toHaveLength(1);
    expect(runtime.attachmentSubmissions[0].content).toBe('recover this photo');
    expect(runtime.attachmentSubmissions[0].inputs).toHaveLength(1);
    expect(runtime.attachmentSubmissions[0].inputs[0].filename).toBe('failed-photo.png');
    expect(runtime.attachmentSubmissions[0].inputs[0].bytes).toBe(source);
  });

  it('preserves the current draft when restoring a failed attachment send into a nonempty composer', async () => {
    const sessionKey = 'restore-failed-attachment-into-nonempty-draft';
    const failedSource = new File(['failed attachment bytes'], 'failed-photo.png', { type: 'image/png' });
    const currentSource = new File(['current attachment bytes'], 'current-draft.pdf', { type: 'application/pdf' });
    const failedSend = {
      sessionKey, deviceId: 'device', clientMessageId: 'failed-send-with-photo',
      content: 'failed draft text', submittedAt: '2026-10-30T09:00:00.000Z',
      status: 'failed', reconciled: false, reason: 'upload-failed', attachmentPhase: 'failed',
      attachmentItems: [{ id: 'failed-photo-item', filename: 'failed-photo.png', bytes: failedSource,
        status: 'failed', error: 'Upload failed' }],
    } as unknown as LocalSend;
    const runtime = new FakeRuntime(sessionKey, { sends: [failedSend] });
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'current draft text' } });
    const filePicker = view.container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    fireEvent.change(filePicker, { target: { files: [currentSource] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false));

    fireEvent.click(screen.getByRole('button', { name: 'Restore draft to the composer' }));

    expect(composer.value).toBe('current draft text');
    expect(screen.getByRole('button', { name: 'Remove current-draft.pdf' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove failed-photo.png' })).toBeNull();
    expect(screen.getByText(
      'Clear the current draft before restoring this send. Both drafts are still preserved.',
    ).getAttribute('role')).toBe('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runtime.attachmentSubmissions).toHaveLength(1);
    expect(runtime.attachmentSubmissions[0].content).toBe('current draft text');
    expect(runtime.attachmentSubmissions[0].inputs).toHaveLength(1);
    expect(runtime.attachmentSubmissions[0].inputs[0].filename).toBe('current-draft.pdf');
    expect(runtime.attachmentSubmissions[0].inputs[0].bytes).toBe(currentSource);
    expect(runtime.attachmentSubmissions[0].inputs.some(input => input.bytes === failedSource)).toBe(false);
  });

  it('preserves text and files when restoring a failed text-only send into a nonempty composer', async () => {
    const sessionKey = 'restore-failed-text-with-current-attachment';
    const currentSource = new File(['current attachment bytes'], 'current-draft.pdf', { type: 'application/pdf' });
    const failedSend = {
      sessionKey, deviceId: 'device', clientMessageId: 'failed-text-send',
      content: 'failed text-only draft', submittedAt: '2026-10-30T09:00:00.000Z',
      status: 'failed', reconciled: false, reason: 'refused',
    } as unknown as LocalSend;
    const runtime = new FakeRuntime(sessionKey, { sends: [failedSend] });
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'current draft text' } });
    const filePicker = view.container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    fireEvent.change(filePicker, { target: { files: [currentSource] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false));

    fireEvent.click(screen.getByRole('button', { name: 'Restore text to the composer' }));

    expect(composer.value).toBe('current draft text');
    expect(screen.getByRole('button', { name: 'Remove current-draft.pdf' })).toBeTruthy();
    expect(screen.getByText(
      'Clear the current draft before restoring this send. Both drafts are still preserved.',
    ).getAttribute('role')).toBe('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runtime.attachmentSubmissions).toHaveLength(1);
    expect(runtime.attachmentSubmissions[0].content).toBe('current draft text');
    expect(runtime.attachmentSubmissions[0].inputs).toHaveLength(1);
    expect(runtime.attachmentSubmissions[0].inputs[0].filename).toBe('current-draft.pdf');
    expect(runtime.attachmentSubmissions[0].inputs[0].bytes).toBe(currentSource);
  });

  it('pastes image bytes with clipboard text, leaves ordinary text paste native, and reports unreadable clipboard images', async () => {
    mockObjectUrls(() => 'blob:pasted-image');
    const runtime = new FakeRuntime('paste-attachments');
    render(<TightbeamChat sessionKey="paste-attachments" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'hello' } });
    composer.focus();
    composer.setSelectionRange(5, 5);
    const pastedImage = new File(['clipboard image bytes'], 'clipboard.png', { type: 'image/png' });

    const combinedPaste = dispatchClipboardPaste(composer, {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => pastedImage }],
      files: [pastedImage],
      getData: type => type === 'text/plain' ? ' world' : '',
    });
    expect(combinedPaste.defaultPrevented).toBe(true);
    expect(composer.value).toBe('hello world');
    expect(await screen.findByRole('img', { name: 'Preview of clipboard.png' })).toBeTruthy();

    const unreadablePaste = dispatchClipboardPaste(composer, {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }],
      getData: type => type === 'text/plain' ? '!' : '',
    });
    expect(unreadablePaste.defaultPrevented).toBe(true);
    expect(composer.value).toBe('hello world!');
    expect(screen.getByRole('alert').textContent).toMatch(/Could not read the pasted image/);
    expect(screen.getByRole('button', { name: 'Remove clipboard.png' })).toBeTruthy();

    const plainTextPaste = dispatchClipboardPaste(composer, {
      getData: type => type === 'text/plain' ? ' ordinary text' : '',
    });
    expect(plainTextPaste.defaultPrevented).toBe(false);
    expect(runtime.attachmentSubmissions).toEqual([]);
  });

  it.each([
    ['denied permission', Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }), /Camera access was denied/],
    ['no camera', Object.assign(new Error('No device'), { name: 'NotFoundError' }), /No camera is available/],
    ['camera API unavailable', null, /Camera capture is not available in this browser/],
  ] as const)('keeps the draft recoverable when camera capture fails: %s', async (_label, reason, expected) => {
    const runtime = new FakeRuntime('camera-failure');
    const existingFile = new File(['keep this'], 'keep.txt', { type: 'text/plain' });
    stubProperty(navigator, 'mediaDevices', reason === null
      ? {}
      : { getUserMedia: vi.fn().mockRejectedValue(reason) });
    const view = render(<TightbeamChat sessionKey="camera-failure" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'keep this draft' } });
    fireEvent.change(view.container.querySelectorAll<HTMLInputElement>('input[type="file"]')[1], {
      target: { files: [existingFile] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Camera' }));

    expect(await screen.findByText(expected)).toBeTruthy();
    expect(composer.value).toBe('keep this draft');
    expect(screen.getByRole('button', { name: 'Remove keep.txt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try camera again' })).toBeTruthy();
    expect(runtime.attachmentSubmissions).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Take a photo' })).toBeNull();
    expect(composer.value).toBe('keep this draft');
    expect(screen.getByRole('button', { name: 'Remove keep.txt' })).toBeTruthy();
  });

  it('captures a camera image as the submitted Blob and stops the camera when capture completes', async () => {
    mockObjectUrls(() => 'blob:camera-preview');
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const capturedBytes = new Blob(['captured image bytes'], { type: 'image/jpeg' });
    stubProperty(navigator, 'mediaDevices', { getUserMedia });
    stubProperty(HTMLVideoElement.prototype, 'play', () => Promise.resolve());
    stubProperty(HTMLCanvasElement.prototype, 'getContext', () => ({ drawImage: vi.fn() }));
    stubProperty(HTMLCanvasElement.prototype, 'toBlob', (callback: BlobCallback) => callback(capturedBytes));

    const runtime = new FakeRuntime('camera-capture');
    render(<TightbeamChat sessionKey="camera-capture" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'photo caption' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Camera' }));
    const video = await screen.findByLabelText('Camera preview') as HTMLVideoElement;
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 640 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 480 });
    await waitFor(() => expect(video.srcObject).toBe(stream));

    fireEvent.click(screen.getByRole('button', { name: 'Capture photo' }));
    expect(await screen.findByRole('button', { name: /Remove camera-/ })).toBeTruthy();
    expect(await screen.findByRole('img', { name: /Preview of camera-/ })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Take a photo' })).toBeNull();
    expect(stopTrack).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runtime.attachmentSubmissions[0].content).toBe('photo caption');
    expect(runtime.attachmentSubmissions[0].inputs[0].bytes).toBe(capturedBytes);
  });

  it('cancels an open camera without adding an item or changing the rest of the draft', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    stubProperty(navigator, 'mediaDevices', { getUserMedia: vi.fn().mockResolvedValue(stream) });
    stubProperty(HTMLVideoElement.prototype, 'play', () => Promise.resolve());
    const runtime = new FakeRuntime('camera-cancel');
    render(<TightbeamChat sessionKey="camera-cancel" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'keep after camera cancel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Camera' }));
    await screen.findByLabelText('Camera preview');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Take a photo' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove camera-/ })).toBeNull();
    expect(composer.value).toBe('keep after camera cancel');
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it('retains the prepared image when local preview creation fails', async () => {
    mockObjectUrls(() => { throw new Error('Preview blocked by browser'); });
    const runtime = new FakeRuntime('preview-creation-failure');
    const view = render(<TightbeamChat sessionKey="preview-creation-failure" adapter={adapterFor(runtime)} />);
    const source = new File(['original'], 'preview-failure.png', { type: 'image/png' });
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"]')!, {
      target: { files: [source] },
    });

    expect(await screen.findByText(/Preview unavailable: Preview blocked by browser\. The converted image remains attached\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runtime.attachmentSubmissions[0].inputs[0].bytes).toBe(source);
  });

  it('keeps selected images and draft content when attachment delivery is unavailable or rejected', async () => {
    mockObjectUrls(() => 'blob:retry-image');
    const runtime = new FakeRuntime('attachment-rejected');
    const view = render(<TightbeamChat sessionKey="attachment-rejected" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    const source = new File(['source bytes'], 'source.png', { type: 'image/png' });
    fireEvent.change(composer, { target: { value: 'keep for retry' } });
    fireEvent.change(view.container.querySelector<HTMLInputElement>('input[type="file"][accept="image/*"]')!, {
      target: { files: [source] },
    });
    await screen.findByRole('img', { name: 'Preview of source.png' });

    const availableMethod = runtime.sendAttachments;
    (runtime as unknown as { sendAttachments?: typeof runtime.sendAttachments }).sendAttachments = undefined;
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(screen.getByRole('alert').textContent).toMatch(/cannot send attachments with its current Chat runtime/);
    expect(composer.value).toBe('keep for retry');
    expect(screen.getByRole('button', { name: 'Remove source.png' })).toBeTruthy();
    (runtime as unknown as { sendAttachments?: typeof runtime.sendAttachments }).sendAttachments = availableMethod;

    runtime.attachmentSendResult = null;
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(screen.getByRole('alert').textContent).toMatch(/did not accept this attachment submission/);
    expect(composer.value).toBe('keep for retry');
    expect(screen.getByRole('button', { name: 'Remove source.png' })).toBeTruthy();
    expect(runtime.attachmentSubmissions[0].inputs[0].bytes).toBe(source);
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

  it('keeps the conversation title available as an accessible empty-state placeholder', () => {
    const runtime = new FakeRuntime('empty-title');
    render(<TightbeamChat sessionKey="empty-title" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    const shell = composer.parentElement;
    const title = composer.parentElement?.querySelector('.tb-chat-empty-title');

    expect(composer.placeholder).toBe('Research assistant');
    expect(shell?.classList.contains('tb-chat-input-shell-empty')).toBe(true);
    expect(title?.textContent).toBe('Research assistant');
    expect(title?.getAttribute('aria-hidden')).toBe('true');

    fireEvent.change(composer, { target: { value: 'A typed draft' } });
    expect(composer.value).toBe('A typed draft');
    expect(shell?.classList.contains('tb-chat-input-shell-empty')).toBe(false);
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

  it('keeps pending messages ghosted and presents uncertain delivery without claiming refusal', () => {
    const sessionKey = 'send-recovery';
    const runtime = new FakeRuntime(sessionKey, { sends: [
      { sessionKey, deviceId: 'device', clientMessageId: 'failed-id', content: 'Failed text',
        submittedAt: '2026-10-20T09:05:00.000Z', status: 'failed', reconciled: false,
        reason: 'private target detail' },
      { sessionKey, deviceId: 'device', clientMessageId: 'accepted-id', content: 'Accepted text',
        submittedAt: '2026-10-20T09:05:30.000Z', status: 'accepted', reconciled: false },
      { sessionKey, deviceId: 'device', clientMessageId: 'uncertain-id', content: 'Uncertain text',
        submittedAt: '2026-10-20T09:06:00.000Z', status: 'uncertain', reconciled: false,
        reason: 'connection-closed-before-acknowledgement' },
      { sessionKey, deviceId: 'device', clientMessageId: 'unreachable-id', content: 'Offline text',
        submittedAt: '2026-10-20T09:07:00.000Z', status: 'pending', reconciled: false,
        reason: 'unreachable' },
    ] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    expect(screen.getByText('Failed text')).toBeTruthy();
    expect(screen.getByText('Accepted text')).toBeTruthy();
    expect(screen.getByText('Uncertain text')).toBeTruthy();
    expect(within(screen.getByRole('log')).getByText('Offline text')).toBeTruthy();
    expect(document.querySelectorAll('.tb-chat-send-spinner')).toHaveLength(2);
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
    const uncertain = screen.getByText('Uncertain text').closest('article');
    expect(uncertain?.getAttribute('data-send-state')).toBe('uncertain');
    expect(uncertain?.getAttribute('aria-label'))
      .toBe("We couldn't confirm whether this message was sent. Check the conversation before trying again.");
    expect(uncertain?.querySelector('.tb-chat-send-uncertainty')?.textContent)
      .toBe("We couldn't confirm whether this message was sent. Check the conversation before trying again.");
    expect(uncertain?.querySelector('[role="status"]')?.textContent)
      .toContain("We couldn't confirm whether this message was sent.");
    expect(screen.queryByText(/Not connected to the server|retrying…/)).toBeNull();
    expect(screen.queryByText(/Sending…|Sent|Delivery is uncertain|Accepted; checking conversation history/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry message' }));
    expect(runtime.retried).toEqual(['failed-id']);
    fireEvent.click(within(uncertain!).getByRole('button', { name: 'Check and retry' }));
    expect(runtime.retried).toEqual(['failed-id', 'uncertain-id']);
    expect(screen.getAllByRole('button', { name: 'Restore text to the composer' })).toHaveLength(2);
    act(() => runtime.update({ sends: runtime.state.sends.map((send) => send.clientMessageId === 'accepted-id'
      ? { ...send, reconciled: true } : send) }));
    const accepted = screen.getByText('Accepted text').closest('article');
    expect(accepted?.getAttribute('data-send-state')).toBe('solid');
    expect(accepted?.getAttribute('aria-label')).toBe('Your message is in the conversation.');
    expect(accepted?.querySelector('[role="status"]')?.textContent).toContain('Your message is in the conversation.');
    expect(accepted?.querySelector('.tb-chat-send-spinner')).toBeNull();
  });

  it('shows a plain size refusal and keeps the complete draft available for editing or retry', () => {
    const sessionKey = 'size-refusal';
    const content = 'The complete prompt remains available after the server rejects it.';
    const runtime = new FakeRuntime(sessionKey);
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;

    fireEvent.change(composer, { target: { value: content } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(runtime.sent).toEqual([content]);
    fireEvent.change(composer, { target: { value: 'An edit made while the send is pending' } });
    act(() => runtime.update({ sends: [{ sessionKey, deviceId: 'device', clientMessageId: 'fixture-send',
      content, submittedAt: new Date().toISOString(), status: 'failed', reconciled: false,
      reason: 'payload_too_large' }] }));

    const refused = screen.getByText(content).closest('article');
    expect(refused?.getAttribute('data-send-state')).toBe('refused');
    expect(refused?.getAttribute('aria-label')).toBe('Your message was not sent. The server refused this prompt because it is too large. Shorten it and try again.');
    expect(within(refused!).getByText('The server refused this prompt because it is too large. Shorten it and try again.')).toBeTruthy();
    expect(composer.value).toBe('An edit made while the send is pending');
    fireEvent.click(within(refused!).getByRole('button', { name: 'Restore text to the composer' }));
    expect(composer.value).toBe(content);
    expect(within(refused!).getByRole('button', { name: 'Retry message' })).toBeTruthy();
  });

  it('shows uncertainty without retry controls when same-message retry is unavailable', () => {
    const sessionKey = 'unsupported-send-recovery';
    const runtime = new FakeRuntime(sessionKey, { status: 'ready', sends: [{
      sessionKey, deviceId: 'device', clientMessageId: 'unsupported-retry-id',
      content: 'Check this message before retrying', submittedAt: '2026-10-25T09:00:00.000Z',
      status: 'uncertain', reconciled: false, reason: 'retry-unavailable',
    }] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    expect(screen.getByText('Check this message before retrying').closest('[data-send-state]')?.getAttribute('data-send-state')).toBe('uncertain');
    expect(document.querySelector('.tb-chat-send-uncertainty')?.textContent)
      .toBe("We couldn't confirm whether this message was sent. Check the conversation before trying again.");
    expect(document.querySelector('.tb-chat-send-uncertain-mark')).toBeTruthy();
    expect(document.querySelector('.tb-chat-send-spinner')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check and retry' })).toBeNull();
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
    const sessionKey = 'activity-overflow';
    const notices = Array.from({ length: 8 }, (_, index) => row(sessionKey, `event-${index + 1}`,
      `Unclassified event ${index + 1}`, { seq: index + 2, sender: 'process:events', messageType: 'substrate', turnSeq: 1 }));
    const human = row(sessionKey, 'human', 'A question', { seq: 1, role: 'user', sender: 'user:person', turnSeq: 1 });
    const answer = row(sessionKey, 'answer', 'The answer', {
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
          const runtime = new FakeRuntime(sessionKey, { records: [human, ...notices, answer] });
          view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
          const viewport = screen.getByRole('log');
          const content = viewport.querySelector<HTMLElement>('.tb-chat-message-content')!;
          layout = installViewportLayout(viewport, 200, rowElement => {
            if (rowElement.matches('.tb-chat-activity-overflow')) return 24;
            if (rowElement.matches('.tb-chat-activity-substrate')) return 48;
            return undefined;
          });

          const visibleRows = () => view!.container.querySelectorAll('.tb-chat-activity-line.tb-chat-activity-substrate');
          expect(view!.container.querySelectorAll('.tb-chat-activity-overflow')).toHaveLength(1);
          expect(visibleRows()).toHaveLength(5);
          expect([...visibleRows()].map(element => element.getAttribute('data-record-key')))
            .toEqual(['message:event-4', 'message:event-5', 'message:event-6', 'message:event-7', 'message:event-8']);
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
          const revealedRows = ['message:event-1', 'message:event-2', 'message:event-3'];
          expect([...visibleRows()].map(element => element.getAttribute('data-record-key')))
            .toEqual([...revealedRows, 'message:event-4', 'message:event-5', 'message:event-6', 'message:event-7', 'message:event-8']);
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
          expect([...view!.container.querySelectorAll<HTMLElement>('.tb-chat-activity-substrate')]
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

  it('folds unnamed Codex-style calls with the yellow summary and grey member styling', () => {
    const sessionKey = 'unnamed-codex-tools';
    let index: ToolCallIndex | undefined;
    const calls: ToolCallRecord[] = [
      { id: 'codex-1', seq: 201, sessionKey, turnSeq: 1, afterMessageSeq: 1, harnessToolCallId: 'call-1',
        title: 'Read the project', kind: 'read', toolName: null, status: 'completed', rawInput: null,
        rawOutput: null, content: null, truncated: [], startedAt: 201, endedAt: 202, rowVersion: 1 },
      { id: 'codex-2', seq: 202, sessionKey, turnSeq: 1, afterMessageSeq: 1, harnessToolCallId: 'call-2',
        title: 'Run the checks', kind: 'command', toolName: null, status: 'in_progress', rawInput: null,
        rawOutput: null, content: null, truncated: [], startedAt: 202, endedAt: null, rowVersion: 1 },
      { id: 'codex-3', seq: 203, sessionKey, turnSeq: 1, afterMessageSeq: 1, harnessToolCallId: 'call-3',
        title: 'Inspect the result', kind: 'read', toolName: null, status: 'completed', rawInput: null,
        rawOutput: null, content: null, truncated: [], startedAt: 203, endedAt: 204, rowVersion: 1 },
    ];
    for (const call of calls) {
      const group = putIndex(getIndex(index, call.afterMessageSeq), call.seq, call, call.startedAt);
      index = putIndex(index, call.afterMessageSeq, group, group.maxTime);
    }
    const human = row(sessionKey, 'human', 'Review the result', {
      seq: 1, role: 'user', sender: 'user:person',
    });
    const runtime = new FakeRuntime(sessionKey, { records: [human], toolCallsEnabled: true, toolCallIndex: index });
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const foldedRun = screen.getByRole('button', {
      name: /3 entries\. Latest: Inspect the result · done/,
    });
    const foldKey = foldedRun.closest('[data-activity-fold]')?.getAttribute('data-record-key');
    expect(foldedRun.querySelector('.tb-chat-activity-run-count')?.textContent).toBe('×3');
    expect(foldedRun.classList.contains('tb-chat-activity-tool-run-toggle')).toBe(true);
    expect(foldedRun.querySelector('svg.tb-chat-tool-terminal-icon rect')?.getAttribute('fill')).toBe('currentColor');
    expect(view.container.querySelectorAll('.tb-chat-activity-run.tb-chat-activity-tool')).toHaveLength(1);

    fireEvent.click(foldedRun);
    const memberRows = view.container.querySelectorAll<HTMLElement>(
      `[data-activity-fold][data-record-key="${foldKey}"] .tb-chat-activity-run-rows details.tb-chat-activity-tool`,
    );
    expect(memberRows).toHaveLength(3);
    expect([...memberRows].map(member => member.querySelector('.tb-chat-activity-gist')?.textContent)).toEqual([
      'Read the project · done', 'Run the checks · running', 'Inspect the result · done',
    ]);
    for (const member of memberRows) {
      expect(member.querySelector('svg.tb-chat-tool-terminal-icon rect')?.getAttribute('fill')).toBe('currentColor');
    }
  });

  it('folds mixed-name tool calls and keeps the run titled by its newest call', () => {
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
    insert(202, 'Run command', 'bash');

    const human = row('latest-tool-title', 'human', 'Keep this message visible', {
      role: 'user', sender: 'user:person', seq: 1,
    });
    const runtime = new FakeRuntime('latest-tool-title', {
      records: [human], toolCallsEnabled: true, toolCallIndex: index,
    });
    const view = render(<TightbeamChat sessionKey="latest-tool-title" adapter={adapterFor(runtime)} />);
    const foldedRun = screen.getByRole('button', {
      name: /2 entries\. Latest: Run command · running/,
    });
    const foldKey = foldedRun.closest('[data-activity-fold]')?.getAttribute('data-record-key');
    expect(foldedRun.querySelector('.tb-chat-activity-gist')?.textContent).toBe('Run command · running');
    expect(foldedRun.getAttribute('aria-expanded')).toBe('false');
    expect(foldedRun.firstElementChild?.matches('svg.tb-chat-tool-terminal-icon')).toBe(true);
    expect(foldedRun.querySelector('.tb-chat-activity-bullet')).toBeNull();
    expect(foldedRun.querySelectorAll('.tb-chat-activity-run-chevron')).toHaveLength(1);

    insert(203, 'Search files', 'grep');
    act(() => runtime.update({ toolCallIndex: index }));
    const updatedFold = screen.getByRole('button', {
      name: /3 entries\. Latest: Search files · running/,
    });
    expect(updatedFold.closest('[data-activity-fold]')?.getAttribute('data-record-key')).toBe(foldKey);
    expect(updatedFold.querySelector('.tb-chat-activity-gist')?.textContent).toBe('Search files · running');

    insert(204, 'List files', 'list_files');
    act(() => runtime.update({ toolCallIndex: index }));
    const mixedFoldAfterAppend = screen.getByRole('button', { name: /4 entries\. Latest: List files · running/ });
    expect(mixedFoldAfterAppend.closest('[data-activity-fold]')?.getAttribute('data-record-key')).toBe(foldKey);
    expect(view.container.querySelectorAll('.tb-chat-activity-run.tb-chat-activity-tool')).toHaveLength(1);
    expect(view.container.querySelectorAll('details.tb-chat-activity-line.tb-chat-activity-tool')).toHaveLength(0);

    fireEvent.click(mixedFoldAfterAppend);
    expect(mixedFoldAfterAppend.getAttribute('aria-expanded')).toBe('true');
    const expandedRun = view.container.querySelector<HTMLElement>(
      `[data-activity-fold][data-record-key="${foldKey}"]`,
    );
    expect(expandedRun?.getAttribute('data-run-expanded')).toBe('true');
    expect(expandedRun?.querySelectorAll('.tb-chat-activity-run-rows details.tb-chat-activity-tool')).toHaveLength(4);
    expect([...view.container.querySelectorAll(
      `[data-activity-fold][data-record-key="${foldKey}"] .tb-chat-activity-run-rows .tb-chat-activity-gist`,
    )]
      .map(element => element.textContent)).toEqual([
      'Read first file · running', 'Run command · running', 'Search files · running', 'List files · running',
    ]);
    expect(screen.getAllByText('List files · running')).toHaveLength(2);
    expect(within(screen.getByRole('log')).getByText('Keep this message visible')).toBeTruthy();
  });

  it('keeps a tool run split around a durable non-tool row', () => {
    const sessionKey = 'tool-run-record-event-boundary';
    const first: ToolCallRecord = { id: 'before-event', seq: 201, sessionKey, turnSeq: 1,
      afterMessageSeq: 1, harnessToolCallId: 'call-1', title: 'Read first', kind: 'read', toolName: 'read_file',
      status: 'completed', rawInput: null, rawOutput: null, content: null, truncated: [],
      startedAt: 2_000, endedAt: 2_100, rowVersion: 1 };
    const second: ToolCallRecord = { id: 'after-event', seq: 202, sessionKey, turnSeq: 1,
      afterMessageSeq: 1, harnessToolCallId: 'call-2', title: 'Run second', kind: 'command', toolName: 'bash',
      status: 'completed', rawInput: null, rawOutput: null, content: null, truncated: [],
      startedAt: 4_000, endedAt: 4_100, rowVersion: 1 };
    let index: ToolCallIndex | undefined;
    for (const call of [first, second]) {
      const group = putIndex(getIndex(index, call.afterMessageSeq), call.seq, call, call.startedAt);
      index = putIndex(index, call.afterMessageSeq, group, group.maxTime);
    }
    const human = row(sessionKey, 'human', 'Question', { seq: 1, role: 'user', sender: 'user:person',
      createdAt: new Date(1_000).toISOString() });
    const reply = row(sessionKey, 'reply', 'Answer', { seq: 2, createdAt: new Date(5_000).toISOString() });
    const event = { eventId: 'work_item.filed:between-tools', sessionKey, at: 3_000, kind: 'work_item.filed',
      record: { type: 'work item', id: 'between-tools', detail: 'A background update' },
      actorSessionKey: sessionKey, tiedAs: ['creator'], cause: { turnSeq: 1, messageId: null }, noticeMessageIds: [] };
    const runtime = new FakeRuntime(sessionKey, { records: [human, reply], recordEvents: [event],
      toolCallsEnabled: true, toolCallIndex: index });
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const keys = [...view.container.querySelectorAll<HTMLElement>('[data-record-key]')]
      .map(element => element.dataset.recordKey);

    expect(keys.indexOf('tool-before-event')).toBeLessThan(keys.indexOf('record-event:' + event.eventId));
    expect(keys.indexOf('record-event:' + event.eventId)).toBeLessThan(keys.indexOf('tool-after-event'));
    expect(view.container.querySelectorAll('.tb-chat-activity-tool-run-toggle')).toHaveLength(0);
    expect(view.container.querySelectorAll('details.tb-chat-activity-line.tb-chat-activity-tool')).toHaveLength(2);
  });

  it('renders reply chunks and adjacent tool calls in turn-event order without folding across a reply', () => {
    const sessionKey = 'turn-event-timeline';
    const prompt = row(sessionKey, 'prompt', 'Question', { seq: 1, role: 'user', sender: 'user:person', turnSeq: 7 });
    const reply = row(sessionKey, 'reply', 'Stored full reply', { seq: 8, replyToMessageId: prompt.id, turnSeq: 7 });
    const makeCall = (id: string, status: ToolCallRecord['status'], rowVersion: number): ToolCallRecord => ({
      id, seq: id === 'call-a' ? 21 : 22, sessionKey, turnSeq: 7, afterMessageSeq: reply.seq,
      harnessToolCallId: id, title: id === 'call-a' ? 'Call A' : 'Call B', kind: 'tool', toolName: null,
      status, rawInput: { id }, rawOutput: status === 'completed' ? { done: id } : null,
      content: null, truncated: [], startedAt: id === 'call-a' ? 100 : 200,
      endedAt: status === 'completed' ? 300 : null, rowVersion,
    });
    const callAStarted = makeCall('call-a', 'in_progress', 1);
    const callAEnded = makeCall('call-a', 'completed', 2);
    const callBStarted = makeCall('call-b', 'in_progress', 1);
    const callBEnded = makeCall('call-b', 'completed', 2);
    const event = (id: string, turnEventSeq: number, kind: TurnEventRecord['kind'],
      messageId: string | null, call?: ToolCallRecord, text?: string): TurnEventRecord => ({
      id, sessionKey, turnSeq: 7, turnEventSeq, kind, messageId,
      toolCallId: call?.id ?? null, content: kind === 'assistant.segment' ? { type: 'text', text } : null,
      toolCall: call ?? null, rowVersion: 1,
    });
    const events = [
      event('segment-1', 1, 'assistant.segment', reply.id, undefined, 'First response.'),
      event('tool-a-start', 2, 'tool.started', null, callAStarted),
      event('tool-b-start', 3, 'tool.started', null, callBStarted),
      event('segment-4', 4, 'assistant.segment', reply.id, undefined, 'Second response.'),
      event('tool-a-end', 5, 'tool.ended', null, callAEnded),
      event('segment-6', 6, 'assistant.segment', reply.id, undefined, 'Final response.'),
      event('tool-b-end', 7, 'tool.ended', null, callBEnded),
    ];
    const runtime = new FakeRuntime(sessionKey, { records: [prompt, reply], turnEventsEnabled: true,
      turnEvents: events, toolCallsEnabled: true, toolCalls: [callAEnded, callBEnded] });
    const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const recordKeys = [...view.container.querySelectorAll<HTMLElement>('[data-record-key]')]
      .map(element => element.dataset.recordKey);

    expect(recordKeys).toEqual([
      'prompt', 'turn-message:7:reply:1', 'turn-tools:7:call-a',
      'turn-message:7:reply:4', 'turn-message:7:reply:6',
    ]);
    expect([...view.container.querySelectorAll<HTMLElement>('[data-scroll-key]')]
      .map(element => element.dataset.scrollKey)).toEqual(recordKeys);
    expect(view.container.querySelector('[data-record-key="reply"]')).toBeNull();
    expect(view.container.querySelector('[data-record-key="turn-message:7:reply:1"]')?.textContent).toContain('First response.');
    expect(view.container.querySelector('[data-record-key="turn-message:7:reply:4"]')?.textContent).toContain('Second response.');
    expect(view.container.querySelector('[data-record-key="turn-message:7:reply:6"]')?.textContent).toContain('Final response.');

    const fold = view.container.querySelector<HTMLElement>('[data-record-key="turn-tools:7:call-a"]')!;
    const toggle = within(fold).getByRole('button', { name: /2 entries\. Latest: Call B · done/ });
    expect(fold.classList.contains('tb-chat-activity-run')).toBe(true);
    expect(fold.querySelector('.tb-chat-activity-run-count')?.textContent).toBe('×2');
    fireEvent.click(toggle);
    expect(fold.querySelectorAll('.tb-chat-activity-run-rows details.tb-chat-activity-tool')).toHaveLength(2);
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

  it('shows retained generic attachment outcome in the closed transcript disclosure', () => {
    const sessionKey = 'closed-attachment-status';
    const human = row(sessionKey, 'attachment-message', 'Inspect the attached report.', {
      seq: 1, role: 'user', sender: 'user:person', turnSeq: 1, attachments: [{
        assetId: 'asset-blocked', mimeType: 'application/zip', filename: 'blocked.zip', size: 32,
        delivery: { outcome: 'not-delivered', reason: {
          code: 'unsupported-delivery', message: 'This file will not reach the agent.',
        } },
      }],
    });
    const runtime = new FakeRuntime(sessionKey, { records: [human] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const disclosure = screen.getByText('1 attachment detail').closest('details')!;
    expect(disclosure.open).toBe(false);
    expect(screen.getByText('blocked.zip: Not delivered to the agent')).toBeTruthy();
    expect(disclosure.querySelector('summary')?.textContent).not.toContain('This file will not reach the agent.');
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
