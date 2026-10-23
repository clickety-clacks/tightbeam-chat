import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TightbeamChat } from '../src/TightbeamChat';
import type { RenderContext } from '../src/TightbeamChat';
import { createTurnProvenance } from '../src/provenance';
import type {
  CanonicalMessage, CanonicalTurn, ChatRuntime, ConversationRecord, RuntimeState,
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
  trigger?: CanonicalMessage, displayName?: string, status = 'completed'): TurnProvenance {
  return createTurnProvenance(turn(seq, sessionKey, messageId, origin, status), trigger, displayName);
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
  retried: string[] = [];
  loadOlderCalls = 0;
  rebuildCalls = 0;
  olderPages: OlderPage[] = [];
  rebuildSnapshots: Partial<RuntimeState>[] = [];
  state: RuntimeState;

  constructor(sessionKey: string, patch: Partial<RuntimeState> = {}) {
    this.state = { sessionKey, generation: 1, status: 'ready', records: [], provenance: [],
      hasOlder: false, loadingOlder: false, sends: [], targetLabel: 'Fixture',
      agentDisplayName: 'Research assistant', targetGateway: 'https://gateway.example',
      session: { sessionKey, rowVersion: 1, displayName: 'Research assistant', model: 'Model A', harness: 'Harness A', raw: {} },
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
  update = (patch: Partial<RuntimeState>) => {
    this.state = { ...this.state, ...patch };
    this.publish();
  };
  send = (text: string) => { this.sent.push(text); return 'fixture-send'; };
  retrySend = async (id: string) => { this.retried.push(id); };
  rebuild = async () => {
    this.rebuildCalls++;
    const snapshot = this.rebuildSnapshots.shift();
    if (snapshot) this.update(snapshot);
  };
  dispose = () => { this.disposed = true; this.listeners.clear(); };
}

function adapterFor(runtime: FakeRuntime): TightbeamAdapter { return { open: () => runtime }; }

function visibilityMix(sessionKey: string, prefix: string): readonly CanonicalMessage[] {
  const human = row(sessionKey, `${prefix}-human`, `Human exchange ${prefix}`, {
    role: 'user', messageType: 'chat', raw: { source: 'fixture', id: `${prefix}-human`, sender: null },
  });
  const humanReply = row(sessionKey, `${prefix}-human-reply`, `Reply to human ${prefix}`, {
    sender: 'agent:selected', messageType: 'assistant', replyToMessageId: human.id,
  });
  const batch = row(sessionKey, `${prefix}-batch`, [
    '[batched notices: 1]', '',
    `[1] source=process sender=process:notifications cause=fixture class=fyi`,
    `Visible batch envelope ${prefix}`, '', 'coalesced by notices',
  ].join('\n'), {
    role: 'user', sender: 'process:notifications', messageType: 'substrate',
  });
  const batchReply = row(sessionKey, `${prefix}-batch-reply`, `Reply to batch ${prefix}`, {
    sender: 'agent:selected', messageType: 'assistant', replyToMessageId: batch.id,
  });
  const marker = row(sessionKey, `${prefix}-marker`, `Hidden assistant substrate marker ${prefix}`, {
    sender: 'process:notifications', messageType: 'substrate',
  });
  const agentWake = row(sessionKey, `${prefix}-agent-wake`, `Hidden agent wake ${prefix}`, {
    role: 'user', sender: 'agent:external', messageType: 'agent',
  });
  const agentReply = row(sessionKey, `${prefix}-agent-reply`, `Hidden reply to agent wake ${prefix}`, {
    sender: 'agent:selected', messageType: 'assistant', replyToMessageId: agentWake.id,
  });
  const processNotice = row(sessionKey, `${prefix}-process`, `Hidden process notice ${prefix}`, {
    role: 'user', sender: 'process:notifications', messageType: 'chat',
  });
  const processReply = row(sessionKey, `${prefix}-process-reply`, `Hidden reply to process notice ${prefix}`, {
    sender: 'agent:selected', messageType: 'assistant', replyToMessageId: processNotice.id,
  });
  return [human, humanReply, batch, batchReply, marker, agentWake, agentReply, processNotice, processReply];
}

function expectVisibilityMix(log: HTMLElement, prefix: string): void {
  for (const label of [
    `Human exchange ${prefix}`, `Reply to human ${prefix}`,
    `Visible batch envelope ${prefix}`, `Reply to batch ${prefix}`,
  ]) expect(within(log).getByText(label)).toBeTruthy();
  for (const label of [
    `Hidden assistant substrate marker ${prefix}`, `Hidden agent wake ${prefix}`,
    `Hidden reply to agent wake ${prefix}`, `Hidden process notice ${prefix}`,
    `Hidden reply to process notice ${prefix}`,
  ]) expect(within(log).queryByText(label)).toBeNull();
}

describe('conversation surface', () => {
  it('revalidates history on resume after a heartbeat window unless the target is locked', async () => {
    const sessionKey = 'background-resume-session';
    const runtime = new FakeRuntime(sessionKey);
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T00:00:00Z'));

    try {
      render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
      const changeVisibility = async (next: DocumentVisibilityState, elapsedMs = 0) => {
        await act(async () => {
          visibility = next;
          document.dispatchEvent(new Event('visibilitychange'));
          if (elapsedMs > 0) await vi.advanceTimersByTimeAsync(elapsedMs);
        });
      };

      await changeVisibility('hidden', 44_999);
      await changeVisibility('visible');
      expect(runtime.rebuildCalls).toBe(0);

      await changeVisibility('hidden', 45_001);
      await changeVisibility('visible');
      expect(runtime.rebuildCalls).toBe(1);

      runtime.state = { ...runtime.state, status: 'stale' };
      await changeVisibility('hidden', 45_001);
      await changeVisibility('visible');
      expect(runtime.rebuildCalls).toBe(2);

      runtime.state = { ...runtime.state, status: 'unsupported' };
      await changeVisibility('hidden', 45_001);
      await changeVisibility('visible');
      expect(runtime.rebuildCalls).toBe(2);

      runtime.state = { ...runtime.state, status: 'unauthorized' };
      await changeVisibility('hidden', 45_001);
      await changeVisibility('visible');
      expect(runtime.rebuildCalls).toBe(2);
    } finally {
      if (originalVisibilityState) Object.defineProperty(document, 'visibilityState', originalVisibilityState);
      else Reflect.deleteProperty(document, 'visibilityState');
      vi.useRealTimers();
    }
  });

  it('uses typed message links to keep human exchanges and mixed batch envelopes', async () => {
    const sessionKey = 'conversation-a';
    const human = row(sessionKey, 'human-trigger', 'Could you explain this?', {
      role: 'user', sender: 'user:person', clientMessageId: 'client-human', deviceId: 'human-device', turnSeq: 1,
    });
    const unprovenHuman = row(sessionKey, 'unproven-human', 'Role alone must not prove this exchange', { role: 'user' });
    const answer = row(sessionKey, 'selected-answer', [
      '## A **useful** answer', '', '- first item', '- second item', '',
      '[Reference](https://example.com)', '', '`inline code`', '',
      '```ts', 'const value = 1;', '```', '', '> A quotation', '',
      '| Name | Value |', '| --- | --- |', '| count | 2 |', '',
      '<script>window.compromised = true</script>',
    ].join('\n'), { sender: 'agent:selected', turnSeq: 1, messageType: 'assistant', replyToMessageId: human.id });
    const otherTrigger = row(sessionKey, 'other-trigger', 'An agent sent a wake', {
      role: 'user', sender: 'agent:external', messageType: 'agent', turnSeq: 2,
    });
    const otherAnswer = row(sessionKey, 'other-answer', 'Must remain hidden', {
      turnSeq: 2, messageType: 'assistant', replyToMessageId: otherTrigger.id,
    });
    const substrateMarker = row(sessionKey, 'substrate-marker', 'A system event marker', {
      role: 'assistant', sender: 'process:notifications', messageType: 'substrate',
    });
    const batchText = [
      '[batched notices: 2]',
      '',
      '[1] source=event-a sender=user:person cause=reply class=input-needed',
      'Batch question from the person',
      '',
      '[2] source=event-b sender=process:maintenance cause=refresh class=fyi',
      'Substrate payload must stay visible inside the envelope',
      '',
      'coalesced by notice-batching-v1',
    ].join('\n');
    const batch = row(sessionKey, 'batch-trigger', batchText, {
      role: 'user', sender: 'process:maintenance', messageType: 'substrate', turnSeq: 3,
    });
    const batchAnswer = row(sessionKey, 'batch-answer', 'Answer to the batch question', {
      sender: 'agent:selected', turnSeq: 3, messageType: 'assistant', replyToMessageId: batch.id,
    });
    const runtime = new FakeRuntime(sessionKey, {
      records: [human, answer, otherTrigger, otherAnswer, batch, batchAnswer, unprovenHuman, substrateMarker],
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
    expect(log.textContent).toContain('[batched notices: 2]');
    expect(log.textContent).toContain('Batch question from the person');
    expect(log.textContent).toContain('Substrate payload must stay visible inside the envelope');
    expect(within(log).getByText('Answer to the batch question')).toBeTruthy();
    expect(within(log).queryByText('A system event marker')).toBeNull();
    expect(within(log).queryByText('An agent sent a wake')).toBeNull();
    expect(within(log).queryByText('Must remain hidden')).toBeNull();
    expect(within(log).queryByText('Role alone must not prove this exchange')).toBeNull();
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
      role: 'assistant', messageType: 'chat', turnSeq: 10,
    });
    const unprovenSelectedReply = row(sessionKey, 'unproven-selected-reply', 'A selected reply without a provable trigger', {
      role: 'assistant', messageType: 'assistant', turnSeq: 12,
    });
    const unlinkedSelectedReply = row(sessionKey, 'unlinked-selected-reply', 'A selected reply without a parent link', {
      role: 'assistant', sender: 'agent:selected', messageType: 'assistant', turnSeq: 13,
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
    expect(within(log).queryByText('An unproven user row')).toBeNull();

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

  it('keeps null-linked and unloaded-parent replies until loaded fields prove exclusion', async () => {
    const sessionKey = 'unresolved-reply-parent';
    const nullSenderHuman = row(sessionKey, 'null-sender-human', 'A human message with a null sender', {
      role: 'user', messageType: 'chat', raw: { source: 'fixture', id: 'null-sender-human', sender: null },
    });
    const unknownSender = row(sessionKey, 'unknown-sender', 'An absent sender is not proven human by metadata alone', {
      role: 'user', messageType: 'chat',
      clientMessageId: 'client-unknown', deviceId: 'unknown-device',
    });
    const nullLinkReply = row(sessionKey, 'null-link-reply', 'A reply without a parent link', {
      role: 'assistant', sender: 'agent:selected', messageType: 'assistant', replyToMessageId: undefined,
    });
    const unloadedParentReply = row(sessionKey, 'unloaded-parent-reply', 'A reply whose parent is not loaded', {
      role: 'assistant', sender: 'agent:selected', messageType: 'assistant', replyToMessageId: 'older-agent-trigger',
    });
    const runtime = new FakeRuntime(sessionKey, {
      records: [nullSenderHuman, unknownSender, nullLinkReply, unloadedParentReply],
    });
    runtime.olderPages = [{ records: [row(sessionKey, 'older-agent-trigger', 'An older agent wake', {
      role: 'user', sender: 'agent:external', messageType: 'agent',
    })], provenance: [], hasOlder: false }];

    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    const log = screen.getByRole('log');
    expect(within(log).getByText('A human message with a null sender')).toBeTruthy();
    expect(within(log).queryByText('An absent sender is not proven human by metadata alone')).toBeNull();
    expect(within(log).getByText('A reply without a parent link')).toBeTruthy();
    expect(within(log).getByText('A reply whose parent is not loaded')).toBeTruthy();

    act(() => runtime.update({ hasOlder: true }));
    await waitFor(() => expect(runtime.loadOlderCalls).toBe(1));
    expect(within(log).queryByText('An older agent wake')).toBeNull();
    expect(within(log).queryByText('A reply whose parent is not loaded')).toBeNull();
    expect(runtime.getSnapshot().records.map((record) => record.id)).toContain('unloaded-parent-reply');
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
    expect(screen.getByText('Reconnecting; the conversation may be out of date.')).toBeTruthy();
    expect(screen.queryByText(/selected-session|gateway\.example/)).toBeNull();
    expect(composer.disabled).toBe(false);
    expect(composer.value).toBe('keep this draft');
    expect(composer.selectionStart).toBe(5);
    expect(document.activeElement).toBe(composer);
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', true);

    act(() => {
      runtime.state = { ...runtime.state, status: 'ready', statusDetail: undefined };
      for (const listener of runtime.listeners) listener();
    });
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
    expect(screen.getByText('Disconnected. Open connection details to reconnect.')).toBeTruthy();
    expect(screen.queryByText(/exact-session/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connection status: Disconnected. Show details' }));
    const disconnected = screen.getByRole('dialog', { name: 'Connection details' });
    expect(within(disconnected).getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  it('suppresses cached active-turn captions when delivered turn state is unavailable', () => {
    const sessionKey = 'caption-lifecycle';
    const human = row(sessionKey, 'human-trigger', 'A human question', { role: 'user', sender: 'user:person' });
    const humanTurn = provenance(31, sessionKey, human.id, 'user:person', human, undefined, 'running');
    const runtime = new FakeRuntime(sessionKey, {
      records: [human], provenance: [humanTurn], activeTurn: humanTurn, provenanceAvailable: false,
    });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    expect(screen.queryByRole('status', { name: /Active turn:/ })).toBeNull();
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

  it('automatically follows hidden-only older pages until a displayable human message arrives', async () => {
    const sessionKey = 'paged-session';
    const hiddenTrigger = row(sessionKey, 'other-trigger', 'Another agent activity', { role: 'assistant' });
    const hiddenReply = row(sessionKey, 'hidden-reply', 'Not a human conversation', { turnSeq: 7 });
    const hiddenTurn = provenance(7, sessionKey, hiddenTrigger.id, 'agent:other', hiddenTrigger, 'Other agent');
    const olderHuman = row(sessionKey, 'older-human', 'Older human message', {
      role: 'user', sender: 'user:person', turnSeq: 8,
    });
    const olderTurn = provenance(8, sessionKey, olderHuman.id, 'user:person', olderHuman);
    const runtime = new FakeRuntime(sessionKey, { hasOlder: true });
    runtime.olderPages = [
      { records: [hiddenReply], provenance: [hiddenTurn], hasOlder: true },
      { records: [olderHuman], provenance: [olderTurn], hasOlder: false },
    ];
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    expect(await screen.findByText('Older human message')).toBeTruthy();
    await waitFor(() => expect(runtime.loadOlderCalls).toBe(2));
    expect(screen.queryByText('Not a human conversation')).toBeNull();
    expect(screen.queryByRole('button', { name: /load earlier/i })).toBeNull();
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

  it('keeps submitted whitespace intact and locks the composer only for unsupported or unauthorized states', () => {
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
    expect(composer).toHaveProperty('disabled', true);
  });

  it('keeps failed and uncertain submissions in their own bubbles with retry and restore actions', () => {
    const sessionKey = 'send-recovery';
    const runtime = new FakeRuntime(sessionKey, { sends: [
      { sessionKey, deviceId: 'device', clientMessageId: 'failed-id', content: 'Failed text',
        submittedAt: '2026-10-20T09:05:00.000Z', status: 'failed', reconciled: false,
        reason: 'private target detail' },
      { sessionKey, deviceId: 'device', clientMessageId: 'uncertain-id', content: 'Uncertain text',
        submittedAt: '2026-10-20T09:06:00.000Z', status: 'uncertain', reconciled: false,
        reason: 'private session detail' },
    ] });
    render(<TightbeamChat sessionKey={sessionKey} adapter={adapterFor(runtime)} />);
    expect(screen.getByText('Failed text')).toBeTruthy();
    expect(screen.getByText('Uncertain text')).toBeTruthy();
    expect(screen.getAllByRole('alert').every((alert) => !alert.textContent?.includes('private'))).toBe(true);
    expect(screen.queryByText(/private target detail|private session detail/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry message' })[0]);
    expect(runtime.retried).toEqual(['failed-id']);
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore text to the composer' })[1]);
    expect(screen.getByRole('textbox', { name: 'Message to Research assistant' })).toHaveProperty('value', 'Uncertain text');
  });
});
