import type { SessionRecordEvent, RecordEventPage } from './types';
import {
  AuthorizationError,
  InvalidCursorError,
  SessionNotFoundError,
  UnsupportedTargetError,
  type ConversationRecord,
  type ChangeConnection,
  type ChangeCallbacks,
  type ToolCallRecord,
  type ChangeNotice,
  type CanonicalTurn,
  type ChatTransport,
  type ConversationPage,
  type HistoryRailDenial,
  type HostIdentity,
  type HumanSendResult,
  type HumanSubmission,
  type ReadMarkerReadResult,
  type ReadMarkerWriteRequest,
  type ReadMarkerWriteResult,
  type SessionRecord,
  type TargetCapabilities,
  type TargetObservation,
  type TargetProfile,
} from './types';
import { ToolHistoryUnavailableError } from './toolHistory';

// Snapshot coverage is the Chat client's subscribe-before-REST overlap, not a
// Gateway snapshot watermark.
const gatewayCapabilities: TargetCapabilities = Object.freeze({
  newestTail: true,
  stableOlderCursor: true,
  retainedHistoryAcrossResets: true,
  orderedTransitions: true,
  snapshotCoverage: true,
  versionedNotices: true,
  humanSendDedupe: true,
  authoritativeTurnProvenance: true,
});

const gatewayIdentity = 'tightbeam-gateway';

/** A fresh, host-authenticated socket. The host owns credentials and the auth handshake. */
export interface Public019Channel {
  send(frame: Readonly<Record<string, unknown>>): void;
  listen(onFrame: (frame: unknown) => void, onClose: (event?: { code?: number }) => void): () => void;
  close(): void;
}

export interface Public019Host {
  /** A host-authorized fetch, including the appropriate bearer header for REST. */
  fetch(input: string, init: RequestInit): Promise<Response>;
  currentIdentity(): HostIdentity;
  /** Set only when this host already routes marker access through a compatible user-device credential. */
  readonly readMarkerRoute?: 'gateway-user-device';
  /** Connect /ws/changes?protocolVersion=2, authenticate, then return a fresh socket. */
  openAuthenticatedChanges(signal: AbortSignal): Promise<Public019Channel>;
  /** Connect /ws, authenticate as the human device, await sync_complete, then return a fresh socket. */
  openAuthenticatedHuman(signal: AbortSignal): Promise<Public019Channel>;
}

export interface Public019Config {
  /** Approved host route; no credentials, query, or fragment. */
  baseUrl: string;
  /** Non-secret exact Gateway origin selected by the host for status presentation. */
  targetGateway?: string;
  host: Public019Host;
  /** Timeout for non-send responses such as Firehose subscription readiness. */
  responseTimeoutMs?: number;
  /** ChangeSocket normally emits a heartbeat every 15 seconds; default allows three intervals. */
  heartbeatTimeoutMs?: number;
}

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnsupportedTargetError('Expected an object in the Gateway wire response.');
  }
  return value as Record<string, unknown>;
};

const requiredString = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string' || !value) throw new UnsupportedTargetError(`Invalid ${key} in Gateway wire response.`);
  return value;
};

const optionalString = (row: Record<string, unknown>, key: string): string | undefined => {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new UnsupportedTargetError(`Invalid ${key} in Gateway wire response.`);
  return value;
};

const positiveInteger = (row: Record<string, unknown>, key: string): number => {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new UnsupportedTargetError(`Invalid ${key} in Gateway wire response.`);
  }
  return value as number;
};

function optionalPositiveInteger(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new UnsupportedTargetError(`Invalid ${key} in Gateway wire response.`);
  }
  return value as number;
}

function nonnegativeInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new UnsupportedTargetError(`Invalid ${key} in Gateway wire response.`);
  }
  return value as number;
}

function optionalNonnegativeInteger(row: Record<string, unknown>, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return nonnegativeInteger(row, key);
}

function decodeHistoryRailDenial(value: unknown, sessionKey: string): HistoryRailDenial {
  const row = record(value);
  if (requiredString(row, 'sessionKey') !== sessionKey) {
    throw new UnsupportedTargetError('Refused action belongs to a different session.');
  }
  const principal = requiredString(row, 'principal');
  if (principal !== `session:${sessionKey}`) {
    throw new UnsupportedTargetError('Refused action belongs to a different principal.');
  }
  const payload = record(row.payload);
  const verb = requiredString(row, 'verb').trim();
  const rule = requiredString(row, 'rule').trim();
  const origin = requiredString(row, 'origin');
  if (!verb || !rule || !origin.trim()) {
    throw new UnsupportedTargetError('Invalid refused-action details in Gateway wire response.');
  }
  const afterMessageSeq = optionalNonnegativeInteger(row, 'afterMessageSeq');
  return Object.freeze({
    id: requiredString(row, 'id'), sessionKey, principal,
    verb, rule, origin, payload: Object.freeze({ ...payload }),
    occurredAt: nonnegativeInteger(row, 'occurredAt'),
    ...(afterMessageSeq === undefined ? {} : { afterMessageSeq }),
  });
}

function messageTime(row: Record<string, unknown>): string {
  const at = row.at;
  if (!Number.isSafeInteger(at) || (at as number) < 0) {
    throw new UnsupportedTargetError('Invalid millisecond at timestamp in Gateway message.');
  }
  const date = new Date(at as number);
  if (!Number.isFinite(date.getTime())) {
    throw new UnsupportedTargetError('Message at timestamp is outside the supported date range.');
  }
  return date.toISOString();
}

/** Decode only the source-backed REST/Firehose item shape, preserving all metadata. */
export function decodePublic019Message(value: unknown, sessionKey: string): ConversationRecord {
  const row = record(value);
  if (requiredString(row, 'sessionKey') !== sessionKey) {
    throw new UnsupportedTargetError('Message belongs to a different session.');
  }
  if (row.messageType === 'marker') {
    const marker = row.marker === undefined || row.marker === null ? {} : record(row.marker);
    const kind = typeof marker.kind === 'string' ? marker.kind : undefined;
    return Object.freeze({
      kind: 'transition', id: requiredString(row, 'id'), sessionKey,
      seq: positiveInteger(row, 'seq'), rowVersion: positiveInteger(row, 'rowVersion'),
      transition: kind === 'harness-switch' ? 'harness' : kind === 'model-retune' ? 'model'
        : kind === 'session-restart' ? 'restart' : kind === 'context-compacted' ? 'compaction' : 'unknown',
      content: typeof row.content === 'string' ? row.content : requiredString(row, 'content'),
      from: typeof marker.from === 'string' ? marker.from : undefined,
      to: typeof marker.to === 'string' ? marker.to : undefined,
      recordEventIds: stringList(row.recordEventIds ?? []),
      createdAt: messageTime(row), raw: Object.freeze({ ...row }),
    });
  }
  const attachments = row.attachments;
  if (!Array.isArray(attachments)) throw new UnsupportedTargetError('Invalid attachments in message.');
  return Object.freeze({
    kind: 'message' as const,
    id: requiredString(row, 'id'),
    sessionKey,
    seq: positiveInteger(row, 'seq'),
    rowVersion: positiveInteger(row, 'rowVersion'),
    role: requiredString(row, 'role'),
    attentionTier: typeof row.attentionTier === 'number' && Number.isSafeInteger(row.attentionTier)
      ? row.attentionTier : undefined,
    content: typeof row.content === 'string' ? row.content : requiredString(row, 'content'),
    sender: optionalString(row, 'sender'),
    replyToMessageId: optionalString(row, 'replyToMessageId'),
    turnIncludesHuman: typeof row.turnIncludesHuman === 'boolean' ? row.turnIncludesHuman : undefined,
    isBatchCarrier: typeof row.isBatchCarrier === 'boolean' ? row.isBatchCarrier : undefined,
    messageType: optionalString(row, 'messageType'),
    createdAt: messageTime(row),
    recordEventIds: stringList(row.recordEventIds ?? []),
    attachments: Object.freeze([...attachments]),
    clientMessageId: optionalString(row, 'clientMessageId'),
    deviceId: optionalString(row, 'deviceId'),
    turnSeq: optionalPositiveInteger(row, 'turnSeq'),
    raw: Object.freeze({ ...row }),
  });
}

export function decodePublic019Turn(value: unknown, sessionKey: string): CanonicalTurn {
  const row = record(value);
  if (requiredString(row, 'sessionKey') !== sessionKey) {
    throw new UnsupportedTargetError('Turn belongs to a different session.');
  }
  return Object.freeze({
    seq: positiveInteger(row, 'seq'), sessionKey, status: requiredString(row, 'status'),
    messageId: optionalString(row, 'messageId'), origin: requiredString(row, 'origin'),
    triggerSource: ['batch', 'mike', 'agent', 'process', 'other'].includes(String(row.triggerSource))
      ? row.triggerSource as CanonicalTurn['triggerSource'] : undefined,
    batchMemberCount: optionalPositiveInteger(row, 'batchMemberCount'),
    raw: Object.freeze({ ...row }),
  });
}

export function decodePublic019Session(value: unknown, sessionKey: string): SessionRecord {
  const row = record(value);
  if (requiredString(row, 'sessionKey') !== sessionKey) {
    throw new UnsupportedTargetError('Session detail belongs to a different session.');
  }
  return Object.freeze({
    sessionKey,
    rowVersion: positiveInteger(row, 'rowVersion'),
    clearedThroughSeq: typeof row.clearedThroughSeq === 'number' && Number.isSafeInteger(row.clearedThroughSeq) &&
      row.clearedThroughSeq >= 0 ? row.clearedThroughSeq : undefined,
    displayName: requiredString(row, 'displayName'),
    model: optionalString(row, 'model'),
    harness: optionalString(row, 'harness'),
    activity: optionalString(row, 'mechanicalStatus') ?? optionalString(row, 'state'),
    raw: Object.freeze({ ...row }),
  });
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new UnsupportedTargetError('Invalid record-event identity list.');
  }
  return Object.freeze([...value]);
}

/** History supplies the session through its route; live frames supply refs.sessionKey. */
export function decodeRecordEvent(value: unknown, sessionKey: string): SessionRecordEvent {
  const row = record(value);
  const source = record(row.record);
  const cause = row.cause == null ? null : record(row.cause);
  return Object.freeze({ eventId: requiredString(row, 'eventId'), sessionKey,
    kind: requiredString(row, 'kind'), at: nonnegativeInteger(row, 'at'),
    record: Object.freeze({ type: requiredString(source, 'type'), id: requiredString(source, 'id'),
      detail: requiredString(source, 'detail'), workItemId: optionalString(source, 'workItemId') }),
    actorSessionKey: optionalString(row, 'actorSessionKey') ?? null,
    tiedAs: stringList(row.tiedAs), noticeMessageIds: stringList(row.noticeMessageIds),
    cause: cause ? Object.freeze({ turnSeq: optionalPositiveInteger(cause, 'turnSeq') ?? null,
      messageId: optionalString(cause, 'messageId') ?? null }) : null,
  });
}

/** REST and changes carry the same tool-call projection. */
export function decodeToolCall(value: unknown, sessionKey: string): ToolCallRecord {
  const row = record(value);
  if (row.sessionKey !== sessionKey) throw new UnsupportedTargetError('Tool call belongs to a different session.');
  const integer = (key: string): number => {
    const value = row[key];
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new UnsupportedTargetError('Invalid tool-call ' + key);
    return value as number;
  };
  const status = row.status;
  if (!['pending', 'in_progress', 'completed', 'failed'].includes(String(status))) throw new UnsupportedTargetError('Unknown tool-call status.');
  if (typeof row.title !== 'string' || !Array.isArray(row.truncated)) throw new UnsupportedTargetError('Invalid tool-call projection.');
  const truncated = row.truncated.map(value => {
    const entry = record(value);
    if (!['rawInput', 'rawOutput', 'content'].includes(String(entry.field))) throw new UnsupportedTargetError('Invalid truncation field.');
    return Object.freeze({ field: entry.field as 'rawInput' | 'rawOutput' | 'content', originalBytes: positiveInteger(entry, 'originalBytes') });
  });
  return Object.freeze({ id: requiredString(row, 'id'), seq: positiveInteger(row, 'seq'), sessionKey,
    turnSeq: positiveInteger(row, 'turnSeq'), afterMessageSeq: integer('afterMessageSeq'),
    harnessToolCallId: requiredString(row, 'harnessToolCallId'), title: row.title, kind: requiredString(row, 'kind'),
    toolName: optionalString(row, 'toolName') ?? null, status: status as ToolCallRecord['status'],
    rawInput: row.rawInput ?? null, rawOutput: row.rawOutput ?? null, content: row.content ?? null,
    truncated: Object.freeze(truncated), startedAt: integer('startedAt'),
    endedAt: row.endedAt === null ? null : integer('endedAt'), rowVersion: positiveInteger(row, 'rowVersion'),
  });
}

/** A source-backed notice decoder; unrecognized frames remain sequenced observations. */
export function decodePublic019Notice(value: unknown, sessionKey: string): ChangeNotice {
  const frame = record(value);
  if (frame.type !== 'change' || frame.schemaVersion !== 2 || typeof frame.class !== 'string') {
    throw new UnsupportedTargetError('Invalid protocol-2 change frame.');
  }
  if (frame.class === 'rail.denied') {
    const refs = frame.refs && typeof frame.refs === 'object' && !Array.isArray(frame.refs)
      ? frame.refs as Record<string, unknown> : {};
    const payload = frame.payload && typeof frame.payload === 'object' && !Array.isArray(frame.payload)
      ? frame.payload as Record<string, unknown> : {};
    const principal = typeof refs.principal === 'string' ? refs.principal : undefined;
    const referencedSession = refs.sessionKey === undefined ? sessionKey
      : typeof refs.sessionKey === 'string' ? refs.sessionKey : undefined;
    const verb = typeof payload.verb === 'string' ? payload.verb.trim() : '';
    const rule = typeof payload.rule === 'string' ? payload.rule.trim() : '';
    if (frame.op === 'observe' && frame.resource === undefined && referencedSession === sessionKey &&
        principal === `session:${sessionKey}` && verb && rule) {
      const publicPayload = frame.payload !== null && typeof frame.payload === 'object' && !Array.isArray(frame.payload)
        ? Object.freeze({ ...(frame.payload as Record<string, unknown>) }) : undefined;
      const origin = typeof refs.origin === 'string' ? refs.origin : undefined;
      const id = Number.isSafeInteger(refs.railDenialId) && (refs.railDenialId as number) > 0
        ? `rail:${refs.railDenialId}`
        : `notice:${JSON.stringify({ principal, verb, rule, occurredAt: frame.occurredAt,
          origin, sessionKey: referencedSession, payload: publicPayload })}`;
      return { operation: 'rail-denial', id, sessionKey: referencedSession, principal, verb, rule,
        ...(origin === undefined ? {} : { origin }),
        ...(publicPayload === undefined ? {} : { payload: publicPayload }),
        ...(Number.isSafeInteger(frame.occurredAt) && (frame.occurredAt as number) >= 0
          ? { occurredAt: frame.occurredAt as number } : {}),
        ...(Number.isSafeInteger(refs.afterMessageSeq) && (refs.afterMessageSeq as number) >= 0
          ? { afterMessageSeq: refs.afterMessageSeq as number } : {}) };
    }
    return { operation: 'unknown', sessionKey, resource: frame.class };
  }
  const refs = record(frame.refs);
  if (refs.sessionKey !== sessionKey) throw new UnsupportedTargetError('Change frame has a different session reference.');
  if (frame.class === 'session_record_event.created') {
    return { operation: 'record-event', event: decodeRecordEvent(frame.payload, sessionKey) };
  }
  if ((frame.class === 'message.created' || frame.class === 'transition.recorded') &&
      ['messages', 'transcript messages'].includes(String(frame.resource)) && frame.op === 'upsert') {
    return { operation: 'upsert', record: decodePublic019Message(frame.payload, sessionKey) };
  }
  if (['tool_call.started', 'tool_call.ended'].includes(frame.class) &&
      frame.resource === 'tool calls' && frame.op === 'upsert') {
    return { operation: 'tool', tool: decodeToolCall(frame.payload, sessionKey) };
  }
  if (typeof frame.class === 'string' && frame.class.startsWith('session.') &&
      frame.resource === 'sessions' && frame.op === 'upsert') {
    return { operation: 'session', session: decodePublic019Session(frame.payload, sessionKey) };
  }
  // The payload seq identifies the turn; the outer seq orders this subscription.
  if (['turn.started', 'turn.ended'].includes(frame.class) &&
      frame.resource === 'turns' && frame.op === 'upsert') {
    return { operation: 'turn', turn: decodePublic019Turn(frame.payload, sessionKey) };
  }
  return { operation: 'unknown', sessionKey, resource: frame.class };
}

function checkedBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('baseUrl must be an HTTP(S) origin/path without credentials, query, or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

async function gatewayError(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = record(await response.json());
    if (!body.error || typeof body.error !== 'object' || Array.isArray(body.error)) return {};
    const error = body.error as Record<string, unknown>;
    return {
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(typeof error.message === 'string' ? { message: error.message } : {}),
    };
  } catch {
    return {};
  }
}

function readMarkerValue(value: unknown): string | number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  return undefined;
}

function isSessionDetailPath(path: string): boolean {
  try { return /^\/api\/sessions\/[^/]+$/.test(new URL(path, 'https://gateway.invalid').pathname); }
  catch { return false; }
}

function isToolHistoryCollectionPath(path: string): boolean {
  try { return /^\/api\/sessions\/[^/]+\/tool-calls$/.test(new URL(path, 'https://gateway.invalid').pathname); }
  catch { return false; }
}

function isRecordEventsCollectionPath(path: string): boolean {
  try { return /^\/api\/sessions\/[^/]+\/record-events$/.test(new URL(path, 'https://gateway.invalid').pathname); }
  catch { return false; }
}

function authorizationFailureCode(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return ['unauthorized', 'forbidden', 'not_authorized', 'not_authenticated',
    'authentication_failed', 'auth_failed'].includes(value.toLowerCase());
}

/** Gateway REST history, protocol-2 changes, and human sending. */
export function createPublic019Transport(config: Public019Config): { transport: ChatTransport; profile: TargetProfile } {
  const baseUrl = checkedBaseUrl(config.baseUrl);
  const timeoutMs = config.responseTimeoutMs ?? 15_000;
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 45_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 1) {
    throw new Error('Expected positive response and heartbeat timeouts.');
  }
  const profile: TargetProfile = Object.freeze({
    identity: gatewayIdentity,
    label: 'Tightbeam Gateway',
    capabilities: gatewayCapabilities,
  });

  async function get(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await config.host.fetch(`${baseUrl}${path}`, { method: 'GET', signal, cache: 'no-store' });
    if (response.status === 401 || response.status === 403) throw new AuthorizationError('Human REST principal is not authorized.');
    if (response.status === 404 && isSessionDetailPath(path)) {
      throw new SessionNotFoundError('This conversation no longer exists.');
    }
    if (response.status === 400 && path.includes('/messages?')) throw new InvalidCursorError('History cursor was rejected.');
    if (!response.ok) {
      let code: string | undefined;
      try {
        const body = record(await response.json());
        if (body.error && typeof body.error === 'object' && !Array.isArray(body.error) &&
            typeof (body.error as Record<string, unknown>).code === 'string') {
          code = (body.error as Record<string, unknown>).code as string;
        }
      } catch {
        // Keep the HTTP status when the service does not return a JSON error.
      }
      if (code === 'chat_gateway_unavailable') {
        throw new Error('No Gateway access is provisioned for the selected conversation. The selected target was not changed.');
      }
      if (response.status === 404 && isRecordEventsCollectionPath(path)) {
        // Older Gateways do not expose this optional collection. Keep transcript
        // history usable and report no record events until the route is present.
        return { schemaVersion: 1, resource: 'record events', items: [],
          page: { oldestCursor: null, hasMoreBefore: false } };
      }
      if (response.status === 404 && isToolHistoryCollectionPath(path)) {
        throw new ToolHistoryUnavailableError('Tool history is unavailable.');
      }
      throw new Error(`Tightbeam REST request failed with HTTP ${response.status}${code ? ` (${code})` : ''}.`);
    }
    return record(await response.json());
  }

  const activeSessions = new Set<string>();
  async function readPage(sessionKey: string, query: string, signal: AbortSignal,
    isAfterPage = false): Promise<ConversationPage> {
    const body = await get(`/api/sessions/${encodeURIComponent(sessionKey)}/messages?limit=50&${query}`, signal);
    if (body.schemaVersion !== 1 || body.resource !== 'transcript messages' || !Array.isArray(body.items)) {
      throw new UnsupportedTargetError('Unexpected transcript collection envelope.');
    }
    const page = record(body.page);
    const oldestCursor = optionalString(page, 'oldestCursor') ?? null;
    const newestCursor = optionalString(page, 'newestCursor') ?? null;
    const hasMoreAfter = page.hasMoreAfter;
    const emptyAfterWithoutBackwardCursor = isAfterPage && body.items.length === 0 && !oldestCursor;
    if (typeof page.hasMoreBefore !== 'boolean' || typeof hasMoreAfter !== 'boolean' ||
        (page.hasMoreBefore && !oldestCursor && !emptyAfterWithoutBackwardCursor) ||
        (page.hasMoreAfter && !newestCursor)) {
      throw new UnsupportedTargetError('Invalid transcript page metadata.');
    }
    const railDenials = body.railDenials === undefined ? undefined : body.railDenials;
    if (railDenials !== undefined && !Array.isArray(railDenials)) {
      throw new UnsupportedTargetError('Invalid refused-action history in Gateway response.');
    }
    return { records: body.items.map((item) => decodePublic019Message(item, sessionKey))
      .sort((a, b) => a.seq - b.seq), oldestCursor: emptyAfterWithoutBackwardCursor ? null : oldestCursor,
      hasOlder: emptyAfterWithoutBackwardCursor ? false : page.hasMoreBefore,
      newestCursor, hasNewer: hasMoreAfter,
      ...(railDenials === undefined ? {} : {
        railDenials: Object.freeze(railDenials.map((denial) => decodeHistoryRailDenial(denial, sessionKey))),
      }), coverage: sessionKey };
  }

  async function openChanges(sessionKey: string, callbacks: ChangeCallbacks, signal: AbortSignal, tools = false): Promise<ChangeConnection> {
      const channel = await config.host.openAuthenticatedChanges(signal);
      let closed = false;
      let ready = false;
      let railSubscriptionPending = false;
      let railRefusalBeforeReady = false;
      let lastSeq = 0;
      let pageWasSuspended = typeof document !== 'undefined' && document.visibilityState !== 'visible';
      let stopListening = () => {};
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      const subscriptionId = (tools ? 'tools:' : 'chat:') + sessionKey;
      const railSubscriptionId = `rail:${sessionKey}`;
      const hasRailSubscription = !tools;
      const close = () => {
        if (closed) return;
        closed = true;
        if (!tools) activeSessions.delete(sessionKey);
        if (readyTimer) clearTimeout(readyTimer);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        stopListening();
        signal.removeEventListener('abort', onAbort);
        if (!tools && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
        if (!tools && typeof window !== 'undefined') {
          window.removeEventListener('pagehide', onPageHide);
          window.removeEventListener('pageshow', onPageShow);
          window.removeEventListener('online', onOnline);
        }
        channel.close();
      };
      let rejectReady: (reason: unknown) => void = () => {};
      let resolveReady: () => void = () => {};
      const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const onAbort = () => { close(); rejectReady(new Error('Change subscription aborted.')); };
      const doubt = (reason: string) => {
        if (closed) return;
        close();
        callbacks.onDoubt(reason);
      };
      const watchHeartbeat = () => {
        if (closed) return;
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(() => doubt('Firehose heartbeat or change timed out.'), heartbeatTimeoutMs);
      };
      const refreshAfterLifecycleChange = (reason: string) => {
        if (closed || !ready) return;
        // A quiet browser WebSocket cannot prove that its server can still send.
        // Reopen through the existing subscription path so runtime catch-up
        // confirms the feed and reads any rows missed while the page was away.
        doubt(reason);
      };
      const onVisibilityChange = () => {
        if (typeof document === 'undefined') return;
        if (document.visibilityState !== 'visible') {
          pageWasSuspended = true;
          return;
        }
        if (!pageWasSuspended) return;
        pageWasSuspended = false;
        refreshAfterLifecycleChange('Refreshing the conversation feed after returning to the app.');
      };
      const onPageHide = () => { pageWasSuspended = true; };
      const onPageShow = () => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (!pageWasSuspended) return;
        pageWasSuspended = false;
        refreshAfterLifecycleChange('Refreshing the conversation feed after the page was restored.');
      };
      const onOnline = () => refreshAfterLifecycleChange('Refreshing the conversation feed after the network changed.');
      signal.addEventListener('abort', onAbort, { once: true });
      if (!tools && typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
      if (!tools && typeof window !== 'undefined') {
        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('pageshow', onPageShow);
        window.addEventListener('online', onOnline);
      }
      stopListening = channel.listen((raw) => {
        if (closed) return;
        try {
          const frame = record(raw);
          if (hasRailSubscription && frame.type === 'subscription_ready' && frame.subscriptionId === railSubscriptionId) {
            railSubscriptionPending = false;
            watchHeartbeat();
            return;
          }
          if (!ready) {
            if (frame.type === 'subscription_ready' && frame.subscriptionId === subscriptionId) {
              ready = true;
              if (!tools) activeSessions.add(sessionKey);
              // An invalid_request without a subscription id is ambiguous until
              // the primary readiness frame arrives. Once it does, the optional
              // rail refusal cannot have prevented the conversation feed.
              railRefusalBeforeReady = false;
              if (readyTimer) clearTimeout(readyTimer);
              watchHeartbeat();
              resolveReady();
            } else if (frame.type === 'auth_result' && frame.success === false) {
              throw new AuthorizationError('Gateway refused the authenticated change subscription.');
            } else if (frame.type === 'error' && hasRailSubscription && frame.subscriptionId === railSubscriptionId) {
              // Rail activity is optional to the conversation feed, including when its filter is refused.
              railSubscriptionPending = false;
              return;
            } else if (frame.type === 'error' && hasRailSubscription && railSubscriptionPending &&
                frame.subscriptionId === undefined && frame.code === 'invalid_request') {
              // Gateway v2 omits subscriptionId on invalid_request. Keep the
              // result pending until primary readiness distinguishes a rail
              // refusal from a conversation subscription that never becomes ready.
              railSubscriptionPending = false;
              railRefusalBeforeReady = true;
              return;
            } else if (frame.type === 'error' && authorizationFailureCode(frame.code)) {
              throw new AuthorizationError('Gateway refused the authenticated change subscription.');
            } else if (frame.type === 'error' || frame.type === 'auth_result') {
              throw new UnsupportedTargetError('The change subscription was refused.');
            }
            return;
          }
          if (frame.type === 'error' && hasRailSubscription && railSubscriptionPending &&
              frame.subscriptionId === undefined && frame.code === 'invalid_request') {
            // Gateway v2 omits subscriptionId on invalid_request. The primary
            // subscription is already ready, so this is the pending optional rail request.
            railSubscriptionPending = false;
            return;
          }
          if (frame.type === 'error' && hasRailSubscription && frame.subscriptionId === railSubscriptionId) {
            railSubscriptionPending = false;
            return;
          }
          if ((frame.type === 'auth_result' && frame.success === false) ||
              (frame.type === 'error' && authorizationFailureCode(frame.code))) {
            close();
            callbacks.onAuthorizationLost?.('Gateway refused the authenticated change subscription.');
            return;
          }
          if (frame.type === 'subscription_ready' &&
              (frame.subscriptionId === subscriptionId || (hasRailSubscription && frame.subscriptionId === railSubscriptionId))) return;
          if (frame.type !== 'change' && frame.type !== 'heartbeat') {
            doubt('Unexpected Firehose frame after subscription readiness.');
            return;
          }
          if (!Number.isSafeInteger(frame.seq) || (frame.seq as number) < lastSeq ||
              (frame.type === 'change' && frame.seq !== lastSeq + 1) ||
              (frame.type === 'heartbeat' && frame.seq !== lastSeq)) {
            doubt('Firehose sequence gap or regression.');
            return;
          }
          lastSeq = frame.seq as number;
          if (frame.type === 'change') {
            if (frame.subscriptionId !== subscriptionId &&
                !(hasRailSubscription && frame.subscriptionId === railSubscriptionId)) {
              throw new UnsupportedTargetError('Wrong Firehose subscription.');
            }
            callbacks.onNotice(decodePublic019Notice(frame, sessionKey));
          }
          watchHeartbeat();
        } catch (error) {
          if (!ready) { close(); rejectReady(error); }
          else doubt(error instanceof Error ? error.message : String(error));
        }
      }, (event) => {
        if (closed) return;
        close();
        if (ready) {
          const reason = Number.isSafeInteger(event?.code)
            ? `Firehose disconnected (close code ${event?.code}).`
            : 'Firehose disconnected.';
          callbacks.onDoubt(reason);
        }
        else rejectReady(new Error('Firehose closed before subscription readiness.'));
      });
      if (signal.aborted) onAbort();
      else if (!closed) {
        readyTimer = setTimeout(() => {
          const error = railRefusalBeforeReady
            ? new UnsupportedTargetError('The conversation feed did not become ready after an uncorrelated subscription refusal.')
            : new Error('Firehose subscription readiness timed out.');
          close();
          rejectReady(error);
        }, timeoutMs);
        try {
          channel.send({ type: 'subscribe', protocolVersion: 2, subscriptionId, filters: { sessionKey, classes: tools ? ['tool_call.']
              : ['message.created', 'transition.recorded', 'session.', 'turn.started', 'turn.ended', 'session_record_event.created'] } });
        } catch (error) { close(); rejectReady(error); }
        if (hasRailSubscription && !closed) {
          railSubscriptionPending = true;
          try {
            channel.send({ type: 'subscribe', protocolVersion: 2, subscriptionId: railSubscriptionId,
              filters: { sessionKey, classes: ['rail.denied'] } });
          } catch {
            railSubscriptionPending = false;
            // The secondary activity category must not disable the primary feed.
          }
        }
      }
      await readyPromise;
      return { close };
    }

  const markerTransport: Pick<ChatTransport, 'readReadMarker' | 'writeReadMarker'> =
    config.host.readMarkerRoute === 'gateway-user-device' ? {
      async readReadMarker(scopeKey, signal): Promise<ReadMarkerReadResult> {
        if (config.host.currentIdentity().principalKey !== 'mike') return { supported: false };
        const response = await config.host.fetch(`${baseUrl}/api/read-markers/${encodeURIComponent(scopeKey)}`, {
          method: 'GET', signal, cache: 'no-store',
        });
        if (response.status === 401 || response.status === 403) return { supported: false };
        if (response.status === 404) {
          const error = await gatewayError(response);
          return error.code === 'not_found' ? { supported: true, marker: null } : { supported: false };
        }
        if (!response.ok) {
          if (response.status === 405 || response.status === 501) return { supported: false };
          throw new Error(`Read marker request failed with HTTP ${response.status}.`);
        }
        const body = record(await response.json());
        if (body.schemaVersion !== 1 || body.resource !== 'read markers') return { supported: false };
        const item = record(body.item);
        if (item.userId !== 'mike' || item.scopeKey !== scopeKey) return { supported: false };
        const marker = readMarkerValue(item.marker);
        return marker === undefined ? { supported: false } : { supported: true, marker };
      },
      async writeReadMarker(request: ReadMarkerWriteRequest, signal): Promise<ReadMarkerWriteResult> {
        if (request.userId !== 'mike' || config.host.currentIdentity().principalKey !== request.userId) {
          return 'unsupported';
        }
        const response = await config.host.fetch(`${baseUrl}/agent/dispatch`, {
          method: 'POST', signal, cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            verb: 'read-marker-set',
            params: {
              scopeKey: request.scopeKey,
              marker: request.sequence,
              expectedCurrent: request.expectedCurrent,
            },
          }),
        });
        if (response.status === 401 || response.status === 403) return 'unsupported';
        if (response.ok && response.status === 200) return 'written';
        const error = await gatewayError(response);
        if (error.code === 'read_marker_conflict') return 'conflict';
        if (response.status === 404 || response.status === 405 || response.status === 501 ||
            (error.code === 'invalid_message' && (!error.message || error.message.includes('verb not allowed: read-marker-set')))) {
          return 'unsupported';
        }
        throw new Error(`Read marker write failed with HTTP ${response.status}${error.code ? ` (${error.code})` : ''}.`);
      },
    } : {};

  const transport: ChatTransport = {
    currentIdentity: () => config.host.currentIdentity(),
    ...markerTransport,
    targetGateway: config.targetGateway,
    async inspectTarget(_signal): Promise<TargetObservation> {
      // This is the transport's declared backend profile, not a probe of
      // release metadata. Actual REST and WebSocket operations report their
      // own errors when Chat uses them.
      return { identity: profile.identity, capabilities: profile.capabilities };
    },
    async readSession(sessionKey, signal) {
      const body = await get(`/api/sessions/${encodeURIComponent(sessionKey)}`, signal);
      if (body.schemaVersion !== 1 || body.resource !== 'sessions') {
        throw new UnsupportedTargetError('Unexpected sessions detail envelope.');
      }
      return decodePublic019Session(body.item, sessionKey);
    },
    async readRoleSessionKey(roleName, signal) {
      const body = await get(`/api/roles/${encodeURIComponent(roleName)}`, signal);
      if (body.schemaVersion !== 1 || body.resource !== 'roles') {
        throw new UnsupportedTargetError('Unexpected role detail envelope.');
      }
      const role = record(body.item);
      if (requiredString(role, 'name') !== roleName) {
        throw new UnsupportedTargetError('Role detail belongs to a different role.');
      }
      return requiredString(role, 'boundSessionKey');
    },
    async readMessage(sessionKey, messageId, signal) {
      const body = await get(`/api/sessions/${encodeURIComponent(sessionKey)}/messages/${encodeURIComponent(messageId)}`, signal);
      if (body.schemaVersion !== 1 || body.resource !== 'transcript messages') {
        throw new UnsupportedTargetError('Unexpected transcript message detail envelope.');
      }
      return decodePublic019Message(body.item, sessionKey);
    },
    readTail: (sessionKey, signal) => readPage(sessionKey, 'tail=true', signal),
    readOlder: (sessionKey, before, signal) => readPage(sessionKey, `before=${encodeURIComponent(before)}`, signal),
    readAfter: (sessionKey, after, signal) => readPage(sessionKey, `after=${encodeURIComponent(after)}`, signal, true),
    // Hub.subscribe completes before subscription_ready. Runtime subscribes first,
    // then reads retained append-only rows and unions buffered versioned notices.
    // This is overlap coverage, not a server snapshot watermark or replay promise.
    proveCoverage: (session, page) => activeSessions.has(session.sessionKey) &&
      page.coverage === session.sessionKey,
    openChanges,
    openToolChanges: (sessionKey, callbacks, signal) => openChanges(sessionKey, callbacks, signal, true),
    async readRecordEvents(sessionKey, before, signal): Promise<RecordEventPage> {
      const query = new URLSearchParams({ limit: '50' });
      if (before) query.set('before', before);
      const body = await get('/api/sessions/' + encodeURIComponent(sessionKey) + '/record-events?' + query, signal);
      if (body.schemaVersion !== 1 || body.resource !== 'record events' || !Array.isArray(body.items)) {
        throw new Error('Unexpected record-event collection envelope.');
      }
      const page = record(body.page);
      const oldestCursor = optionalString(page, 'oldestCursor') ?? null;
      if (typeof page.hasMoreBefore !== 'boolean' || (page.hasMoreBefore && !oldestCursor)) {
        throw new Error('Invalid record-event page cursor.');
      }
      return Object.freeze({ items: Object.freeze(body.items.map(item => decodeRecordEvent(item, sessionKey))),
        oldestCursor, hasOlder: page.hasMoreBefore });
    },
    async readToolCalls(sessionKey, range, signal) {
      const filters = new URLSearchParams({ limit: '50', afterMessageSeqFromInclusive: String(range.fromInclusive) });
      if (range.toExclusive !== undefined) filters.set('afterMessageSeqToExclusive', String(range.toExclusive));
      const calls = new Map<string, ToolCallRecord>();
      const cursors = new Set<string>();
      while (true) {
        const body = await get('/api/sessions/' + encodeURIComponent(sessionKey) + '/tool-calls?' + filters, signal);
        if (body.schemaVersion !== 1 || body.resource !== 'tool calls' || !Array.isArray(body.items)) {
          throw new Error('Unexpected tool-call collection envelope.');
        }
        for (const item of body.items) {
          const call = decodeToolCall(item, sessionKey);
          if (call.afterMessageSeq < range.fromInclusive ||
              (range.toExclusive !== undefined && call.afterMessageSeq >= range.toExclusive)) {
            throw new Error('Tool call falls outside the requested history slice.');
          }
          const previous = calls.get(call.id);
          if (!previous || call.rowVersion > previous.rowVersion) calls.set(call.id, call);
        }
        const page = record(body.page);
        if (page.hasMoreBefore === false) break;
        const cursor = optionalString(page, 'oldestCursor');
        if (page.hasMoreBefore !== true || !cursor || cursors.has(cursor)) throw new Error('Invalid tool-call page cursor.');
        cursors.add(cursor);
        filters.set('before', cursor);
      }
      return Object.freeze([...calls.values()].sort((a, b) => a.afterMessageSeq - b.afterMessageSeq || a.seq - b.seq));
    },
    async sendHuman(submission: HumanSubmission, signal: AbortSignal): Promise<HumanSendResult> {
      const submittingIdentity = config.host.currentIdentity();
      if (!submission.clientMessageId.startsWith('c_') ||
          new TextEncoder().encode(submission.content).byteLength > 64 * 1024) {
        return { outcome: 'refused', reason: 'Invalid Gateway human message ID or content length.' };
      }
      if (submittingIdentity.deviceId !== submission.deviceId) {
        return { outcome: 'refused', reason: 'Host device identity changed.' };
      }
      let channel: Public019Channel;
      try { channel = await config.host.openAuthenticatedHuman(signal); }
      catch (error) {
        if (error instanceof AuthorizationError) throw error;
        if (signal.aborted) return { outcome: 'uncertain', reason: 'Human send was interrupted before connecting.' };
        return { outcome: 'unreachable', reason: 'Not connected to the server.' };
      }
      const connectedIdentity = config.host.currentIdentity();
      if (connectedIdentity.deviceId !== submittingIdentity.deviceId ||
          connectedIdentity.principalKey !== submittingIdentity.principalKey) {
        channel.close();
        return { outcome: 'refused', reason: 'Host principal changed before human send.' };
      }
      return new Promise<HumanSendResult>((resolve) => {
        let settled = false;
        let stopListening = () => {};
        const finish = (result: HumanSendResult) => {
          if (settled) return;
          settled = true;
          stopListening();
          signal.removeEventListener('abort', onAbort);
          channel.close();
          resolve(result);
        };
        const onAbort = () => finish({ outcome: 'uncertain', reason: 'Human send interrupted before acknowledgement.' });
        signal.addEventListener('abort', onAbort, { once: true });
        stopListening = channel.listen((raw) => {
          try {
            const frame = record(raw);
            if (frame.type === 'ack' && frame.id === submission.clientMessageId) finish({ outcome: 'accepted' });
            else if (frame.type === 'error' && frame.messageId === submission.clientMessageId) {
              finish({ outcome: 'refused', reason: String(frame.code ?? 'refused') });
            }
          } catch { finish({ outcome: 'retryable', reason: 'Malformed human response.' }); }
        }, () => finish({ outcome: 'retryable', reason: 'Human socket closed before acknowledgement.' }));
        if (signal.aborted) onAbort();
        else if (!settled) {
          try {
            channel.send({ type: 'message', id: submission.clientMessageId,
              sessionKey: submission.sessionKey, content: submission.content });
          } catch { finish({ outcome: 'retryable', reason: 'Human send connection closed before acknowledgement.' }); }
        }
      });
    },
  };
  return { transport, profile };
}
