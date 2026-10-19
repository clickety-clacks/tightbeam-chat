import {
  AuthorizationError,
  InvalidCursorError,
  UnsupportedTargetError,
  type ConversationRecord,
  type ChangeConnection,
  type ChangeNotice,
  type ChatTransport,
  type ConversationPage,
  type HostIdentity,
  type HumanSendResult,
  type HumanSubmission,
  type SessionRecord,
  type TargetCapabilities,
  type TargetObservation,
  type TargetProfile,
} from './types';

/** Released 0.1.9 build inspected for this mapping. */
export const PUBLIC_019_SOURCE = 'f724fc41089335887e6eb76bfd89d9b6d50db7cd';
export const PUBLIC_019_BUILD = 2476;
/** The release's /version.sha is a short build stamp. */
export const PUBLIC_019_GATEWAY_SHA = 'f724fc41';
/** Later 0.1.9 source assessed against the same required Chat wire behavior. */
export const PUBLIC_019_SOURCE_2844 = 'ad3e0f802d5706f6ab77bae8f84c87492ba2cf56';
export const PUBLIC_019_BUILD_2844 = 2844;
export const PUBLIC_019_GATEWAY_SHA_2844 = 'ad3e0f80';
/** Exact Gateway release identity; its behavior remains unqualified here. */
export const PUBLIC_019_SOURCE_2857 = '45580d9ebac42218bbf35e1ce9694d536b378d76';
export const PUBLIC_019_BUILD_2857 = 2857;
export const PUBLIC_019_GATEWAY_SHA_2857 = '45580d9e';
/** Current exact Gateway source identity compared for selected Chat paths. */
export const PUBLIC_019_SOURCE_2887 = '0198c918dbd86861297aca19e7c3dc583943bbac';
export const PUBLIC_019_BUILD_2887 = 2887;
export const PUBLIC_019_GATEWAY_SHA_2887 = '0198c918';

const capabilities: TargetCapabilities = Object.freeze({
  newestTail: true,
  stableOlderCursor: true,
  retainedHistoryAcrossResets: true,
  orderedTransitions: true,
  snapshotCoverage: true,
  versionedNotices: true,
  humanSendDedupe: true,
});

// The source comparison supports these individual 2887 paths. The aggregate
// transition capability stays disabled because harness_failed_park_reconciled
// has no Chat marker mapping, and snapshot coverage has no closed watermark.
const capabilities2887: TargetCapabilities = Object.freeze({
  newestTail: true,
  stableOlderCursor: true,
  retainedHistoryAcrossResets: true,
  orderedTransitions: false,
  snapshotCoverage: false,
  versionedNotices: true,
  humanSendDedupe: true,
});

const unsupportedCapabilities: TargetCapabilities = Object.freeze({
  newestTail: false, stableOlderCursor: false, retainedHistoryAcrossResets: false,
  orderedTransitions: false, snapshotCoverage: false, versionedNotices: false,
  humanSendDedupe: false,
});

function sourceBackedCapabilities(build: number, sha: string): TargetCapabilities | undefined {
  if ((build === PUBLIC_019_BUILD && sha === PUBLIC_019_GATEWAY_SHA) ||
      (build === PUBLIC_019_BUILD_2844 && sha === PUBLIC_019_GATEWAY_SHA_2844)) return capabilities;
  if (build === PUBLIC_019_BUILD_2887 && sha === PUBLIC_019_GATEWAY_SHA_2887) return capabilities2887;
  return undefined;
}

// These released Firehose classes report actions, not canonical row changes.
const observationalClasses = new Set([
  'verb.accepted', 'verb.denied', 'rail.denied', 'lifecycle.boot',
  'lifecycle.clean_shutdown', 'lifecycle.dirty_exit', 'lifecycle.takeover',
  'prod.fired', 'lifecycle.terminal_credential_opened',
  'lifecycle.terminal_credential_suppression_activated',
  'lifecycle.terminal_credential_redirect_observed',
  'lifecycle.terminal_credential_recovery_claimed',
  'lifecycle.terminal_credential_recovery_outcome',
  'lifecycle.terminal_credential_resolved',
]);

/** A fresh, host-authenticated socket. The host owns credentials and the auth handshake. */
export interface Public019Channel {
  send(frame: Readonly<Record<string, unknown>>): void;
  listen(onFrame: (frame: unknown) => void, onClose: () => void): () => void;
  close(): void;
}

export interface Public019Host {
  /** A host-authorized fetch, including the appropriate bearer header for REST. */
  fetch(input: string, init: RequestInit): Promise<Response>;
  currentIdentity(): HostIdentity;
  /** Connect /ws/changes?protocolVersion=2, authenticate, then return a fresh socket. */
  openAuthenticatedChanges(signal: AbortSignal): Promise<Public019Channel>;
  /** Connect /ws, authenticate as the human device, await sync_complete, then return a fresh socket. */
  openAuthenticatedHuman(signal: AbortSignal): Promise<Public019Channel>;
}

export interface Public019Config {
  /** Approved host route; no credentials, query, or fragment. */
  baseUrl: string;
  /** Selected Gateway identity route. Native callers default to /version; private Chat bridges use /gateway/version. */
  gatewayVersionPath?: '/version' | '/gateway/version';
  /** Exact /version.build and /version.sha observed by the host. */
  build: number;
  sha: string;
  host: Public019Host;
  responseTimeoutMs?: number;
  /** ChangeSocket normally emits a heartbeat every 15 seconds; default allows three intervals. */
  heartbeatTimeoutMs?: number;
}

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnsupportedTargetError('Expected an object in the public 0.1.9 wire response.');
  }
  return value as Record<string, unknown>;
};

const requiredString = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  if (typeof value !== 'string' || !value) throw new UnsupportedTargetError(`Invalid ${key} in public 0.1.9 wire response.`);
  return value;
};

const optionalString = (row: Record<string, unknown>, key: string): string | undefined => {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new UnsupportedTargetError(`Invalid ${key} in public 0.1.9 wire response.`);
  return value;
};

const positiveInteger = (row: Record<string, unknown>, key: string): number => {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new UnsupportedTargetError(`Invalid ${key} in public 0.1.9 wire response.`);
  }
  return value as number;
};

function messageTime(row: Record<string, unknown>): string {
  const at = row.at;
  if (!Number.isSafeInteger(at) || (at as number) < 0) {
    throw new UnsupportedTargetError('Invalid millisecond at timestamp in public 0.1.9 message.');
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
    const marker = record(row.marker);
    const kind = requiredString(marker, 'kind');
    if (!['harness-switch', 'model-retune', 'session-restart'].includes(kind)) {
      throw new UnsupportedTargetError('Unknown stored marker kind.');
    }
    return Object.freeze({
      kind: 'transition', id: requiredString(row, 'id'), sessionKey,
      seq: positiveInteger(row, 'seq'), rowVersion: positiveInteger(row, 'rowVersion'),
      transition: kind === 'harness-switch' ? 'harness' : kind === 'model-retune' ? 'model' : 'restart',
      from: typeof marker.from === 'string' ? marker.from : requiredString(marker, 'from'),
      to: typeof marker.to === 'string' ? marker.to : requiredString(marker, 'to'),
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
    content: typeof row.content === 'string' ? row.content : requiredString(row, 'content'),
    sender: optionalString(row, 'sender'),
    messageType: optionalString(row, 'messageType'),
    createdAt: messageTime(row),
    attachments: Object.freeze([...attachments]),
    clientMessageId: optionalString(row, 'clientMessageId'),
    deviceId: optionalString(row, 'deviceId'),
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
    activity: optionalString(row, 'mechanicalStatus') ?? optionalString(row, 'state'),
    raw: Object.freeze({ ...row }),
  });
}

/** A source-backed notice decoder; unknown selected-session changes request a rebuild. */
export function decodePublic019Notice(value: unknown, sessionKey: string): ChangeNotice {
  const frame = record(value);
  if (frame.type !== 'change' || frame.schemaVersion !== 2 || typeof frame.class !== 'string') {
    throw new UnsupportedTargetError('Invalid protocol-2 change frame.');
  }
  const refs = record(frame.refs);
  if (refs.sessionKey !== sessionKey) throw new UnsupportedTargetError('Change frame has a different session reference.');
  if (frame.class === 'message.created' && frame.resource === 'messages' && frame.op === 'upsert') {
    return { operation: 'upsert', record: decodePublic019Message(frame.payload, sessionKey) };
  }
  if (typeof frame.class === 'string' && frame.class.startsWith('session.') &&
      frame.resource === 'sessions' && frame.op === 'upsert') {
    return { operation: 'session', session: decodePublic019Session(frame.payload, sessionKey) };
  }
  // Turn and wake events can affect the selected session's activity without
  // carrying a complete session projection. Refresh that projection instead.
  if ((frame.class === 'turn.started' || frame.class === 'turn.ended') &&
      frame.resource === 'turns' && frame.op === 'upsert') {
    return { operation: 'observe', sessionKey, resource: frame.class };
  }
  if (['wake.scheduled', 'wake.fired', 'wake.canceled'].includes(frame.class) &&
      frame.resource === 'wakes' && frame.op === 'upsert') {
    return { operation: 'observe', sessionKey, resource: frame.class };
  }
  if (observationalClasses.has(frame.class) && frame.op === 'observe' &&
      (frame.resource === undefined || frame.resource === null)) {
    return { operation: 'ignore', sessionKey, resource: frame.class };
  }
  return { operation: 'unknown', sessionKey, resource: frame.class };
}

function identity(version: string, build: number, sha: string): string {
  return `${version}+${build}/${sha}`;
}

function checkedBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('baseUrl must be an HTTP(S) origin/path without credentials, query, or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

/** Released 0.1.9 REST history, protocol-2 changes, and human sending. */
export function createPublic019Transport(config: Public019Config): { transport: ChatTransport; profile: TargetProfile } {
  const baseUrl = checkedBaseUrl(config.baseUrl);
  const timeoutMs = config.responseTimeoutMs ?? 15_000;
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 45_000;
  if (!Number.isSafeInteger(config.build) || config.build < 1 ||
      !/^([a-f0-9]{8,40})$/.test(config.sha) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 1) {
    throw new Error('Expected an exact public 0.1.9 build, source SHA, and positive timeouts.');
  }
  const expectedIdentity = identity('0.1.9', config.build, config.sha);
  const gatewayVersionPath = config.gatewayVersionPath ?? '/version';
  const supportedCapabilities = sourceBackedCapabilities(config.build, config.sha);
  const profile: TargetProfile = Object.freeze({
    identity: expectedIdentity,
    label: `Tightbeam 0.1.9 build ${config.build}`,
    capabilities: supportedCapabilities ?? unsupportedCapabilities,
  });

  async function get(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await config.host.fetch(`${baseUrl}${path}`, { method: 'GET', signal, cache: 'no-store' });
    if (response.status === 401 || response.status === 403) throw new AuthorizationError('Human REST principal is not authorized.');
    if (response.status === 400 && path.includes('/messages?')) throw new InvalidCursorError('History cursor was rejected.');
    if (!response.ok) throw new Error(`Tightbeam REST request failed with HTTP ${response.status}.`);
    return record(await response.json());
  }

  const activeSessions = new Set<string>();
  async function readPage(sessionKey: string, query: string, signal: AbortSignal): Promise<ConversationPage> {
    const body = await get(`/api/sessions/${encodeURIComponent(sessionKey)}/messages?limit=50&${query}`, signal);
    if (body.schemaVersion !== 1 || body.resource !== 'transcript messages' || !Array.isArray(body.items)) {
      throw new UnsupportedTargetError('Unexpected transcript collection envelope.');
    }
    const page = record(body.page);
    const oldestCursor = optionalString(page, 'oldestCursor') ?? null;
    if (typeof page.hasMoreBefore !== 'boolean' || (page.hasMoreBefore && !oldestCursor)) {
      throw new UnsupportedTargetError('Invalid transcript page metadata.');
    }
    return { records: body.items.map((item) => decodePublic019Message(item, sessionKey))
      .sort((a, b) => a.seq - b.seq), oldestCursor, hasOlder: page.hasMoreBefore, coverage: sessionKey };
  }

  const transport: ChatTransport = {
    currentIdentity: () => config.host.currentIdentity(),
    async inspectTarget(signal): Promise<TargetObservation> {
      // The host selects the Gateway route: native embeddings use /version,
      // while the private Chat server exposes it through /gateway/version.
      // The Chat bundle manifest is separate and never determines the target profile.
      const version = await get(gatewayVersionPath, signal);
      const observed = identity(String(version.version), Number(version.build), String(version.sha));
      return { identity: observed,
        capabilities: supportedCapabilities && observed === expectedIdentity
          ? supportedCapabilities : unsupportedCapabilities };
    },
    async readSession(sessionKey, signal) {
      const body = await get(`/api/sessions/${encodeURIComponent(sessionKey)}`, signal);
      if (body.schemaVersion !== 1 || body.resource !== 'sessions') {
        throw new UnsupportedTargetError('Unexpected sessions detail envelope.');
      }
      return decodePublic019Session(body.item, sessionKey);
    },
    readTail: (sessionKey, signal) => readPage(sessionKey, 'tail=true', signal),
    readOlder: (sessionKey, before, signal) => readPage(sessionKey, `before=${encodeURIComponent(before)}`, signal),
    // Hub.subscribe completes before subscription_ready. Runtime subscribes first,
    // then reads retained append-only rows and unions buffered versioned notices.
    // This is overlap coverage, not a server snapshot watermark or replay promise.
    proveCoverage: (session, page, buffered) => activeSessions.has(session.sessionKey) &&
      page.coverage === session.sessionKey && !buffered.some((notice) => notice.operation === 'unknown'),
    async openChanges(sessionKey, callbacks, signal): Promise<ChangeConnection> {
      const channel = await config.host.openAuthenticatedChanges(signal);
      let closed = false;
      let ready = false;
      let lastSeq = 0;
      let stopListening = () => {};
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
      const subscriptionId = `chat:${sessionKey}`;
      const close = () => {
        if (closed) return;
        closed = true;
        activeSessions.delete(sessionKey);
        if (readyTimer) clearTimeout(readyTimer);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        stopListening();
        signal.removeEventListener('abort', onAbort);
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
      signal.addEventListener('abort', onAbort, { once: true });
      stopListening = channel.listen((raw) => {
        if (closed) return;
        try {
          const frame = record(raw);
          if (!ready) {
            if (frame.type === 'subscription_ready' && frame.subscriptionId === subscriptionId) {
              ready = true;
              activeSessions.add(sessionKey);
              if (readyTimer) clearTimeout(readyTimer);
              watchHeartbeat();
              resolveReady();
            } else if (frame.type === 'error' || frame.type === 'auth_result') {
              throw new UnsupportedTargetError('Protocol-2 subscription was refused.');
            }
            return;
          }
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
            if (frame.subscriptionId !== subscriptionId) throw new UnsupportedTargetError('Wrong Firehose subscription.');
            callbacks.onNotice(decodePublic019Notice(frame, sessionKey));
          }
          watchHeartbeat();
        } catch (error) {
          if (!ready) { close(); rejectReady(error); }
          else doubt(error instanceof Error ? error.message : String(error));
        }
      }, () => {
        if (closed) return;
        close();
        if (ready) callbacks.onDoubt('Firehose disconnected.');
        else rejectReady(new Error('Firehose closed before subscription readiness.'));
      });
      if (signal.aborted) onAbort();
      else if (!closed) {
        readyTimer = setTimeout(() => { close(); rejectReady(new Error('Firehose subscription readiness timed out.')); }, timeoutMs);
        try {
          channel.send({ type: 'subscribe', protocolVersion: 2, subscriptionId, filters: { sessionKey } });
        } catch (error) { close(); rejectReady(error); }
      }
      await readyPromise;
      return { close };
    },
    async sendHuman(submission: HumanSubmission, signal: AbortSignal): Promise<HumanSendResult> {
      const submittingIdentity = config.host.currentIdentity();
      if (!submission.clientMessageId.startsWith('c_') ||
          new TextEncoder().encode(submission.content).byteLength > 64 * 1024) {
        return { outcome: 'refused', reason: 'Invalid public 0.1.9 human message ID or content length.' };
      }
      if (submittingIdentity.deviceId !== submission.deviceId) {
        return { outcome: 'refused', reason: 'Host device identity changed.' };
      }
      let channel: Public019Channel;
      try { channel = await config.host.openAuthenticatedHuman(signal); }
      catch (error) {
        if (error instanceof AuthorizationError) throw error;
        return { outcome: 'uncertain', reason: error instanceof Error ? error.message : String(error) };
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
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: HumanSendResult) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
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
          } catch { finish({ outcome: 'uncertain', reason: 'Malformed human response.' }); }
        }, () => finish({ outcome: 'uncertain', reason: 'Human socket closed before acknowledgement.' }));
        if (signal.aborted) onAbort();
        else if (!settled) {
          timer = setTimeout(() => finish({ outcome: 'uncertain', reason: 'Human acknowledgement timed out.' }), timeoutMs);
          try {
            channel.send({ type: 'message', id: submission.clientMessageId,
              sessionKey: submission.sessionKey, content: submission.content });
          } catch { finish({ outcome: 'uncertain', reason: 'Human send was interrupted.' }); }
        }
      });
    },
  };
  return { transport, profile };
}
