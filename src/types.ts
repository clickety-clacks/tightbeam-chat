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
  readonly to: string;
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
  /** Opaque coverage evidence interpreted only by the host's target implementation. */
  readonly coverage: unknown;
}

export interface SessionRecord {
  readonly sessionKey: string;
  readonly rowVersion: number;
  readonly displayName: string;
  readonly model?: string;
  readonly harness?: string;
  readonly activity?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type ChangeNotice =
  | { readonly operation: 'tool'; readonly tool: ToolCallRecord }
  | { readonly operation: 'upsert'; readonly record: ConversationRecord }
  | { readonly operation: 'delete'; readonly sessionKey: string; readonly id: string; readonly rowVersion: number }
  | { readonly operation: 'session'; readonly session: SessionRecord }
  | { readonly operation: 'turn'; readonly turn: CanonicalTurn }
  | { readonly operation: 'ignore'; readonly sessionKey: string; readonly resource: string }
  | { readonly operation: 'observe' | 'unknown'; readonly sessionKey: string; readonly resource: string };

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
  /** Full source/build identity, or an explicitly local fixture identity. */
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
  | { readonly outcome: 'uncertain'; readonly reason: string };

export interface ChangeConnection {
  close(): void;
}

export interface ChangeCallbacks {
  onNotice(notice: ChangeNotice): void;
  /** Disconnection, sequence doubt, missed heartbeat or overflow. */
  onDoubt(reason: string): void;
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
  readSession(sessionKey: string, signal: AbortSignal): Promise<SessionRecord>;
  /** Exact turn lookup used only after a message supplies a turn index. */
  readTurn(sessionKey: string, seq: number, signal: AbortSignal): Promise<CanonicalTurn | null>;
  /** Source message lookup; the returned row is always checked against sessionKey. */
  readMessage(sessionKey: string, messageId: string, signal: AbortSignal): Promise<CanonicalMessage | null>;
  /** Bounded newest turn page used to determine current activity. */
  readRecentTurns(sessionKey: string, signal: AbortSignal): Promise<readonly CanonicalTurn[]>;
  /** Resolves an agent/session origin to its display name without reading its transcript. */
  resolveOriginDisplayName(origin: string, signal: AbortSignal): Promise<string | undefined>;
  /** Exact non-secret Gateway origin selected by the host, when the transport knows it. */
  readonly targetGateway?: string;
  /** Establishes the elected target's snapshot/notice coverage rule. */
  proveCoverage(session: SessionRecord, page: ConversationPage, buffered: readonly ChangeNotice[]): boolean;
  /** Separate authenticated human /ws post, resolved by correlated ack/refusal/uncertainty. */
  sendHuman(submission: HumanSubmission, signal: AbortSignal): Promise<HumanSendResult>;
}

export type RuntimeStatus = 'loading' | 'ready' | 'stale' | 'unsupported' | 'unauthorized' | 'error';
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
  readonly status: RuntimeStatus;
  readonly statusDetail?: string;
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
  /** False until a typed turn record arrives on this connection generation. */
  readonly provenanceAvailable?: boolean;
  readonly activeTurn?: TurnProvenance;
  readonly targetGateway?: string;
  readonly agentDisplayName?: string;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly historyError?: string;
  readonly sends: readonly LocalSend[];
  readonly targetLabel: string;
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
  /** Restart bypasses an in-flight attempt, for foreground return or manual recovery. */
  rebuild(options?: { restart?: boolean }): Promise<void>;
  dispose(): void;
}

export interface TightbeamAdapter {
  open(sessionKey: string): ChatRuntime;
}

export class AuthorizationError extends Error {}
export class UnsupportedTargetError extends Error {}
export class InvalidCursorError extends Error {}
