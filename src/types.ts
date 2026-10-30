import type { RecordIndex } from './recordIndex';
/** The host decodes the elected backend's wire schema into these canonical records. */
export interface CanonicalMessage {
  readonly kind: 'message';
  readonly id: string;
  readonly sessionKey: string;
  readonly seq: number;
  readonly rowVersion: number;
  readonly role: string;
  readonly sender?: string;
  /** Gateway attention tier; high-attention substrate rows may be revised in place. */
  readonly attentionTier?: number;
  readonly replyToMessageId?: string;
  readonly turnIncludesHuman?: boolean;
  readonly isBatchCarrier?: boolean;
  readonly content: string;
  readonly messageType?: string;
  readonly createdAt?: string;
  readonly attachments?: readonly unknown[];
  readonly clientMessageId?: string;
  readonly deviceId?: string;
  /** Optional source-backed turn index; never sufficient by itself to classify a row. */
  readonly turnSeq?: number;
  /** Full decoded row, including unrecognized metadata and provenance. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface CanonicalTurn {
  readonly seq: number;
  readonly sessionKey: string;
  readonly status: string;
  readonly messageId?: string;
  readonly origin: string;
  readonly triggerSource?: 'batch' | 'mike' | 'agent' | 'process' | 'other';
  readonly batchMemberCount?: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface BatchMember {
  readonly index: number;
  readonly origin: string;
  readonly content: string;
}

export type TurnSourceKind = 'human' | 'agent' | 'substrate' | 'unknown';

/** Source-backed live turn detail used for active-turn captions. */
export interface TurnProvenance {
  readonly turn: CanonicalTurn;
  readonly trigger?: CanonicalMessage;
  readonly sourceKind: TurnSourceKind;
  readonly captionOrigin: string;
  readonly sourceDisplayName?: string;
  readonly sourceMessageType?: string;
  readonly batchCount?: number;
  readonly humanMembers: readonly BatchMember[];
}

/** A target-verified projection of an actual stored switch, never inferred from text. */
export interface CanonicalTransition {
  readonly kind: 'transition';
  readonly id: string;
  readonly sessionKey: string;
  readonly seq: number;
  readonly rowVersion: number;
  readonly transition: 'harness' | 'model' | 'restart' | 'compaction' | 'unknown';
  readonly content?: string;
  readonly from?: string;
  readonly to?: string;
  readonly createdAt?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Tool records use a separate sequence domain, anchored to transcript messages. */
export interface ToolCallRecord {
  readonly id: string;
  readonly seq: number;
  readonly sessionKey: string;
  readonly turnSeq: number;
  readonly afterMessageSeq: number;
  readonly harnessToolCallId: string;
  readonly title: string;
  readonly kind: string;
  readonly toolName: string | null;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
  readonly rawInput: unknown;
  readonly rawOutput: unknown;
  readonly content: unknown;
  readonly truncated: readonly { readonly field: 'rawInput' | 'rawOutput' | 'content'; readonly originalBytes: number }[];
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly rowVersion: number;
}

export type ToolCallIndex = RecordIndex<RecordIndex<ToolCallRecord>>;

export interface ToolCallRange {
  readonly fromInclusive: number;
  readonly toExclusive?: number;
}

export type ConversationRecord = CanonicalMessage | CanonicalTransition;

export interface ConversationPage {
  /** Chronological, bounded records from authorized retained human history. */
  readonly records: readonly ConversationRecord[];
  readonly oldestCursor: string | null;
  readonly hasOlder: boolean;
  /** Opaque cursor for records at or before the newest row in this page. */
  readonly newestCursor?: string | null;
  /** Whether an `after` page has another page of newer records. */
  readonly hasNewer?: boolean;
  /** Optional Gateway 0.1.14+ selected-session refusal history; absent on older Gateways. */
  readonly railDenials?: readonly HistoryRailDenial[];
  /** Opaque coverage evidence interpreted only by the host's target implementation. */
  readonly coverage: unknown;
}

export interface SessionRecord {
  readonly sessionKey: string;
  readonly rowVersion: number;
  readonly clearedThroughSeq?: number;
  readonly displayName: string;
  readonly model?: string;
  readonly harness?: string;
  readonly activity?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type ChangeNotice =
  | { readonly operation: 'tool'; readonly tool: ToolCallRecord }
  | { readonly operation: 'upsert'; readonly record: ConversationRecord }
  | { readonly operation: 'rail-denial'; readonly id: string; readonly sessionKey: string;
      readonly principal: string; readonly verb: string; readonly rule: string; readonly origin?: string;
      readonly payload?: Readonly<Record<string, unknown>>; readonly occurredAt?: number; readonly afterMessageSeq?: number }
  | { readonly operation: 'delete'; readonly sessionKey: string; readonly id: string; readonly rowVersion: number }
  | { readonly operation: 'session'; readonly session: SessionRecord }
  | { readonly operation: 'turn'; readonly turn: CanonicalTurn }
  | { readonly operation: 'unknown'; readonly sessionKey: string; readonly resource: string };

export interface HostIdentity {
  /** Non-secret stable principal reference, supplied by the embedding host. */
  readonly principalKey: string;
  /** Device identity participating in human-send deduplication. */
  readonly deviceId: string;
}

export interface TargetCapabilities {
  readonly newestTail: boolean;
  readonly stableOlderCursor: boolean;
  readonly retainedHistoryAcrossResets: boolean;
  readonly orderedTransitions: boolean;
  readonly snapshotCoverage: boolean;
  readonly versionedNotices: boolean;
  readonly humanSendDedupe: boolean;
  readonly authoritativeTurnProvenance: boolean;
}

export interface TargetObservation {
  /** Stable backend identity, or an explicitly local fixture identity. */
  readonly identity: string;
  readonly capabilities: TargetCapabilities;
}

export interface TargetProfile extends TargetObservation {
  /** A human-readable label; fixture profiles must say fixture. */
  readonly label: string;
}

export interface HumanSubmission {
  readonly sessionKey: string;
  readonly deviceId: string;
  readonly clientMessageId: string;
  readonly content: string;
}

/** In-page correlation metadata for one host-managed logical message. */
export interface HostSendContext {
  readonly lifetimeId: string;
  readonly attempt: number;
  readonly outcome?: 'delivered' | 'failed' | 'uncertain';
}

export type HumanSendResult =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'refused'; readonly reason: string }
  /** The authenticated send socket ended before its response; repeat the exact submission. */
  | { readonly outcome: 'retryable'; readonly reason: string }
  /** No authenticated send connection could be established. */
  | { readonly outcome: 'unreachable'; readonly reason: string }
  | { readonly outcome: 'uncertain'; readonly reason: string };

export interface ChangeConnection {
  close(): void;
}

export interface ChangeCallbacks {
  onNotice(notice: ChangeNotice): void;
  /** Disconnection, sequence doubt, missed heartbeat or overflow. */
  onDoubt(reason: string): void;
  /** An optional change subscription refused authentication; this does not prove session access is lost. */
  onAuthorizationLost?(reason: string): void;
}

/**
 * Host-owned authenticated transport. openChanges resolves only after protocol-2
 * authentication and selected-session subscription readiness. No credential is
 * passed to the component, stored here, or placed in a URL by this package.
 */
export interface ChatTransport {
  currentIdentity(): HostIdentity;
  inspectTarget(signal: AbortSignal): Promise<TargetObservation>;
  openChanges(sessionKey: string, callbacks: ChangeCallbacks, signal: AbortSignal): Promise<ChangeConnection>;
  /** Separate category connection so toggling tools does not interrupt messages or sends. */
  openToolChanges?(sessionKey: string, callbacks: ChangeCallbacks, signal: AbortSignal): Promise<ChangeConnection>;
  /** Exhaust the page chain for this fixed message-anchor range. */
  readToolCalls?(sessionKey: string, range: ToolCallRange, signal: AbortSignal): Promise<readonly ToolCallRecord[]>;
  readTail(sessionKey: string, signal: AbortSignal): Promise<ConversationPage>;
  readOlder(sessionKey: string, before: string, signal: AbortSignal): Promise<ConversationPage>;
  /** Read only rows newer than a held Gateway transcript cursor. */
  readAfter?(sessionKey: string, after: string, signal: AbortSignal): Promise<ConversationPage>;
  /** Refresh one known in-place-editable transcript row without rereading a page. */
  readMessage?(sessionKey: string, messageId: string, signal: AbortSignal): Promise<ConversationRecord>;
  readSession(sessionKey: string, signal: AbortSignal): Promise<SessionRecord>;
  /** Exact non-secret Gateway origin selected by the host, when the transport knows it. */
  readonly targetGateway?: string;
  /** Establishes the elected target's snapshot/notice coverage rule. */
  proveCoverage(session: SessionRecord, page: ConversationPage, buffered: readonly ChangeNotice[]): boolean;
  /** Separate authenticated human /ws post, resolved by ack/refusal, retry after a dropped socket, or uncertainty. */
  sendHuman(submission: HumanSubmission, signal: AbortSignal): Promise<HumanSendResult>;
}

export type RuntimeStatus = 'loading' | 'ready' | 'stale' | 'unsupported' | 'unauthorized' | 'error';
export type LiveConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type SendStatus = 'pending' | 'accepted' | 'failed' | 'uncertain';

export interface LocalSend extends HumanSubmission {
  readonly submittedAt: string;
  readonly status: SendStatus;
  readonly reason?: string;
  readonly reconciled: boolean;
  readonly hostSend?: HostSendContext;
}

/** A source-backed lifecycle signal for a host-owned, correlated send. */
export type HostSendSignal =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'reconciled' }
  | { readonly kind: 'failed'; readonly reason: 'refused' | 'retry-unavailable'; readonly detail?: string }
  | { readonly kind: 'uncertain'; readonly reason: 'ack-lost' | 'accepted-unreconciled' };
export type HostSendObserver = (signal: HostSendSignal) => void;

export interface RuntimeState {
  /** Exact non-secret authenticated Gateway principal, independent of send correlation. */
  readonly principalKey?: string;
  readonly sessionKey: string;
  readonly generation: number;
  /** Advances when rebuild/catch-up data is published, so consumers can keep recovered rows still. */
  readonly recoveryRevision?: number;
  readonly status: RuntimeStatus;
  readonly statusDetail?: string;
  /** Optional session details can fail without hiding the transcript or composer. */
  readonly sessionError?: string;
  /** True only when the selected session detail endpoint returned HTTP 404. */
  readonly sessionNotFound?: boolean;
  /** The transcript snapshot can fail independently from sending and live updates. */
  readonly conversationError?: string;
  /** Live updates can reconnect independently from reading and sending. */
  readonly liveError?: string;
  /** The live-feed connection is independent from conversation availability. */
  readonly liveConnectionState?: LiveConnectionState;
  /** Set only when the host principal/device no longer matches this runtime's identity. */
  readonly identityChanged?: boolean;
  readonly records: readonly ConversationRecord[];
  readonly toolCallsEnabled?: boolean;
  /** Optional array for custom hosts; the live runtime uses the persistent index. */
  readonly toolCalls?: readonly ToolCallRecord[];
  readonly toolCallIndex?: ToolCallIndex;
  readonly toolCallsLoading?: boolean;
  readonly toolCallsError?: string;
  readonly session?: SessionRecord;
  readonly provenance?: readonly TurnProvenance[];
  /** False until typed turn data is observed or retrieved for this runtime. */
  readonly provenanceAvailable?: boolean;
  readonly activeTurn?: TurnProvenance;
  /** A local caption-only failure; it never makes conversation or sending unavailable. */
  /** True only after this live subscription has delivered at least one turn record. */
  readonly activityTurnStateAvailable?: boolean;
  /** @deprecated Retained for source compatibility; runtime snapshots no longer populate this field. */
  readonly liveActivityIds?: readonly string[];
  /** @deprecated Retained for source compatibility; runtime snapshots no longer populate this field. */
  readonly liveActivityEligibleIds?: readonly string[];
  /** Ephemeral rail.denied observations; they are not transcript history. */
  readonly liveRailDenials?: readonly LiveRailDenial[];
  /** Canonical refused-action history supplied by newer Gateway message pages. */
  readonly historyRailDenials?: readonly HistoryRailDenial[];
  readonly targetGateway?: string;
  readonly agentDisplayName?: string;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly historyError?: string;
  readonly sends: readonly LocalSend[];
  readonly targetLabel: string;
}

export interface RailDenialIdentity {
  readonly id: string;
  readonly sessionKey: string;
  readonly principal: string;
  readonly verb: string;
  readonly rule: string;
  readonly origin?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: number;
  readonly afterMessageSeq?: number;
}

export interface HistoryRailDenial extends RailDenialIdentity {
  readonly origin: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: number;
}

export interface LiveRailDenial extends RailDenialIdentity {
  /** Whether this notice qualified for a live tail when it arrived. */
  readonly tailEligibleAtArrival: boolean;
  /** Message sequence at receipt; its rendered position remains fixed for this runtime. */
  readonly afterMessageSeq: number;
  readonly arrivalOrder: number;
}

export interface ChatRuntime {
  getSnapshot(): RuntimeState;
  subscribe(listener: () => void): () => void;
  loadOlder(): Promise<void>;
  setToolCallsEnabled?(enabled: boolean): void;
  retryToolCalls?(): void;
  send(content: string, clientMessageId?: string, hostSend?: HostSendContext): string | null;
  retrySend(clientMessageId: string): Promise<void>;
  /** Subscribe before a host-correlated send so ack and reconciliation order is preserved. */
  observeHostSend(clientMessageId: string, observer: HostSendObserver): () => void;
  /** Rebuild/inspect canonical state without replacing the active changes subscription. */
  refreshHostSend(clientMessageId: string): Promise<'found' | 'absent' | 'unavailable'>;
  /** Retry is always explicitly initiated by the host and uses the same correlation/content. */
  retryHostSend(clientMessageId: string, content: string, hostSend?: HostSendContext): void;
  /** Retain only the latest terminal outcome beside its local message row for same-lifetime checks. */
  recordHostSendOutcome(clientMessageId: string, hostSend: HostSendContext,
    outcome: 'delivered' | 'failed' | 'uncertain'): void;
  /** Reflect an accepted attempt that reached a caught-up snapshot without its row. */
  markHostSendUncertain(clientMessageId: string, reason: 'accepted-unreconciled'): void;
  /** Restart bypasses an in-flight attempt for explicit manual recovery. */
  rebuild(options?: { restart?: boolean }): Promise<void>;
  dispose(): void;
}

export interface TightbeamAdapter {
  open(sessionKey: string): ChatRuntime;
}

export class AuthorizationError extends Error {}
export class SessionNotFoundError extends Error {}
export class UnsupportedTargetError extends Error {}
export class InvalidCursorError extends Error {}
