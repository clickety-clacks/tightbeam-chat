import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TightbeamChat } from '../src/TightbeamChat';
import { createTightbeamAdapter } from '../src/runtime';
import { HOST_COMMAND_NAME, HOST_DECLARATION_NAME, HostComposerBridge, type HostComposerCommandEntry, type HostComposerEvent } from '../src/hostComposer';
import type {
  CanonicalMessage, ChangeCallbacks, ChangeNotice, ChatRuntime, ChatTransport,
  ConversationPage, ConversationRecord, HostIdentity, HumanSendResult, HumanSubmission,
  SessionRecord, TargetCapabilities, TargetObservation, TargetProfile, TightbeamAdapter,
} from '../src/types';
import { SessionNotFoundError } from '../src/types';

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
  readonly callbacks = new Map<string, ChangeCallbacks>();
  readonly closed = new Set<string>();
  readonly targetGateway = 'https://gateway.example:8443';
  readonly observation: TargetObservation = profile;
  readyGate?: ReturnType<typeof deferred<void>>;
  failReadSessionOnce = false;
  missingSession = false;
  nextSend?: (submission: HumanSubmission) => Promise<HumanSendResult>;
  private seq = 0;

  currentIdentity = () => identity;
  inspectTarget = async () => this.observation;
  openChanges = async (sessionKey: string, callbacks: ChangeCallbacks, signal: AbortSignal) => {
    this.callbacks.set(sessionKey, callbacks);
    if (this.readyGate) await this.readyGate.promise;
    if (signal.aborted) throw new Error('Changes subscription was canceled.');
    return { close: () => { this.closed.add(sessionKey); this.callbacks.delete(sessionKey); } };
  };
  readSession = async (sessionKey: string): Promise<SessionRecord> => {
    if (this.missingSession) throw new SessionNotFoundError('This conversation no longer exists.');
    if (this.failReadSessionOnce) {
      this.failReadSessionOnce = false;
      throw new Error('Temporary history read failure.');
    }
    return { sessionKey, rowVersion: 1, displayName: `Agent ${sessionKey}`, model: 'Model A', harness: 'Harness A', raw: {} };
  };
  readTail = async (sessionKey: string): Promise<ConversationPage> => {
    const rows = this.records.get(sessionKey) ?? [];
    return { records: rows.slice(-50), oldestCursor: rows[0]?.id ?? null, hasOlder: false, coverage: sessionKey };
  };
  readOlder = async (_sessionKey: string, _before: string): Promise<ConversationPage> => ({
    records: [], oldestCursor: null, hasOlder: false, coverage: _sessionKey,
  });
  proveCoverage = (session: SessionRecord, page: ConversationPage, _buffered: readonly ChangeNotice[]) => page.coverage === session.sessionKey;
  sendHuman = async (submission: HumanSubmission): Promise<HumanSendResult> => {
    this.submissions.push(submission);
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

function installDeclaration(events: HostComposerEvent[], versions: number[] = [1]): void {
  (window as unknown as Record<string, unknown>)[HOST_DECLARATION_NAME] = {
    versions, onEvent: (event: HostComposerEvent) => events.push(event),
  };
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

async function waitForReady(events: readonly HostComposerEvent[], sessionKey: string) {
  await waitFor(() => expect(readyEvent(events, sessionKey)).toBeDefined());
  return readyEvent(events, sessionKey)!;
}

function openChat(transport: HostComposerTransport, sessionKey: string) {
  const { adapter, runtimes } = makeAdapter(transport);
  const view = render(<TightbeamChat sessionKey={sessionKey} adapter={adapter} />);
  return { ...view, adapter, runtimes };
}

afterEach(() => {
  cleanup();
  const page = window as unknown as Record<string, unknown>;
  delete page[HOST_DECLARATION_NAME];
  delete page[HOST_COMMAND_NAME];
});

describe('versioned host composer seam on the real adapter and surface', () => {
  it('keeps the web composer until fresh ready, then hides it and exposes only text capability', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    transport.readyGate = deferred<void>();
    installDeclaration(events);
    openChat(transport, 'conversation-a');

    await screen.findByRole('textbox');
    expect(screen.queryByRole('button', { name: /Connection status/ })).toBeNull();
    expect(events.some((event) => event.event === 'ready')).toBe(false);
    await act(async () => { transport.readyGate?.resolve(); });

    const ready = await waitForReady(events, 'conversation-a');
    expect(Object.keys(ready).sort()).toEqual([
      'agentDisplayName', 'capabilities', 'event', 'gatewayOrigin', 'lifetimeId', 'sessionKey', 'version',
    ].sort());
    expect(ready).toMatchObject({ version: 1, gatewayOrigin: 'https://gateway.example:8443',
      sessionKey: 'conversation-a', capabilities: { text: true } });
    expect('attachments' in ready.capabilities).toBe(false);
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(screen.queryByRole('button', { name: /Connection status/ })).toBeNull();
    expect(document.querySelector('.tb-chat-host-composer-hidden .tb-chat-viewport')).not.toBeNull();
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
      const snapshotKeys = ['composerHidden', 'optedIn', 'ready', 'settingsRequestRevision'];
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

  it('reports refusal and uncertain outcomes without automatically reposting', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    transport.nextSend = async (submission) => submission.content === 'refuse'
      ? { outcome: 'refused', reason: 'client_message_id_conflict' }
      : { outcome: 'uncertain', reason: 'ack timed out' };
    installDeclaration(events);
    openChat(transport, 'conversation-a');
    const ready = await waitForReady(events, 'conversation-a');
    const send = (id: string, content: string) => act(() => commandEntry()({ type: 'send',
      lifetimeId: ready.lifetimeId, sessionKey: ready.sessionKey, correlationId: id, content }));

    send(correlation, 'refuse');
    await waitFor(() => expect(events.some((event) => event.event === 'failed' && event.reason === 'refused')).toBe(true));
    expect(events.find((event) => event.event === 'failed')).toMatchObject({ detail: 'client_message_id_conflict', attempt: 1 });
    const second = 'c_223e4567-e89b-42d3-a456-426614174000';
    send(second, 'uncertain');
    await waitFor(() => expect(events.some((event) => event.event === 'uncertain' && event.correlationId === second)).toBe(true));
    expect(events.find((event) => event.event === 'uncertain' && event.correlationId === second))
      .toMatchObject({ reason: 'ack-lost', attempt: 1 });
    expect(screen.getByText('Message could not be sent')).toBeTruthy();
    expect(screen.getByText('Delivery is uncertain')).toBeTruthy();
    expect(screen.getByText('This message was refused. Any retry or text editing belongs in the host composer.')).toBeTruthy();
    expect(screen.getByText('Delivery could not be confirmed. Use the host composer to decide whether to retry.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore text to the composer' })).toBeNull();
    expect(transport.submissions).toHaveLength(2);
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
    transport.readyGate = gate;
    const pending = deferred<HumanSendResult>();
    transport.nextSend = () => pending.promise;
    installDeclaration(events);
    const { adapter, rerender } = openChat(transport, 'conversation-a');
    await screen.findByRole('textbox');
    const command = commandEntry();
    act(() => command({ type: 'send', lifetimeId: 'before-ready', sessionKey: 'conversation-a',
      correlationId: correlation, content: 'pending' }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'not-ready' });
    expect(screen.queryByRole('button', { name: /Connection status/ })).toBeNull();
    await act(async () => { gate.resolve(); });
    const ready = await waitForReady(events, 'conversation-a');
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
    transport.readyGate = gate;
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
    const overlayOpenIndex = events.findIndex((event) => event.event === 'overlay' && event.lifetimeId === ready.lifetimeId && event.open);
    expect(overlayOpenIndex).toBeGreaterThan(readyIndex);

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

  it('reports unavailable during reconnect and returns ready in the same lifetime', async () => {
    const events: HostComposerEvent[] = [];
    const transport = new HostComposerTransport();
    installDeclaration(events);
    const { runtimes } = openChat(transport, 'conversation-a');
    const first = await waitForReady(events, 'conversation-a');

    act(() => transport.callbacks.get('conversation-a')?.onDoubt('connection closed'));
    await waitFor(() => expect(events.some((event) => event.event === 'unavailable' &&
      event.lifetimeId === first.lifetimeId && event.reason === 'reconnecting')).toBe(true));
    act(() => commandEntry()({ type: 'send', lifetimeId: first.lifetimeId, sessionKey: first.sessionKey,
      correlationId: correlation, content: 'do not queue while reconnecting' }));
    expect(events.at(-1)).toMatchObject({ event: 'rejected', reason: 'not-ready' });
    expect(transport.submissions).toHaveLength(0);

    await act(async () => { await runtimes[0].rebuild({ restart: true }); });
    await waitFor(() => expect(events.filter((event) => event.event === 'ready')).toHaveLength(2));
    const nextReady = events.filter((event): event is Extract<HostComposerEvent, { event: 'ready' }> => event.event === 'ready').at(-1);
    expect(nextReady?.lifetimeId).toBe(first.lifetimeId);
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
    expect(screen.getByText('Some conversation details are unavailable.')).toBeTruthy();
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
});
