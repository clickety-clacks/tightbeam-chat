import { getIndex, putIndex } from '../src/recordIndex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TightbeamChat, workingStateOpacity } from '../src/TightbeamChat';
import type { RenderContext } from '../src/TightbeamChat';
import { createTurnProvenance } from '../src/provenance';
import type {
  ToolCallIndex, ToolCallRecord, CanonicalMessage, CanonicalTurn, ChatRuntime, ConversationRecord, LocalSend, RuntimeState,
  TightbeamAdapter, TurnProvenance,
} from '../src/types';

afterEach(() => {
  cleanup();
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
  markHostSendUncertain = () => {};
  rebuild = async (options?: { restart?: boolean }) => { this.rebuildCalls++; this.rebuildOptions.push(options); const snapshot = this.rebuildSnapshots.shift(); if (snapshot) this.update(snapshot); };
  setToolCallsEnabled = (enabled: boolean) => this.update({ toolCallsEnabled: enabled });
  dispose = () => { this.disposed = true; this.listeners.clear(); };
}

function adapterFor(runtime: FakeRuntime): TightbeamAdapter { return { open: () => runtime }; }

function installViewportLayout(viewport: HTMLElement) {
  const content = viewport.querySelector<HTMLElement>('.tb-chat-message-content')!;
  const rowHeight = 92;
  let scrollTop = 0;
  const anchorSpace = () => Number.parseFloat(viewport.style.getPropertyValue('--tb-chat-anchor-space')) || 0;
  const scrollHeight = () => 32 + content.children.length * rowHeight + anchorSpace() + 200;
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => 180 },
    scrollHeight: { configurable: true, get: scrollHeight },
    scrollTop: {
      configurable: true, get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight() - 180)); },
    },
  });
  Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: (options: ScrollToOptions) => {
    viewport.scrollTop = options.top ?? 0;
  } });
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === viewport) return new DOMRect(0, 100, 320, 180);
    const index = [...content.children].indexOf(this);
    if (index >= 0) return new DOMRect(0, 116 + anchorSpace() + index * rowHeight - scrollTop, 320, 80);
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
    sender: 'process:notifications', messageType: 'substrate',
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
    `Hidden reply to agent wake ${prefix}`, `Hidden process notice ${prefix}`,
    `Hidden reply to process notice ${prefix}`,
  ]) expect(within(log).queryByText(label)).toBeNull();
}

describe('conversation surface', () => {
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

  it('filters with message provenance and renders safe Markdown without exposing batch wrappers', async () => {
    const sessionKey = 'conversation-a';
    const human = row(sessionKey, 'human-trigger', 'Could you explain this?', { seq: 1, role: 'user', sender: 'user:person', turnSeq: 1 });
    const unprovenHuman = row(sessionKey, 'unproven-human', 'A user row with no sender stays visible', { seq: 8, role: 'user' });
    const mismatchedHuman = row(sessionKey, 'mismatched-human', 'A differently marked user row stays visible', {
      seq: 9, role: 'user', sender: 'user:another-person', messageType: 'chat',
    });
    const answer = row(sessionKey, 'selected-answer', [
      '## A **useful** answer', '', '- first item', '- second item', '',
      '[Reference](https://example.com)', '', '`inline code`', '',
      '```ts', 'const value = 1;', '```', '', '> A quotation', '',
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
      'Substrate payload must stay hidden',
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
        batchAnswer, unprovenHuman, mismatchedHuman, substrateMarker],
      provenanceAvailable: false,
    });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    const log = screen.getByRole('log');
    expect(within(log).getByText('Could you explain this?')).toBeTruthy();
    expect(within(log).getByRole('heading', { level: 2, name: 'A useful answer' })).toBeTruthy();
    expect(within(log).getByText('first item')).toBeTruthy();
    expect(within(log).getByRole('link', { name: 'Reference' }).getAttribute('target')).toBe('_blank');
    expect(within(log).getByText('inline code')).toBeTruthy();
    expect(within(log).getByText('const value = 1;')).toBeTruthy();
    expect(within(log).getByText('A quotation')).toBeTruthy();
    expect(within(log).getByRole('table')).toBeTruthy();
    const batchBubble = within(log).getByText('Batch question from the person').closest('article');
    expect(batchBubble?.classList.contains('tb-chat-bubble-human')).toBe(true);
    expect(batchBubble?.getAttribute('aria-label')).toBe('Message from You');
    expect(batchBubble?.textContent).not.toContain('coalesced by');
    const substrateLine = within(log).getByRole('note', { name: 'Substrate: Substrate payload must stay hidden' });
    expect(substrateLine.classList.contains('tb-chat-activity-substrate')).toBe(true);
    expect(substrateLine.closest('article')?.classList.contains('tb-chat-bubble')).not.toBe(true);
    expect(batch.content).toBe(batchText);
    expect(within(log).getByText('Answer to the batch question')).toBeTruthy();
    expect(within(log).queryByText('A system event marker')).toBeNull();
    expect(within(log).queryByText('An agent sent a wake')).toBeNull();
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
  });

  it('hides typed non-envelope activity and keeps human exchanges across pages, live updates, and reconnects', async () => {
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
    expect(await screen.findByText('Message 1200')).toBeTruthy();
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

    expect(screen.getByText('A new question')).toBeTruthy();
    expect(screen.getByText('A new answer')).toBeTruthy();
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

  it('shows a live-feed reconnect only through the yellow then green status dot', () => {
    const runtime = new FakeRuntime('feed-status', { status: 'ready', liveError: 'Changes socket closed' });
    render(<TightbeamChat sessionKey="feed-status" adapter={adapterFor(runtime)} />);

    const reconnectingButton = screen.getByRole('button', { name: 'Connection status: Reconnecting. Show details' });
    expect(reconnectingButton.querySelector('.tb-chat-status-dot')?.classList.contains('tb-chat-status-stale')).toBe(true);
    expect(screen.queryByText(/Reconnecting|Live updates are reconnecting|conversation may be out of date/)).toBeNull();
    fireEvent.click(reconnectingButton);
    const details = screen.getByRole('dialog', { name: 'Connection details' });
    expect(within(details).queryByText(/Changes socket closed|Live updates:/)).toBeNull();
    expect(within(details).getByRole('button', { name: 'Reconnect' })).toBeTruthy();

    act(() => runtime.update({ liveError: undefined }));
    const connectedButton = screen.getByRole('button', { name: 'Connection status: Connected. Show details' });
    expect(connectedButton.querySelector('.tb-chat-status-dot')?.classList.contains('tb-chat-status-ready')).toBe(true);
    expect(screen.queryByText(/Reconnecting|Live updates are reconnecting|conversation may be out of date/)).toBeNull();
  });

  it('keeps the authorization-loss explanation with the red connection dot', () => {
    const runtime = new FakeRuntime('unauthorized-status', { status: 'unauthorized' });
    render(<TightbeamChat sessionKey="unauthorized-status" adapter={adapterFor(runtime)} />);

    expect(screen.getByRole('alert').textContent).toContain('Access to this conversation is unavailable.');
    const disconnectedButton = screen.getByRole('button', {
      name: 'Connection status: Access to this conversation is unavailable. Show details',
    });
    expect(disconnectedButton.querySelector('.tb-chat-status-dot')?.classList.contains('tb-chat-status-unauthorized')).toBe(true);
    expect(screen.queryByText(/^Disconnected$/)).toBeNull();
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
      const activeTurn = createTurnProvenance(turn(1, sessionKey, human.id, 'user:person', 'running'), [human], 'person', 'person');
      const runtime = new FakeRuntime(sessionKey, { records: [human], activeTurn, activityTurnStateAvailable: true });
      render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
      expect(screen.getByRole('status', { name: 'Active turn: Replying to you' }).style.opacity).toBe('1');
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original);
      else Reflect.deleteProperty(window, 'matchMedia');
    }
  });

  it('expands one activity gap in place and keeps it expanded for later entries', () => {
    const sessionKey = 'activity-expansion';
    const prompt = row(sessionKey, 'prompt', 'Question', { role: 'user', sender: 'user:person', seq: 1, turnSeq: 1 });
    const activity = Array.from({ length: 8 }, (_, index) => row(sessionKey, `notice-${index + 1}`,
      `Background event ${index + 1}`, { role: 'user', sender: 'process:events', messageType: 'substrate', seq: index + 2 }));
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
    const overflow = screen.getByRole('button', { name: 'Show earlier activity' });
    expect(screen.getByRole('separator', { name: 'Transition: Context compacted' })).toBeTruthy();
    fireEvent.click(overflow);

    expect(screen.getAllByRole('note')).toHaveLength(8);
    expect(screen.queryByRole('button', { name: 'Show earlier activity' })).toBeNull();
    expect(screen.getByText('Context compacted')).toBeTruthy();
    expect(Math.abs(layout.offset(replyRow) - before)).toBeLessThanOrEqual(1);
    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe('Unsent draft');
    expect([composer.selectionStart, composer.selectionEnd]).toEqual([2, 6]);

    const later = row(sessionKey, 'notice-later', 'A later background event', {
      role: 'user', sender: 'process:events', messageType: 'substrate', seq: 15,
    });
    act(() => runtime.update({ records: [prompt, ...activity, boundary, later, reply] }));
    expect(screen.getAllByRole('note')).toHaveLength(9);
    expect(screen.getByText('A later background event')).toBeTruthy();
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
    expect(await screen.findByText('Older human message')).toBeTruthy();
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

  it('renders tool history updates as captions without restyling the toggle', () => {
    const runtime = new FakeRuntime('tool-history-caption', { toolCallsEnabled: true, toolCallsLoading: true });
    const view = render(<TightbeamChat sessionKey="tool-history-caption" adapter={adapterFor(runtime)} />);

    const toggle = screen.getByRole('button', { name: 'Tool calls' });
    expect(toggle.classList.contains('tb-chat-caption')).toBe(false);
    const loading = screen.getByText('Loading tool history…');
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.classList.contains('tb-chat-caption-neutral')).toBe(true);

    act(() => runtime.update({ toolCallsLoading: false, toolCallsError: 'Connection unavailable' }));
    const status = view.container.querySelector<HTMLElement>('.tb-chat-tool-controls > .tb-chat-caption-danger');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toBe('Tool history is not current: Connection unavailable Retry tool history');
    const retry = within(status!).getByRole('button', { name: 'Retry tool history' });
    expect(retry).toBeTruthy();
    expect(retry.closest('.tb-chat-caption-body')).toBeTruthy();
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
    await screen.findByText('A question');
    fireEvent.change(screen.getByRole('textbox', { name: 'Message to Research assistant' }), { target: { value: 'draft A' } });
    view.rerender(<TightbeamChat sessionKey="B" adapter={adapter} renderMessage={renderMessage} />);
    expect(await screen.findByText('Custom B')).toBeTruthy();
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
    expect(composer).toHaveProperty('value', '');

    act(() => {
      runtime.state = { ...runtime.state, status: 'unauthorized' };
      for (const listener of runtime.listeners) listener();
    });
    expect(composer).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', true);
  });

  it('opens Settings from the composer while disconnected, clears the draft and restores focus on close', async () => {
    const runtime = new FakeRuntime('local-settings', { status: 'stale' });
    render(<TightbeamChat sessionKey="local-settings" adapter={adapterFor(runtime)} />);
    const composer = screen.getByRole('textbox', { name: 'Message to Research assistant' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: '  /settings\n' } });

    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(runtime.sent).toEqual([]);
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
    await screen.findByText('Reader anchor');
    const viewport = screen.getByRole('log');
    const layout = installViewportLayout(viewport);
    try {
      const anchor = screen.getByText('Reader anchor').closest('article')!;
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
    expect(composer).toHaveProperty('value', '');
    expect(document.activeElement).toBe(composer);
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

  it('shows Sending while a message remains pending during a connection retry', () => {
    const sessionKey = 'send-recovery';
    const runtime = new FakeRuntime(sessionKey, { sends: [
      { sessionKey, deviceId: 'device', clientMessageId: 'failed-id', content: 'Failed text',
        submittedAt: '2026-10-20T09:05:00.000Z', status: 'failed', reconciled: false,
        reason: 'private target detail' },
      { sessionKey, deviceId: 'device', clientMessageId: 'uncertain-id', content: 'Uncertain text',
        submittedAt: '2026-10-20T09:06:00.000Z', status: 'uncertain', reconciled: false,
        reason: 'private session detail' },
      { sessionKey, deviceId: 'device', clientMessageId: 'unreachable-id', content: 'Offline text',
        submittedAt: '2026-10-20T09:07:00.000Z', status: 'pending', reconciled: false,
        reason: 'unreachable' },
    ] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    expect(screen.getByText('Failed text')).toBeTruthy();
    expect(screen.getByText('Uncertain text')).toBeTruthy();
    expect(screen.getByText('Offline text')).toBeTruthy();
    const sendStatus = screen.getByText('Sending…');
    expect(sendStatus.getAttribute('role')).toBe('status');
    expect(screen.queryByText(/Not connected to the server|retrying…/)).toBeNull();
    expect(screen.queryByText('Reconnect, then check the conversation before retrying this message.')).toBeNull();
    expect(screen.getAllByRole('alert').every((alert) => !alert.textContent?.includes('private'))).toBe(true);
    expect(screen.queryByText(/private target detail|private session detail/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry message' })[0]);
    expect(runtime.retried).toEqual(['failed-id']);
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore text to the composer' })[1]);
    expect(screen.getByRole('textbox', { name: 'Message to Research assistant' })).toHaveProperty('value', 'Uncertain text');
  });

  it('explains an unconfirmed send when safe retry is unavailable', () => {
    const sessionKey = 'unsupported-send-recovery';
    const runtime = new FakeRuntime(sessionKey, { status: 'ready', sends: [{
      sessionKey, deviceId: 'device', clientMessageId: 'unsupported-retry-id',
      content: 'Check this message before retrying', submittedAt: '2026-10-25T09:00:00.000Z',
      status: 'uncertain', reconciled: false, reason: 'retry-unavailable',
    }] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);

    expect(screen.getByText('This target stopped supporting safe retries. Delivery could not be confirmed; check the conversation before retrying.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry message' })).toBeNull();
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
    expect(view.container.querySelectorAll('.tb-chat-activity-tool')).toHaveLength(5);
    const overflow = screen.getByRole('button', { name: 'Show earlier activity' });
    overflow.focus();
    fireEvent.click(overflow);
    expect(view.container.querySelectorAll('.tb-chat-activity-tool')).toHaveLength(2000);
    const retained = view.container.querySelector<HTMLDetailsElement>('[data-record-key="tool-tc_1000"]')!;
    retained.open = true;
    fireEvent(retained, new Event('toggle'));
    insert(tool(2001));
    act(() => runtime.update({ toolCallIndex: index }));
    expect(view.container.querySelector('[data-record-key="tool-tc_1000"]')).toBe(retained);
    expect(retained.open).toBe(true);
    expect(view.container.querySelectorAll('.tb-chat-activity-tool')).toHaveLength(2001);
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
    expect(keys()).toEqual(['human', 'tool-tc_201', 'tool-tc_202', 'local-c_pending', 'reply']);
    expect(screen.getAllByText('Follow-up')).toHaveLength(1);
  });

  it('anchors tools between messages, expands input/results with truthful truncation, and keeps the draft while toggling', async () => {
    const call: ToolCallRecord = { id: 'tc_read', seq: 500, sessionKey: 'tools', turnSeq: 7, afterMessageSeq: 1,
      harnessToolCallId: 'read-1', title: 'Read the source file', kind: 'read', toolName: 'read_file',
      status: 'in_progress', rawInput: { path: 'source.ts' }, rawOutput: null, content: null,
      truncated: [], startedAt: 1000, endedAt: null, rowVersion: 1 };
    const human = row('tools', 'human', 'Please read the source', { role: 'user', sender: 'user:person', seq: 1 });
    const reply = row('tools', 'reply', 'Read complete', { seq: 3, replyToMessageId: human.id });
    const marker: ConversationRecord = { kind: 'transition', id: 'boundary', seq: 2, rowVersion: 1,
      sessionKey: 'tools', transition: 'unknown', from: 'old', to: 'new', content: 'A new boundary kind', raw: {} };
    const runtime = new FakeRuntime('tools', { records: [human, marker, reply], toolCallsEnabled: true, toolCalls: [call] });
    const view = render(<TightbeamChat sessionKey="tools" adapter={adapterFor(runtime)} />);
    expect([...view.container.querySelectorAll('[data-record-key]')].map(node => node.getAttribute('data-record-key')))
      .toEqual(['human', 'tool-tc_read', 'boundary', 'reply']);
    expect(screen.getByText('A new boundary kind')).toBeTruthy();
    expect(screen.getByText('A new boundary kind').closest('.tb-chat-transition-marker')?.getAttribute('role')).toBe('separator');
    expect(screen.queryByText('source.ts')).toBeNull();
    const detail = view.container.querySelector('details')!;
    detail.open = true;
    fireEvent(detail, new Event('toggle'));
    await screen.findByText(/source.ts/);
    expect(screen.getByText('Waiting for result…')).toBeTruthy();
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'draft kept' } });
    act(() => runtime.update({ toolCalls: [{ ...call, status: 'completed', rowVersion: 2,
      rawOutput: '{"prefix":', truncated: [{ field: 'rawOutput', originalBytes: 20000 }], endedAt: 2000 }] }));
    expect(screen.getByText('Read the source file · done')).toBeTruthy();
    expect(screen.getByText('Result truncated — original size 20000 bytes.')).toBeTruthy();
    expect(screen.getByText('{"prefix":')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tool calls' }));
    expect(screen.queryByText(/Read the source file/)).toBeNull();
    expect(screen.getByText('A new boundary kind')).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe('draft kept');
    fireEvent.click(screen.getByRole('button', { name: 'Tool calls' }));
    expect(screen.getByText('Read the source file · done')).toBeTruthy();
  });
});
