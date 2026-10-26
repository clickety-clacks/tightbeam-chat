import {
  AuthorizationError,
  InvalidCursorError,
  UnsupportedTargetError,
  type CanonicalTurn,
  type ToolCallRecord,
  type ToolCallIndex,
  type ToolCallRange,
  type ChangeConnection,
  type ChangeNotice,
  type ChatRuntime,
  type ChatTransport,
  type ConversationPage,
  type ConversationRecord,
  type HostIdentity,
  type HostSendObserver,
  type HostSendContext,
  type HostSendSignal,
  type HumanSendResult,
  type HumanSubmission,
  type LocalSend,
  type RuntimeState,
  type SessionRecord,
  type TargetProfile,
  type TightbeamAdapter,
  type TurnProvenance,
  SessionNotFoundError,
} from './types';
import { createTurnProvenance } from './provenance';
import { getIndex, putIndex, trimIndexBelow } from './recordIndex';

function identityEquals(a: HostIdentity, b: HostIdentity): boolean {
  return a.principalKey === b.principalKey && a.deviceId === b.deviceId;
}

function compareRecords(a: ConversationRecord, b: ConversationRecord): number {
  return a.seq - b.seq || a.id.localeCompare(b.id);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordsFrom(map: Map<string, ConversationRecord>): readonly ConversationRecord[] {
  return Object.freeze([...map.values()].sort(compareRecords));
}

/** Message publication can acquire its turn link without changing rowVersion. */
function mergeRecord(previous: ConversationRecord | undefined, incoming: ConversationRecord): ConversationRecord {
  if (!previous || incoming.rowVersion > previous.rowVersion) return incoming;
  if (incoming.rowVersion === previous.rowVersion && previous.kind === 'message' && incoming.kind === 'message' &&
      previous.id === incoming.id && previous.sessionKey === incoming.sessionKey &&
      previous.turnSeq === undefined && incoming.turnSeq !== undefined) {
    // Only the newly delivered link is authoritative at the same version. Keep
    // the stored body, attribution, correlation and all other metadata intact.
    return Object.freeze({ ...previous, turnSeq: incoming.turnSeq,
      raw: Object.freeze({ ...previous.raw, turnSeq: incoming.turnSeq }) });
  }
  return previous;
}

const noProvenance: readonly TurnProvenance[] = Object.freeze([]);
const hostCorrelationPattern = /^c_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const humanSendRetryInitialDelayMs = 250;
const humanSendRetryMaxDelayMs = 30_000;

/** Pace only after a send socket has dropped; a live acknowledgement has no timeout. */
function waitForHumanSendRetry(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (elapsed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(elapsed);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A target-independent runtime. Its transport is the only backend-specific code. */
export function createTightbeamAdapter(transport: ChatTransport, profile: TargetProfile): TightbeamAdapter {
  return { open: (sessionKey) => new SessionRuntime(sessionKey, transport, profile) };
}

class SessionRuntime implements ChatRuntime {
  private state: RuntimeState;
  private readonly turns = new Map<number, CanonicalTurn>();
  private readonly listeners = new Set<() => void>();
  private readonly identity: HostIdentity;
  private readonly rows = new Map<string, ConversationRecord>();
  private readonly tombstones = new Map<string, number>();
  private readonly sendControllers = new Map<string, AbortController>();
  private readonly pendingReconciledIds = new Set<string>();
  private readonly hostSendObservers = new Map<string, Set<HostSendObserver>>();
  private readonly coverageReaders = new Set<ChangeNotice[]>();
  private toolConnection: ChangeConnection | undefined;
  private toolReadiness: Promise<ChangeConnection> | undefined;
  private toolController: AbortController | undefined;
  private toolEpoch = 0;
  private readonly tools = new Map<string, ToolCallRecord>();
  private toolIndex: ToolCallIndex | undefined;
  private connection: ChangeConnection | undefined;
  private connectionController: AbortController | undefined;
  private connectionBinding: { generation: number; doubted: boolean } | undefined;
  private connectionForRebuild: ChangeConnection | undefined;
  private controller: AbortController | undefined;
  private cursor: string | null = null;
  private buffered: ChangeNotice[] = [];
  private bufferedSession: RuntimeState['session'];
  private generation = 0;
  private disposed = false;
  private initializing = false;
  private restoreDepth = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelayMs = 250;
  private rebuildPromise: Promise<void> | undefined;

  constructor(
    private readonly sessionKey: string,
    private readonly transport: ChatTransport,
    private readonly profile: TargetProfile,
  ) {
    this.identity = transport.currentIdentity();
    this.state = Object.freeze({
      sessionKey, principalKey: this.identity.principalKey, generation: 0, status: 'loading', records: Object.freeze([]),
      // Tool calls are visible by default when supported. The existing toggle
      // stops both their optional stream and history reads while disabled.
      toolCallsEnabled: transport.openToolChanges && transport.readToolCalls ? true : undefined,
      toolCalls: Object.freeze([]), toolCallIndex: undefined,
      hasOlder: false, loadingOlder: false, sends: Object.freeze([]), targetLabel: profile.label,
      targetGateway: transport.targetGateway, provenance: noProvenance, provenanceAvailable: false,
    });
    void this.rebuild();
  }

  getSnapshot = (): RuntimeState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(patch: Partial<RuntimeState>): void {
    if (this.disposed) return;
    const next = { ...this.state, ...patch };
    if (next.status !== 'ready') next.activeTurn = undefined;
    else if ('records' in patch || 'session' in patch || 'activeTurn' in patch || 'status' in patch) {
      let running: CanonicalTurn | undefined;
      for (const turn of this.turns.values()) {
        if (turn.status === 'running' && (!running || turn.seq > running.seq)) running = turn;
      }
      next.activeTurn = running
        ? createTurnProvenance(running, next.records, this.identity.principalKey, next.session?.raw.ownerUserId)
        : undefined;
      next.provenanceAvailable = this.turns.size > 0;
    }
    this.state = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }

  private stopTools(): void {
    this.toolEpoch++;
    this.toolController?.abort();
    this.toolConnection?.close();
    this.toolConnection = undefined;
    this.toolReadiness = undefined;
    this.toolController = undefined;
  }

  private putTool(call: ToolCallRecord): void {
    if (call.sessionKey !== this.sessionKey) return;
    const previous = this.tools.get(call.id);
    if (!previous || call.rowVersion > previous.rowVersion) {
      this.tools.set(call.id, call);
      const calls = putIndex(getIndex(this.toolIndex, call.afterMessageSeq), call.seq, call, call.startedAt);
      this.toolIndex = putIndex(this.toolIndex, call.afterMessageSeq, calls, calls.maxTime);
    }
  }

  private publishTools(): void {
    const floor = this.state.hasOlder ? this.state.records[0]?.seq ?? 0 : 0;
    const toolCallIndex = trimIndexBelow(this.toolIndex, floor);
    if (toolCallIndex !== this.state.toolCallIndex) this.publish({ toolCallIndex });
  }

  private toolFailure(error: unknown): void {
    this.stopTools();
    this.publish({ toolCallsLoading: false, toolCallsError: errorText(error) });
  }

  /** Tools are optional to conversation availability, but never silently complete. */
  private async startTools(): Promise<void> {
    this.stopTools();
    if (!this.state.toolCallsEnabled || !this.transport.openToolChanges || !this.transport.readToolCalls ||
        this.state.status !== 'ready' || this.disposed) return;
    const epoch = this.toolEpoch;
    const generation = this.generation;
    const controller = new AbortController();
    this.toolController = controller;
    const current = () => this.isCurrent(generation) && epoch === this.toolEpoch && this.checkIdentity();
    this.tools.clear();
    this.toolIndex = undefined;
    this.publish({ toolCalls: Object.freeze([]), toolCallIndex: undefined, toolCallsLoading: true, toolCallsError: undefined });
    try {
      this.toolReadiness = this.transport.openToolChanges(this.sessionKey, {
        onNotice: notice => {
          if (!current()) return;
          if (notice.operation !== 'tool') {
            this.toolFailure(new Error('Tool subscription needs a fresh history read.'));
            return;
          }
          this.putTool(notice.tool);
          if (!this.state.toolCallsLoading) this.publishTools();
        },
        onDoubt: reason => { if (current()) this.toolFailure(new Error(reason)); },
        onAuthorizationLost: reason => {
          if (current()) this.toolFailure(new AuthorizationError(reason));
        },
      }, controller.signal);
      const connection = await this.toolReadiness;
      if (!current()) { connection.close(); return; }
      this.toolConnection = connection;
      const range = { fromInclusive: this.state.records[0]?.seq ?? 0 };
      const calls = await this.transport.readToolCalls(this.sessionKey, range, controller.signal);
      if (!current()) return;
      for (const call of calls) this.putTool(call);
      this.publish({ toolCallsLoading: false });
      this.publishTools();
    } catch (error) {
      if (current()) this.toolFailure(error);
    }
  }

  private async olderTools(page: ConversationPage): Promise<void> {
    if (!this.state.toolCallsEnabled || !this.transport.readToolCalls || !this.toolController ||
        !page.records.length || this.state.toolCallsError) return;
    const epoch = this.toolEpoch;
    const range: ToolCallRange = { fromInclusive: page.records[0].seq,
      toExclusive: page.records[page.records.length - 1].seq + 1 };
    try {
      const controller = this.toolController;
      await this.toolReadiness;
      if (epoch !== this.toolEpoch || this.disposed) return;
      const calls = await this.transport.readToolCalls(this.sessionKey, range, controller.signal);
      if (epoch !== this.toolEpoch || this.disposed) return;
      for (const call of calls) this.putTool(call);
    } catch (error) {
      if (epoch === this.toolEpoch && !this.disposed) this.toolFailure(error);
    }
  }

  setToolCallsEnabled = (enabled: boolean): void => {
    if (this.disposed || !this.checkIdentity() || this.state.toolCallsEnabled === undefined ||
        this.state.toolCallsEnabled === enabled) return;
    this.stopTools();
    this.tools.clear();
    this.toolIndex = undefined;
    this.publish({ toolCallsEnabled: enabled, toolCalls: Object.freeze([]), toolCallIndex: undefined,
      toolCallsLoading: false, toolCallsError: undefined });
    if (enabled) void this.startTools();
  };

  retryToolCalls = (): void => { void this.startTools(); };

  private notifyHostSend(id: string, signal: HostSendSignal): void {
    for (const observer of [...(this.hostSendObservers.get(id) ?? [])]) observer(signal);
  }

  observeHostSend = (clientMessageId: string, observer: HostSendObserver): (() => void) => {
    let observers = this.hostSendObservers.get(clientMessageId);
    if (!observers) {
      observers = new Set();
      this.hostSendObservers.set(clientMessageId, observers);
    }
    observers.add(observer);
    return () => {
      const current = this.hostSendObservers.get(clientMessageId);
      current?.delete(observer);
      if (current?.size === 0) this.hostSendObservers.delete(clientMessageId);
    };
  };

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private checkIdentity(): boolean {
    if (identityEquals(this.identity, this.transport.currentIdentity())) return true;
    this.generation++;
    this.stopTools();
    this.controller?.abort();
    this.connectionController?.abort();
    this.connectionController = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.connectionBinding = undefined;
    this.connectionForRebuild = undefined;
    this.initializing = false;
    this.buffered = [];
    this.bufferedSession = undefined;
    for (const controller of this.sendControllers.values()) controller.abort();
    this.sendControllers.clear();
    this.rows.clear();
    this.tombstones.clear();
    this.turns.clear();
    this.cursor = null;
    this.restoreDepth = 0;
    this.publish({
      generation: this.generation, status: 'unauthorized',
      identityChanged: true,
      statusDetail: 'Host principal or device changed. Open a new component lifetime.',
      toolCalls: Object.freeze([]), toolCallIndex: undefined, toolCallsLoading: false, toolCallsError: undefined,
      records: Object.freeze([]), sends: Object.freeze([]), hasOlder: false,
      session: undefined, agentDisplayName: undefined, provenance: Object.freeze([]),
      activeTurn: undefined, historyError: undefined, loadingOlder: false,
      sessionError: undefined, sessionNotFound: undefined, conversationError: undefined, liveError: undefined,
    });
    return false;
  }

  private put(pageRecord: ConversationRecord): void {
    if (pageRecord.sessionKey !== this.sessionKey) return;
    if ((this.tombstones.get(pageRecord.id) ?? -1) >= pageRecord.rowVersion) return;
    const record = mergeRecord(this.rows.get(pageRecord.id), pageRecord);
    this.rows.set(record.id, record);
    if (record.kind === 'message' && record.clientMessageId && record.deviceId === this.identity.deviceId) {
      if (this.initializing) {
        this.pendingReconciledIds.add(record.clientMessageId);
        return;
      }
      const sends = this.state.sends.map((send) =>
        send.clientMessageId === record.clientMessageId && send.sessionKey === record.sessionKey
          ? { ...send, status: 'accepted' as const, reconciled: true, reason: undefined }
          : send,
      );
      if (sends.some((send, index) => send !== this.state.sends[index])) {
        this.publish({ sends: Object.freeze(sends) });
      }
      this.notifyHostSend(record.clientMessageId, { kind: 'reconciled' });
    }
  }

  private apply(notice: ChangeNotice): boolean {
    switch (notice.operation) {
      case 'upsert': {
        const record = notice.record;
        if (record.sessionKey !== this.sessionKey) return false;
        this.put(record);
        return true;
      }
      case 'delete': {
        if (notice.sessionKey !== this.sessionKey) return false;
        const prior = this.tombstones.get(notice.id) ?? -1;
        if (notice.rowVersion > prior) this.tombstones.set(notice.id, notice.rowVersion);
        const row = this.rows.get(notice.id);
        if (row && notice.rowVersion >= row.rowVersion) this.rows.delete(notice.id);
        return true;
      }
      case 'session':
        if (notice.session.sessionKey !== this.sessionKey) return false;
        if (this.initializing) {
          if (!this.bufferedSession || notice.session.rowVersion > this.bufferedSession.rowVersion) {
            this.bufferedSession = notice.session;
          }
          return false;
        }
        if (!this.state.session || notice.session.rowVersion > this.state.session.rowVersion) {
          this.publish({ session: notice.session, agentDisplayName: notice.session.displayName });
        }
        return false;
      case 'turn': {
        const turn = notice.turn;
        if (turn.sessionKey !== this.sessionKey) return false;
        const previous = this.turns.get(turn.seq);
        if (previous && Number(turn.raw.rowVersion ?? 0) < Number(previous.raw.rowVersion ?? 0)) return false;
        this.turns.set(turn.seq, turn);
        if (!this.initializing) this.publish({ activeTurn: undefined });
        return false;
      }
      case 'tool':
        return false; // Only the separate optional category connection owns tool records.
      case 'unknown':
        // These frames still advance the transport sequence, but they do not
        // change the selected transcript or justify replacing its snapshot.
        return false;
    }
  }

  private receive(notice: ChangeNotice, generation: number): void {
    if (!this.isCurrent(generation) || !this.checkIdentity()) return;
    if (this.initializing) {
      this.buffered.push(notice);
      return;
    }
    for (const captured of this.coverageReaders) captured.push(notice);
    if (this.apply(notice)) this.publish({ records: recordsFrom(this.rows) });
  }

  private doubt(reason: string, generation: number): void {
    if (!this.isCurrent(generation) || !this.checkIdentity()) return;
    this.connectionController?.abort();
    this.connectionController = undefined;
    if (this.initializing) {
      this.connection?.close();
      this.connection = undefined;
      this.connectionBinding = undefined;
      this.connectionForRebuild = undefined;
      this.buffered = [];
      this.bufferedSession = undefined;
      this.publish({ liveError: reason, activeTurn: undefined });
      return;
    }
    this.generation++;
    this.stopTools();
    this.controller?.abort();
    this.connection?.close();
    this.connection = undefined;
    this.connectionBinding = undefined;
    this.connectionForRebuild = undefined;
    this.rebuildPromise = undefined;
    this.initializing = false;
    this.publish({ generation: this.generation, status: 'ready', liveError: reason, activeTurn: undefined });
    this.scheduleRebuild();
  }

  private scheduleRebuild(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.rebuild();
    }, delay);
  }

  private failClosed(reason: string): void {
    this.generation++;
    this.initializing = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopTools();
    this.controller?.abort();
    this.connectionController?.abort();
    this.connectionController = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.connectionBinding = undefined;
    this.connectionForRebuild = undefined;
    for (const controller of this.sendControllers.values()) controller.abort();
    this.sendControllers.clear();
    this.rows.clear();
    this.tombstones.clear();
    this.cursor = null;
    this.restoreDepth = 0;
    this.turns.clear();
    this.publish({
      generation: this.generation, status: 'unauthorized', statusDetail: reason,
      toolCalls: Object.freeze([]), toolCallIndex: undefined, toolCallsLoading: false, toolCallsError: undefined,
      records: Object.freeze([]), sends: Object.freeze([]), session: undefined,
      agentDisplayName: undefined, provenance: noProvenance, provenanceAvailable: false, activeTurn: undefined,
      hasOlder: false, loadingOlder: false, historyError: undefined,
      sessionError: undefined, sessionNotFound: undefined, conversationError: undefined, liveError: undefined,
    });
  }

  rebuild = (options?: { restart?: boolean }): Promise<void> => {
    if (options?.restart) {
      if (this.disposed || this.state.status === 'unauthorized') return Promise.resolve();
      // A suspended connection/read can outlive the background interval. Start
      // a new generation instead of waiting for that attempt to settle.
      this.rebuildPromise = undefined;
      this.retryDelayMs = 250;
    }
    if (this.rebuildPromise) return this.rebuildPromise;
    // An explicit recovery supersedes a retry that may have been throttled.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const work = this.doRebuild();
    const tracked = work.finally(() => {
      if (this.rebuildPromise === tracked) this.rebuildPromise = undefined;
    });
    this.rebuildPromise = tracked;
    return tracked;
  };

  private async doRebuild(): Promise<void> {
    if (this.disposed || !this.checkIdentity()) return;
    const priorOldest = this.state.records[0];
    const priorDepth = this.restoreDepth;
    const reusableConnection = this.connectionForRebuild;
    this.connectionForRebuild = undefined;
    this.generation++;
    const generation = this.generation;
    this.stopTools();
    this.controller?.abort();
    if (reusableConnection && this.connection === reusableConnection && this.connectionBinding) {
      this.connectionBinding.generation = generation;
    } else {
      this.connectionController?.abort();
      this.connectionController = undefined;
      this.connection?.close();
      this.connection = undefined;
      this.connectionBinding = undefined;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.buffered = [];
    this.bufferedSession = undefined;
    this.pendingReconciledIds.clear();
    this.initializing = true;
    this.publish({
      generation, status: this.state.status === 'ready' || this.state.records.length ? 'ready' : 'loading',
      statusDetail: undefined, loadingOlder: false, activeTurn: undefined,
    });

    let liveError: string | undefined;
    try {
      let liveAttemptSettled = Boolean(this.connection);
      if (!this.connection) {
        const binding = { generation, doubted: false };
        const connectionController = new AbortController();
        this.connectionBinding = binding;
        this.connectionController = connectionController;
        let opening: Promise<ChangeConnection>;
        try {
          // Live updates are optional; do not wait for their handshake before
          // loading the conversation snapshot.
          opening = this.transport.openChanges(this.sessionKey, {
            onNotice: (notice) => this.receive(notice, binding.generation),
            onDoubt: (reason) => {
              binding.doubted = true;
              liveError = reason;
              this.doubt(reason, binding.generation);
            },
            onAuthorizationLost: (reason) => {
              binding.doubted = true;
              // This refusal applies to the optional live-update endpoint.
              // The session and transcript requests decide whether the
              // conversation itself is still available.
              this.doubt(reason, binding.generation);
            },
          }, connectionController.signal);
        } catch (error) {
          opening = Promise.reject(error);
        }
        void opening.then((connection) => {
          liveAttemptSettled = true;
          if (!this.isCurrent(binding.generation) || connectionController.signal.aborted || binding.doubted ||
              this.connectionBinding !== binding) {
            connection.close();
            return;
          }
          this.connection = connection;
          if (!this.initializing) {
            // Re-read with the now-ready stream to cover the gap between the
            // first REST snapshot and subscription readiness.
            this.connectionForRebuild = connection;
            this.scheduleRebuild();
          }
        }).catch((error) => {
          liveAttemptSettled = true;
          if (!this.isCurrent(binding.generation) || connectionController.signal.aborted) return;
          liveError = errorText(error);
          this.publish({ liveError });
          if (!this.initializing) this.scheduleRebuild();
        });
      }

      const [sessionResult, tailResult] = await Promise.allSettled([
        this.transport.readSession(this.sessionKey, controller.signal),
        this.transport.readTail(this.sessionKey, controller.signal),
      ] as const);
      if (!this.isCurrent(generation) || !this.checkIdentity()) return;
      const sessionFailure = sessionResult.status === 'rejected' ? sessionResult.reason : undefined;
      const tailFailure = tailResult.status === 'rejected' ? tailResult.reason : undefined;
      if (sessionFailure instanceof AuthorizationError || tailFailure instanceof AuthorizationError) {
        throw sessionFailure instanceof AuthorizationError ? sessionFailure : tailFailure;
      }

      let session: SessionRecord | undefined;
      let sessionError: string | undefined;
      let sessionNotFound = false;
      if (sessionResult.status === 'fulfilled') {
        if (sessionResult.value.sessionKey === this.sessionKey) session = sessionResult.value;
        else sessionError = 'The session endpoint returned a different conversation.';
      } else {
        sessionNotFound = sessionFailure instanceof SessionNotFoundError;
        sessionError = sessionNotFound ? 'This conversation no longer exists.' : errorText(sessionFailure);
      }

      let tail: ConversationPage | undefined;
      let conversationError: string | undefined;
      if (tailResult.status === 'fulfilled') {
        try {
          this.validatePage(tailResult.value);
          tail = tailResult.value;
        } catch (error) {
          if (error instanceof AuthorizationError) throw error;
          conversationError = errorText(error);
        }
      } else conversationError = errorText(tailFailure);

      let cursor = this.cursor;
      let hasOlder = this.state.hasOlder;
      let historyError: string | undefined;
      if (tail) {
        const candidate = new Map<string, ConversationRecord>();
        for (const record of tail.records) {
          const previous = candidate.get(record.id);
          candidate.set(record.id, mergeRecord(previous, record));
        }
        cursor = tail.oldestCursor;
        hasOlder = tail.hasOlder;
        let restored = 0;
        let restoreFailed = false;
        // Restore the previously visible depth from fresh canonical pages after a gap.
        while (hasOlder && cursor && priorOldest &&
          (restored < priorDepth ||
            [...candidate.values()].every((record) => compareRecords(record, priorOldest) > 0))) {
          try {
            const page = await this.transport.readOlder(this.sessionKey, cursor, controller.signal);
            if (!this.isCurrent(generation) || !this.checkIdentity()) return;
            this.validatePage(page);
            if (page.oldestCursor === cursor && page.hasOlder) {
              throw new UnsupportedTargetError('Older cursor did not advance.');
            }
            for (const record of page.records) {
              const previous = candidate.get(record.id);
              candidate.set(record.id, mergeRecord(previous, record));
            }
            cursor = page.oldestCursor;
            hasOlder = page.hasOlder;
            restored++;
          } catch (error) {
            historyError = errorText(error);
            restoreFailed = true;
            break;
          }
        }

        if (!restoreFailed) {
          this.rows.clear();
          this.tombstones.clear();
        }
        this.cursor = cursor;
        this.restoreDepth = restored;
        for (const record of candidate.values()) this.put(record);
      }

      if (!this.connection || !session || !tail || sessionError || conversationError) {
        this.connection?.close();
        this.connection = undefined;
        if (sessionNotFound) {
          this.connectionController?.abort();
          this.connectionController = undefined;
          this.connectionBinding = undefined;
        }
        this.buffered = [];
        this.bufferedSession = undefined;
        if (!liveError && (sessionError || conversationError)) {
          liveError = 'Live updates are paused while conversation data is unavailable.';
        }
      } else {
        const prefix: ChangeNotice[] = [];
        let coverageVerified = true;
        while (true) {
          prefix.push(...this.buffered.splice(0));
          try {
            if (!this.transport.proveCoverage(session, tail, prefix)) {
              liveError = 'The live connection could not verify conversation updates.';
              coverageVerified = false;
              break;
            }
          } catch (error) {
            liveError = errorText(error);
            coverageVerified = false;
            break;
          }
          if (this.buffered.length === 0) break;
        }
        if (coverageVerified) {
          for (const notice of prefix) this.apply(notice);
        } else {
          this.connection?.close();
          this.connection = undefined;
          this.connectionController?.abort();
          this.connectionController = undefined;
          this.connectionBinding = undefined;
          this.buffered = [];
          this.bufferedSession = undefined;
        }
      }

      if (!this.isCurrent(generation)) return;
      this.initializing = false;
      if (!this.connection && !liveError) {
        liveError = liveAttemptSettled ? 'Live updates are unavailable.' : 'Live updates are connecting.';
      }
      if (!liveError) this.retryDelayMs = 250;
      const sends = this.state.sends.map((send) => this.pendingReconciledIds.has(send.clientMessageId)
        ? { ...send, status: 'accepted' as const, reconciled: true, reason: undefined }
        : send);
      this.pendingReconciledIds.clear();
      const bufferedSession = this.connection ? this.bufferedSession : undefined;
      const currentSession = session
        ? bufferedSession && bufferedSession.rowVersion > session.rowVersion ? bufferedSession : session
        : sessionNotFound ? undefined : this.state.session;
      this.publish({
        status: 'ready', statusDetail: undefined, records: recordsFrom(this.rows), sends: Object.freeze(sends),
        session: currentSession, agentDisplayName: currentSession?.displayName ?? (sessionNotFound ? undefined : this.state.agentDisplayName),
        provenance: noProvenance, provenanceAvailable: false, activeTurn: undefined,
        hasOlder, historyError: tail ? historyError : this.state.historyError,
        sessionError, sessionNotFound, conversationError, liveError,
      });
      void this.startTools();
      for (const send of sends) {
        if (send.reconciled) this.notifyHostSend(send.clientMessageId, { kind: 'reconciled' });
      }
      // A synchronous callback may have buffered a notice during publication.
      for (const notice of this.buffered.splice(0)) this.receive(notice, generation);
      if (((liveError && liveAttemptSettled) || sessionError || conversationError) && !sessionNotFound) {
        this.scheduleRebuild();
      }
    } catch (error) {
      if (!this.isCurrent(generation) || controller.signal.aborted) return;
      this.initializing = false;
      this.connectionController?.abort();
      this.connectionController = undefined;
      this.connection?.close();
      this.connection = undefined;
      this.connectionBinding = undefined;
      this.connectionForRebuild = undefined;
      if (error instanceof AuthorizationError) {
        this.failClosed(errorText(error));
        return;
      }
      this.publish({ status: 'ready', statusDetail: undefined,
        conversationError: errorText(error), liveError: liveError ?? this.state.liveError });
      this.scheduleRebuild();
    }
  }

  private validatePage(page: ConversationPage): void {
    if (page.hasOlder && !page.oldestCursor) throw new UnsupportedTargetError('Older history has no opaque cursor.');
    for (const record of page.records) {
      if (record.sessionKey !== this.sessionKey) throw new UnsupportedTargetError('History page crossed session boundary.');
    }
    for (let index = 1; index < page.records.length; index++) {
      if (compareRecords(page.records[index - 1], page.records[index]) > 0) {
        throw new UnsupportedTargetError('History page is not chronological.');
      }
    }
  }

  loadOlder = async (): Promise<void> => {
    if (this.disposed || !this.checkIdentity() || this.state.status !== 'ready' ||
      !this.state.hasOlder || !this.cursor || this.state.loadingOlder) return;
    const generation = this.generation;
    const cursor = this.cursor;
    const signal = this.controller?.signal;
    if (!signal) return;
    this.publish({ loadingOlder: true, historyError: undefined });
    try {
      const page = await this.transport.readOlder(this.sessionKey, cursor, signal);
      if (!this.isCurrent(generation) || !this.checkIdentity()) return;
      this.validatePage(page);
      if (page.hasOlder && page.oldestCursor === cursor) throw new InvalidCursorError('Older cursor did not advance.');
      await this.olderTools(page);
      if (!this.isCurrent(generation) || !this.checkIdentity()) return;
      for (const record of page.records) this.put(record);
      this.cursor = page.oldestCursor;
      this.restoreDepth++;
      this.publish({ records: recordsFrom(this.rows), hasOlder: page.hasOlder, loadingOlder: false });
      this.publishTools();
    } catch (error) {
      if (!this.isCurrent(generation) || signal.aborted) return;
      this.publish({ loadingOlder: false, historyError: errorText(error) });
    }
  };

  send = (content: string, clientMessageId?: string, hostSend?: HostSendContext): string | null => {
    if (!content.trim() || this.disposed || !this.checkIdentity() || this.state.status === 'unauthorized') return null;
    const id = clientMessageId ?? `c_${crypto.randomUUID()}`;
    if (clientMessageId && !hostCorrelationPattern.test(clientMessageId)) return null;
    if (this.state.sends.some((send) => send.clientMessageId === id)) return null;
    const submission: HumanSubmission = Object.freeze({
      sessionKey: this.sessionKey, deviceId: this.identity.deviceId,
      clientMessageId: id, content,
    });
    const send: LocalSend = Object.freeze({ ...submission, submittedAt: new Date().toISOString(),
      status: 'pending', reconciled: false, ...(hostSend ? { hostSend: Object.freeze({ ...hostSend }) } : {}) });
    this.publish({ sends: Object.freeze([...this.state.sends, send]) });
    void this.post(submission);
    return submission.clientMessageId;
  };

  private async post(submission: HumanSubmission): Promise<void> {
    const controller = new AbortController();
    this.sendControllers.set(submission.clientMessageId, controller);
    try {
      let result: HumanSendResult;
      let retryDelayMs = humanSendRetryInitialDelayMs;
      while (true) {
        try {
          result = await this.transport.sendHuman(submission, controller.signal);
        } catch (error) {
          if (error instanceof AuthorizationError) throw error;
          result = { outcome: 'unreachable', reason: 'Not connected to the server.' };
        }
        if (controller.signal.aborted || !this.checkIdentity()) return;
        const current = this.state.sends.find((send) => send.clientMessageId === submission.clientMessageId);
        if (!current) return;
        if (current.reconciled) {
          result = { outcome: 'accepted' };
          break;
        }
        const shouldReask = result.outcome === 'retryable' || result.outcome === 'unreachable';
        if (!shouldReask) break;
        // A send socket may fail before posting or drop after the Gateway has
        // accepted the post. Keep showing a nonterminal connection notice and
        // re-ask with the identical ID/content until the server answers or
        // canonical history settles it. A capped backoff paces reconnects; it
        // never ends a live acknowledgement wait or turns disconnection into a
        // final delivery failure.
        if (this.state.status === 'unauthorized') return;
        if (!this.profile.capabilities.humanSendDedupe) {
          result = { outcome: 'uncertain', reason: 'retry-unavailable' };
          break;
        }
        if (result.outcome === 'unreachable') {
          this.updateSend(submission.clientMessageId, (send) => send.reconciled ? send
            : { ...send, status: 'pending', reason: 'unreachable' });
        }
        if (!await waitForHumanSendRetry(controller.signal, retryDelayMs)) return;
        if (controller.signal.aborted || !this.checkIdentity()) return;
        const statusAfterWait = this.getSnapshot().status;
        const resumed = this.state.sends.find((send) => send.clientMessageId === submission.clientMessageId);
        if (!resumed) return;
        if (resumed.reconciled) {
          result = { outcome: 'accepted' };
          break;
        }
        if (statusAfterWait === 'unauthorized') return;
        this.updateSend(submission.clientMessageId, (send) => send.reconciled ? send
          : { ...send, status: 'pending', reason: undefined });
        retryDelayMs = Math.min(retryDelayMs * 2, humanSendRetryMaxDelayMs);
      }
      if (!this.checkIdentity() || controller.signal.aborted) return;
      this.updateSend(submission.clientMessageId, (send) => {
        if (send.reconciled) return send;
        return result.outcome === 'accepted'
          ? { ...send, status: 'accepted', reason: undefined }
          : result.outcome === 'refused'
            ? { ...send, status: 'failed', reason: result.reason }
            : result.outcome === 'unreachable'
              ? { ...send, status: 'failed', reason: 'unreachable' }
              : { ...send, status: 'uncertain', reason: result.reason };
      });
      if (result.outcome === 'accepted') this.notifyHostSend(submission.clientMessageId, { kind: 'accepted' });
      else if (result.outcome === 'refused') this.notifyHostSend(submission.clientMessageId, {
        kind: 'failed', reason: 'refused', detail: result.reason,
      });
      else if (result.outcome === 'unreachable') this.notifyHostSend(submission.clientMessageId, {
        kind: 'failed', reason: 'retry-unavailable', detail: 'Not connected to the server.',
      });
      else this.notifyHostSend(submission.clientMessageId, { kind: 'uncertain', reason: 'ack-lost' });
    } catch (error) {
      if (!controller.signal.aborted && this.checkIdentity()) {
        if (error instanceof AuthorizationError) {
          this.notifyHostSend(submission.clientMessageId, {
            kind: 'failed', reason: 'refused', detail: 'unauthorized',
          });
          this.failClosed(errorText(error));
          return;
        }
        this.updateSend(submission.clientMessageId, (send) => send.reconciled ? send
          : { ...send, status: 'uncertain', reason: errorText(error) });
        this.notifyHostSend(submission.clientMessageId, { kind: 'uncertain', reason: 'ack-lost' });
      }
    } finally {
      if (this.sendControllers.get(submission.clientMessageId) === controller) {
        this.sendControllers.delete(submission.clientMessageId);
      }
    }
  }

  private updateSend(id: string, update: (send: LocalSend) => LocalSend): void {
    this.publish({ sends: Object.freeze(this.state.sends.map((send) =>
      send.clientMessageId === id ? update(send) : send,
    )) });
  }

  retrySend = async (clientMessageId: string): Promise<void> => {
    if (this.disposed || !this.checkIdentity()) return;
    if (this.state.status === 'unauthorized') return;
    const send = this.state.sends.find((item) => item.clientMessageId === clientMessageId);
    if (!send || !['failed', 'uncertain'].includes(send.status) || send.reconciled ||
        !this.profile.capabilities.humanSendDedupe) return;
    // Rebuild/query first. Absence from a bounded tail does not mean rejection.
    await this.rebuild();
    if (this.disposed || !this.checkIdentity() || this.state.status === 'unauthorized') return;
    const current = this.state.sends.find((item) => item.clientMessageId === clientMessageId);
    if (!current || current.reconciled || !['failed', 'uncertain'].includes(current.status)) return;
    this.updateSend(clientMessageId, (item) => ({ ...item, status: 'pending', reason: undefined }));
    await this.post({
      sessionKey: send.sessionKey, deviceId: send.deviceId,
      clientMessageId: send.clientMessageId, content: send.content,
    });
  };

  refreshHostSend = async (clientMessageId: string): Promise<'found' | 'absent' | 'unavailable'> => {
    if (this.disposed || !this.checkIdentity() || this.state.status === 'unauthorized' || !this.controller) return 'unavailable';
    const generation = this.generation;
    const signal = this.controller.signal;
    const captured: ChangeNotice[] = [];
    this.coverageReaders.add(captured);
    try {
      const page = await this.transport.readTail(this.sessionKey, signal);
      if (!this.isCurrent(generation) || !this.checkIdentity() || signal.aborted) return 'unavailable';
      // The ready runtime owns the latest session snapshot through initialization
      // and versioned session notices. Host-send reconciliation needs only the
      // canonical tail rows, so do not make this per-send refresh depend on a
      // second session-detail request.
      const session = this.state.session;
      if (!session || session.sessionKey !== this.sessionKey) {
        throw new UnsupportedTargetError('Ready session snapshot is unavailable for canonical refresh.');
      }
      this.validatePage(page);
      if (!this.transport.proveCoverage(session, page, captured)) {
        throw new UnsupportedTargetError('Canonical refresh lacks verified subscription coverage.');
      }
      for (const record of page.records) this.put(record);
      this.publish({ records: recordsFrom(this.rows) });
      const found = [...this.rows.values()].some((record) => record.kind === 'message' &&
        record.sessionKey === this.sessionKey && record.deviceId === this.identity.deviceId &&
        record.clientMessageId === clientMessageId);
      return found ? 'found' : 'absent';
    } catch (error) {
      if (!this.isCurrent(generation) || signal.aborted) return 'unavailable';
      return 'unavailable';
    } finally {
      this.coverageReaders.delete(captured);
    }
  };

  retryHostSend = (clientMessageId: string, content: string, hostSend?: HostSendContext): void => {
    if (this.disposed || !this.checkIdentity() || this.state.status === 'unauthorized' ||
        !hostCorrelationPattern.test(clientMessageId) || !content.trim()) {
      this.notifyHostSend(clientMessageId, { kind: 'uncertain', reason: 'ack-lost' });
      return;
    }
    const previous = this.state.sends.find((send) => send.clientMessageId === clientMessageId);
    if (previous && previous.content !== content) return;
    const submission: HumanSubmission = Object.freeze({ sessionKey: this.sessionKey,
      deviceId: this.identity.deviceId, clientMessageId, content });
    const local: LocalSend = Object.freeze({ ...submission,
      submittedAt: previous?.submittedAt ?? new Date().toISOString(), status: 'pending', reconciled: false,
      ...(hostSend ? { hostSend: Object.freeze({ ...hostSend }) } : {}) });
    this.publish({ sends: Object.freeze(previous
      ? this.state.sends.map((send) => send.clientMessageId === clientMessageId ? local : send)
      : [...this.state.sends, local]) });
    void (async () => {
      const canonical = await this.refreshHostSend(clientMessageId);
      if (canonical === 'found') {
        this.notifyHostSend(clientMessageId, { kind: 'reconciled' });
        return;
      }
      if (canonical === 'unavailable') {
        this.updateSend(clientMessageId, (send) => send.reconciled ? send
          : { ...send, status: 'uncertain', reason: 'Canonical history could not be checked before retry.' });
        this.notifyHostSend(clientMessageId, { kind: 'uncertain', reason: 'ack-lost' });
        return;
      }
      if (!this.profile.capabilities.humanSendDedupe) {
        this.updateSend(clientMessageId, (send) => ({ ...send, status: 'failed', reason: 'Retry is unavailable for this target.' }));
        this.notifyHostSend(clientMessageId, { kind: 'failed', reason: 'retry-unavailable' });
        return;
      }
      if (this.disposed || !this.checkIdentity() || this.state.status === 'unauthorized') {
        this.updateSend(clientMessageId, (send) => ({ ...send, status: 'uncertain', reason: 'Connection changed before retry.' }));
        this.notifyHostSend(clientMessageId, { kind: 'uncertain', reason: 'ack-lost' });
        return;
      }
      void this.post(submission);
    })();
  };

  recordHostSendOutcome = (clientMessageId: string, hostSend: HostSendContext,
    outcome: 'delivered' | 'failed' | 'uncertain'): void => {
    const current = this.state.sends.find((send) => send.clientMessageId === clientMessageId);
    if (!current?.hostSend || current.hostSend.lifetimeId !== hostSend.lifetimeId ||
        current.hostSend.attempt !== hostSend.attempt) return;
    this.updateSend(clientMessageId, (send) => ({
      ...send,
      hostSend: { ...hostSend, outcome },
    }));
  };

  markHostSendUncertain = (clientMessageId: string, reason: 'accepted-unreconciled'): void => {
    this.updateSend(clientMessageId, (send) => send.reconciled ? send
      : { ...send, status: 'uncertain', reason: 'Accepted, but no matching canonical row appeared in the refreshed conversation.' });
    this.notifyHostSend(clientMessageId, { kind: 'uncertain', reason });
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopTools();
    this.controller?.abort();
    this.connectionController?.abort();
    this.connectionController = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.connectionBinding = undefined;
    this.connectionForRebuild = undefined;
    for (const controller of this.sendControllers.values()) controller.abort();
    this.sendControllers.clear();
    this.listeners.clear();
  };
}
