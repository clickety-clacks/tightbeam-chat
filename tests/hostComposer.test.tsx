import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TightbeamChat } from '../src/TightbeamChat';
import { createTightbeamAdapter } from '../src/runtime';
import { decodeRunningModel } from '../src/runningModel';
import { unseenReleaseNotes } from '../src/releaseNotes';
import { HOST_COMMAND_NAME, HOST_DECLARATION_NAME, HostComposerBridge, type HostComposerCommandEntry, type HostComposerEvent } from '../src/hostComposer';
import type {
  CanonicalMessage, CanonicalTurn, ChangeCallbacks, ChangeNotice, ChatRuntime, ChatTransport,
  ConversationPage, ConversationRecord, HostIdentity, HumanSendResult, HumanSubmission,
  SessionRecord, TargetCapabilities, TargetObservation, TargetProfile, TightbeamAdapter,
} from '../src/types';
import { AuthorizationError, SessionNotFoundError } from '../src/types';

vi.mock('../src/releaseNotes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/releaseNotes')>();
  return { ...actual, unseenReleaseNotes: vi.fn(actual.unseenReleaseNotes) };
});

const capabilities: TargetCapabilities = {
  newestTail: true, stableOlderCursor: true, retainedHistoryAcrossResets: true,
  orderedTransitions: true, snapshotCoverage: true, versionedNotices: true,
  humanSendDedupe: true, authoritativeTurnProvenance: true,
};
const profile: TargetProfile = { identity: 'fixture:host-composer', label: 'TEST FIXTURE', capabilities };
const identity: HostIdentity = { principalKey: 'person', deviceId: 'device-1' };
const correlation = 'c_123e4567-e89b-42d3-a456-426614174000';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class HostComposerTransport implements ChatTransport {
  readonly submissions: HumanSubmission[] = [];
  readonly records = new Map<string, ConversationRecord[]>();
  currentTurns: CanonicalTurn[] = [];
  readonly callbacks = new Map<string, ChangeCallbacks>();
  readonly closed = new Set<string>();
  changeOpenCount = 0;
  readonly targetGateway = 'https://gateway.example:8443';
  readonly observation: TargetObservation = profile;
  readReadMarker?: ChatTransport['readReadMarker'];
  writeReadMarker?: ChatTransport['writeReadMarker'];
  readMarkerOperatorPrincipalKey?: string;
  readyGate?: ReturnType<typeof deferred<void>>;
  readGate?: ReturnType<typeof deferred<void>>;
  tailRecoveryGate?: ReturnType<typeof deferred<void>>;
  tailReadFailures = 0;
  tailReadFailureStatus = 502;
  tailReadCount = 0;
  changeOpenFailures = 0;
  failReadSessionOnce = false;
  missingSession = false;
  runningModel: unknown = undefined;
  private sessionVersion = 1;
  authorizationLost = false;
  nextSend?: (submission: HumanSubmission) => Promise<HumanSendResult>;
  private seq = 0;

  currentIdentity = () => identity;
  inspectTarget = async () => this.observation;
  openChanges = async (sessionKey: string, callbacks: ChangeCallbacks, signal: AbortSignal) => {
    this.changeOpenCount++;
    this.callbacks.set(sessionKey, callbacks);
    if (this.readyGate) await this.readyGate.promise;
    if (signal.aborted) throw new Error('Changes subscription was canceled.');
    if (this.changeOpenFailures > 0) {
      this.changeOpenFailures--;
      if (this.callbacks.get(sessionKey) === callbacks) this.callbacks.delete(sessionKey);
      throw new Error('Live updates are unavailable.');
    }
    queueMicrotask(() => {
      if (signal.aborted || this.callbacks.get(sessionKey) !== callbacks) return;
      for (const turn of this.currentTurns.filter(turn => turn.sessionKey === sessionKey)) {
        callbacks.onNotice({ operation: 'turn', turn });
      }
    });
    return { close: () => { this.closed.add(sessionKey); this.callbacks.delete(sessionKey); } };
  };
  readSession = async (sessionKey: string): Promise<SessionRecord> => {
    if (this.readGate) await this.readGate.promise;
    if (this.authorizationLost) throw new AuthorizationError('Access to this conversation is no longer authorized.');
    if (this.missingSession) throw new SessionNotFoundError('This conversation no longer exists.');
    if (this.failReadSessionOnce) {
      this.failReadSessionOnce = false;
      throw new Error('Temporary history read failure.');
    }
    return { sessionKey, rowVersion: this.sessionVersion, displayName: `Agent ${sessionKey}`, model: 'Model A', harness: 'Harness A',
      runningModel: decodeRunningModel(this.runningModel), raw: {} };
  };
  readTail = async (sessionKey: string): Promise<ConversationPage> => {
    this.tailReadCount++;
    if (this.tailReadFailures > 0) {
      this.tailReadFailures--;
      throw new Error(`Tightbeam REST request failed with HTTP ${this.tailReadFailureStatus}.`);
    }
    if (this.tailRecoveryGate && this.records.has(sessionKey)) await this.tailRecoveryGate.promise;
    if (this.readGate) await this.readGate.promise;
    if (this.authorizationLost) throw new AuthorizationError('Access to this conversation is no longer authorized.');
    const rows = this.records.get(sessionKey) ?? [];
    return { records: rows.slice(-50), oldestCursor: rows[0]?.id ?? null, hasOlder: false, coverage: sessionKey };
  };
  readOlder = async (_sessionKey: string, _before: string): Promise<ConversationPage> => ({
    records: [], oldestCursor: null, hasOlder: false, coverage: _sessionKey,
  });
  proveCoverage = (session: SessionRecord, page: ConversationPage, _buffered: readonly ChangeNotice[]) => page.coverage === session.sessionKey;
  sendHuman = async (submission: HumanSubmission, _signal?: AbortSignal, onSubmitted?: () => void): Promise<HumanSendResult> => {
    this.submissions.push(submission);
    onSubmitted?.();
    if (this.authorizationLost) throw new AuthorizationError('Access to this conversation is no longer authorized.');
    return this.nextSend ? this.nextSend(submission) : { outcome: 'accepted' };
  };

  addCanonical(submission: HumanSubmission): CanonicalMessage {
    const record: CanonicalMessage = {
      kind: 'message', id: `canonical-${++this.seq}`, sessionKey: submission.sessionKey,
      seq: this.seq, rowVersion: 1, role: 'user', sender: 'user:person', content: submission.content,
      clientMessageId: submission.clientMessageId, deviceId: submission.deviceId, raw: {},
    };
    const rows = this.records.get(submission.sessionKey) ?? [];
    rows.push(record);
    this.records.set(submission.sessionKey, rows);
    return record;
  }

  setRunningModel(sessionKey: string, runningModel: unknown): void {
    this.runningModel = runningModel;
    this.sessionVersion++;
    this.callbacks.get(sessionKey)?.onNotice({ operation: 'session', session: {
      sessionKey, rowVersion: this.sessionVersion, displayName: `Agent ${sessionKey}`, model: 'Model A', harness: 'Harness A',
      runningModel: decodeRunningModel(runningModel), raw: {} } });
  }

  emit(record: ConversationRecord): void {
    this.callbacks.get(record.sessionKey)?.onNotice({ operation: 'upsert', record });
  }

  emitTurn(turn: CanonicalTurn): void {
    const index = this.currentTurns.findIndex(current => current.seq === turn.seq && current.sessionKey === turn.sessionKey);
    this.currentTurns = index < 0 ? [...this.currentTurns, turn]
      : this.currentTurns.map((current, currentIndex) => currentIndex === index ? turn : current);
    this.callbacks.get(turn.sessionKey)?.onNotice({ operation: 'turn', turn });
  }
}

function makeAdapter(transport: HostComposerTransport) {
  const base = createTightbeamAdapter(transport, profile);
  const runtimes: ChatRuntime[] = [];
  const adapter: TightbeamAdapter = {
    open: (sessionKey) => {
      const runtime = base.open(sessionKey);
      runtimes.push(runtime);
      return runtime;
    },
  };
  return { adapter, runtimes };
}

function installDeclaration(events: HostComposerEvent[], versions: number[] = [1], extra: Record<string, unknown> = {}): void {
  const page = window as unknown as Record<string, unknown>;
  const nativeHandler = { postMessage: (value: string) => events.push(JSON.parse(value) as HostComposerEvent) };
  page.webkit = { messageHandlers: { tunerChatHost: nativeHandler } };
  page[HOST_DECLARATION_NAME] = Object.freeze({
    ...extra,
    versions: Object.freeze([...versions]),
    onEvent: (event: HostComposerEvent) => nativeHandler.postMessage(JSON.stringify(event)),
  });
}

function commandEntry(): HostComposerCommandEntry {
  const entry = (window as unknown as Record<string, unknown>)[HOST_COMMAND_NAME];
  expect(typeof entry).toBe('function');
  return entry as HostComposerCommandEntry;
}

function readyEvent(events: readonly HostComposerEvent[], sessionKey: string) {
  return events.find((event): event is Extract<HostComposerEvent, { event: 'ready' }> =>
    event.event === 'ready' && event.sessionKey === sessionKey);
}

function connectionEvents(events: readonly HostComposerEvent[]) {
  return events.filter((event): event is Extract<HostComposerEvent, { event: 'connection' }> =>
    event.event === 'connection');
}

async function waitForReady(events: readonly HostComposerEvent[], sessionKey: string) {
  await waitFor(() => expect(readyEvent(events, sessionKey)).toBeDefined());
  return readyEvent(events, sessionKey)!;
}

function openChat(transport: HostComposerTransport, sessionKey: string) {
  const { adapter, runtimes } = makeAdapter(transport);
  const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapter} />);
  return { ...view, adapter, runtimes };
}

function installSubmitViewportLayout(viewport: HTMLElement) {
  const content = viewport.querySelector<HTMLElement>('.tb-chat-message-content')!;
  const rowHeight = 92;
  let scrollTop = 0;
  const anchorSpace = () => Number.parseFloat(viewport.style.getPropertyValue('--tb-chat-anchor-space')) || 0;
  const scrollHeight = () => 32 + content.children.length * rowHeight + anchorSpace();
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
    setScrollTop(value: number) { viewport.scrollTop = value; },
    restore() { bounds.mockRestore(); },
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.removeItem('tightbeam-chat.release-notes.seen-version');
  vi.mocked(unseenReleaseNotes).mockClear();
  const page = window as unknown as Record<string, unknown>;
  delete page[HOST_DECLARATION_NAME];
  delete page[HOST_COMMAND_NAME];
  delete page.webkit;
});

describe('versioned host composer seam on the real adapter and surface', () => {
  it('shows a background assistant reply delivered to the hosted transcript', async () => {
    const sessionKey = 'hosted-background-reply';
    const transport = new HostComposerTransport();
    const events: HostComposerEvent[] = [];
    transport.readSession = async () => ({
      sessionKey, rowVersion: 1, displayName: 'Agent', raw: { ownerUserId: 'person' },
    });
    installDeclaration(events);
    openChat(transport, sessionKey);
    await waitForReady(events, sessionKey);
    expect(screen.queryByRole('textbox')).toBeNull();
    const reply: CanonicalMessage = {
      kind: 'message', sessionKey, id: 'reply', seq: 2, rowVersion: 2, role: 'assistant',
      sender: 'tightbeam', messageType: 'assistant', turnSeq: 1, turnIncludesHuman: false,
      content: 'A reply from a background turn', raw: {},
    };
    act(() => {
      transport.emit(reply);
      transport.emit(reply);
    });
    const text = await screen.findByText(reply.content);
    expect(text.closest('article')?.getAttribute('data-record-key')).toBe(reply.id);
    expect(screen.getAllByText(reply.content)).toHaveLength(1);
  });

  it.each([false, true])('keeps first-received time and transcript order until Gateway time arrives (hosted: %s)', async hosted => {
    const sessionKey = 'receipt-time';
    const transport = new HostComposerTransport();
    const events: HostComposerEvent[] = [];
    const earlier: CanonicalMessage = { kind: 'message', sessionKey, id: 'earlier', seq: 1,
      rowVersion: 1, role: 'assistant', content: 'Earlier reply', raw: {}, createdAt: new Date(5_000).toISOString() };
    const missing: CanonicalMessage = { ...earlier, id: 'missing', seq: 2, content: 'Live reply', createdAt: undefined };
    transport.records.set(sessionKey, [earlier]);
    if (hosted) installDeclaration(events);
    openChat(transport, sessionKey);
    await screen.findByText('Earlier reply');
    if (hosted) {
      await waitForReady(events, sessionKey);
      expect(screen.queryByRole('textbox')).toBeNull();
    }
    const epoch = Date.now();
    const time = vi.spyOn(Date, 'now').mockReturnValue(epoch);
    try {
      act(() => transport.emit(missing));
      const bubble = () => screen.getByText('Live reply').closest('article')!;
      const order = () => [...screen.getByRole('log').querySelectorAll('article')].map(row => row.getAttribute('data-record-key'));
      const timestamp = () => bubble().querySelector('time')?.getAttribute('datetime');
      expect(timestamp()).toBe(new Date(epoch).toISOString());
      expect(order()).toEqual(['earlier', 'missing']);

      time.mockReturnValue(epoch + 60_000);
      act(() => transport.emit({ ...missing }));
      expect(timestamp()).toBe(new Date(epoch).toISOString());

      const realTime = new Date(4_000).toISOString();
      act(() => transport.emit({ ...missing, createdAt: realTime }));
      expect(timestamp()).toBe(realTime);
      expect(order()).toEqual(['earlier', 'missing']);

      act(() => transport.emit({ ...missing, rowVersion: 2 }));
      expect(timestamp()).toBe(realTime);
    } finally {
      time.mockRestore();
    }
  });

  it('suppresses automatic What’s New in hosted mode without delaying ready, connection, or transcript rendering', async () => {
    vi.mocked(unseenReleaseNotes).mockReturnValueOnce([
      { version: 'v0.1.103', items: [{ title: 'Recent update', description: 'A recent change.' }] },
    ]);
    const sessionKey = 'hosted-whats-new';
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    transport.records.set(sessionKey, [{ kind: 'message', sessionKey, id: 'history-1', seq: 1,
      rowVersion: 1, role: 'assistant', content: 'Transcript line from history', raw: {} }]);
    installDeclaration(events);

    openChat(transport, sessionKey);

    const ready = await waitForReady(events, sessionKey);
    await waitFor(() => expect(connectionEvents(events).some(event =>
      event.lifetimeId === ready.lifetimeId && event.state === 'connected')).toBe(true), { timeout: 2500 });
    expect(screen.getByText('Transcript line from history')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: "What's new" })).toBeNull();
    const readyIndex = events.findIndex(event => event.event === 'ready' && event.lifetimeId === ready.lifetimeId);
    const connectedIndex = events.findIndex(event => event.event === 'connection' &&
      event.lifetimeId === ready.lifetimeId && event.state === 'connected');
    expect(connectedIndex).toBeGreaterThan(readyIndex);
  });

  it('keeps automatic What’s New for the browser surface', async () => {
    vi.mocked(unseenReleaseNotes).mockReturnValueOnce([
      { version: 'v0.1.103', items: [{ title: 'Recent update', description: 'A recent change.' }] },
    ]);
    const transport = new HostComposerTransport();

    openChat(transport, 'browser-whats-new');

    expect(await screen.findByRole('dialog', { name: "What's new" })).toBeTruthy();
    expect(screen.getByText('Recent update')).toBeTruthy();
  });

  it('keeps the web composer until the snapshot is ready, without waiting for live updates', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    const readGate = deferred<void>();
    transport.readGate = readGate;
    transport.readyGate = deferred<void>();
    installDeclaration(events);
    openChat(transport, 'conversation-a');

    await screen.findByRole('textbox');
    expect(screen.queryByRole('button', { name: /Connection status/ })).toBeNull();
    expect(events.some((event) => event.event === 'ready')).toBe(false);
    const openCount = transport.changeOpenCount;
    const eventCount = events.length;
    act(() => commandEntry()({ type: 'reconnect', lifetimeId: 'not-ready', sessionKey: 'conversation-a' }));
    expect(transport.changeOpenCount).toBe(openCount);
    expect(events).toHaveLength(eventCount);
    await act(async () => { readGate.resolve(); });

    const ready = await waitForReady(events, 'conversation-a');
    expect(Object.keys(ready).sort()).toEqual([
      'agentDisplayName', 'capabilities', 'event', 'gatewayOrigin', 'lifetimeId', 'sessionKey', 'version',
    ].sort());
    expect(ready).toMatchObject({ version: 1, gatewayOrigin: 'https://gateway.example:8443',
      sessionKey: 'conversation-a', capabilities: { text: true, reconnect: true } });
    expect('attachments' in ready.capabilities).toBe(false);
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(screen.queryByRole('button', { name: /Connection status/ })).toBeNull();
    expect(document.querySelector('.tb-chat-host-composer-hidden .tb-chat-viewport')).not.toBeNull();
    expect(events.filter((event) => event.event === 'ready')).toHaveLength(1);
    expect(events.slice(-2).map((event) => event.event)).toEqual(['ready', 'connection']);
    expect(events.at(-1)).toMatchObject({ event: 'connection', state: 'reconnecting', lifetimeId: ready.lifetimeId });
    await act(async () => { transport.readyGate?.resolve(); });
    expect(events.filter((event) => event.event === 'ready')).toHaveLength(1);
    await waitFor(() => expect(connectionEvents(events).map((event) => event.state))
      .toEqual(['reconnecting', 'connected']), { timeout: 2500 });
  });

  it('leaves keyboard navigation to the host after native-composer opt-in', async () => {
    const events: HostComposerEvent[] = [];
    installDeclaration(events);
    openChat(new HostComposerTransport(), 'native-keyboard');
    await waitForReady(events, 'native-keyboard');
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());

    const transcript = screen.getByRole('log');
    expect(fireEvent.keyDown(transcript, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(transcript, { key: 'j', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(transcript, { key: 'u', ctrlKey: true })).toBe(true);
  });

  it('moves a native-composer submission from older history to its visible prompt', async () => {
    const events: HostComposerEvent[] = [];
    const sessionKey = 'native-prompt-submit';
    const transport = new HostComposerTransport();
    transport.records.set(sessionKey, Array.from({ length: 8 }, (_, index): CanonicalMessage => ({
      kind: 'message', id: `history-${index + 1}`, sessionKey, seq: index + 1, rowVersion: 1,
      role: 'user', sender: 'user:person', content: `Earlier message ${index + 1}`, raw: {},
    })));
    installDeclaration(events);
    const { runtimes } = openChat(transport, sessionKey);
    const ready = await waitForReady(events, sessionKey);
    await waitFor(() => expect(runtimes[0].getSnapshot().records).toHaveLength(8));

    const log = screen.getByRole('log');
    const layout = installSubmitViewportLayout(log);
    try {
      layout.setScrollTop(0);
      fireEvent.wheel(log, { deltaY: -100 });
      fireEvent.scroll(log);
      await screen.findByRole('button', { name: /^(?:\d+ unseen messages?|Scroll to bottom)$/ });
      fireEvent(log, new Event('scrollend'));

      act(() => commandEntry()({ type: 'send', lifetimeId: ready.lifetimeId,
        sessionKey: ready.sessionKey, correlationId: correlation, content: 'Native host prompt' }));
      await waitFor(() => expect(runtimes[0].getSnapshot().sends).toHaveLength(1));

      const prompt = screen.getByText('Native host prompt').closest('article')!;
      expect(prompt.classList.contains('tb-chat-bubble-human')).toBe(true);
      expect(layout.scrollTop).toBeGreaterThan(0);
      expect(layout.offset(prompt)).toBeGreaterThanOrEqual(0);
      expect(layout.offset(prompt)).toBeLessThan(180);
      expect(screen.queryByRole('button', { name: /^(?:\d+ unseen messages?|Scroll to bottom)$/ })).toBeNull();
      expect(runtimes[0].getSnapshot().sends[0]).toMatchObject({
        clientMessageId: correlation, content: 'Native host prompt', reconciled: false,
      });

      const reply: CanonicalMessage = {
        kind: 'message', id: 'reply-after-native-prompt', sessionKey, seq: 9, rowVersion: 1,
        role: 'assistant', sender: 'assistant-service', content: 'Reply after the native prompt', raw: {},
      };
      act(() => transport.emit(reply));
      await screen.findByText('Reply after the native prompt');
      await waitFor(() => expect(layout.scrollTop).toBe(log.scrollHeight - log.clientHeight), { timeout: 1500 });
    } finally {
      layout.restore();
    }
  });

  it('keeps the standalone composer and status control for absent or unsupported opt-in', async () => {
    const transport = new HostComposerTransport();
    openChat(transport, 'standalone');
    await screen.findByRole('textbox', { name: /Message to Agent standalone/ });
    expect(screen.getByRole('button', { name: /Connection status/ })).toBeTruthy();
    expect((window as unknown as Record<string, unknown>)[HOST_COMMAND_NAME]).toBeUndefined();

    cleanup();
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [2]);
    openChat(transport, 'unsupported-host');
    await waitFor(() => expect(events).toContainEqual({ event: 'declined', reason: 'unsupported-version' }));
    await screen.findByRole('textbox', { name: /Message to Agent unsupported-host/ });
    expect(screen.getByRole('button', { name: /Connection status/ })).toBeTruthy();
    expect((window as unknown as Record<string, unknown>)[HOST_COMMAND_NAME]).toBeUndefined();
  });

  it('declines a malformed declaration and retains the standalone composer', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    (window as unknown as Record<string, unknown>)[HOST_DECLARATION_NAME] = {
      versions: '1', onEvent: (event: HostComposerEvent) => events.push(event),
    };
    openChat(transport, 'malformed-host');

    await waitFor(() => expect(events).toContainEqual({ event: 'declined', reason: 'malformed-declaration' }));
    await screen.findByRole('textbox', { name: /Message to Agent malformed-host/ });
    expect(screen.getByRole('button', { name: /Connection status/ })).toBeTruthy();
    expect((window as unknown as Record<string, unknown>)[HOST_COMMAND_NAME]).toBeUndefined();
  });

  it('posts the host correlation through the authenticated send path and reports canonical delivery', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    transport.nextSend = async (submission) => {
      transport.addCanonical(submission);
      return { outcome: 'accepted' };
    };
    installDeclaration(events);
    openChat(transport, 'conversation-a');
    const ready = await waitForReady(events, 'conversation-a');

    act(() => commandEntry()({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: correlation, content: 'Hello from the host' }));
    await waitFor(() => expect(events.some((event) => event.event === 'delivered' && event.correlationId === correlation)).toBe(true));

    expect(transport.submissions).toHaveLength(1);
    expect(transport.submissions[0]).toMatchObject({ sessionKey: 'conversation-a',
      deviceId: identity.deviceId, clientMessageId: correlation, content: 'Hello from the host' });
    expect(events.filter((event) => ['accepted', 'delivered'].includes(event.event)).map((event) => event.event))
      .toEqual(['accepted', 'delivered']);
    act(() => commandEntry()({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: correlation, content: 'Hello from the host', retry: true }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'already-delivered' });
    expect(transport.submissions).toHaveLength(1);
  });

  it('marks an accepted host send, but not a rejected local command or a reply by itself', async () => {
    const events: HostComposerEvent[] = [];
    const sessionKey = 'agent:sample assistant with space';
    const acceptedCorrelation = 'c_223e4567-e89b-42d3-a456-426614174001';
    const transport = new HostComposerTransport();
    transport.currentIdentity = () => ({ principalKey: 'configured-operator', deviceId: 'device-1' });
    transport.readMarkerOperatorPrincipalKey = 'configured-operator';
    const initial: CanonicalMessage = { kind: 'message', id: 'initial', sessionKey, seq: 7, rowVersion: 1,
      role: 'assistant', sender: 'assistant-service', content: 'Initial reply', raw: {} };
    transport.records.set(sessionKey, [initial]);
    let marker: string | number | null = null;
    const read = vi.fn(async () => ({ supported: true as const, marker }));
    const write = vi.fn(async (request: { sequence: string }) => {
      marker = request.sequence;
      return 'written' as const;
    });
    transport.readReadMarker = read;
    transport.writeReadMarker = write;
    transport.nextSend = async () => ({ outcome: 'refused', reason: 'The Gateway refused the send.' });
    installDeclaration(events);
    const { runtimes } = openChat(transport, sessionKey);
    const ready = await waitForReady(events, sessionKey);
    await waitFor(() => expect(marker).toBe('7'));
    read.mockClear();
    write.mockClear();

    const reply: CanonicalMessage = { kind: 'message', id: 'reply', sessionKey, seq: 8, rowVersion: 1,
      role: 'assistant', sender: 'assistant-service', content: 'A newer reply', raw: {} };
    transport.records.get(sessionKey)!.push(reply);
    act(() => transport.emit(reply));
    await waitFor(() => expect(runtimes[0].getSnapshot().records.some((record) => record.id === reply.id)).toBe(true));
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    act(() => commandEntry()({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: correlation, content: ' /settings ' }));
    expect(events).toContainEqual(expect.objectContaining({ event: 'rejected', reason: 'local-command' }));
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    act(() => commandEntry()({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: acceptedCorrelation, content: 'A regular host message' }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(events.some((event) => event.event === 'failed' &&
      event.correlationId === acceptedCorrelation)).toBe(true));
    expect(events.some((event) => event.event === 'rejected' && event.correlationId === acceptedCorrelation)).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith({ userId: 'configured-operator',
      scopeKey: `${sessionKey}:session-read-position`, sequence: '8', expectedCurrent: '7' },
    expect.any(AbortSignal));
  });

  it('keeps an acknowledged host send free of a warning while canonical history catches up', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    installDeclaration(events);
    const { runtimes } = openChat(transport, 'conversation-a');
    const ready = await waitForReady(events, 'conversation-a');
    act(() => commandEntry()({ type: 'send', lifetimeId: ready.lifetimeId,
      sessionKey: ready.sessionKey, correlationId: correlation, content: 'acknowledged message' }));

    await waitFor(() => expect(events.some((event) => event.event === 'accepted' &&
      event.correlationId === correlation)).toBe(true));
    expect(events.some((event) => event.event === 'uncertain' && event.correlationId === correlation)).toBe(false);
    expect(events.some((event) => event.event === 'delivered' && event.correlationId === correlation)).toBe(false);

    const canonical = transport.addCanonical(transport.submissions[0]);
    act(() => transport.callbacks.get('conversation-a')?.onNotice({ operation: 'upsert', record: canonical }));
    await waitFor(() => expect(events.some((event) => event.event === 'delivered' &&
      event.correlationId === correlation)).toBe(true));
    expect(runtimes[0].getSnapshot().sends[0]).toMatchObject({ status: 'accepted', reconciled: true });
  });

  it('keeps bridge snapshots constant-size after many settled sends and still rejects delivered correlations', async () => {
    const events: HostComposerEvent[] = [];
    const delivered = new Set<string>();
    (window as unknown as Record<string, unknown>)[HOST_DECLARATION_NAME] = {
      versions: [1],
      onEvent: (event: HostComposerEvent) => {
        events.push(event);
        if (event.event === 'delivered') delivered.add(event.correlationId);
      },
    };
    const transport = new HostComposerTransport();
    transport.nextSend = async (submission) => {
      transport.addCanonical(submission);
      return { outcome: 'accepted' };
    };
    const runtime = createTightbeamAdapter(transport, profile).open('conversation-a');
    const bridge = HostComposerBridge.create(window);
    expect(bridge).not.toBeNull();
    if (!bridge) {
      runtime.dispose();
      throw new Error('The test declaration should create a host bridge.');
    }
    bridge.attach(runtime);

    try {
      const ready = await waitForReady(events, 'conversation-a');
      const snapshotKeys = ['composerHidden', 'optedIn', 'ready', 'restoreRequested', 'settingsRequestRevision'];
      expect(Object.keys(bridge.getSnapshot()).sort()).toEqual(snapshotKeys);
      const ids: string[] = [];
      for (let index = 0; index < 64; index++) {
        const id = `c_00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
        ids.push(id);
        commandEntry()({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
          correlationId: id, content: `Host message ${index}` });
        await waitFor(() => expect(delivered.has(id)).toBe(true));
        expect(Object.keys(bridge.getSnapshot()).sort()).toEqual(snapshotKeys);
      }

      expect(runtime.getSnapshot().sends).toHaveLength(ids.length);
      expect(runtime.getSnapshot().sends.every((send) => send.hostSend?.attempt === 1)).toBe(true);
      commandEntry()({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
        correlationId: ids[0], content: 'Host message 0', retry: true });
      expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'already-delivered' });
      expect(transport.submissions).toHaveLength(ids.length);
    } finally {
      bridge.dispose();
      runtime.dispose();
    }
  });

  it('restores readiness after a per-message refusal without a runtime rebuild', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    transport.nextSend = async (submission) => submission.content === 'refuse'
      ? { outcome: 'refused', reason: 'client_message_id_conflict' }
      : submission.content === 'uncertain'
        ? { outcome: 'uncertain', reason: 'ack timed out' }
        : { outcome: 'accepted' };
    installDeclaration(events);
    openChat(transport, 'conversation-a');
    const ready = await waitForReady(events, 'conversation-a');
    const send = (id: string, content: string) => act(() => commandEntry()({ type: 'send',
      lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey, correlationId: id, content }));

    const second = 'c_223e4567-e89b-42d3-a456-426614174000';
    send(second, 'uncertain');
    await waitFor(() => expect(events.some((event) => event.event === 'uncertain' && event.correlationId === second)).toBe(true));
    expect(events.find((event) => event.event === 'uncertain' && event.correlationId === second))
      .toMatchObject({ reason: 'ack-lost', attempt: 1 });
    send(correlation, 'refuse');
    await waitFor(() => expect(events.some((event) => event.event === 'failed' && event.reason === 'refused')).toBe(true));
    expect(events.find((event) => event.event === 'failed')).toMatchObject({ detail: 'client_message_id_conflict', attempt: 1 });
    expect(events.find((event) => event.event === 'unavailable')).toMatchObject({
      event: 'unavailable', reason: 'send-refused', lifetimeId: ready.lifetimeId,
    });
    expect(screen.getByRole('alert').textContent).toContain('Your message was not sent.');
    expect(screen.getByRole('alert').textContent).toContain('client_message_id_conflict');
    expect(screen.queryByText('Delivery is uncertain')).toBeNull();
    expect(screen.getByText('refuse').closest('[data-send-state]')?.getAttribute('data-send-state')).toBe('refused');
    const uncertain = screen.getByText('uncertain').closest('[data-send-state]');
    expect(uncertain?.getAttribute('data-send-state')).toBe('uncertain');
    expect(uncertain?.getAttribute('aria-label'))
      .toBe("We couldn't confirm whether this message was sent. Check the conversation before trying again.");
    expect(uncertain?.querySelector('.tb-chat-send-uncertainty')?.textContent)
      .toBe("We couldn't confirm whether this message was sent. Check the conversation before trying again.");
    expect(screen.queryByText(/Message could not be sent|Delivery could not be confirmed|This message was refused/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore text to the composer' })).toBeNull();
    expect(transport.submissions).toHaveLength(2);

    await waitFor(() => expect(events.filter((event) => event.event === 'ready' &&
      event.lifetimeId === ready.lifetimeId)).toHaveLength(2));
    const unavailableIndex = events.findIndex((event) => event.event === 'unavailable' &&
      event.lifetimeId === ready.lifetimeId);
    const recoveredReadyIndex = events.findIndex((event, index) => index > unavailableIndex &&
      event.event === 'ready' && event.lifetimeId === ready.lifetimeId);
    expect(unavailableIndex).toBeGreaterThan(-1);
    expect(recoveredReadyIndex).toBeGreaterThan(unavailableIndex);

    const recoveredCorrelation = 'c_423e4567-e89b-42d3-a456-426614174000';
    send(recoveredCorrelation, 'sending works again');
    await waitFor(() => expect(events.some((event) => event.event === 'accepted' &&
      event.correlationId === recoveredCorrelation)).toBe(true));
    expect(transport.submissions).toHaveLength(3);
  });

  it('allows same-correlation user retry after uncertainty and reconciles before another post', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    transport.nextSend = async (submission) => {
      if (transport.submissions.length === 1) return { outcome: 'uncertain', reason: 'ack timed out' };
      transport.addCanonical(submission);
      return { outcome: 'accepted' };
    };
    installDeclaration(events);
    openChat(transport, 'conversation-a');
    const ready = await waitForReady(events, 'conversation-a');
    const send = (retry?: boolean, content = 'Try once more') => act(() => commandEntry()({ type: 'send',
      lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey, correlationId: correlation, content,
      ...(retry ? { retry: true } : {}) }));

    send();
    await waitFor(() => expect(events.some((event) => event.event === 'uncertain' && event.correlationId === correlation)).toBe(true));
    send(true, 'edited text');
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'correlation-conflict' });
    expect(transport.submissions).toHaveLength(1);
    send(true);
    await waitFor(() => expect(events.filter((event) => event.event === 'delivered' && event.correlationId === correlation)).toHaveLength(1));
    expect(transport.submissions).toHaveLength(2);
    expect(transport.submissions.map((submission) => submission.clientMessageId)).toEqual([correlation, correlation]);
    expect(events.filter((event) => event.event === 'accepted' && event.correlationId === correlation))
      .toMatchObject([{ attempt: 2 }]);
  });

  it('reconciles a canonical row that arrived after uncertainty before retrying', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    transport.nextSend = async () => ({ outcome: 'uncertain', reason: 'ack timed out' });
    installDeclaration(events);
    const { runtimes } = openChat(transport, 'conversation-a');
    const ready = await waitForReady(events, 'conversation-a');
    const send = (retry = false) => act(() => commandEntry()({ type: 'send',
      lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey, correlationId: correlation,
      content: 'Already delivered later', ...(retry ? { retry: true } : {}) }));

    send();
    await waitFor(() => expect(events.some((event) => event.event === 'uncertain' && event.correlationId === correlation)).toBe(true));
    const canonical = transport.addCanonical(transport.submissions[0]);
    act(() => transport.callbacks.get('conversation-a')?.onNotice({ operation: 'upsert', record: canonical }));
    await waitFor(() => expect(runtimes[0].getSnapshot().sends[0]).toMatchObject({ reconciled: true }));

    send(true);
    await waitFor(() => expect(events.some((event) => event.event === 'delivered' &&
      event.correlationId === correlation && event.attempt === 2)).toBe(true));
    expect(transport.submissions).toHaveLength(1);
  });

  it('rejects not-ready, target-mismatched, pending-duplicate and post-success commands without changing attempts', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    const gate = deferred<void>();
    transport.readGate = gate;
    const pending = deferred<HumanSendResult>();
    transport.nextSend = () => pending.promise;
    installDeclaration(events);
    const { adapter, rerender } = openChat(transport, 'conversation-a');
    await screen.findByRole('textbox');
    const command = commandEntry();
    act(() => command({ type: 'send', lifetimeId: 'before-ready', sessionKey: 'conversation-a',
      correlationId: correlation, content: 'pending' }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'not-ready' });
    const notReadyIndex = events.findIndex((event) => event.event === 'rejected' && event.reason === 'not-ready');
    expect(screen.queryByRole('button', { name: /Connection status/ })).toBeNull();
    await act(async () => { gate.resolve(); });
    const ready = await waitForReady(events, 'conversation-a');
    const recoveredReadyIndex = events.findIndex((event) => event.event === 'ready' && event.lifetimeId === ready.lifetimeId);
    expect(notReadyIndex).toBeGreaterThanOrEqual(0);
    expect(recoveredReadyIndex).toBeGreaterThan(notReadyIndex);
    act(() => command({ type: 'send', lifetimeId: 'old-lifetime', sessionKey: 'conversation-a',
      correlationId: correlation, content: 'pending' }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'target-mismatch' });

    act(() => command({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: correlation, content: 'pending' }));
    const postCount = transport.submissions.length;
    act(() => command({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: correlation, content: 'pending', retry: true }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'attempt-in-flight' });
    expect(transport.submissions).toHaveLength(postCount);

    transport.addCanonical(transport.submissions[0]);
    await act(async () => { pending.resolve({ outcome: 'accepted' }); });
    await waitFor(() => expect(events.some((event) => event.event === 'delivered')).toBe(true));
    act(() => command({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: correlation, content: 'pending', retry: true }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'already-delivered' });
    expect(transport.submissions).toHaveLength(postCount);
    rerender(<TightbeamChat sessionKey="conversation-a" adapter={adapter} />);
  });

  it('reports invalid correlation and empty content in the specified validation order', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    installDeclaration(events);
    openChat(transport, 'conversation-a');
    const ready = await waitForReady(events, 'conversation-a');
    const command = commandEntry();

    act(() => command({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: 'invalid', content: '   ' }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'invalid-correlation' });
    act(() => command({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: correlation, content: ' \n ' }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'empty' });
    expect(transport.submissions).toHaveLength(0);
  });

  it('handles a local Settings command before readiness and announces overlay focus after ready', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    const gate = deferred<void>();
    transport.readGate = gate;
    installDeclaration(events);
    const { runtimes } = openChat(transport, 'local-settings');
    await screen.findByRole('textbox');
    const command = commandEntry();

    act(() => command({ type: 'send', lifetimeId: 'before-ready', sessionKey: 'local-settings',
      correlationId: correlation, content: ' \n/settings\t' }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', lifetimeId: 'before-ready',
      correlationId: correlation, reason: 'local-command' });
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(runtimes[0].getSnapshot().sends).toEqual([]);
    expect(transport.submissions).toHaveLength(0);

    await act(async () => { gate.resolve(); });
    const ready = await waitForReady(events, 'local-settings');
    await waitFor(() => expect(events.some((event) => event.event === 'overlay' &&
      event.lifetimeId === ready.lifetimeId && event.open)).toBe(true));
    const readyIndex = events.findIndex((event) => event.event === 'ready' && event.lifetimeId === ready.lifetimeId);
    const connectionIndex = events.findIndex((event) => event.event === 'connection' && event.lifetimeId === ready.lifetimeId);
    const overlayOpenIndex = events.findIndex((event) => event.event === 'overlay' && event.lifetimeId === ready.lifetimeId && event.open);
    expect(connectionIndex).toBe(readyIndex + 1);
    expect(overlayOpenIndex).toBe(connectionIndex + 1);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(events.some((event) => event.event === 'overlay' &&
      event.lifetimeId === ready.lifetimeId && !event.open)).toBe(true));
    act(() => command({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: correlation, content: '/compact' }));
    await waitFor(() => expect(transport.submissions).toHaveLength(1));
    expect(transport.submissions[0]).toMatchObject({ clientMessageId: correlation, content: '/compact' });
    expect(events.some((event) => event.event === 'rejected' && event.correlationId === correlation &&
      event.reason === 'correlation-conflict')).toBe(false);
  });

  it('ends the old lifetime before announcing a newly selected session', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    const pending = deferred<HumanSendResult>();
    transport.nextSend = () => pending.promise;
    installDeclaration(events);
    const { adapter, rerender } = openChat(transport, 'session-a');
    const first = await waitForReady(events, 'session-a');
    act(() => commandEntry()({ type: 'send', lifetimeId: first.lifetimeId, sessionKey: first.sessionKey,
      correlationId: correlation, content: 'only for A' }));

    rerender(<TightbeamChat sessionKey="session-b" adapter={adapter} />);
    const second = await waitForReady(events, 'session-b');
    const uncertainIndex = events.findIndex((event) => event.event === 'uncertain' && event.reason === 'lifetime-ended');
    const endedIndex = events.findIndex((event) => event.event === 'lifetime-ended' && event.lifetimeId === first.lifetimeId);
    const nextReadyIndex = events.findIndex((event) => event.event === 'ready' && event.sessionKey === 'session-b');
    expect(uncertainIndex).toBeGreaterThanOrEqual(0);
    expect(uncertainIndex).toBeLessThan(endedIndex);
    expect(endedIndex).toBeLessThan(nextReadyIndex);
    expect(second.lifetimeId).not.toBe(first.lifetimeId);
    expect(transport.submissions).toHaveLength(1);
    expect(transport.submissions[0].sessionKey).toBe('session-a');
  });

  it.each([500, 502])('recovers a down-at-load snapshot after HTTP %i with a neutral notice and one host lifetime', async (status) => {
    const events: HostComposerEvent[] = [];
    const sessionKey = 'gateway-down-at-load';
    const transport = new HostComposerTransport();
    transport.records.set(sessionKey, [{ kind: 'message', id: 'recovered-on-start', sessionKey, seq: 1,
      rowVersion: 1, role: 'assistant', content: 'Transcript loaded after Gateway recovery.', raw: {} }]);
    transport.tailReadFailures = 1;
    transport.tailReadFailureStatus = status;
    transport.tailRecoveryGate = deferred<void>();
    installDeclaration(events);
    const { runtimes, unmount } = openChat(transport, sessionKey);
    const runtime = runtimes[0];

    try {
      const ready = await waitForReady(events, sessionKey);
      await waitFor(() => expect(runtime.getSnapshot().conversationError).toContain(`HTTP ${status}`));
      await waitFor(() => expect(transport.tailReadCount).toBe(2));
      // A second route to recovery cannot overlap the scheduled history read.
      const duplicateRebuild = runtime.rebuild();
      expect(transport.tailReadCount).toBe(2);
      await waitFor(() => expect(connectionEvents(events).some((event) => event.lifetimeId === ready.lifetimeId &&
        event.state === 'reconnecting')).toBe(true));

      const notice = screen.getByRole('status');
      expect(notice.textContent).toContain('Reconnecting…');
      expect(notice.classList.contains('tb-chat-caption-neutral')).toBe(true);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(/HTTP 5\d\d/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();

      transport.tailRecoveryGate.resolve();
      await duplicateRebuild;
      await waitFor(() => expect(runtime.getSnapshot().conversationError).toBeUndefined());
      expect(await screen.findByText('Transcript loaded after Gateway recovery.')).toBeTruthy();
      expect(events.filter((event) => event.event === 'ready' && event.lifetimeId === ready.lifetimeId)).toHaveLength(1);
      expect(events.some((event) => event.event === 'unavailable' && event.lifetimeId === ready.lifetimeId)).toBe(false);
      expect(events.some((event) => event.event === 'lifetime-ended' && event.lifetimeId === ready.lifetimeId)).toBe(false);
    } finally {
      transport.tailRecoveryGate.resolve();
      unmount();
    }
  });

  it('keeps the host composer ready and reports reconnecting through feed debounce, sustained failure, and recovery', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    transport.nextSend = async (submission) => {
      transport.addCanonical(submission);
      return { outcome: 'accepted' };
    };
    installDeclaration(events);
    const { runtimes } = openChat(transport, 'conversation-a');
    const first = await waitForReady(events, 'conversation-a');
    await waitFor(() => expect(connectionEvents(events).some((event) => event.state === 'connected' &&
      event.lifetimeId === first.lifetimeId)).toBe(true), { timeout: 2000 });
    const connectionEventCountBeforeDrop = connectionEvents(events).length;

    transport.changeOpenFailures = 8;
    act(() => transport.callbacks.get('conversation-a')?.onDoubt('connection closed'));
    expect(connectionEvents(events).slice(connectionEventCountBeforeDrop).some((event) => event.state === 'disconnected'))
      .toBe(false);
    await waitFor(() => expect(connectionEvents(events).slice(connectionEventCountBeforeDrop).some((event) =>
      event.state === 'reconnecting' && event.lifetimeId === first.lifetimeId)).toBe(true), { timeout: 2000 });

    // Past the point where an outage used to turn red: Chat is still retrying,
    // so the host keeps hearing 'reconnecting' and never 'disconnected'.
    const openedBeforeWait = transport.changeOpenCount;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 11_000)); });
    expect(transport.changeOpenCount).toBeGreaterThan(openedBeforeWait);
    expect(connectionEvents(events).slice(connectionEventCountBeforeDrop).map((event) => event.state))
      .toEqual(['reconnecting']);
    expect(runtimes[0].getSnapshot().liveConnectionState).toBe('reconnecting');
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(events.filter((event) => event.event === 'ready' && event.lifetimeId === first.lifetimeId)).toHaveLength(1);
    expect(events.some((event) => event.event === 'unavailable' && event.lifetimeId === first.lifetimeId)).toBe(false);
    act(() => commandEntry()({ type: 'send', lifetimeId: first.lifetimeId, sessionKey: first.sessionKey,
      correlationId: correlation, content: 'send while live updates reconnect' }));
    await waitFor(() => expect(transport.submissions).toHaveLength(1));
    await waitFor(() => expect(events.some((event) => event.event === 'delivered' &&
      event.lifetimeId === first.lifetimeId && event.correlationId === correlation)).toBe(true));
    await within(screen.getByRole('log')).findByText('send while live updates reconnect');
    expect(events.some((event) => event.event === 'unavailable' && event.lifetimeId === first.lifetimeId)).toBe(false);
    expect(runtimes[0].getSnapshot().status).toBe('ready');
    transport.changeOpenFailures = 0;
    act(() => commandEntry()({ type: 'reconnect', lifetimeId: first.lifetimeId, sessionKey: first.sessionKey }));
    await waitFor(() => expect(transport.changeOpenCount).toBeGreaterThan(1));
    await waitFor(() => expect(runtimes[0].getSnapshot().liveError).toBeUndefined());
    await waitFor(() => expect(events.some((event) => event.event === 'connection' && event.state === 'connected' &&
      event.lifetimeId === first.lifetimeId)).toBe(true), { timeout: 3000 });

    const reply: CanonicalMessage = { kind: 'message', id: 'live-agent-reply', sessionKey: 'conversation-a',
      seq: 2, rowVersion: 1, role: 'assistant', sender: 'assistant-service', messageType: 'assistant',
      content: 'The reply arrived without reloading.', raw: {} };
    transport.records.set(reply.sessionKey, [...(transport.records.get(reply.sessionKey) ?? []), reply]);
    act(() => transport.emit(reply));
    await screen.findByText(reply.content);
    expect(events.filter((event) => event.event === 'ready')).toHaveLength(1);
    expect(readyEvent(events, 'conversation-a')?.lifetimeId).toBe(first.lifetimeId);
  }, 20_000);

  it('reconnects the live feed in place and preserves the newest view and an older reading anchor', async () => {
    const events: HostComposerEvent[] = [];
    const sessionKey = 'reconnect-in-place';
    const transport = new HostComposerTransport();
    const history = Array.from({ length: 8 }, (_, index): CanonicalMessage => ({
      kind: 'message', id: `history-${index + 1}`, sessionKey, seq: index + 1, rowVersion: 1,
      role: 'user', sender: 'user:person', messageType: 'chat', content: `Earlier message ${index + 1}`, raw: {},
    }));
    transport.records.set(sessionKey, history);
    installDeclaration(events);
    const { runtimes } = openChat(transport, sessionKey);
    const ready = await waitForReady(events, sessionKey);
    const viewport = screen.getByRole('log');
    const layout = installSubmitViewportLayout(viewport);
    const reconnect = async () => {
      const openedBefore = transport.changeOpenCount;
      act(() => {
        transport.callbacks.get(sessionKey)?.onDoubt('live feed dropped');
        commandEntry()({ type: 'reconnect', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey });
      });
      expect(transport.changeOpenCount).toBe(openedBefore + 1);
      await waitFor(() => expect(runtimes[0].getSnapshot().liveError).toBeUndefined());
      await waitFor(() => expect(runtimes[0].getSnapshot().liveConnectionState).toBe('connected'),
        { timeout: 2500 });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(transport.changeOpenCount).toBe(openedBefore + 1);
    };

    try {
      await waitFor(() => expect(connectionEvents(events).map((event) => event.state))
        .toEqual(['reconnecting', 'connected']),
        { timeout: 2500 });
      const openCount = transport.changeOpenCount;
      const eventCount = events.length;
      act(() => {
        commandEntry()({ type: 'reconnect', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey });
        commandEntry()({ type: 'reconnect', lifetimeId: 'old-lifetime', sessionKey: ready.sessionKey });
        commandEntry()({ type: 'reconnect', lifetimeId: ready.lifetimeId, sessionKey: 'other-session' });
      });
      expect(transport.changeOpenCount).toBe(openCount);
      expect(events).toHaveLength(eventCount);

      layout.setScrollTop(viewport.scrollHeight - viewport.clientHeight);
      fireEvent.scroll(viewport);
      const newest = within(viewport).getByText('Earlier message 8').closest('article')!;
      const newestBefore = layout.offset(newest);
      expect(newestBefore).toBeGreaterThanOrEqual(0);
      expect(newestBefore + 80).toBeLessThanOrEqual(viewport.clientHeight);
      await reconnect();
      expect(Math.abs(layout.offset(newest) - newestBefore)).toBeLessThanOrEqual(1);

      fireEvent.wheel(viewport, { deltaY: -100 });
      layout.setScrollTop(220);
      fireEvent.scroll(viewport);
      const anchor = screen.getByText('Earlier message 4').closest('article')!;
      const anchorBefore = layout.offset(anchor);
      expect(anchorBefore).toBeGreaterThanOrEqual(0);
      expect(anchorBefore).toBeLessThan(viewport.clientHeight);
      await reconnect();

      expect(Math.abs(layout.offset(anchor) - anchorBefore)).toBeLessThanOrEqual(1);
      for (const record of history) expect(within(viewport).getByText(record.content)).toBeTruthy();
      expect(runtimes[0].getSnapshot().records.map((record) => record.id)).toEqual(history.map((record) => record.id));
      expect(events.filter((event) => event.event === 'ready' && event.lifetimeId === ready.lifetimeId)).toHaveLength(1);
      expect(events.some((event) => event.event === 'unavailable' && event.lifetimeId === ready.lifetimeId)).toBe(false);
      expect(events.some((event) => event.event === 'lifetime-ended' && event.lifetimeId === ready.lifetimeId)).toBe(false);
      expect(runtimes[0].getSnapshot().liveConnectionState).toBe('connected');
    } finally {
      layout.restore();
    }
  });

  it('keeps host connection status aligned with the connected dot during a short feed blip', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    installDeclaration(events);
    const { runtimes, unmount } = openChat(transport, 'conversation-a');
    const ready = await waitForReady(events, 'conversation-a');
    await waitFor(() => expect(connectionEvents(events).some((event) =>
      event.state === 'connected' && event.lifetimeId === ready.lifetimeId)).toBe(true), { timeout: 2500 });

    const initialConnectionEvents = connectionEvents(events).map((event) => event.state);
    act(() => transport.callbacks.get('conversation-a')?.onDoubt('brief feed gap'));
    expect(runtimes[0].getSnapshot().liveConnectionState).toBe('connected');
    expect(connectionEvents(events).map((event) => event.state)).toEqual(initialConnectionEvents);

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    await waitFor(() => expect(runtimes[0].getSnapshot().liveError).toBeUndefined(), { timeout: 1500 });
    expect(runtimes[0].getSnapshot().liveConnectionState).toBe('connected');
    expect(connectionEvents(events).map((event) => event.state)).toEqual(initialConnectionEvents);
    unmount();
  });

  it('keeps the built-in composer live through reconnect and renders the human and agent rows without reload', async () => {
    const transport = new HostComposerTransport();
    transport.nextSend = async (submission) => {
      transport.addCanonical(submission);
      return { outcome: 'accepted' };
    };
    const { runtimes } = openChat(transport, 'conversation-a');
    await screen.findByRole('textbox', { name: /Message to Agent conversation-a/ });
    await waitFor(() => expect(runtimes[0].getSnapshot().status).toBe('ready'));

    act(() => transport.callbacks.get('conversation-a')?.onDoubt('Firehose closed with code 4008'));
    const textbox = screen.getByRole('textbox', { name: /Message to Agent conversation-a/ });
    fireEvent.change(textbox, { target: { value: 'Send while live updates reconnect' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(transport.submissions).toHaveLength(1));
    await within(screen.getByRole('log')).findByText('Send while live updates reconnect');
    await waitFor(() => expect(runtimes[0].getSnapshot().sends[0]?.status).toBe('accepted'));
    expect(runtimes[0].getSnapshot().status).toBe('ready');
    await waitFor(() => expect(transport.changeOpenCount).toBeGreaterThan(1));
    await waitFor(() => expect(runtimes[0].getSnapshot().liveError).toBeUndefined());

    const reply: CanonicalMessage = { kind: 'message', id: 'no-reload-reply', sessionKey: 'conversation-a',
      seq: 2, rowVersion: 1, role: 'assistant', sender: 'assistant-service', messageType: 'assistant',
      content: 'This reply also arrived live.', raw: {} };
    transport.records.set(reply.sessionKey, [...(transport.records.get(reply.sessionKey) ?? []), reply]);
    act(() => transport.emit(reply));
    await screen.findByText(reply.content);
    expect(runtimes).toHaveLength(1);
  });

  it('shows only delivered turn state on open and after reconnect, then clears it at completion', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    const active: CanonicalTurn = { seq: 7, sessionKey: 'conversation-a', status: 'running',
      messageId: 'human-trigger', origin: 'user:person', triggerSource: 'human', raw: { rowVersion: 1 } };
    const human: CanonicalMessage = { kind: 'message', id: 'human-trigger', sessionKey: 'conversation-a',
      seq: 1, rowVersion: 1, role: 'user', sender: 'user:person', content: 'Can you help?', turnSeq: 7, raw: {} };
    transport.records.set('conversation-a', [human]);
    installDeclaration(events);
    const { runtimes } = openChat(transport, 'conversation-a');
    await waitForReady(events, 'conversation-a');
    expect(screen.queryByRole('status', { name: 'Active turn: Replying to you' })).toBeNull();
    act(() => transport.emitTurn(active));
    await screen.findByRole('status', { name: 'Active turn: Replying to you' });
    const runtime = runtimes[0];

    act(() => transport.callbacks.get('conversation-a')?.onDoubt('live connection closed'));
    expect(screen.queryByRole('status', { name: 'Active turn: Replying to you' })).toBeNull();
    await waitFor(() => expect(transport.changeOpenCount).toBeGreaterThan(1));
    await waitFor(() => expect(runtime.getSnapshot().liveError).toBeUndefined());
    expect(screen.getByRole('status', { name: 'Active turn: Replying to you' })).toBeTruthy();

    act(() => transport.emitTurn({ ...active, status: 'completed', raw: { rowVersion: 2 } }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Active turn: Replying to you' })).toBeNull());
    expect(events.filter((event) => event.event === 'ready')).toHaveLength(1);
    runtime.dispose();
  });

  it('clears a completed turn after reconnect and restores a turn when reopening mid-run', async () => {
    const transport = new HostComposerTransport();
    const active: CanonicalTurn = { seq: 7, sessionKey: 'conversation-a', status: 'running',
      messageId: 'human-trigger', origin: 'user:person', triggerSource: 'human', raw: { rowVersion: 1 } };
    const human: CanonicalMessage = { kind: 'message', id: 'human-trigger', sessionKey: 'conversation-a',
      seq: 1, rowVersion: 1, role: 'user', sender: 'user:person', content: 'Can you help?', turnSeq: 7, raw: {} };
    transport.emitTurn(active);
    transport.records.set('conversation-a', [human]);

    const firstView = openChat(transport, 'conversation-a');
    await screen.findByRole('status', { name: 'Active turn: Replying to you' });
    const runtime = firstView.runtimes[0];
    act(() => transport.callbacks.get('conversation-a')?.onDoubt('live connection closed'));
    expect(screen.queryByRole('status', { name: 'Active turn: Replying to you' })).toBeNull();

    transport.emitTurn({ ...active, status: 'completed', raw: { rowVersion: 2 } });
    await waitFor(() => expect(transport.changeOpenCount).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Active turn: Replying to you' })).toBeNull());
    expect(runtime.getSnapshot().status).toBe('ready');
    firstView.unmount();

    transport.emitTurn({ ...active, seq: 8, messageId: 'human-trigger-next', raw: { rowVersion: 1 } });
    transport.records.set('conversation-a', [...(transport.records.get('conversation-a') ?? []), {
      kind: 'message', id: 'human-trigger-next', sessionKey: 'conversation-a', seq: 2, rowVersion: 1,
      role: 'user', sender: 'user:person', content: 'A second question while reopening.', turnSeq: 8, raw: {},
    }]);
    const secondView = openChat(transport, 'conversation-a');
    await screen.findByRole('status', { name: 'Active turn: Replying to you' });
    expect(secondView.runtimes[0].getSnapshot().activeTurn?.turn.seq).toBe(8);
    secondView.unmount();
  });

  it('ends and re-handshakes its page lifetime after a cached page hide/show', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    const pending = deferred<HumanSendResult>();
    transport.nextSend = () => pending.promise;
    installDeclaration(events);
    openChat(transport, 'conversation-a');
    const first = await waitForReady(events, 'conversation-a');

    act(() => commandEntry()({ type: 'send', lifetimeId: first.lifetimeId,
      sessionKey: first.sessionKey, correlationId: correlation, content: 'still in flight' }));
    await waitFor(() => expect(transport.submissions).toHaveLength(1));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(events.at(-1)).toMatchObject({ event: 'lifetime-ended', lifetimeId: first.lifetimeId, reason: 'unloading' });
    expect(events.some((event) => event.event === 'uncertain' && event.correlationId === correlation)).toBe(false);
    act(() => window.dispatchEvent(new Event('pageshow')));
    await waitFor(() => expect(events.filter((event) => event.event === 'ready')).toHaveLength(2));
    const nextReady = events.filter((event): event is Extract<HostComposerEvent, { event: 'ready' }> => event.event === 'ready').at(-1)!;
    expect(nextReady.sessionKey).toBe(first.sessionKey);
    expect(nextReady.lifetimeId).not.toBe(first.lifetimeId);
    expect(screen.queryByRole('textbox', { name: /Message to Agent conversation-a/ })).toBeNull();
  });

  it('re-handshakes after reload without warning only because the old page ended', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    const pending = deferred<HumanSendResult>();
    transport.nextSend = () => pending.promise;
    installDeclaration(events);
    const firstView = openChat(transport, 'conversation-a');
    const firstReady = await waitForReady(events, 'conversation-a');
    act(() => commandEntry()({ type: 'send', lifetimeId: firstReady.lifetimeId,
      sessionKey: firstReady.sessionKey, correlationId: correlation, content: 'retained draft' }));
    transport.addCanonical(transport.submissions[0]);
    firstView.unmount();
    expect(events.some((event) => event.event === 'uncertain' && event.reason === 'lifetime-ended')).toBe(false);
    expect(events.some((event) => event.event === 'lifetime-ended' && event.reason === 'disposed')).toBe(true);

    const secondView = openChat(transport, 'conversation-a');
    const secondPageStart = events.findIndex((event) => event.event === 'lifetime-ended') + 1;
    await waitFor(() => expect(readyEvent(events.slice(secondPageStart), 'conversation-a')).toBeDefined());
    const secondReady = readyEvent(events.slice(secondPageStart), 'conversation-a')!;
    expect(screen.queryByRole('textbox')).toBeNull();
    act(() => commandEntry()({ type: 'send', lifetimeId: secondReady.lifetimeId, sessionKey: secondReady.sessionKey,
      correlationId: correlation, content: 'retained draft', retry: true }));
    await waitFor(() => expect(events.filter((event) => event.event === 'delivered' && event.lifetimeId === secondReady.lifetimeId)).toHaveLength(1));
    expect(transport.submissions).toHaveLength(1);
    expect(events.find((event) => event.event === 'delivered' && event.lifetimeId === secondReady.lifetimeId))
      .toMatchObject({ attempt: 1 });
    secondView.unmount();
  });

  it('keeps session-detail failures local and offers inline Reconnect after opting in', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    transport.failReadSessionOnce = true;
    installDeclaration(events);
    openChat(transport, 'conversation-a');
    const reconnect = await screen.findByRole('button', { name: 'Reconnect' });
    expect(screen.queryByRole('button', { name: /Connection status/ })).toBeNull();
    expect(screen.getByText(/Some conversation details are unavailable/)).toBeTruthy();
    fireEvent.click(reconnect);
    await waitForReady(events, 'conversation-a');
    expect(screen.queryByRole('button', { name: /Connection status/ })).toBeNull();
  });

  it('reports a missing session through the existing unavailable event with a reason', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    transport.missingSession = true;
    installDeclaration(events);
    openChat(transport, 'conversation-a');

    await waitFor(() => expect(events.filter((event) => event.event === 'unavailable')).toHaveLength(1));
    expect(events[0]).toMatchObject({ event: 'unavailable', reason: 'session-not-found' });
    expect(events.some((event) => event.event === 'ready')).toBe(false);
    expect(screen.getByRole('textbox', { name: /message to the selected agent/i })).toBeTruthy();
    expect(screen.getByText('This conversation no longer exists.')).toBeTruthy();
  });

  it('reports authorization loss during a send as unavailable', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    installDeclaration(events);
    openChat(transport, 'conversation-a');
    const ready = await waitForReady(events, 'conversation-a');

    transport.authorizationLost = true;
    act(() => commandEntry()({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: correlation, content: 'authorization expired during send' }));
    await waitFor(() => expect(events.some((event) => event.event === 'unavailable' &&
      event.reason === 'unauthorized' && event.lifetimeId === ready.lifetimeId)).toBe(true));
    const openCount = transport.changeOpenCount;
    const eventCount = events.length;
    act(() => commandEntry()({ type: 'reconnect', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey }));
    expect(transport.changeOpenCount).toBe(openCount);
    expect(events).toHaveLength(eventCount);
    expect(events.find((event) => event.event === 'failed' && event.correlationId === correlation))
      .toMatchObject({ reason: 'refused', detail: 'unauthorized' });
    expect(events.filter((event) => event.event === 'unavailable')).toHaveLength(1);
    expect(events.filter((event) => event.event === 'ready')).toHaveLength(1);
  });
});

type RestoreRequested = Extract<HostComposerEvent, { event: 'restore-requested' }>;
const restoreDeclaration = { events: Object.freeze({ 'restore-requested': Object.freeze([1]) }) };
const failureReason = 'Synthetic failure reason for tests';

function restoreEvents(events: readonly HostComposerEvent[]): RestoreRequested[] {
  return events.filter((event): event is RestoreRequested => event.event === 'restore-requested');
}

function humanPrompt(sessionKey: string, id: string, seq: number, content: string,
  extra: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return { kind: 'message', id, sessionKey, seq, rowVersion: 1, role: 'user', sender: 'user:person', content, raw: {}, ...extra };
}

function turnFailure(sessionKey: string, promptId: string, seq: number): CanonicalMessage {
  return { kind: 'message', id: `failure-${promptId}`, sessionKey, seq, rowVersion: 1, role: 'assistant',
    sender: 'process:tightbeam', messageType: 'substrate', replyToMessageId: promptId,
    content: `[turn failed]\n${failureReason}`, raw: {} };
}

function failedBubble(content: string): HTMLElement {
  const bubble = screen.getByText(content).closest('article');
  expect(bubble?.getAttribute('data-message-state')).toBe('failed');
  return bubble as HTMLElement;
}

describe('host restore-requested for failed turns', () => {
  const sessionKey = 'restore-session';
  const promptCorrelation = 'c_323e4567-e89b-42d3-a456-426614174002';

  function failedHistory(transport: HostComposerTransport) {
    transport.records.set(sessionKey, [
      humanPrompt(sessionKey, 'prompt-1', 1, 'Synthetic failed prompt', { clientMessageId: promptCorrelation, deviceId: 'device-2' }),
      turnFailure(sessionKey, 'prompt-1', 2),
    ]);
  }

  it.each([
    ['no events field', {}],
    ['an unsupported event version', { events: { 'restore-requested': [2] } }],
    ['a malformed events field', { events: 'restore-requested' }],
  ])('keeps today’s host behaviour for a host with %s', async (_label, extra) => {
    const transport = new HostComposerTransport();
    failedHistory(transport);
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], extra);
    openChat(transport, sessionKey);
    await waitForReady(events, sessionKey);
    await waitFor(() => expect(document.querySelector('textarea')).toBeNull());

    const bubble = failedBubble('Synthetic failed prompt');
    expect(within(bubble).getByText('Message failed.')).toBeTruthy();
    expect(within(bubble).getByText(failureReason)).toBeTruthy();
    expect(within(bubble).queryByRole('button', { name: 'Edit and resend' })).toBeNull();
    expect(events.some(event => event.event === 'declined')).toBe(false);
    expect(restoreEvents(events)).toEqual([]);
  });

  it('emits exactly one restore-requested event per tap for a declared host, never automatically', async () => {
    const transport = new HostComposerTransport();
    failedHistory(transport);
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], restoreDeclaration);
    const { runtimes } = openChat(transport, sessionKey);
    const ready = await waitForReady(events, sessionKey);
    const bubble = failedBubble('Synthetic failed prompt');
    await within(bubble).findByRole('button', { name: 'Edit and resend' });
    // The failed bubble and its verbatim reason are unchanged by the action.
    expect(within(bubble).getByText('Message failed.')).toBeTruthy();
    expect(within(bubble).getByText(failureReason)).toBeTruthy();

    // Readiness, connection updates and history refreshes never emit it.
    await waitFor(() => expect(connectionEvents(events).length).toBeGreaterThan(0));
    await act(async () => { await runtimes[0].rebuild({ restart: true }); });
    await waitFor(() => expect(within(failedBubble('Synthetic failed prompt'))
      .getByRole('button', { name: 'Edit and resend' })).toBeTruthy());
    expect(restoreEvents(events)).toEqual([]);

    fireEvent.click(within(failedBubble('Synthetic failed prompt')).getByRole('button', { name: 'Edit and resend' }));
    expect(restoreEvents(events)).toEqual([{
      event: 'restore-requested', version: 1, lifetimeId: ready.lifetimeId, sessionKey,
      messageId: 'prompt-1', correlationId: promptCorrelation, content: 'Synthetic failed prompt',
    }]);
    fireEvent.click(within(failedBubble('Synthetic failed prompt')).getByRole('button', { name: 'Edit and resend' }));
    expect(restoreEvents(events)).toHaveLength(2);
    expect(restoreEvents(events)[1]).toEqual(restoreEvents(events)[0]);

    // Chat neither sends, retries nor restores into its hidden composer.
    expect(transport.submissions).toEqual([]);
    expect(document.querySelector('textarea')).toBeNull();
    expect(events.some(event => ['accepted', 'delivered', 'failed', 'uncertain', 'rejected'].includes(event.event))).toBe(false);
    expect(failedBubble('Synthetic failed prompt').querySelector('.tb-chat-persisted-failure-reason')?.textContent).toBe(failureReason);
  });

  it('offers the action only on failed human prompts owned by the viewer', async () => {
    const transport = new HostComposerTransport();
    transport.records.set(sessionKey, [
      humanPrompt(sessionKey, 'answered', 1, 'Synthetic answered prompt'),
      { kind: 'message', id: 'answer', sessionKey, seq: 2, rowVersion: 1, role: 'assistant', sender: 'assistant-service',
        messageType: 'assistant', replyToMessageId: 'answered', content: 'Synthetic answer', raw: {} },
      humanPrompt(sessionKey, 'other-user', 3, 'Synthetic prompt from someone else', { sender: 'user:someone-else' }),
      turnFailure(sessionKey, 'other-user', 4),
      humanPrompt(sessionKey, 'own-failed', 5, 'Synthetic own failed prompt'),
      turnFailure(sessionKey, 'own-failed', 6),
    ]);
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], restoreDeclaration);
    openChat(transport, sessionKey);
    await waitForReady(events, sessionKey);
    await within(failedBubble('Synthetic own failed prompt')).findByRole('button', { name: 'Edit and resend' });
    expect(screen.getAllByRole('button', { name: 'Edit and resend' })).toHaveLength(1);
    expect(screen.getByText('Synthetic answered prompt').closest('article')?.querySelector('button')).toBeNull();
    expect(screen.getByText('Synthetic answer').closest('article')?.querySelector('button')).toBeNull();
    const other = screen.getByText('Synthetic prompt from someone else').closest('article');
    expect(other && within(other).queryByRole('button', { name: 'Edit and resend' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit and resend' }));
    const [event] = restoreEvents(events);
    expect(event).toMatchObject({ messageId: 'own-failed', content: 'Synthetic own failed prompt' });
    // A row with no client message ID carries no correlation.
    expect('correlationId' in event).toBe(false);
    expect(restoreEvents(events)).toHaveLength(1);
  });

  it('hides the action while the lifetime is not ready and emits nothing for it', async () => {
    const transport = new HostComposerTransport();
    failedHistory(transport);
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], restoreDeclaration);
    openChat(transport, sessionKey);
    const ready = await waitForReady(events, sessionKey);
    await within(failedBubble('Synthetic failed prompt')).findByRole('button', { name: 'Edit and resend' });
    transport.authorizationLost = true;
    act(() => commandEntry()({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey,
      correlationId: correlation, content: 'synthetic send while access expires' }));
    await waitFor(() => expect(events.some(event => event.event === 'unavailable')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit and resend' })).toBeNull());
    expect(restoreEvents(events)).toEqual([]);
  });
});

describe('native photo host commands', () => {
  const photo = { filename: 'photo.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  class PhotoTransport extends HostComposerTransport {
    uploads: Blob[] = [];
    failUpload = false;
    uploadAttachment: NonNullable<ChatTransport['uploadAttachment']> = async input => {
      this.uploads.push(input.bytes);
      if (this.failUpload) throw new Error('Upload interrupted');
      return { assetId: 'asset-photo', mimeType: input.bytes.type, filename: input.filename, size: input.bytes.size };
    };
    readAttachment: NonNullable<ChatTransport['readAttachment']> = async () => this.uploads.at(-1)!;
    attachmentCapabilities?: ChatTransport['attachmentCapabilities'];
    assessAttachments?: ChatTransport['assessAttachments'];
    override addCanonical(submission: HumanSubmission): CanonicalMessage {
      const row = super.addCanonical(submission);
      const withPhotos = { ...row, attachments: submission.attachments };
      const rows = this.records.get(submission.sessionKey)!;
      rows[rows.indexOf(row)] = withPhotos;
      return withPhotos;
    }
  }
  function stubImagePreparation() {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 1, height: 1, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) =>
      callback(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fixture-photo');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  }
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(['', 'a caption', '/settings'])('uploads a native photo with content %j and reconciles its real reference', async content => {
    stubImagePreparation();
    const transport = new PhotoTransport();
    transport.nextSend = async submission => {
      const row = transport.addCanonical(submission);
      return { outcome: 'accepted', messageId: row.id };
    };
    const events: HostComposerEvent[] = [];
    installDeclaration(events);
    openChat(transport, 'photo-session');
    const ready = await waitForReady(events, 'photo-session');
    expect(ready.capabilities.attachments).toEqual({ mediaTypes: ['image/jpeg', 'image/png'] });
    act(() => commandEntry()({ type: 'send', ...ready, correlationId: correlation, content, attachments: [photo] }));
    await waitFor(() => expect(events.some(e => e.event === 'delivered')).toBe(true));
    expect(transport.uploads).toHaveLength(1);
    expect(transport.submissions).toHaveLength(1);
    expect(transport.submissions[0]).toMatchObject({ content, clientMessageId: correlation,
      attachments: [{ assetId: 'asset-photo', mimeType: 'image/png', filename: 'photo.png', size: 8 }] });
    expect(events.filter(e => e.event === 'accepted' || e.event === 'delivered').map(e => e.event)).toEqual(['accepted', 'delivered']);
    await screen.findByRole('button', { name: /Enlarge Image: photo.png/ });
    expect(events.some(e => e.event === 'rejected')).toBe(false);
  });

  it('prepares JPEG input through the shared image path and reports decode failures by index', async () => {
    stubImagePreparation();
    const transport = new PhotoTransport();
    const events: HostComposerEvent[] = [];
    installDeclaration(events); openChat(transport, 'photo-session');
    const ready = await waitForReady(events, 'photo-session');
    const jpeg = { filename: 'camera.jpg', mimeType: 'image/jpeg', data: '/9j/4AA=' };
    act(() => commandEntry()({ type: 'send', ...ready, correlationId: correlation, content: 'camera', attachments: [jpeg] }));
    await waitFor(() => expect(transport.submissions).toHaveLength(1));
    expect(transport.submissions[0].attachments?.[0]).toMatchObject({ filename: 'camera.jpg', mimeType: 'image/jpeg' });
    vi.mocked(createImageBitmap).mockRejectedValue(new Error('decode unavailable'));
    vi.stubGlobal('Image', class { src = ''; decode = async () => { throw new Error('decode unavailable'); }; });
    act(() => commandEntry()({ type: 'send', ...ready,
      correlationId: 'c_223e4567-e89b-42d3-a456-426614174001', content: '', attachments: [jpeg] }));
    await waitFor(() => expect(events.some(e => e.event === 'failed' && e.reason === 'image-unreadable' && e.attachmentIndex === 0)).toBe(true));
    expect(transport.submissions).toHaveLength(1);
  });

  it('narrows supplied upload capabilities to photos and preserves actual limits', async () => {
    const transport = new PhotoTransport();
    transport.attachmentCapabilities = () => ({ mediaTypes: ['image/png', 'text/plain'], maxAttachments: 3 });
    const events: HostComposerEvent[] = [];
    installDeclaration(events); openChat(transport, 'photo-session');
    const ready = await waitForReady(events, 'photo-session');
    expect(ready.capabilities.attachments).toEqual({ mediaTypes: ['image/png'], maxAttachments: 3 });
  });

  it.each([null, {}, [{ ...photo, filename: '' }], [{ ...photo, data: '' }],
    [{ ...photo, data: 'data:image/png;base64,iVBORw0KGgo=' }], [{ ...photo, data: '%%%%' }],
    [{ ...photo, mimeType: 'application/pdf' }]])('rejects invalid attachment manifest %j without upload or post', async attachments => {
    const transport = new PhotoTransport();
    const events: HostComposerEvent[] = [];
    installDeclaration(events); openChat(transport, 'photo-session');
    const ready = await waitForReady(events, 'photo-session');
    act(() => commandEntry()({ type: 'send', ...ready, correlationId: correlation, content: '', attachments }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'invalid-attachments' });
    expect(transport.uploads).toEqual([]); expect(transport.submissions).toEqual([]);
  });

  it('keeps a pending photo visible, reports upload failure and retries only the original manifest', async () => {
    stubImagePreparation();
    const transport = new PhotoTransport(); transport.failUpload = true;
    const events: HostComposerEvent[] = [];
    installDeclaration(events); openChat(transport, 'photo-session');
    const ready = await waitForReady(events, 'photo-session');
    const request = { type: 'send' as const, ...ready, correlationId: correlation, content: '', attachments: [photo] };
    act(() => commandEntry()(request));
    await waitFor(() => expect(events.some(e => e.event === 'failed')).toBe(true));
    expect(events.at(-1)).toMatchObject({ event: 'failed', reason: 'upload-failed', attachmentIndex: 0, attempt: 1 });
    await screen.findByRole('button', { name: /Enlarge Image: photo.png/ });
    act(() => commandEntry()({ ...request, retry: true, attachments: [{ ...photo, data: 'iVBORw0KGgs=' }] }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'correlation-conflict' });
    expect(transport.uploads).toHaveLength(1);
    transport.failUpload = false;
    transport.nextSend = async submission => { const row = transport.addCanonical(submission); return { outcome: 'accepted', messageId: row.id }; };
    act(() => commandEntry()({ ...request, retry: true }));
    await waitFor(() => expect(events.some(e => e.event === 'delivered' && e.attempt === 2)).toBe(true));
    expect(transport.uploads).toHaveLength(2);
    expect(transport.uploads[0]).toBe(transport.uploads[1]);
    expect(transport.submissions).toHaveLength(1);
  });

  it.each(['unknown', 'failed', 'missing', 'nondelivery'] as const)('posts native photos normally without hidden confirmation when assessment is %s', async mode => {
    stubImagePreparation();
    const transport = new PhotoTransport();
    transport.assessAttachments = async submission => {
      if (mode === 'missing') return undefined;
      if (mode === 'failed') throw new Error('Assessment unavailable');
      return { sessionKey: submission.sessionKey, clientMessageId: submission.clientMessageId,
        attachments: submission.attachments!.map(item => ({ assetId: item.assetId,
          assessment: mode === 'nondelivery' ? 'will-not-deliver' : 'unknown',
          reason: mode === 'nondelivery' ? { code: 'unsupported', message: 'Gateway reports nondelivery' } : null })) };
    };
    transport.nextSend = async submission => { const row = transport.addCanonical(submission); return { outcome: 'accepted', messageId: row.id }; };
    const events: HostComposerEvent[] = [];
    installDeclaration(events);
    const { runtimes } = openChat(transport, 'photo-session');
    const ready = await waitForReady(events, 'photo-session');
    const phases: (string | undefined)[] = [];
    const unsubscribe = runtimes[0].subscribe(() => phases.push(runtimes[0].getSnapshot().sends[0]?.attachmentPhase));
    act(() => commandEntry()({ type: 'send', ...ready, correlationId: correlation, content: 'keep this text', attachments: [photo] }));
    await waitFor(() => expect(events.some(e => e.event === 'delivered')).toBe(true));
    unsubscribe();
    expect(phases).not.toContain('confirmation');
    expect(transport.submissions).toHaveLength(1);
    expect(transport.submissions[0].content).toBe('keep this text');
    if (mode !== 'nondelivery') expect(runtimes[0].getSnapshot().sends[0].attachmentAssessment).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Send anyway' })).toBeNull();
  });

  it.each(['uploading', 'posted', 'reconciled'] as const)('settles photo retry after cached page hide/show while %s', async phase => {
    stubImagePreparation();
    const transport = new PhotoTransport();
    const uploadGate = deferred<void>();
    const postGate = deferred<HumanSendResult>();
    const upload = transport.uploadAttachment;
    let uploading = false;
    transport.uploadAttachment = async input => {
      if (phase === 'uploading' && !uploading) {
        uploading = true;
        await uploadGate.promise;
      }
      return upload(input, new AbortController().signal);
    };
    transport.nextSend = async submission => {
      if (phase !== 'uploading' && transport.submissions.length === 1) return postGate.promise;
      const row = transport.addCanonical(submission);
      return { outcome: 'accepted', messageId: row.id };
    };
    const events: HostComposerEvent[] = [];
    installDeclaration(events); openChat(transport, 'photo-session');
    const first = await waitForReady(events, 'photo-session');
    const request = { type: 'send' as const, lifetimeId: first.lifetimeId, sessionKey: first.sessionKey,
      correlationId: correlation, content: '', attachments: [photo] };
    act(() => commandEntry()(request));
    await waitFor(() => expect(phase === 'uploading' ? uploading : transport.submissions.length === 1).toBe(true));
    act(() => window.dispatchEvent(new Event('pagehide')));
    expect(events.some(e => ['failed', 'uncertain'].includes(e.event))).toBe(false);
    if (phase === 'reconciled') transport.addCanonical(transport.submissions[0]);
    act(() => window.dispatchEvent(new Event('pageshow')));
    await waitFor(() => expect(events.filter(e => e.event === 'ready')).toHaveLength(2));
    const next = events.filter((e): e is Extract<HostComposerEvent, { event: 'ready' }> => e.event === 'ready').at(-1)!;
    act(() => commandEntry()({ ...request, lifetimeId: next.lifetimeId, retry: true }));
    await waitFor(() => expect(events.some(e => e.event === 'delivered' && e.lifetimeId === next.lifetimeId)).toBe(true));
    expect(transport.submissions).toHaveLength(phase === 'posted' ? 2 : 1);
    expect(transport.uploads).toHaveLength(1);
    expect(events.some(e => e.event === 'rejected' && e.reason === 'attempt-in-flight')).toBe(false);
    uploadGate.resolve(); postGate.resolve({ outcome: 'accepted' });
  });

  it('recovers an unknown correlation without uploading or posting fresh references', async () => {
    stubImagePreparation();
    const transport = new PhotoTransport();
    const events: HostComposerEvent[] = [];
    installDeclaration(events); openChat(transport, 'photo-session');
    const ready = await waitForReady(events, 'photo-session');
    act(() => commandEntry()({ type: 'send', ...ready, correlationId: correlation, content: '', attachments: [photo], retry: true }));
    await waitFor(() => expect(events.some(e => e.event === 'uncertain' && e.reason === 'retry-unavailable')).toBe(true));
    expect(transport.uploads).toEqual([]); expect(transport.submissions).toEqual([]);
  });

  it('hands the host the restorable photo manifest Chat holds for a failed turn', async () => {
    stubImagePreparation();
    const transport = new PhotoTransport();
    transport.nextSend = async submission => {
      const row = transport.addCanonical(submission);
      return { outcome: 'accepted', messageId: row.id };
    };
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], restoreDeclaration);
    openChat(transport, 'photo-session');
    const ready = await waitForReady(events, 'photo-session');
    act(() => commandEntry()({ type: 'send', ...ready, correlationId: correlation, content: 'Synthetic photo prompt', attachments: [photo] }));
    await waitFor(() => expect(events.some(e => e.event === 'delivered')).toBe(true));
    const prompt = transport.records.get('photo-session')!.at(-1)!;
    act(() => transport.emit(turnFailure('photo-session', prompt.id, 100)));
    const button = await within(await waitFor(() => failedBubble('Synthetic photo prompt')))
      .findByRole('button', { name: 'Edit and resend' });
    expect(restoreEvents(events)).toEqual([]);

    fireEvent.click(button);
    await waitFor(() => expect(restoreEvents(events)).toHaveLength(1));
    expect(restoreEvents(events)[0]).toEqual({
      event: 'restore-requested', version: 1, lifetimeId: ready.lifetimeId, sessionKey: 'photo-session',
      messageId: prompt.id, correlationId: correlation, content: 'Synthetic photo prompt',
      attachments: [{ filename: 'photo.png', mimeType: 'image/png', data: photo.data }],
    });
    expect(transport.submissions).toHaveLength(1);
    expect(transport.uploads).toHaveLength(1);
  });

  it('flags photos Chat cannot restore instead of hiding the action', async () => {
    const transport = new PhotoTransport();
    transport.records.set('photo-session', [
      humanPrompt('photo-session', 'photo-prompt', 1, 'Synthetic photo prompt from history', {
        attachments: [{ assetId: 'asset-history', mimeType: 'image/png', filename: 'history.png', size: 8 }] }),
      turnFailure('photo-session', 'photo-prompt', 2),
    ]);
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], restoreDeclaration);
    openChat(transport, 'photo-session');
    const ready = await waitForReady(events, 'photo-session');
    fireEvent.click(await within(failedBubble('Synthetic photo prompt from history'))
      .findByRole('button', { name: 'Edit and resend' }));
    expect(restoreEvents(events)).toEqual([{
      event: 'restore-requested', version: 1, lifetimeId: ready.lifetimeId, sessionKey: 'photo-session',
      messageId: 'photo-prompt', content: 'Synthetic photo prompt from history', attachmentsUnavailable: true,
    }]);
    expect(transport.uploads).toEqual([]);
    expect(transport.submissions).toEqual([]);
  });
});

describe('host agent-model event', () => {
  const modelDeclaration = { events: Object.freeze({ 'agent-model': Object.freeze([1]) }) };
  const running = (label: string | null = 'Claude Opus 5.5') => ({ id: 'model-x', label, harness: 'Harness A' });
  // The live feed can connect just after ready, so the first value may be null; later values only on change.
  const models = (events: readonly HostComposerEvent[]) => modelEvents(events).map((event) => event.model);
  const settled = (events: readonly HostComposerEvent[], model: string | null) =>
    waitFor(() => expect(models(events).at(-1)).toBe(model), { timeout: 4000 });
  const modelEvents = (events: readonly HostComposerEvent[]) =>
    events.filter((event): event is Extract<HostComposerEvent, { event: 'agent-model' }> => event.event === 'agent-model');

  it.each([
    ['no events field', {}],
    ['an unsupported version', { events: { 'agent-model': [2] } }],
    ['a malformed events field', { events: 'agent-model' }],
  ])('sends nothing for a host with %s and leaves ready unchanged', async (_label, extra) => {
    const transport = new HostComposerTransport();
    transport.runningModel = running();
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], extra);
    openChat(transport, 'model-session');
    const ready = await waitForReady(events, 'model-session');
    await waitFor(() => expect(connectionEvents(events).length).toBeGreaterThan(0));
    expect(modelEvents(events)).toEqual([]);
    expect(Object.keys(ready).sort()).toEqual(
      ['agentDisplayName', 'capabilities', 'event', 'gatewayOrigin', 'lifetimeId', 'sessionKey', 'version']);
    expect(JSON.stringify(ready)).not.toContain('Opus');
  });

  it('sends the display text right after ready, then only on change, including to null', async () => {
    const transport = new HostComposerTransport();
    transport.runningModel = running();
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], modelDeclaration);
    openChat(transport, 'model-session');
    const ready = await waitForReady(events, 'model-session');
    await settled(events, 'Opus 5.5');
    expect(events.indexOf(modelEvents(events)[0])).toBe(events.indexOf(ready) + 1);
    expect(modelEvents(events).at(-1)).toEqual({ event: 'agent-model', version: 1, lifetimeId: ready.lifetimeId,
      sessionKey: 'model-session', model: 'Opus 5.5' });
    await waitFor(() => expect(transport.callbacks.has('model-session')).toBe(true));
    const before = modelEvents(events).length;

    act(() => transport.setRunningModel('model-session', running()));
    await act(async () => { await Promise.resolve(); });
    expect(modelEvents(events)).toHaveLength(before);
    act(() => transport.setRunningModel('model-session', running('Claude Sonnet 5.5')));
    await settled(events, 'Sonnet 5.5');
    act(() => transport.setRunningModel('model-session', null));
    await settled(events, null);
    const after = modelEvents(events).length;
    act(() => transport.setRunningModel('model-session', 'malformed'));
    await act(async () => { await Promise.resolve(); });
    expect(modelEvents(events)).toHaveLength(after);
    const values = models(events);
    expect(values.every((value, index) => index === 0 || value !== values[index - 1])).toBe(true);
  });

  it('sends null once when the live feed starts reconnecting and the model again on recovery', async () => {
    const transport = new HostComposerTransport();
    transport.runningModel = running();
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], modelDeclaration);
    openChat(transport, 'model-session');
    const ready = await waitForReady(events, 'model-session');
    await settled(events, 'Opus 5.5');
    const before = modelEvents(events).length;
    transport.changeOpenFailures = 3;
    act(() => transport.callbacks.get('model-session')?.onDoubt('connection closed'));
    await waitFor(() => expect(models(events).at(-1)).toBeNull(), { timeout: 6000 });
    expect(modelEvents(events)).toHaveLength(before + 1);
    expect(events.filter((event) => event.event === 'ready' && event.lifetimeId === ready.lifetimeId)).toHaveLength(1);
    await waitFor(() => expect(models(events).at(-1)).toBe('Opus 5.5'), { timeout: 12_000 });
    expect(modelEvents(events)).toHaveLength(before + 2);
  }, 30_000);

  it('sends null when status leaves ready and the model again when it returns', async () => {
    const transport = new HostComposerTransport();
    transport.runningModel = running();
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], modelDeclaration);
    const { runtimes } = openChat(transport, 'model-session');
    const ready = await waitForReady(events, 'model-session');
    await settled(events, 'Opus 5.5');
    const before = modelEvents(events).length;
    transport.readGate = deferred<void>();
    let rebuilt!: Promise<void>;
    act(() => { rebuilt = runtimes[0].rebuild({ restart: true }) as Promise<void>; });
    await waitFor(() => expect(runtimes[0].getSnapshot().status).not.toBe('ready'));
    await waitFor(() => expect(models(events).at(-1)).toBeNull());
    expect(modelEvents(events)).toHaveLength(before + 1);
    expect(events.filter((event) => event.event === 'ready' && event.lifetimeId === ready.lifetimeId)).toHaveLength(1);
    transport.readGate.resolve();
    await act(async () => { await rebuilt; });
    await waitFor(() => expect(models(events).at(-1)).toBe('Opus 5.5'), { timeout: 12_000 });
  }, 30_000);

  it('sends null before unavailable, and nothing after the lifetime ended', async () => {
    const transport = new HostComposerTransport();
    transport.runningModel = running();
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], modelDeclaration);
    openChat(transport, 'model-session');
    const ready = await waitForReady(events, 'model-session');
    await settled(events, 'Opus 5.5');
    transport.authorizationLost = true;
    act(() => commandEntry()({ type: 'send', lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey,
      correlationId: correlation, content: 'authorization expired' }));
    await waitFor(() => expect(events.some((event) => event.event === 'unavailable')).toBe(true));
    const unavailableAt = events.findIndex((event) => event.event === 'unavailable');
    const lastModel = events.map((event, index) => ({ event, index })).filter(({ event }) => event.event === 'agent-model').at(-1)!;
    expect(lastModel.event).toMatchObject({ model: null });
    expect(lastModel.index).toBeLessThan(unavailableAt);
    const count = events.length;
    await act(async () => { await new Promise((done) => setTimeout(done, 200)); });
    expect(events.slice(count).some((event) => event.event === 'agent-model')).toBe(false);
  });

  it('sends null when the model is unknown', async () => {
    const transport = new HostComposerTransport();
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], modelDeclaration);
    openChat(transport, 'model-session');
    await waitForReady(events, 'model-session');
    await waitFor(() => expect(modelEvents(events)).toHaveLength(1));
    await act(async () => { await new Promise((done) => setTimeout(done, 2500)); });
    expect(models(events)).toEqual([null]);
  });

  it('works alongside restore-requested when both are declared', async () => {
    const transport = new HostComposerTransport();
    transport.runningModel = running();
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], { events: Object.freeze({
      'restore-requested': Object.freeze([1]), 'agent-model': Object.freeze([1]) }) });
    openChat(transport, 'model-session');
    await waitForReady(events, 'model-session');
    await settled(events, 'Opus 5.5');
    expect(restoreEvents(events)).toEqual([]);
  });

  it('sends again for a new lifetime and never for an ended one', async () => {
    const transport = new HostComposerTransport();
    transport.runningModel = running();
    const events: HostComposerEvent[] = [];
    installDeclaration(events, [1], modelDeclaration);
    const { rerender, adapter } = openChat(transport, 'session-a');
    const first = await waitForReady(events, 'session-a');
    await settled(events, 'Opus 5.5');
    const firstCount = modelEvents(events).length;
    rerender(<TightbeamChat sessionKey="session-b" adapter={adapter} />);
    const second = await waitForReady(events, 'session-b');
    await waitFor(() => expect(modelEvents(events).length).toBeGreaterThan(firstCount), { timeout: 4000 });
    await settled(events, 'Opus 5.5');
    expect(modelEvents(events).at(-1)).toMatchObject({ lifetimeId: second.lifetimeId, sessionKey: 'session-b', model: 'Opus 5.5' });
    const endedAt = events.findIndex((event) => event.event === 'lifetime-ended' && event.lifetimeId === first.lifetimeId);
    expect(endedAt).toBeGreaterThan(-1);
    expect(modelEvents(events.slice(endedAt)).every((event) => event.lifetimeId !== first.lifetimeId)).toBe(true);
  });
});
