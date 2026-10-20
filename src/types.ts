/** The host decodes the elected backend's wire schema into these canonical records. */
export interface CanonicalMessage {
  readonly kind: 'message';
  readonly id: string;
  readonly sessionKey: string;
  readonly seq: number;
  readonly rowVersion: number;
  readonly role: string;
  readonly sender?: string;
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
  readonly messageId: string;
  readonly origin: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface BatchMember {
  readonly index: number;
  readonly origin: string;
  readonly content: string;
}

export type TurnSourceKind = 'human' | 'agent' | 'substrate' | 'unknown';

/** Source-backed trigger detail used for display filtering and active-turn captions. */
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
  readonly transition: 'harness' | 'model' | 'restart';
  readonly from?: string;
  readonly to: string;
  readonly createdAt?: string;
  readonly raw: Readonly<Record<string, unknown>>;
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
  | { readonly operation: 'upsert'; readonly record: ConversationRecord }
  | { readonly operation: 'delete'; readonly sessionKey: string; readonly id: string; readonly rowVersion: number }
  | { readonly operation: 'session'; readonly session: SessionRecord }
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
}

export interface RuntimeState {
  readonly sessionKey: string;
  readonly generation: number;
  readonly status: RuntimeStatus;
  readonly statusDetail?: string;
  readonly records: readonly ConversationRecord[];
  readonly session?: SessionRecord;
  readonly provenance?: readonly TurnProvenance[];
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
  send(content: string): string | null;
  retrySend(clientMessageId: string): Promise<void>;
  rebuild(): Promise<void>;
  dispose(): void;
}

export interface TightbeamAdapter {
  open(sessionKey: string): ChatRuntime;
}

export class AuthorizationError extends Error {}
export class UnsupportedTargetError extends Error {}
export class InvalidCursorError extends Error {}
