import {
  AuthorizationError,
  InvalidCursorError,
  UnsupportedTargetError,
  type ChangeConnection,
  type ChangeNotice,
  type ChatRuntime,
  type ChatTransport,
  type CanonicalTurn,
  type ConversationPage,
  type ConversationRecord,
  type HostIdentity,
  type HumanSubmission,
  type LocalSend,
  type RuntimeState,
  type SessionRecord,
  type TargetCapabilities,
  type TargetProfile,
  type TightbeamAdapter,
  type TurnProvenance,
} from './types';
import { createTurnProvenance, turnSourceKind } from './provenance';

const requiredCapabilities: readonly (keyof TargetCapabilities)[] = [
  'newestTail', 'stableOlderCursor', 'retainedHistoryAcrossResets',
  'orderedTransitions', 'snapshotCoverage', 'versionedNotices', 'humanSendDedupe',
  'authoritativeTurnProvenance',
];

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

/** A target-independent runtime. Its transport is the only backend-specific code. */
export function createTightbeamAdapter(transport: ChatTransport, profile: TargetProfile): TightbeamAdapter {
  return { open: (sessionKey) => new SessionRuntime(sessionKey, transport, profile) };
}

class SessionRuntime implements ChatRuntime {
  private state: RuntimeState;
  private readonly listeners = new Set<() => void>();
  private readonly identity: HostIdentity;
  private readonly rows = new Map<string, ConversationRecord>();
  private readonly tombstones = new Map<string, number>();
  // Notices for rows below the loaded slice can race an older-page read.
  private readonly pendingHistoryUpserts = new Map<string, ConversationRecord>();
  private readonly sendControllers = new Map<string, AbortController>();
  private readonly pendingReconciledIds = new Set<string>();
  private connection: ChangeConnection | undefined;
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
  private provenanceRefreshToken = 0;

  constructor(
    private readonly sessionKey: string,
    private readonly transport: ChatTransport,
    private readonly profile: TargetProfile,
  ) {
    this.identity = transport.currentIdentity();
    this.state = Object.freeze({
      sessionKey, generation: 0, status: 'loading', records: Object.freeze([]),
      hasOlder: false, loadingOlder: false, sends: Object.freeze([]), targetLabel: profile.label,
      targetGateway: transport.targetGateway, provenance: Object.freeze([]),
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
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private checkIdentity(): boolean {
    if (identityEquals(this.identity, this.transport.currentIdentity())) return true;
    this.generation++;
    this.controller?.abort();
    this.connection?.close();
    this.connection = undefined;
    for (const controller of this.sendControllers.values()) controller.abort();
    this.sendControllers.clear();
    this.rows.clear();
    this.tombstones.clear();
    this.pendingHistoryUpserts.clear();
    this.publish({
      generation: this.generation, status: 'unauthorized',
      statusDetail: 'Host principal or device changed. Open a new component lifetime.',
      records: Object.freeze([]), sends: Object.freeze([]), hasOlder: false,
      session: undefined, agentDisplayName: undefined, provenance: Object.freeze([]),
      activeTurn: undefined, historyError: undefined,
    });
    return false;
  }

  private checkTarget(observed: Awaited<ReturnType<ChatTransport['inspectTarget']>>): void {
    if (observed.identity !== this.profile.identity) {
      throw new UnsupportedTargetError(`Target identity ${observed.identity} does not match ${this.profile.identity}.`);
    }
    for (const capability of requiredCapabilities) {
      if (!this.profile.capabilities[capability] || !observed.capabilities[capability]) {
        throw new UnsupportedTargetError(`Required target capability ${capability} is unverified.`);
      }
    }
  }

  private put(pageRecord: ConversationRecord): void {
    const pending = this.pendingHistoryUpserts.get(pageRecord.id);
    this.pendingHistoryUpserts.delete(pageRecord.id);
    const record = pending && pending.rowVersion > pageRecord.rowVersion ? pending : pageRecord;
    if (record.sessionKey !== this.sessionKey) return;
    if ((this.tombstones.get(record.id) ?? -1) >= record.rowVersion) return;
    const previous = this.rows.get(record.id);
    if (!previous || record.rowVersion > previous.rowVersion) this.rows.set(record.id, record);
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
    }
  }

  private reconcilePendingHistory(hasOlder: boolean): void {
    const oldest = [...this.rows.values()].sort(compareRecords)[0];
    for (const record of this.pendingHistoryUpserts.values()) {
      // A page may have been captured before a newly inserted row appeared.
      if (!hasOlder || (oldest && compareRecords(record, oldest) >= 0)) this.put(record);
    }
  }

  private apply(notice: ChangeNotice): boolean {
    switch (notice.operation) {
      case 'upsert': {
        const record = notice.record;
        if (record.sessionKey !== this.sessionKey) return false;
        const oldest = [...this.rows.values()].sort(compareRecords)[0];
        // A notice below the loaded slice cannot create a disconnected history island.
        if (oldest && compareRecords(record, oldest) < 0 && !this.rows.has(record.id)) {
          if (!this.initializing && !this.state.hasOlder) {
            this.put(record);
            return true;
          }
          const prior = this.pendingHistoryUpserts.get(record.id);
          if (!prior || record.rowVersion > prior.rowVersion) this.pendingHistoryUpserts.set(record.id, record);
          return false;
        }
        this.put(record);
        return true;
      }
      case 'delete': {
        if (notice.sessionKey !== this.sessionKey) return false;
        const prior = this.tombstones.get(notice.id) ?? -1;
        if (notice.rowVersion > prior) this.tombstones.set(notice.id, notice.rowVersion);
        if ((this.pendingHistoryUpserts.get(notice.id)?.rowVersion ?? -1) <= notice.rowVersion) {
          this.pendingHistoryUpserts.delete(notice.id);
        }
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
      case 'ignore':
        return false;
      case 'observe':
      case 'unknown':
        if (notice.sessionKey === this.sessionKey) this.doubt(`State notice ${notice.resource} requires a fresh snapshot.`, this.generation);
        return false;
    }
  }

  private receive(notice: ChangeNotice, generation: number): void {
    if (!this.isCurrent(generation) || !this.checkIdentity()) return;
    if (this.initializing) {
      this.buffered.push(notice);
      return;
    }
    if (this.apply(notice)) {
      this.publish({ records: recordsFrom(this.rows) });
      if (notice.operation === 'upsert' && notice.record.kind === 'message') {
        void this.refreshLiveProvenance(generation);
      }
    }
  }

  private markPendingUncertain(reason: string): void {
    const sends = this.state.sends.map((send) =>
      send.status === 'pending' ? { ...send, status: 'uncertain' as const, reason } : send,
    );
    for (const controller of this.sendControllers.values()) controller.abort();
    this.sendControllers.clear();
    this.publish({ sends: Object.freeze(sends) });
  }

  private doubt(reason: string, generation: number): void {
    if (!this.isCurrent(generation) || !this.checkIdentity()) return;
    this.markPendingUncertain(reason);
    this.generation++;
    this.controller?.abort();
    this.connection?.close();
    this.connection = undefined;
    this.rebuildPromise = undefined;
    this.initializing = false;
    this.publish({ generation: this.generation, status: 'stale', statusDetail: reason, activeTurn: undefined });
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

  private failClosed(status: 'unauthorized' | 'unsupported', reason: string): void {
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const sends = status === 'unsupported'
      ? Object.freeze(this.state.sends.map((send) => send.status === 'pending'
        ? { ...send, status: 'uncertain' as const,
          reason: 'Target became unsupported before acknowledgement; send outcome is unknown.' }
        : send))
      : Object.freeze([]);
    this.controller?.abort();
    this.connection?.close();
    this.connection = undefined;
    for (const controller of this.sendControllers.values()) controller.abort();
    this.sendControllers.clear();
    this.rows.clear();
    this.tombstones.clear();
    this.pendingHistoryUpserts.clear();
    this.cursor = null;
    this.restoreDepth = 0;
    this.publish({
      generation: this.generation, status, statusDetail: reason,
      records: Object.freeze([]), sends, session: undefined,
      agentDisplayName: undefined, provenance: Object.freeze([]), activeTurn: undefined,
      hasOlder: false, loadingOlder: false, historyError: undefined,
    });
  }

  private async readProvenance(
    records: readonly ConversationRecord[],
    recentTurns: readonly CanonicalTurn[],
    signal: AbortSignal,
    previous: readonly TurnProvenance[],
    refreshAll: boolean,
  ): Promise<{ provenance: readonly TurnProvenance[]; activeTurn?: TurnProvenance }> {
    const bySequence = new Map(previous.map((item) => [item.turn.seq, item]));
    const recentBySequence = new Map(recentTurns.map((turn) => [turn.seq, turn]));
    const active = recentTurns.filter((turn) => turn.status === 'running')
      .sort((a, b) => b.seq - a.seq)[0];
    const recordById = new Map(records.filter((record): record is Extract<ConversationRecord, { kind: 'message' }> =>
      record.kind === 'message').map((record) => [record.id, record]));
    const sequences = new Set<number>();
    for (const record of records) if (record.kind === 'message' && record.turnSeq) sequences.add(record.turnSeq);
    for (const turn of recentTurns) if (recordById.has(turn.messageId)) sequences.add(turn.seq);
    if (active) sequences.add(active.seq);

    const resolved: TurnProvenance[] = [];
    for (const seq of [...sequences].sort((a, b) => a - b)) {
      const prior = bySequence.get(seq);
      const listed = recentBySequence.get(seq);
      if (!refreshAll && prior && !listed) {
        resolved.push(prior);
        continue;
      }
      const turn = listed ?? (prior && !refreshAll
        ? prior.turn
        : await this.transport.readTurn(this.sessionKey, seq, signal));
      if (!turn) continue;
      if (turn.sessionKey !== this.sessionKey || !Number.isSafeInteger(turn.seq) || turn.seq !== seq) {
        throw new UnsupportedTargetError('Turn provenance crossed the selected session or sequence boundary.');
      }

      const loadedTrigger = recordById.get(turn.messageId);
      let trigger = loadedTrigger;
      if (!trigger && !refreshAll && prior?.trigger?.id === turn.messageId) trigger = prior.trigger;
      if (!trigger) trigger = (await this.transport.readMessage(this.sessionKey, turn.messageId, signal)) ?? undefined;
      if (trigger && (trigger.sessionKey !== this.sessionKey || trigger.id !== turn.messageId)) {
        throw new UnsupportedTargetError('Trigger message crossed the selected session or message boundary.');
      }

      const provisional = createTurnProvenance(turn, trigger);
      let sourceDisplayName: string | undefined;
      if (turn.seq === active?.seq && turnSourceKind(provisional.captionOrigin) === 'agent') {
        sourceDisplayName = await this.transport.resolveOriginDisplayName(provisional.captionOrigin, signal);
      }
      resolved.push(createTurnProvenance(turn, trigger, sourceDisplayName));
    }
    const frozen = Object.freeze(resolved);
    return { provenance: frozen, activeTurn: active ? resolved.find((item) => item.turn.seq === active.seq) : undefined };
  }

  private async refreshLiveProvenance(generation: number): Promise<void> {
    const controller = this.controller;
    if (!controller || !this.isCurrent(generation) || controller.signal.aborted) return;
    const refreshToken = ++this.provenanceRefreshToken;
    try {
      const currentTurn = this.state.activeTurn?.turn;
      const result = await this.readProvenance(recordsFrom(this.rows), currentTurn ? [currentTurn] : [],
        controller.signal, this.state.provenance ?? [], false);
      if (!this.isCurrent(generation) || controller.signal.aborted || refreshToken !== this.provenanceRefreshToken) return;
      this.publish(result);
    } catch (error) {
      if (!this.isCurrent(generation) || controller.signal.aborted) return;
      if (error instanceof AuthorizationError) {
        this.failClosed('unauthorized', errorText(error));
      } else if (error instanceof UnsupportedTargetError) {
        this.failClosed('unsupported', errorText(error));
      } else {
        this.doubt(`Message provenance could not be refreshed: ${errorText(error)}`, generation);
      }
    }
  }

  rebuild = (): Promise<void> => {
    if (this.rebuildPromise) return this.rebuildPromise;
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
    this.generation++;
    const generation = this.generation;
    this.markPendingUncertain('Connection rebuilt before acknowledgement.');
    this.controller?.abort();
    this.connection?.close();
    this.connection = undefined;
    const controller = new AbortController();
    this.controller = controller;
    this.buffered = [];
    this.bufferedSession = undefined;
    this.pendingReconciledIds.clear();
    this.pendingHistoryUpserts.clear();
    this.initializing = true;
    this.publish({
      generation, status: this.state.records.length ? 'stale' : 'loading',
      statusDetail: undefined, loadingOlder: false, historyError: undefined, activeTurn: undefined,
    });

    try {
      const observed = await this.transport.inspectTarget(controller.signal);
      if (!this.isCurrent(generation) || !this.checkIdentity()) return;
      this.checkTarget(observed);
      // openChanges must resolve only after selected-session subscription_ready.
      const connection = await this.transport.openChanges(this.sessionKey, {
        onNotice: (notice) => this.receive(notice, generation),
        onDoubt: (reason) => this.doubt(reason, generation),
      }, controller.signal);
      if (!this.isCurrent(generation) || !this.checkIdentity()) {
        connection.close();
        return;
      }
      this.connection = connection;

      let [session, tail, recentTurns] = await Promise.all([
        this.transport.readSession(this.sessionKey, controller.signal),
        this.transport.readTail(this.sessionKey, controller.signal),
        this.transport.readRecentTurns(this.sessionKey, controller.signal),
      ]);
      if (!this.isCurrent(generation) || !this.checkIdentity()) return;
      if (session.sessionKey !== this.sessionKey) throw new UnsupportedTargetError('Session read returned another selection.');
      this.validatePage(tail);
      const candidate = new Map<string, ConversationRecord>();
      for (const record of tail.records) {
        const previous = candidate.get(record.id);
        if (!previous || record.rowVersion > previous.rowVersion) candidate.set(record.id, record);
      }
      let cursor = tail.oldestCursor;
      let hasOlder = tail.hasOlder;
      let restored = 0;
      // Restore the previously visible depth from fresh canonical pages after a gap.
      while (hasOlder && cursor && priorOldest &&
        (restored < priorDepth ||
          [...candidate.values()].every((record) => compareRecords(record, priorOldest) > 0))) {
        const page = await this.transport.readOlder(this.sessionKey, cursor, controller.signal);
        if (!this.isCurrent(generation) || !this.checkIdentity()) return;
        this.validatePage(page);
        if (page.oldestCursor === cursor && page.hasOlder) throw new UnsupportedTargetError('Older cursor did not advance.');
        for (const record of page.records) {
          const previous = candidate.get(record.id);
          if (!previous || record.rowVersion > previous.rowVersion) candidate.set(record.id, record);
        }
        cursor = page.oldestCursor;
        hasOlder = page.hasOlder;
        restored++;
      }

      // Refetch complete session state for observations before choosing the finite
      // publication cut. Rows emitted while a refresh is in flight belong to the
      // same candidate, rather than appearing only after the first ready snapshot.
      this.rows.clear();
      this.tombstones.clear();
      this.cursor = cursor;
      this.restoreDepth = restored;
      for (const record of candidate.values()) this.put(record);
      this.reconcilePendingHistory(hasOlder);

      const prefix: ChangeNotice[] = [];
      let provenance: readonly TurnProvenance[] = Object.freeze([]);
      let activeTurn: TurnProvenance | undefined;
      let refreshAll = true;
      while (true) {
        const next = this.buffered.splice(0);
        prefix.push(...next);
        let refreshTurnState = next.some((notice) => notice.operation === 'observe');
        if (next.some((notice) => notice.operation === 'upsert' || notice.operation === 'delete')) refreshAll = true;
        for (const notice of next) if (notice.operation !== 'observe') this.apply(notice);
        if (refreshTurnState) {
          [session, recentTurns] = await Promise.all([
            this.transport.readSession(this.sessionKey, controller.signal),
            this.transport.readRecentTurns(this.sessionKey, controller.signal),
          ]);
          if (!this.isCurrent(generation) || !this.checkIdentity()) return;
          if (session.sessionKey !== this.sessionKey) {
            throw new UnsupportedTargetError('Session refresh returned another selection.');
          }
        }
        if (!this.transport.proveCoverage(session, tail, prefix)) {
          throw new UnsupportedTargetError('Snapshot and buffered notices lack verified coverage.');
        }
        const hydrated = await this.readProvenance(recordsFrom(this.rows), recentTurns, controller.signal,
          provenance, refreshAll);
        if (!this.isCurrent(generation) || !this.checkIdentity()) return;
        provenance = hydrated.provenance;
        activeTurn = hydrated.activeTurn;
        refreshAll = false;
        if (this.buffered.length === 0) break;
      }
      if (!this.isCurrent(generation)) return;
      this.initializing = false;
      this.retryDelayMs = 250;
      const sends = this.state.sends.map((send) => this.pendingReconciledIds.has(send.clientMessageId)
        ? { ...send, status: 'accepted' as const, reconciled: true, reason: undefined }
        : send);
      this.pendingReconciledIds.clear();
      const bufferedSession = this.bufferedSession as SessionRecord | undefined;
      const currentSession = bufferedSession && bufferedSession.rowVersion > session.rowVersion ? bufferedSession : session;
      this.publish({
        status: 'ready', statusDetail: undefined, records: recordsFrom(this.rows), sends: Object.freeze(sends),
        session: currentSession, agentDisplayName: currentSession.displayName,
        provenance, activeTurn,
        hasOlder, historyError: undefined,
      });
      // A synchronous callback may have buffered a notice during publication.
      for (const notice of this.buffered.splice(0)) this.receive(notice, generation);
    } catch (error) {
      if (!this.isCurrent(generation) || controller.signal.aborted) return;
      this.initializing = false;
      this.connection?.close();
      this.connection = undefined;
      const status = error instanceof AuthorizationError ? 'unauthorized'
        : error instanceof UnsupportedTargetError ? 'unsupported' : 'error';
      if (status === 'unauthorized' || status === 'unsupported') {
        this.failClosed(status, errorText(error));
        return;
      }
      this.publish({ status, statusDetail: errorText(error) });
      if (status === 'error') this.scheduleRebuild();
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
      const candidate = new Map(this.rows);
      for (const record of [...page.records, ...this.pendingHistoryUpserts.values()]) {
        if ((this.tombstones.get(record.id) ?? -1) >= record.rowVersion) continue;
        const previous = candidate.get(record.id);
        if (!previous || record.rowVersion > previous.rowVersion) candidate.set(record.id, record);
      }
      const active = this.state.activeTurn?.turn;
      const hydrated = await this.readProvenance(recordsFrom(candidate), active ? [active] : [], signal,
        this.state.provenance ?? [], false);
      if (!this.isCurrent(generation) || !this.checkIdentity()) return;
      for (const record of page.records) this.put(record);
      this.reconcilePendingHistory(page.hasOlder);
      this.cursor = page.oldestCursor;
      this.restoreDepth++;
      this.publish({ records: recordsFrom(this.rows), provenance: hydrated.provenance, activeTurn: hydrated.activeTurn,
        hasOlder: page.hasOlder, loadingOlder: false });
    } catch (error) {
      if (!this.isCurrent(generation) || signal.aborted) return;
      if (error instanceof AuthorizationError) {
        this.failClosed('unauthorized', errorText(error));
        return;
      }
      if (error instanceof UnsupportedTargetError) {
        this.failClosed('unsupported', errorText(error));
        return;
      }
      if (error instanceof InvalidCursorError) {
        this.doubt(errorText(error), generation);
        return;
      }
      this.publish({ loadingOlder: false, historyError: errorText(error) });
    }
  };

  send = (content: string): string | null => {
    if (!content.trim() || this.disposed || !this.checkIdentity() || this.state.status !== 'ready') return null;
    const submission: HumanSubmission = Object.freeze({
      sessionKey: this.sessionKey, deviceId: this.identity.deviceId,
      clientMessageId: `c_${crypto.randomUUID()}`, content,
    });
    const send: LocalSend = Object.freeze({ ...submission, submittedAt: new Date().toISOString(),
      status: 'pending', reconciled: false });
    this.publish({ sends: Object.freeze([...this.state.sends, send]) });
    void this.post(submission);
    return submission.clientMessageId;
  };

  private async post(submission: HumanSubmission): Promise<void> {
    const generation = this.generation;
    const controller = new AbortController();
    this.sendControllers.set(submission.clientMessageId, controller);
    try {
      const result = await this.transport.sendHuman(submission, controller.signal);
      if (!this.isCurrent(generation) || !this.checkIdentity()) return;
      this.updateSend(submission.clientMessageId, (send) => {
        if (send.reconciled) return send;
        return result.outcome === 'accepted'
          ? { ...send, status: 'accepted', reason: undefined }
          : result.outcome === 'refused'
            ? { ...send, status: 'failed', reason: result.reason }
            : { ...send, status: 'uncertain', reason: result.reason };
      });
    } catch (error) {
      if (this.isCurrent(generation) && !controller.signal.aborted) {
        if (error instanceof AuthorizationError) {
          this.failClosed('unauthorized', errorText(error));
          return;
        }
        this.updateSend(submission.clientMessageId, (send) => send.reconciled ? send
          : { ...send, status: 'uncertain', reason: errorText(error) });
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
    if (this.state.status === 'unsupported') return;
    const send = this.state.sends.find((item) => item.clientMessageId === clientMessageId);
    if (!send || !['failed', 'uncertain'].includes(send.status) || send.reconciled ||
        !this.profile.capabilities.humanSendDedupe) return;
    // Rebuild/query first. Absence from a bounded tail does not mean rejection.
    await this.rebuild();
    if (this.disposed || !this.checkIdentity() || this.state.status !== 'ready') return;
    const current = this.state.sends.find((item) => item.clientMessageId === clientMessageId);
    if (!current || current.reconciled || !['failed', 'uncertain'].includes(current.status)) return;
    this.updateSend(clientMessageId, (item) => ({ ...item, status: 'pending', reason: undefined }));
    await this.post({
      sessionKey: send.sessionKey, deviceId: send.deviceId,
      clientMessageId: send.clientMessageId, content: send.content,
    });
  };

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.controller?.abort();
    this.connection?.close();
    for (const controller of this.sendControllers.values()) controller.abort();
    this.sendControllers.clear();
    this.listeners.clear();
  };
}
