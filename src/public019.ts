import {
  AuthorizationError,
  UnsupportedTargetError,
  type CanonicalMessage,
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

/** Exact public 0.1.9 branch source inspected for this mapping. This is not a supported release. */
export const PUBLIC_019_SOURCE = 'd33c510fb62b0baa51e6b89021b064d8091800b8';

const capabilities: TargetCapabilities = Object.freeze({
  newestTail: false,
  stableOlderCursor: false,
  retainedHistoryAcrossResets: true,
  orderedTransitions: false,
  snapshotCoverage: false,
  versionedNotices: true,
  humanSendDedupe: true,
});

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
  /** Exact /version.build and /version.sha expected of the elected isolated target. */
  build: number;
  sha: string;
  host: Public019Host;
  responseTimeoutMs?: number;
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

/** Decode only the source-backed REST/Firehose item shape, preserving all metadata. */
export function decodePublic019Message(value: unknown, sessionKey: string): CanonicalMessage {
  const row = record(value);
  if (requiredString(row, 'sessionKey') !== sessionKey) {
    throw new UnsupportedTargetError('Message belongs to a different session.');
  }
  if (row.messageType === 'marker') {
    // d33c510f stores markerKind/From/To, but StateResources.message/1 omits them.
    throw new UnsupportedTargetError('Public 0.1.9 message projection omits stored transition marker fields.');
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
    createdAt: optionalString(row, 'at'),
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

/**
 * Wire mapping for public 0.1.9 d33c510f. Its profile deliberately cannot pass
 * createTightbeamAdapter's required capability gate. It is useful for exact
 * target inspection and fixture-independent transport checks while the source
 * history/marker/coverage repair is pending.
 */
export function createPublic019Transport(config: Public019Config): { transport: ChatTransport; profile: TargetProfile } {
  const baseUrl = checkedBaseUrl(config.baseUrl);
  const timeoutMs = config.responseTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(config.build) || config.build < 1 ||
      config.sha.length < 8 || !PUBLIC_019_SOURCE.startsWith(config.sha) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Expected an exact public 0.1.9 build, source SHA, and positive response timeout.');
  }
  const expectedIdentity = identity('0.1.9', config.build, config.sha);
  const profile: TargetProfile = Object.freeze({
    identity: expectedIdentity,
    label: `Public Tightbeam 0.1.9 source ${PUBLIC_019_SOURCE.slice(0, 8)} (unsupported Chat history)`,
    capabilities,
  });

  async function get(path: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await config.host.fetch(`${baseUrl}${path}`, { method: 'GET', signal, cache: 'no-store' });
    if (response.status === 401 || response.status === 403) throw new AuthorizationError('Human REST principal is not authorized.');
    if (!response.ok) throw new Error(`Tightbeam REST request failed with HTTP ${response.status}.`);
    return record(await response.json());
  }

  const transport: ChatTransport = {
    currentIdentity: () => config.host.currentIdentity(),
    async inspectTarget(signal): Promise<TargetObservation> {
      const version = await get('/version', signal);
      const observed = identity(String(version.version), Number(version.build), String(version.sha));
      return { identity: observed, capabilities: observed === expectedIdentity ? capabilities : {
        newestTail: false, stableOlderCursor: false, retainedHistoryAcrossResets: false,
        orderedTransitions: false, snapshotCoverage: false, versionedNotices: false, humanSendDedupe: false,
      } };
    },
    async readSession(sessionKey, signal) {
      const body = await get(`/api/sessions/${encodeURIComponent(sessionKey)}`, signal);
      if (body.schemaVersion !== 1 || body.resource !== 'sessions') {
        throw new UnsupportedTargetError('Unexpected sessions detail envelope.');
      }
      return decodePublic019Session(body.item, sessionKey);
    },
    async readTail(_sessionKey, _signal): Promise<ConversationPage> {
      throw new UnsupportedTargetError('Public 0.1.9 d33c510f has no bounded newest transcript tail.');
    },
    async readOlder(_sessionKey, _before, _signal): Promise<ConversationPage> {
      throw new UnsupportedTargetError('Public 0.1.9 d33c510f rejects stable before cursors.');
    },
    proveCoverage: () => false,
    async openChanges(sessionKey, callbacks, signal): Promise<ChangeConnection> {
      const channel = await config.host.openAuthenticatedChanges(signal);
      let closed = false;
      let ready = false;
      let lastSeq = 0;
      let stopListening = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const subscriptionId = `chat:${sessionKey}`;
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        stopListening();
        signal.removeEventListener('abort', onAbort);
        channel.close();
      };
      let rejectReady: (reason: unknown) => void = () => {};
      let resolveReady: () => void = () => {};
      const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const onAbort = () => { close(); rejectReady(new Error('Change subscription aborted.')); };
      signal.addEventListener('abort', onAbort, { once: true });
      stopListening = channel.listen((raw) => {
        if (closed) return;
        try {
          const frame = record(raw);
          if (!ready) {
            if (frame.type === 'subscription_ready' && frame.subscriptionId === subscriptionId) {
              ready = true;
              if (timer) clearTimeout(timer);
              resolveReady();
            } else if (frame.type === 'error' || frame.type === 'auth_result') {
              throw new UnsupportedTargetError('Protocol-2 subscription was refused.');
            }
            return;
          }
          if (frame.type !== 'change' && frame.type !== 'heartbeat') {
            callbacks.onDoubt('Unexpected Firehose frame after subscription readiness.');
            return;
          }
          if (!Number.isSafeInteger(frame.seq) || (frame.seq as number) < lastSeq ||
              (frame.type === 'change' && frame.seq !== lastSeq + 1) ||
              (frame.type === 'heartbeat' && frame.seq !== lastSeq)) {
            callbacks.onDoubt('Firehose sequence gap or regression.');
            return;
          }
          lastSeq = frame.seq as number;
          if (frame.type === 'change') {
            if (frame.subscriptionId !== subscriptionId) throw new UnsupportedTargetError('Wrong Firehose subscription.');
            callbacks.onNotice(decodePublic019Notice(frame, sessionKey));
          }
        } catch (error) {
          if (!ready) { close(); rejectReady(error); }
          else callbacks.onDoubt(error instanceof Error ? error.message : String(error));
        }
      }, () => {
        if (closed) return;
        close();
        if (ready) callbacks.onDoubt('Firehose disconnected.');
        else rejectReady(new Error('Firehose closed before subscription readiness.'));
      });
      if (signal.aborted) onAbort();
      else if (!closed) {
        timer = setTimeout(() => { close(); rejectReady(new Error('Firehose subscription readiness timed out.')); }, timeoutMs);
        channel.send({ type: 'subscribe', protocolVersion: 2, subscriptionId, filters: { sessionKey } });
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
      catch (error) { return { outcome: 'uncertain', reason: error instanceof Error ? error.message : String(error) }; }
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
