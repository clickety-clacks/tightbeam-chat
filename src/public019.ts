import type { SessionRecordEvent, RecordEventPage } from './types';
import {
  AuthorizationError,
  AttachmentUploadError,
  InvalidCursorError,
  SessionNotFoundError,
  UnsupportedTargetError,
  type ConversationRecord,
  type ChangeConnection,
  type ChangeCallbacks,
  type ToolCallRecord,
  type TurnEventRecord,
  type AttachmentReference,
  type AttachmentAssessmentItem,
  type AttachmentAssessmentResult,
  type AttachmentLimitRefusal,
  type AttachmentDeliveryReason,
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
import { TurnEventHistoryUnavailableError } from './turnEvents';

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

function logGatewayIncompatibility(site: string, reason: string): void {
  console.error('[Chat] Gateway data incompatibility', { site, reason });
}

function logDecodeFailure(site: string, error: unknown): void {
  logGatewayIncompatibility(site, error instanceof Error ? error.message : 'Unsupported Gateway data.');
}

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
  /** Set when marker reads and writes use the configured Chat user. */
  readonly readMarkerRoute?: 'gateway-configured-user';
  /** The configured Chat user permitted to use the declared marker route. */
  readonly readMarkerOperatorPrincipalKey?: string;
  /** Connect /ws/changes?protocolVersion=2, authenticate, then return a fresh socket. */
  openAuthenticatedChanges(signal: AbortSignal): Promise<Public019Channel>;
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

function readableOptionalString(row: Record<string, unknown>, key: string, site: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  logGatewayIncompatibility(site, `Ignored invalid optional ${key}.`);
  return undefined;
}

function decodeHistoryRailDenial(value: unknown, sessionKey: string): HistoryRailDenial | undefined {
  try {
    const row = record(value);
    const principal = `session:${sessionKey}`;
    // Gateway history selection also returns denials attached to the selected
    // session but made by another principal. Only the actor's own session row
    // is a transcript pill; ignore other or unscoped principals per entry.
    if (row.sessionKey !== sessionKey || row.principal !== principal) return undefined;
    const payload = record(row.payload);
    const verb = requiredString(row, 'verb').trim();
    const rule = requiredString(row, 'rule').trim();
    const origin = requiredString(row, 'origin');
    if (!verb || !rule || !origin.trim()) {
      throw new UnsupportedTargetError('Invalid refused-action details in Gateway wire response.');
    }
    let afterMessageSeq: number | undefined;
    try { afterMessageSeq = optionalNonnegativeInteger(row, 'afterMessageSeq'); }
    catch (error) { logDecodeFailure('history refusal position', error); }
    // A refusal without a usable time still shows; it only loses time placement
    // and live matching.
    let occurredAt: number | undefined;
    try { occurredAt = nonnegativeInteger(row, 'occurredAt'); }
    catch (error) { logDecodeFailure('history refusal time', error); }
    return Object.freeze({
      id: requiredString(row, 'id'), sessionKey, principal,
      verb, rule, origin, payload: Object.freeze({ ...payload }),
      ...(occurredAt === undefined ? {} : { occurredAt }),
      ...(afterMessageSeq === undefined ? {} : { afterMessageSeq }),
    });
  } catch (error) {
    if (error instanceof UnsupportedTargetError) {
      logDecodeFailure('history refusal', error);
      return undefined;
    }
    throw error;
  }
}

function messageTime(row: Record<string, unknown>, site: string): string | undefined {
  const at = row.at;
  if (!Number.isSafeInteger(at) || (at as number) < 0) {
    logGatewayIncompatibility(site, 'Ignored invalid millisecond at timestamp.');
    return undefined;
  }
  const date = new Date(at as number);
  if (!Number.isFinite(date.getTime())) {
    logGatewayIncompatibility(site, 'Ignored timestamp outside the supported date range.');
    return undefined;
  }
  return date.toISOString();
}

/** Decode only the source-backed REST/Firehose item shape, preserving all metadata. */
export function decodePublic019Message(value: unknown, sessionKey: string): ConversationRecord {
  const row = record(value);
  if (requiredString(row, 'sessionKey') !== sessionKey) {
    throw new UnsupportedTargetError('Message belongs to a different session.');
  }
  const content = typeof row.content === 'string' ? row.content : '';
  if (typeof row.content !== 'string') logGatewayIncompatibility('message', 'Used the empty-content display fallback.');
  const recordEventIds = stringList(row.recordEventIds ?? [], 'message record-event references');
  if (row.messageType === 'marker') {
    let marker: Record<string, unknown> = {};
    if (row.marker !== undefined && row.marker !== null) {
      try { marker = record(row.marker); }
      catch (error) { logDecodeFailure('transition marker metadata', error); }
    }
    const kind = typeof marker.kind === 'string' ? marker.kind : undefined;
    if (!['harness-switch', 'model-retune', 'session-restart', 'context-compacted'].includes(kind ?? '')) {
      logGatewayIncompatibility('transition marker metadata', 'Used the unknown-transition fallback.');
    }
    const from = readableOptionalString(marker, 'from', 'transition marker metadata');
    const to = readableOptionalString(marker, 'to', 'transition marker metadata');
    return Object.freeze({
      kind: 'transition', id: requiredString(row, 'id'), sessionKey,
      seq: positiveInteger(row, 'seq'), rowVersion: positiveInteger(row, 'rowVersion'),
      transition: kind === 'harness-switch' ? 'harness' : kind === 'model-retune' ? 'model'
        : kind === 'session-restart' ? 'restart' : kind === 'context-compacted' ? 'compaction' : 'unknown',
      content, from, to, recordEventIds,
      createdAt: messageTime(row, 'transition marker'), raw: Object.freeze({ ...row }),
    });
  }
  const attachments = row.attachments;
  if (attachments !== undefined && attachments !== null && !Array.isArray(attachments)) {
    logGatewayIncompatibility('message attachments', 'Ignored a non-list attachments field.');
  }
  const attentionTier = typeof row.attentionTier === 'number' && Number.isSafeInteger(row.attentionTier)
    ? row.attentionTier : undefined;
  if (row.attentionTier !== undefined && row.attentionTier !== null && attentionTier === undefined) {
    logGatewayIncompatibility('message', 'Ignored invalid optional attentionTier.');
  }
  const turnIncludesHuman = typeof row.turnIncludesHuman === 'boolean' ? row.turnIncludesHuman : undefined;
  if (row.turnIncludesHuman !== undefined && row.turnIncludesHuman !== null && turnIncludesHuman === undefined) {
    logGatewayIncompatibility('message', 'Ignored invalid optional turnIncludesHuman.');
  }
  const isBatchCarrier = typeof row.isBatchCarrier === 'boolean' ? row.isBatchCarrier : undefined;
  if (row.isBatchCarrier !== undefined && row.isBatchCarrier !== null && isBatchCarrier === undefined) {
    logGatewayIncompatibility('message', 'Ignored invalid optional isBatchCarrier.');
  }
  const turnSeq = row.turnSeq === undefined || row.turnSeq === null ? undefined
    : Number.isSafeInteger(row.turnSeq) && (row.turnSeq as number) > 0 ? row.turnSeq as number : undefined;
  if (row.turnSeq !== undefined && row.turnSeq !== null && turnSeq === undefined) {
    logGatewayIncompatibility('message', 'Ignored invalid optional turnSeq.');
  }
  return Object.freeze({
    kind: 'message' as const,
    id: requiredString(row, 'id'),
    sessionKey,
    seq: positiveInteger(row, 'seq'),
    rowVersion: positiveInteger(row, 'rowVersion'),
    role: requiredString(row, 'role'),
    attentionTier,
    content,
    sender: readableOptionalString(row, 'sender', 'message'),
    replyToMessageId: readableOptionalString(row, 'replyToMessageId', 'message'),
    turnIncludesHuman,
    isBatchCarrier,
    messageType: readableOptionalString(row, 'messageType', 'message'),
    createdAt: messageTime(row, 'message'),
    recordEventIds,
    attachments: Object.freeze(Array.isArray(attachments) ? [...attachments] : []),
    clientMessageId: readableOptionalString(row, 'clientMessageId', 'message'),
    deviceId: readableOptionalString(row, 'deviceId', 'message'),
    turnSeq,
    raw: Object.freeze({ ...row }),
  });
}

export function decodePublic019Turn(value: unknown, sessionKey: string): CanonicalTurn {
  const row = record(value);
  if (requiredString(row, 'sessionKey') !== sessionKey) {
    throw new UnsupportedTargetError('Turn belongs to a different session.');
  }
  const origin = requiredString(row, 'origin');
  const triggerSource = row.triggerSource;
  const messageId = readableOptionalString(row, 'messageId', 'turn');
  const batchMemberCount = row.batchMemberCount === undefined || row.batchMemberCount === null ? undefined
    : Number.isSafeInteger(row.batchMemberCount) && (row.batchMemberCount as number) > 0
      ? row.batchMemberCount as number : undefined;
  if (row.batchMemberCount !== undefined && row.batchMemberCount !== null && batchMemberCount === undefined) {
    logGatewayIncompatibility('turn', 'Ignored invalid optional batchMemberCount.');
  }
  return Object.freeze({
    seq: positiveInteger(row, 'seq'), sessionKey, status: requiredString(row, 'status'),
    messageId, origin,
    triggerSource: decodeTriggerSource(triggerSource, origin),
    batchMemberCount,
    raw: Object.freeze({ ...row }),
  });
}

function decodeTriggerSource(value: unknown, origin: string): CanonicalTurn['triggerSource'] {
  if (value === 'batch' || value === 'agent' || value === 'process' || value === 'other') return value;
  if (typeof value !== 'string' || !value || !origin.startsWith('user:')) return undefined;
  if (!origin.slice('user:'.length)) return undefined;
  // Gateway uses a nonstandard trigger value for human turns; the user origin disambiguates it.
  return 'human';
}

export function decodePublic019Session(value: unknown, sessionKey: string): SessionRecord {
  const row = record(value);
  if (requiredString(row, 'sessionKey') !== sessionKey) {
    throw new UnsupportedTargetError('Session detail belongs to a different session.');
  }
  const clearedThroughSeq = typeof row.clearedThroughSeq === 'number' && Number.isSafeInteger(row.clearedThroughSeq) &&
    row.clearedThroughSeq >= 0 ? row.clearedThroughSeq : undefined;
  if (row.clearedThroughSeq !== undefined && row.clearedThroughSeq !== null && clearedThroughSeq === undefined) {
    logGatewayIncompatibility('session', 'Ignored invalid optional clearedThroughSeq.');
  }
  const model = readableOptionalString(row, 'model', 'session');
  const harness = readableOptionalString(row, 'harness', 'session');
  const mechanicalStatus = readableOptionalString(row, 'mechanicalStatus', 'session');
  const state = readableOptionalString(row, 'state', 'session');
  const displayName = typeof row.displayName === 'string' ? row.displayName : '';
  if (typeof row.displayName !== 'string') logGatewayIncompatibility('session', 'Used the empty display-name fallback.');
  return Object.freeze({
    sessionKey,
    rowVersion: positiveInteger(row, 'rowVersion'),
    clearedThroughSeq,
    displayName,
    model,
    harness,
    activity: mechanicalStatus ?? state,
    raw: Object.freeze({ ...row }),
  });
}

function stringList(value: unknown, site: string): readonly string[] {
  if (!Array.isArray(value)) {
    logGatewayIncompatibility(site, 'Used an empty-list fallback.');
    return Object.freeze([]);
  }
  const strings = value.filter((item): item is string => typeof item === 'string');
  if (strings.length !== value.length) logGatewayIncompatibility(site, 'Ignored non-string list entries.');
  return Object.freeze(strings);
}

/** History supplies the session through its route; live frames supply refs.sessionKey. */
export function decodeRecordEvent(value: unknown, sessionKey: string): SessionRecordEvent {
  const row = record(value);
  const source = record(row.record);
  let cause: Record<string, unknown> | null = null;
  if (row.cause != null) {
    try { cause = record(row.cause); }
    catch (error) { logDecodeFailure('record-event cause', error); }
  }
  const actorSessionKey = readableOptionalString(row, 'actorSessionKey', 'record-event');
  let causeTurnSeq: number | null = null;
  let causeMessageId: string | undefined;
  if (cause) {
    const value = cause.turnSeq;
    if (value !== undefined && value !== null) {
      if (Number.isSafeInteger(value) && (value as number) > 0) causeTurnSeq = value as number;
      else logGatewayIncompatibility('record-event cause', 'Ignored invalid turnSeq.');
    }
    causeMessageId = readableOptionalString(cause, 'messageId', 'record-event cause');
  }
  return Object.freeze({ eventId: requiredString(row, 'eventId'), sessionKey,
    kind: requiredString(row, 'kind'), at: nonnegativeInteger(row, 'at'),
    record: Object.freeze({ type: requiredString(source, 'type'), id: requiredString(source, 'id'),
      detail: requiredString(source, 'detail'), workItemId: readableOptionalString(source, 'workItemId', 'record-event details') }),
    actorSessionKey: actorSessionKey ?? null,
    tiedAs: stringList(row.tiedAs, 'record-event tiedAs'),
    noticeMessageIds: stringList(row.noticeMessageIds, 'record-event notice references'),
    cause: cause ? Object.freeze({ turnSeq: causeTurnSeq, messageId: causeMessageId ?? null }) : null,
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
  const title = typeof row.title === 'string' ? row.title : '';
  if (typeof row.title !== 'string') logGatewayIncompatibility('tool call', 'Used the existing title fallback.');
  const kind = typeof row.kind === 'string' ? row.kind : '';
  if (typeof row.kind !== 'string') logGatewayIncompatibility('tool call', 'Ignored invalid kind.');
  const toolName = readableOptionalString(row, 'toolName', 'tool call') ?? null;
  if (!title.trim() && !toolName?.trim() && !kind.trim()) {
    throw new UnsupportedTargetError('Tool call has no usable display label.');
  }
  const truncated: Array<{ field: 'rawInput' | 'rawOutput' | 'content'; originalBytes: number }> = [];
  if (!Array.isArray(row.truncated)) {
    logGatewayIncompatibility('tool call truncation metadata', 'Used an empty-list fallback.');
  } else {
    row.truncated.forEach(value => {
      try {
        const entry = record(value);
        if (!['rawInput', 'rawOutput', 'content'].includes(String(entry.field))) {
          throw new UnsupportedTargetError('Invalid truncation field.');
        }
        truncated.push(Object.freeze({ field: entry.field as 'rawInput' | 'rawOutput' | 'content',
          originalBytes: positiveInteger(entry, 'originalBytes') }));
      } catch (error) {
        if (!(error instanceof UnsupportedTargetError)) throw error;
        logDecodeFailure('tool call truncation metadata', error);
      }
    });
  }
  const harnessToolCallId = readableOptionalString(row, 'harnessToolCallId', 'tool call') ?? '';
  const endedAt = row.endedAt === null || row.endedAt === undefined ? null
    : Number.isSafeInteger(row.endedAt) && (row.endedAt as number) >= 0 ? row.endedAt as number : null;
  if (row.endedAt !== null && row.endedAt !== undefined && endedAt === null) {
    logGatewayIncompatibility('tool call', 'Ignored invalid optional endedAt.');
  }
  return Object.freeze({ id: requiredString(row, 'id'), seq: positiveInteger(row, 'seq'), sessionKey,
    turnSeq: positiveInteger(row, 'turnSeq'), afterMessageSeq: integer('afterMessageSeq'),
    harnessToolCallId, title, kind,
    toolName, status: status as ToolCallRecord['status'],
    rawInput: row.rawInput ?? null, rawOutput: row.rawOutput ?? null, content: row.content ?? null,
    truncated: Object.freeze(truncated), startedAt: integer('startedAt'),
    endedAt, rowVersion: positiveInteger(row, 'rowVersion'),
  });
}

export function decodeTurnEvent(value: unknown, sessionKey: string): TurnEventRecord {
  const row = record(value);
  if (requiredString(row, 'sessionKey') !== sessionKey) {
    throw new UnsupportedTargetError('Turn event belongs to a different session.');
  }
  const kind = row.kind;
  if (!['assistant.segment', 'tool.started', 'tool.ended'].includes(String(kind))) {
    throw new UnsupportedTargetError('Unknown turn-event kind.');
  }
  const turnSeq = positiveInteger(row, 'turnSeq');
  const turnEventSeq = positiveInteger(row, 'turnEventSeq');
  const messageId = readableOptionalString(row, 'messageId', 'turn event') ?? null;
  const toolCallId = readableOptionalString(row, 'toolCallId', 'turn event') ?? null;
  let content: Readonly<Record<string, unknown>> | null = null;
  let toolCall: ToolCallRecord | null = null;
  if (kind === 'assistant.segment') {
    if (!messageId || toolCallId || !row.content || typeof row.content !== 'object' || Array.isArray(row.content)) {
      throw new UnsupportedTargetError('Assistant turn event has an invalid message segment.');
    }
    content = Object.freeze({ ...(row.content as Record<string, unknown>) });
    if (content.type !== 'text' || typeof content.text !== 'string') {
      throw new UnsupportedTargetError('Assistant turn event does not contain a text segment.');
    }
    if (row.toolCall !== null && row.toolCall !== undefined) {
      throw new UnsupportedTargetError('Assistant turn event unexpectedly contains a tool call.');
    }
  } else {
    if (messageId || !toolCallId || !row.toolCall || typeof row.toolCall !== 'object' || Array.isArray(row.toolCall)) {
      throw new UnsupportedTargetError('Tool turn event has an invalid tool-call reference.');
    }
    toolCall = decodeToolCall(row.toolCall, sessionKey);
    if (toolCall.id !== toolCallId || toolCall.turnSeq !== turnSeq) {
      throw new UnsupportedTargetError('Tool turn event does not match its tool-call reference.');
    }
    if (row.content !== null && row.content !== undefined) {
      throw new UnsupportedTargetError('Tool turn event unexpectedly contains a message segment.');
    }
  }
  return Object.freeze({ id: requiredString(row, 'id'), sessionKey, turnSeq, turnEventSeq,
    kind: kind as TurnEventRecord['kind'], messageId, toolCallId, content, toolCall,
    rowVersion: positiveInteger(row, 'rowVersion') });
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
      if (refs.origin !== undefined && origin === undefined) logGatewayIncompatibility('refused-action notice', 'Ignored invalid origin.');
      if (frame.occurredAt !== undefined &&
          !(Number.isSafeInteger(frame.occurredAt) && (frame.occurredAt as number) >= 0)) {
        logGatewayIncompatibility('refused-action notice', 'Ignored invalid occurredAt.');
      }
      if (refs.afterMessageSeq !== undefined &&
          !(Number.isSafeInteger(refs.afterMessageSeq) && (refs.afterMessageSeq as number) >= 0)) {
        logGatewayIncompatibility('refused-action notice', 'Ignored invalid afterMessageSeq.');
      }
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
    logGatewayIncompatibility('refused-action notice', 'Skipped an unusable refusal entry.');
    return { operation: 'unknown', sessionKey, resource: frame.class };
  }
  const knownClass = frame.class === 'session_record_event.created' ||
    frame.class === 'message.created' || frame.class === 'transition.recorded' ||
    frame.class === 'message.attachment_delivery.updated' ||
    frame.class === 'tool_call.started' || frame.class === 'tool_call.ended' ||
    frame.class === 'message.segment_recorded' || frame.class === 'tool_call.event_recorded' ||
    frame.class.startsWith('session.') || frame.class === 'turn.started' || frame.class === 'turn.ended';
  if (!knownClass) {
    logGatewayIncompatibility('change notice', 'Skipped an unknown change class.');
    return { operation: 'unknown', sessionKey, resource: frame.class };
  }
  const refs = record(frame.refs);
  if (refs.sessionKey !== sessionKey) throw new UnsupportedTargetError('Change frame has a different session reference.');
  if (frame.class === 'message.attachment_delivery.updated') {
    const payload = record(frame.payload);
    if (payload.sessionKey !== sessionKey ||
        typeof payload.messageId !== 'string' || !payload.messageId.trim() ||
        typeof payload.clientMessageId !== 'string' || !payload.clientMessageId.trim() ||
        typeof payload.assetId !== 'string' || !payload.assetId.trim() ||
        (refs.messageId !== undefined && refs.messageId !== payload.messageId)) {
      throw new UnsupportedTargetError('Attachment delivery notice has invalid message references.');
    }
    return { operation: 'attachment-delivery-delta', sessionKey,
      messageId: payload.messageId, clientMessageId: payload.clientMessageId, assetId: payload.assetId };
  }
  if (frame.class === 'session_record_event.created') {
    return { operation: 'record-event', event: decodeRecordEvent(frame.payload, sessionKey) };
  }
  if (frame.class === 'message.created' || frame.class === 'transition.recorded') {
    if (!['messages', 'transcript messages'].includes(String(frame.resource)) || frame.op !== 'upsert') {
      logGatewayIncompatibility('transcript notice', 'Skipped an unexpected resource or operation.');
      return { operation: 'unknown', sessionKey, resource: frame.class };
    }
    return { operation: 'upsert', record: decodePublic019Message(frame.payload, sessionKey) };
  }
  if (frame.class === 'tool_call.started' || frame.class === 'tool_call.ended') {
    if (frame.resource !== 'tool calls' || frame.op !== 'upsert') {
      logGatewayIncompatibility('tool-call notice', 'Skipped an unexpected resource or operation.');
      return { operation: 'unknown', sessionKey, resource: frame.class };
    }
    return { operation: 'tool', tool: decodeToolCall(frame.payload, sessionKey) };
  }
  if (frame.class === 'message.segment_recorded' || frame.class === 'tool_call.event_recorded') {
    if (frame.resource !== 'turn events' || frame.op !== 'upsert') {
      logGatewayIncompatibility('turn-event notice', 'Skipped an unexpected resource or operation.');
      return { operation: 'unknown', sessionKey, resource: frame.class };
    }
    const event = decodeTurnEvent(frame.payload, sessionKey);
    if ((frame.class === 'message.segment_recorded' && event.kind !== 'assistant.segment') ||
        (frame.class === 'tool_call.event_recorded' && event.kind === 'assistant.segment')) {
      throw new UnsupportedTargetError('Turn-event notice class does not match its payload.');
    }
    if (record(frame.refs).turnEventId !== event.id) {
      throw new UnsupportedTargetError('Turn-event notice reference does not match its payload.');
    }
    return { operation: 'turn-event', event };
  }
  if (frame.class.startsWith('session.')) {
    if (frame.resource !== 'sessions' || frame.op !== 'upsert') {
      logGatewayIncompatibility('session notice', 'Skipped an unexpected resource or operation.');
      return { operation: 'unknown', sessionKey, resource: frame.class };
    }
    return { operation: 'session', session: decodePublic019Session(frame.payload, sessionKey) };
  }
  // The payload seq identifies the turn; the outer seq orders this subscription.
  if (frame.class === 'turn.started' || frame.class === 'turn.ended') {
    if (frame.resource !== 'turns' || frame.op !== 'upsert') {
      logGatewayIncompatibility('turn notice', 'Skipped an unexpected resource or operation.');
      return { operation: 'unknown', sessionKey, resource: frame.class };
    }
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

async function gatewayError(response: Response): Promise<{ code?: string; message?: string; sessionKey?: string;
  clientMessageId?: string; maxDeliverableAttachmentBytes?: number; offendingAssetIds?: unknown }> {
  try {
    const body = record(await response.json());
    if (!body.error || typeof body.error !== 'object' || Array.isArray(body.error)) return {};
    const error = body.error as Record<string, unknown>;
    return {
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
      ...(typeof error.message === 'string' ? { message: error.message } : {}),
      ...(typeof body.sessionKey === 'string' ? { sessionKey: body.sessionKey } : {}),
      ...(typeof body.clientMessageId === 'string' ? { clientMessageId: body.clientMessageId } : {}),
      ...(Number.isSafeInteger(body.maxDeliverableAttachmentBytes)
        ? { maxDeliverableAttachmentBytes: body.maxDeliverableAttachmentBytes as number } : {}),
      ...(body.offendingAssetIds !== undefined ? { offendingAssetIds: body.offendingAssetIds } : {}),
    };
  } catch {
    return {};
  }
}

function attachmentLimitRefusal(error: Awaited<ReturnType<typeof gatewayError>>,
  submission: HumanSubmission): AttachmentLimitRefusal | undefined {
  const requestedIds = submission.attachments?.map(reference => reference.assetId) ?? [];
  if (error.code !== 'attachment_over_limit' || error.sessionKey !== submission.sessionKey ||
      error.clientMessageId !== submission.clientMessageId || !requestedIds.length ||
      !Number.isSafeInteger(error.maxDeliverableAttachmentBytes) ||
      (error.maxDeliverableAttachmentBytes as number) <= 0 || !Array.isArray(error.offendingAssetIds) ||
      error.offendingAssetIds.length === 0) return undefined;
  const offendingAssetIds = error.offendingAssetIds;
  let previousIndex = -1;
  for (const assetId of offendingAssetIds) {
    if (typeof assetId !== 'string' || !assetId.trim()) return undefined;
    const index = requestedIds.indexOf(assetId);
    if (index <= previousIndex) return undefined;
    previousIndex = index;
  }
  return Object.freeze({ offendingAssetIds: Object.freeze([...offendingAssetIds] as string[]),
    maxDeliverableAttachmentBytes: error.maxDeliverableAttachmentBytes as number,
    ...(typeof error.message === 'string' && error.message.trim() ? { message: error.message } : {}),
  });
}

const unknownAssessmentMessage = 'Attachment delivery could not be confirmed.';

function unknownAttachmentAssessment(sessionKey: string, clientMessageId: string,
  assetIds: readonly string[], maxDeliverableAttachmentBytes?: number,
  reason: AttachmentDeliveryReason = { code: 'assessment-unavailable', message: unknownAssessmentMessage }): AttachmentAssessmentResult {
  return Object.freeze({ sessionKey, clientMessageId,
    ...(maxDeliverableAttachmentBytes === undefined ? {} : { maxDeliverableAttachmentBytes }),
    attachments: Object.freeze(assetIds.map(assetId => Object.freeze({
      assetId, assessment: 'unknown' as const, reason: Object.freeze({ ...reason }),
    }))),
  });
}

function assessmentReason(value: unknown): AttachmentDeliveryReason | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const reason = value as Record<string, unknown>;
  if (typeof reason.code !== 'string' || !reason.code.trim() ||
      typeof reason.message !== 'string' || !reason.message.trim()) return undefined;
  return Object.freeze({ code: reason.code, message: reason.message });
}

function decodeAssessmentRows(value: unknown, sessionKey: string, clientMessageId: string,
  assetIds: readonly string[], requireLimit: boolean, forceUnknown: boolean): AttachmentAssessmentResult | undefined {
  try {
    const envelope = record(value);
    if (envelope.sessionKey !== sessionKey || envelope.clientMessageId !== clientMessageId ||
        !Array.isArray(envelope.attachments) || envelope.attachments.length !== assetIds.length) return undefined;
    const limit = envelope.maxDeliverableAttachmentBytes;
    if (requireLimit && (!Number.isSafeInteger(limit) || (limit as number) < 0)) return undefined;
    const attachments: AttachmentAssessmentItem[] = [];
    for (const [index, value] of envelope.attachments.entries()) {
      const row = record(value);
      if (row.assetId !== assetIds[index]) return undefined;
      if (forceUnknown) {
        if (row.assessment !== 'unknown') return undefined;
        const reason = assessmentReason(row.reason);
        if (!reason) return undefined;
        attachments.push(Object.freeze({ assetId: assetIds[index], assessment: 'unknown', reason }));
        continue;
      }
      if (row.assessment === 'will-deliver' && row.reason === null) {
        attachments.push(Object.freeze({ assetId: assetIds[index], assessment: 'will-deliver', reason: null }));
      } else if (row.assessment === 'will-not-deliver' || row.assessment === 'unknown') {
        const reason = assessmentReason(row.reason);
        if (!reason) return undefined;
        attachments.push(Object.freeze({ assetId: assetIds[index], assessment: row.assessment, reason }));
      } else return undefined;
    }
    return Object.freeze({ sessionKey, clientMessageId,
      ...(Number.isSafeInteger(limit) && (limit as number) >= 0
        ? { maxDeliverableAttachmentBytes: limit as number } : {}),
      attachments: Object.freeze(attachments),
    });
  } catch {
    return undefined;
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

function isTurnEventsCollectionPath(path: string): boolean {
  try { return /^\/api\/sessions\/[^/]+\/turn-events$/.test(new URL(path, 'https://gateway.invalid').pathname); }
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
      if (response.status === 404 && isTurnEventsCollectionPath(path)) {
        throw new TurnEventHistoryUnavailableError('Reply ordering history is unavailable.');
      }
      throw new Error(`Tightbeam REST request failed with HTTP ${response.status}${code ? ` (${code})` : ''}.`);
    }
    try { return record(await response.json()); }
    catch (error) {
      logDecodeFailure('Gateway REST response', error);
      throw error;
    }
  }

  const activeSessions = new Set<string>();
  async function readPage(sessionKey: string, query: string, signal: AbortSignal,
    isAfterPage = false): Promise<ConversationPage> {
    const body = await get(`/api/sessions/${encodeURIComponent(sessionKey)}/messages?limit=50&${query}`, signal);
    if (body.schemaVersion !== 1 || body.resource !== 'transcript messages' || !Array.isArray(body.items)) {
      logGatewayIncompatibility('transcript history', 'Received an unexpected protocol envelope.');
      throw new UnsupportedTargetError('Unexpected transcript collection envelope.');
    }
    let page: Record<string, unknown>;
    try { page = record(body.page); }
    catch (error) { logDecodeFailure('transcript page metadata', error); throw error; }
    let oldestCursor: string | null;
    let newestCursor: string | null;
    try {
      oldestCursor = optionalString(page, 'oldestCursor') ?? null;
      newestCursor = optionalString(page, 'newestCursor') ?? null;
    } catch (error) { logDecodeFailure('transcript page metadata', error); throw error; }
    const hasMoreAfter = page.hasMoreAfter;
    const emptyAfterWithoutBackwardCursor = isAfterPage && body.items.length === 0 && !oldestCursor;
    if (typeof page.hasMoreBefore !== 'boolean' || typeof hasMoreAfter !== 'boolean' ||
        (page.hasMoreBefore && !oldestCursor && !emptyAfterWithoutBackwardCursor) ||
        (page.hasMoreAfter && !newestCursor)) {
      logGatewayIncompatibility('transcript page metadata', 'Received unusable pagination fields.');
      throw new UnsupportedTargetError('Invalid transcript page metadata.');
    }
    let railDenials: unknown[] | undefined;
    if (body.railDenials === undefined || body.railDenials === null) railDenials = undefined;
    else if (Array.isArray(body.railDenials)) railDenials = body.railDenials;
    else {
      logGatewayIncompatibility('history refusal collection', 'Ignored a non-list optional field.');
    }
    const records: ConversationRecord[] = [];
    for (const item of body.items) {
      try { records.push(decodePublic019Message(item, sessionKey)); }
      catch (error) {
        if (!(error instanceof UnsupportedTargetError)) throw error;
        logDecodeFailure('transcript history item', error);
      }
    }
    if (body.items.length > 0 && records.length === 0) {
      logGatewayIncompatibility('transcript history', 'No entries had enough information to place a message.');
      throw new UnsupportedTargetError('Transcript page contains no usable messages.');
    }
    return { records: records.sort((a, b) => a.seq - b.seq), oldestCursor: emptyAfterWithoutBackwardCursor ? null : oldestCursor,
      hasOlder: emptyAfterWithoutBackwardCursor ? false : page.hasMoreBefore,
      newestCursor, hasNewer: hasMoreAfter,
      ...(railDenials === undefined ? {} : {
        railDenials: Object.freeze(railDenials.flatMap((denial) => {
          const decoded = decodeHistoryRailDenial(denial, sessionKey);
          return decoded ? [decoded] : [];
        })),
      }), coverage: sessionKey };
  }

  async function openChanges(sessionKey: string, callbacks: ChangeCallbacks, signal: AbortSignal,
    tools = false, turnEvents = false): Promise<ChangeConnection> {
      const channel = await config.host.openAuthenticatedChanges(signal);
      const category = turnEvents ? 'turn-events' : tools ? 'tools' : 'chat';
      let closed = false;
      let ready = false;
      let railSubscriptionPending = false;
      let railRefusalBeforeReady = false;
      let lastSeq = 0;
      let pageWasSuspended = typeof document !== 'undefined' && document.visibilityState !== 'visible';
      let stopListening = () => {};
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      const subscriptionId = `${category}:${sessionKey}`;
      const railSubscriptionId = `rail:${sessionKey}`;
      const hasRailSubscription = category === 'chat';
      const close = () => {
        if (closed) return;
        closed = true;
        if (category === 'chat') activeSessions.delete(sessionKey);
        if (readyTimer) clearTimeout(readyTimer);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        stopListening();
        signal.removeEventListener('abort', onAbort);
        if (category === 'chat' && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
        if (category === 'chat' && typeof window !== 'undefined') {
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
      if (category === 'chat' && typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);
      if (category === 'chat' && typeof window !== 'undefined') {
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
              if (category === 'chat') activeSessions.add(sessionKey);
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
            let notice: ChangeNotice;
            try { notice = decodePublic019Notice(frame, sessionKey); }
            catch (error) {
              if (error instanceof UnsupportedTargetError && frame.schemaVersion === 2 && typeof frame.class === 'string') {
                logDecodeFailure('live change entry', error);
                watchHeartbeat();
                return;
              }
              throw error;
            }
            callbacks.onNotice(notice);
          }
          watchHeartbeat();
        } catch (error) {
          if (error instanceof UnsupportedTargetError) {
            logDecodeFailure(ready ? 'live change frame' : 'change subscription frame', error);
          }
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
          const classes = tools ? ['tool_call.'] : turnEvents
            ? ['message.segment_recorded', 'tool_call.event_recorded']
            : ['message.created', 'message.attachment_delivery.updated', 'transition.recorded',
              'session.', 'turn.started', 'turn.ended', 'session_record_event.created'];
          channel.send({ type: 'subscribe', protocolVersion: 2, subscriptionId, filters: { sessionKey, classes } });
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

  const markerOperatorPrincipalKey = config.host.readMarkerOperatorPrincipalKey?.trim();
  const markerTransport: Pick<ChatTransport,
    'readMarkerOperatorPrincipalKey' | 'readReadMarker' | 'writeReadMarker'> =
    config.host.readMarkerRoute === 'gateway-configured-user' && markerOperatorPrincipalKey ? {
      readMarkerOperatorPrincipalKey: markerOperatorPrincipalKey,
      async readReadMarker(scopeKey, signal): Promise<ReadMarkerReadResult> {
        if (config.host.currentIdentity().principalKey !== markerOperatorPrincipalKey) return { supported: false };
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
        let body: Record<string, unknown>;
        try { body = record(await response.json()); }
        catch (error) {
          logDecodeFailure('read marker response', error);
          throw error;
        }
        if (body.schemaVersion !== 1 || body.resource !== 'read markers') {
          logGatewayIncompatibility('read marker', 'Used the unsupported-protocol fallback.');
          return { supported: false };
        }
        let item: Record<string, unknown>;
        try { item = record(body.item); }
        catch (error) {
          logDecodeFailure('read marker', error);
          return { supported: false };
        }
        if (item.userId !== markerOperatorPrincipalKey || item.scopeKey !== scopeKey) return { supported: false };
        const marker = readMarkerValue(item.marker);
        if (marker === undefined) logGatewayIncompatibility('read marker', 'Used the unsupported-marker fallback.');
        return marker === undefined ? { supported: false } : { supported: true, marker };
      },
      async writeReadMarker(request: ReadMarkerWriteRequest, signal): Promise<ReadMarkerWriteResult> {
        if (request.userId !== markerOperatorPrincipalKey ||
            config.host.currentIdentity().principalKey !== markerOperatorPrincipalKey) {
          return 'unsupported';
        }
        const response = await config.host.fetch(`${baseUrl}/agent/dispatch`, {
          method: 'POST', signal, cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            verb: 'read-marker-set',
            asUser: markerOperatorPrincipalKey,
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
        logGatewayIncompatibility('session detail', 'Received an unexpected protocol envelope.');
        throw new UnsupportedTargetError('Unexpected sessions detail envelope.');
      }
      try { return decodePublic019Session(body.item, sessionKey); }
      catch (error) {
        if (error instanceof UnsupportedTargetError) logDecodeFailure('session detail', error);
        throw error;
      }
    },
    async readRoleSessionKey(roleName, signal) {
      const body = await get(`/api/roles/${encodeURIComponent(roleName)}`, signal);
      if (body.schemaVersion !== 1 || body.resource !== 'roles') {
        logGatewayIncompatibility('role detail', 'Received an unexpected protocol envelope.');
        throw new UnsupportedTargetError('Unexpected role detail envelope.');
      }
      try {
        const role = record(body.item);
        if (requiredString(role, 'name') !== roleName) {
          throw new UnsupportedTargetError('Role detail belongs to a different role.');
        }
        return requiredString(role, 'boundSessionKey');
      } catch (error) {
        if (error instanceof UnsupportedTargetError) logDecodeFailure('role detail', error);
        throw error;
      }
    },
    async readMessage(sessionKey, messageId, signal) {
      const body = await get(`/api/sessions/${encodeURIComponent(sessionKey)}/messages/${encodeURIComponent(messageId)}`, signal);
      if (body.schemaVersion !== 1 || body.resource !== 'transcript messages') {
        logGatewayIncompatibility('transcript message detail', 'Received an unexpected protocol envelope.');
        throw new UnsupportedTargetError('Unexpected transcript message detail envelope.');
      }
      try { return decodePublic019Message(body.item, sessionKey); }
      catch (error) {
        if (error instanceof UnsupportedTargetError) logDecodeFailure('transcript message detail', error);
        throw error;
      }
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
    openTurnEventChanges: (sessionKey, callbacks, signal) => openChanges(sessionKey, callbacks, signal, false, true),
    async readTurnEvents(sessionKey, turnSeqs, signal): Promise<readonly TurnEventRecord[]> {
      const requestedTurns = [...new Set(turnSeqs)].sort((left, right) => left - right);
      const events: TurnEventRecord[] = [];
      for (const turnSeq of requestedTurns) {
        if (!Number.isSafeInteger(turnSeq) || turnSeq < 1) {
          throw new UnsupportedTargetError('Turn-event history received an invalid turn sequence.');
        }
        let before: string | undefined;
        const cursors = new Set<string>();
        const turnEvents: TurnEventRecord[] = [];
        while (true) {
          const query = new URLSearchParams({ limit: '500', turnSeq: String(turnSeq) });
          if (before) query.set('before', before);
          const body = await get(`/api/sessions/${encodeURIComponent(sessionKey)}/turn-events?${query}`, signal);
          if (body.schemaVersion !== 1 || body.resource !== 'turn events' || !Array.isArray(body.items)) {
            logGatewayIncompatibility('turn-event history', 'Received an unexpected protocol envelope.');
            throw new UnsupportedTargetError('Unexpected turn-event collection envelope.');
          }
          let page: Record<string, unknown>;
          let oldestCursor: string | null;
          try {
            page = record(body.page);
            oldestCursor = optionalString(page, 'oldestCursor') ?? null;
          } catch (error) {
            logDecodeFailure('turn-event page metadata', error);
            throw new UnsupportedTargetError('Invalid turn-event page metadata.');
          }
          if (typeof page.hasMoreBefore !== 'boolean' || (page.hasMoreBefore && !oldestCursor)) {
            logGatewayIncompatibility('turn-event history', 'Received an unusable page cursor.');
            throw new UnsupportedTargetError('Invalid turn-event page cursor.');
          }
          for (const item of body.items) {
            try {
              const event = decodeTurnEvent(item, sessionKey);
              if (event.turnSeq !== turnSeq) throw new UnsupportedTargetError('Turn event falls outside its requested turn.');
              turnEvents.push(event);
            } catch (error) {
              logDecodeFailure('turn-event history item', error);
              throw new UnsupportedTargetError('Turn-event history contains an unusable event.');
            }
          }
          if (!page.hasMoreBefore) break;
          if (!oldestCursor || cursors.has(oldestCursor)) {
            throw new UnsupportedTargetError('Turn-event history cursor did not advance.');
          }
          cursors.add(oldestCursor);
          before = oldestCursor;
        }
        turnEvents.sort((left, right) => left.turnEventSeq - right.turnEventSeq || left.id.localeCompare(right.id));
        for (let index = 0; index < turnEvents.length; index++) {
          if (turnEvents[index].turnEventSeq !== index + 1) {
            throw new UnsupportedTargetError('Turn-event history is missing an ordinal.');
          }
        }
        events.push(...turnEvents);
      }
      return Object.freeze(events.sort((left, right) => left.turnSeq - right.turnSeq ||
        left.turnEventSeq - right.turnEventSeq || left.id.localeCompare(right.id)));
    },
    async readRecordEvents(sessionKey, before, signal): Promise<RecordEventPage> {
      const query = new URLSearchParams({ limit: '50' });
      if (before) query.set('before', before);
      const body = await get('/api/sessions/' + encodeURIComponent(sessionKey) + '/record-events?' + query, signal);
      if (body.schemaVersion !== 1 || body.resource !== 'record events' || !Array.isArray(body.items)) {
        logGatewayIncompatibility('record-event history', 'Received an unexpected protocol envelope.');
        throw new Error('Unexpected record-event collection envelope.');
      }
      let page: Record<string, unknown>;
      let oldestCursor: string | null;
      try {
        page = record(body.page);
        oldestCursor = optionalString(page, 'oldestCursor') ?? null;
      } catch (error) { logDecodeFailure('record-event page metadata', error); throw error; }
      if (typeof page.hasMoreBefore !== 'boolean' || (page.hasMoreBefore && !oldestCursor)) {
        logGatewayIncompatibility('record-event history', 'Received an unusable page cursor.');
        throw new Error('Invalid record-event page cursor.');
      }
      const items: SessionRecordEvent[] = [];
      for (const item of body.items) {
        try { items.push(decodeRecordEvent(item, sessionKey)); }
        catch (error) {
          if (!(error instanceof UnsupportedTargetError)) throw error;
          logDecodeFailure('record-event history item', error);
        }
      }
      if (body.items.length > 0 && items.length === 0) {
        logGatewayIncompatibility('record-event history', 'No entries had enough information to place an activity item.');
        throw new UnsupportedTargetError('Record-event page contains no usable entries.');
      }
      return Object.freeze({ items: Object.freeze(items), oldestCursor, hasOlder: page.hasMoreBefore });
    },
    async readToolCalls(sessionKey, range, signal) {
      const filters = new URLSearchParams({ limit: '50', afterMessageSeqFromInclusive: String(range.fromInclusive) });
      if (range.toExclusive !== undefined) filters.set('afterMessageSeqToExclusive', String(range.toExclusive));
      const calls = new Map<string, ToolCallRecord>();
      const cursors = new Set<string>();
      let seenItems = 0;
      while (true) {
        const body = await get('/api/sessions/' + encodeURIComponent(sessionKey) + '/tool-calls?' + filters, signal);
        if (body.schemaVersion !== 1 || body.resource !== 'tool calls' || !Array.isArray(body.items)) {
          logGatewayIncompatibility('tool-call history', 'Received an unexpected protocol envelope.');
          throw new Error('Unexpected tool-call collection envelope.');
        }
        seenItems += body.items.length;
        for (const item of body.items) {
          try {
            const call = decodeToolCall(item, sessionKey);
            if (call.afterMessageSeq < range.fromInclusive ||
                (range.toExclusive !== undefined && call.afterMessageSeq >= range.toExclusive)) {
              throw new UnsupportedTargetError('Tool call falls outside the requested history slice.');
            }
            const previous = calls.get(call.id);
            if (!previous || call.rowVersion > previous.rowVersion) calls.set(call.id, call);
          } catch (error) {
            if (!(error instanceof UnsupportedTargetError)) throw error;
            logDecodeFailure('tool-call history item', error);
          }
        }
        let page: Record<string, unknown>;
        try { page = record(body.page); }
        catch (error) { logDecodeFailure('tool-call page metadata', error); throw error; }
        if (page.hasMoreBefore === false) break;
        let cursor: string | undefined;
        try { cursor = optionalString(page, 'oldestCursor'); }
        catch (error) { logDecodeFailure('tool-call page metadata', error); throw error; }
        if (page.hasMoreBefore !== true || !cursor || cursors.has(cursor)) {
          logGatewayIncompatibility('tool-call history', 'Received an unusable page cursor.');
          throw new Error('Invalid tool-call page cursor.');
        }
        cursors.add(cursor);
        filters.set('before', cursor);
      }
      if (seenItems > 0 && calls.size === 0) {
        logGatewayIncompatibility('tool-call history', 'No entries had enough information to place a tool call.');
        throw new UnsupportedTargetError('Tool-call history contains no usable entries.');
      }
      return Object.freeze([...calls.values()].sort((a, b) => a.afterMessageSeq - b.afterMessageSeq || a.seq - b.seq));
    },
    async uploadAttachment(input, signal) {
      const body = new FormData();
      body.append('file', input.bytes, input.filename);
      const response = await config.host.fetch(`${baseUrl}/upload`, { method: 'POST', body, signal });
      if (!response.ok) {
        let code = `http-${response.status}`;
        try {
          const error = await response.json();
          if (typeof error?.code === 'string') code = error.code;
          else if (typeof error?.error === 'string') code = error.error;
        } catch { /* Some upstream failures have no JSON body. */ }
        throw new AttachmentUploadError(code, `Attachment upload failed (HTTP ${response.status}): ${code}`);
      }
      let wire: unknown;
      try { wire = await response.json(); }
      catch (error) {
        logDecodeFailure('attachment upload response', error);
        throw error;
      }
      const upload = wire && typeof wire === 'object' && !Array.isArray(wire)
        ? wire as Record<string, unknown> : {};
      if (typeof upload.assetId !== 'string' || !upload.assetId ||
          typeof upload.mimeType !== 'string' || !upload.mimeType || !Number.isSafeInteger(upload.size) ||
          upload.size !== input.bytes.size || upload.mimeType !== (input.bytes.type || 'application/octet-stream')) {
        logGatewayIncompatibility('attachment upload response', 'Received an incompatible attachment reference.');
        throw new AttachmentUploadError('reference-mismatch', 'Attachment upload returned a different type or byte count.');
      }
      return Object.freeze({ assetId: upload.assetId, mimeType: upload.mimeType,
        filename: input.filename, size: upload.size as number }) as AttachmentReference;
    },
    async readAttachment(reference, signal) {
      const response = await config.host.fetch(`${baseUrl}/download/${encodeURIComponent(reference.assetId)}`,
        { method: 'GET', signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`Attachment retrieval failed (HTTP ${response.status}).`);
      const bytes = await response.blob();
      if (bytes.size !== reference.size) {
        logGatewayIncompatibility('attachment download', 'Received an incomplete attachment.');
        throw new Error('Attachment retrieval returned an incomplete file.');
      }
      return bytes;
    },
    async assessAttachments(request, signal): Promise<AttachmentAssessmentResult | undefined> {
      const references = request.attachments ?? [];
      const assetIds = references.map(reference => reference.assetId);
      const fallback = () => unknownAttachmentAssessment(request.sessionKey, request.clientMessageId, assetIds);
      if (!assetIds.length) return fallback();
      if (signal.aborted) throw signal.reason ?? new Error('Attachment assessment was interrupted.');
      const submittingIdentity = config.host.currentIdentity();
      if (!submittingIdentity.principalKey?.trim()) return fallback();

      const controller = new AbortController();
      const relayAbort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', relayAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Attachment assessment timed out.'));
      }, timeoutMs);
      try {
        const response = await config.host.fetch(`${baseUrl}/agent/dispatch`, {
          method: 'POST', signal: controller.signal, cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            verb: 'assess_attachments',
            asUser: submittingIdentity.principalKey,
            sessionKey: request.sessionKey,
            params: { clientMessageId: request.clientMessageId, assetIds },
          }),
        });
        const body = record(await response.json());
        if (signal.aborted) throw signal.reason ?? new Error('Attachment assessment was interrupted.');
        if (timedOut) return fallback();
        if (response.ok) {
          const decoded = decodeAssessmentRows(body.result, request.sessionKey, request.clientMessageId,
            assetIds, true, false);
          if (decoded) return decoded;
          logGatewayIncompatibility('attachment assessment', 'Used unknown for a malformed or mismatched result.');
          return fallback();
        }
        if (!body.error || typeof body.error !== 'object' || Array.isArray(body.error)) return fallback();
        const dispatchError = body.error as Record<string, unknown>;
        if (response.status === 400 && dispatchError.code === 'invalid_message' &&
            dispatchError.message === 'verb not allowed: assess_attachments') {
          return undefined;
        }
        const decoded = decodeAssessmentRows(body, request.sessionKey, request.clientMessageId,
          assetIds, false, true);
        if (decoded) return decoded;
        logGatewayIncompatibility('attachment assessment', 'Used unknown for an uncorrelated request error.');
        return fallback();
      } catch (error) {
        if (signal.aborted) throw error;
        logGatewayIncompatibility('attachment assessment', timedOut
          ? 'The pre-send result timed out; delivery remains unknown.'
          : 'The pre-send result was unavailable; delivery remains unknown.');
        return fallback();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', relayAbort);
      }
    },
    async sendHuman(submission: HumanSubmission, signal: AbortSignal, onSubmitted?: () => void): Promise<HumanSendResult> {
      const submittingIdentity = config.host.currentIdentity();
      if (!submission.clientMessageId.startsWith('c_')) {
        return { outcome: 'refused', reason: 'invalid_message_id' };
      }
      if (!submittingIdentity.principalKey?.trim()) {
        return { outcome: 'refused', reason: 'chat_service_unconfigured' };
      }
      if (submittingIdentity.deviceId !== submission.deviceId) {
        return { outcome: 'refused', reason: 'Host device identity changed.' };
      }
      if (signal.aborted) return { outcome: 'unreachable', reason: 'Human send was interrupted before submission.' };
      const currentIdentity = config.host.currentIdentity();
      if (currentIdentity.deviceId !== submittingIdentity.deviceId ||
          currentIdentity.principalKey !== submittingIdentity.principalKey) {
        return { outcome: 'refused', reason: 'Host principal changed before human send.' };
      }
      let request: Promise<Response>;
      try {
        request = config.host.fetch(`${baseUrl}/agent/dispatch`, {
          method: 'POST', signal, cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            verb: 'post',
            asUser: submittingIdentity.principalKey,
            sessionKey: submission.sessionKey,
            params: {
              clientMessageId: submission.clientMessageId,
              deviceId: submission.deviceId,
              content: submission.content,
              attachments: submission.attachments ?? [],
            },
          }),
        });
        onSubmitted?.();
      } catch {
        return { outcome: 'unreachable', reason: 'Not connected to the server.' };
      }
      let response: Response;
      try { response = await request; }
      catch {
        return { outcome: signal.aborted ? 'uncertain' : 'retryable',
          reason: signal.aborted ? 'Human send was interrupted after submission.' : 'Human send response was unavailable.' };
      }
      if (!response.ok) {
        const error = await gatewayError(response);
        const definitiveRefusal = new Set(['auth_failed', 'principal_required', 'not_found',
          'invalid_message', 'payload_too_large', 'not_deliverable', 'attachment_over_limit']);
        const overLimit = attachmentLimitRefusal(error, submission);
        const withOverLimit = (reason: string): HumanSendResult => ({ outcome: 'refused', reason,
          ...(overLimit ? { attachmentLimitRefusal: overLimit } : {}) });
        if (error.code && (response.status < 500 || definitiveRefusal.has(error.code))) {
          return withOverLimit(error.code);
        }
        if (response.status >= 500) return { outcome: 'retryable', reason: error.code ?? `http-${response.status}` };
        if (error.code) return withOverLimit(error.code);
        return withOverLimit(response.status === 401 ? 'auth_failed'
          : response.status === 403 ? 'principal_required' : `http-${response.status}`);
      }
      try {
        const body = record(await response.json());
        const result = record(body.result);
        if ((result.outcome !== 'recorded' && result.outcome !== 'duplicate') ||
            result.sessionKey !== submission.sessionKey || result.deviceId !== submission.deviceId ||
            result.clientMessageId !== submission.clientMessageId || typeof result.messageId !== 'string' ||
            !result.messageId || !Number.isSafeInteger(result.turnSeq)) {
          logGatewayIncompatibility('human send response', 'Used the uncertain-result fallback.');
          return { outcome: 'uncertain', reason: 'invalid-send-response' };
        }
        return { outcome: 'accepted', messageId: result.messageId };
      } catch (error) {
        logDecodeFailure('human send response', error);
        return { outcome: 'uncertain', reason: 'invalid-send-response' };
      }
    },
  };
  return { transport, profile };
}
