import type { AttachmentCapabilities, AttachmentInput, ChatRuntime, HostSendSignal, RuntimeState } from './types';
import { isSettingsCommand } from './settingsCommand';
import { newUuid } from './uuid';
import { composerModelText } from './runningModel';

/** Public, fixed in-page names for host-composer protocol version 1. */
export const HOST_DECLARATION_NAME = '__TIGHTBEAM_CHAT_HOST__';
export const HOST_COMMAND_NAME = '__TIGHTBEAM_CHAT_COMMAND__';

export type HostConnectionState = 'connected' | 'reconnecting' | 'disconnected';

export type HostComposerEvent =
  | { readonly event: 'declined'; readonly reason: 'malformed-declaration' | 'unsupported-version' }
  | { readonly event: 'ready'; readonly version: 1; readonly lifetimeId: string; readonly sessionKey: string;
      readonly gatewayOrigin: string; readonly agentDisplayName: string;
      readonly capabilities: { readonly text: true; readonly reconnect: true; readonly attachments?: AttachmentCapabilities } }
  | { readonly event: 'connection'; readonly version: 1; readonly lifetimeId: string; readonly state: HostConnectionState }
  | { readonly event: 'unavailable'; readonly version: 1; readonly lifetimeId: string; readonly reason: string }
  | { readonly event: 'overlay'; readonly version: 1; readonly lifetimeId: string; readonly open: boolean }
  | { readonly event: 'lifetime-ended'; readonly version: 1; readonly lifetimeId: string;
      readonly reason: 'target-changed' | 'identity-changed' | 'disposed' | 'unloading' }
  | { readonly event: 'rejected'; readonly lifetimeId: unknown; readonly correlationId: unknown;
      readonly reason: 'not-ready' | 'target-mismatch' | 'invalid-correlation' | 'empty' |
        'attempt-in-flight' | 'already-delivered' | 'correlation-conflict' | 'local-command' | 'invalid-attachments' }
  | { readonly event: 'accepted'; readonly lifetimeId: string; readonly correlationId: string; readonly attempt: number }
  | { readonly event: 'delivered'; readonly lifetimeId: string; readonly correlationId: string; readonly attempt: number }
  | { readonly event: 'failed'; readonly lifetimeId: string; readonly correlationId: string; readonly attempt: number;
      readonly reason: 'refused' | 'retry-unavailable' | 'upload-failed' | 'image-unreadable'; readonly detail?: string; readonly attachmentIndex?: number }
  | { readonly event: 'uncertain'; readonly lifetimeId: string; readonly correlationId: string; readonly attempt: number;
      readonly reason: 'ack-lost' | 'accepted-unreconciled' | 'lifetime-ended' | 'retry-unavailable' }
  | HostRestoreRequestedEvent
  | { readonly event: 'draft-insert-requested'; readonly version: 1; readonly lifetimeId: string;
      readonly sessionKey: string; readonly text: string }
  | HostAgentModelEvent;

/** Optional host events a declaration can opt into; each lists the event versions the host handles. */
export const HOST_RESTORE_REQUESTED_EVENT = 'restore-requested';
export const HOST_AGENT_MODEL_EVENT = 'agent-model';
const HOST_DRAFT_INSERT_REQUESTED_EVENT = 'draft-insert-requested';

/**
 * The model text Chat's own composer would show after the agent name, or null when
 * unknown. Sent right after each `ready` and again only when the value changes.
 */
export interface HostAgentModelEvent {
  readonly event: 'agent-model';
  readonly version: 1;
  readonly lifetimeId: string;
  readonly sessionKey: string;
  readonly model: string | null;
}

/**
 * Emitted once per user activation of host-mode "Edit and resend" on a failed turn.
 * The host restores the text into its own composer; Chat never sends or retries it.
 */
export interface HostRestoreRequestedEvent {
  readonly event: 'restore-requested';
  readonly version: 1;
  readonly lifetimeId: string;
  readonly sessionKey: string;
  /** Canonical row ID of the failed prompt. */
  readonly messageId: string;
  /** The row's client message ID, present only when the row has one. */
  readonly correlationId?: string;
  /** Exactly the row content Chat's own Edit and resend restores. */
  readonly content: string;
  /** Present when the row had photos and Chat holds their bytes: the ordered restorable manifest. */
  readonly attachments?: readonly HostComposerAttachment[];
  /** Present when the row had photos that Chat cannot restore; `attachments` is then absent. */
  readonly attachmentsUnavailable?: true;
}

/** One eligible failed prompt, read by the surface at the moment of the user's tap. */
export interface HostRestoreRequest {
  readonly sessionKey: string;
  readonly messageId: string;
  readonly correlationId?: string;
  readonly content: string;
  /** Number of photos on the canonical row; zero for a text-only prompt. */
  readonly attachmentCount: number;
  /** Retained photo inputs in row order, when Chat still holds them. */
  readonly attachments?: readonly AttachmentInput[];
}

export interface HostComposerDeclaration {
  readonly versions: readonly number[];
  readonly onEvent: (event: HostComposerEvent) => void;
  /** Optional events the host handles, by name, each with the event versions it accepts. */
  readonly events?: { readonly 'restore-requested'?: readonly number[]; readonly 'agent-model'?: readonly number[];
    readonly 'draft-insert-requested'?: readonly number[] };
}

/** JSON-safe native photo input; bytes follow the web attachment preparation path. */
export interface HostComposerAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly data: string;
}

export interface HostComposerSendCommand {
  readonly type: 'send';
  readonly lifetimeId: unknown;
  readonly sessionKey: unknown;
  readonly correlationId: unknown;
  readonly content: unknown;
  readonly retry?: unknown;
  readonly attachments?: unknown;
}

export interface HostComposerReconnectCommand {
  readonly type: 'reconnect';
  readonly lifetimeId: unknown;
  readonly sessionKey: unknown;
}

export type HostComposerCommand = HostComposerSendCommand | HostComposerReconnectCommand;
export type HostComposerCommandEntry = (command: HostComposerCommand) => void;

export interface HostComposerSnapshot {
  readonly optedIn: boolean;
  readonly composerHidden: boolean;
  readonly ready: boolean;
  readonly settingsRequestRevision: number;
  /** The declaration lists restore-requested version 1. */
  readonly restoreRequested: boolean;
  readonly draftInsertRequested: boolean;
}

interface Attempt {
  readonly correlationId: string;
  readonly number: number;
  accepted: boolean;
  settled: boolean;
  lastCheckedGeneration: number;
  stopObserving?: () => void;
}

interface Lifetime {
  readonly runtime: ChatRuntime;
  readonly lifetimeId: string;
  readonly sessionKey: string;
  readonly attempts: Map<string, Attempt>;
  ready: boolean;
  hasBeenReady: boolean;
  /** Last agent-model value sent; undefined until the first send for this lifetime. */
  lastModel?: string | null;
  connectionState?: HostConnectionState;
  unavailableReason?: string;
  unsubscribe: () => void;
}

const emptySnapshot: HostComposerSnapshot = Object.freeze({
  optedIn: false, composerHidden: false, ready: false, settingsRequestRevision: 0, restoreRequested: false, draftInsertRequested: false,
});
const correlationPattern = /^c_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const declinedDeclarations = new WeakSet<object>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function runtimeUnavailableReason(state: RuntimeState): string | undefined {
  if (state.sessionNotFound) return 'session-not-found';
  if (state.status === 'unauthorized') return 'unauthorized';
  return undefined;
}

function liveFeedState(state: RuntimeState): HostConnectionState {
  if (state.status === 'ready') {
    if (state.liveConnectionState === 'disconnected') return 'disconnected';
    if (state.liveConnectionState === 'connecting' || state.liveConnectionState === 'reconnecting') return 'reconnecting';
    if (state.liveConnectionState === 'connected') return 'connected';
    return state.liveError ? 'reconnecting' : 'connected';
  }
  if (state.status === 'loading' || state.status === 'stale') return 'reconnecting';
  return 'disconnected';
}

/** An absent or malformed `events` field declares no optional events; it never declines the seam. */
function declaresEvent(raw: Record<string, unknown>, name: string): boolean {
  const events = raw.events;
  if (!isObject(events)) return false;
  const versions = events[name];
  return Array.isArray(versions) && versions.includes(1);
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(blob.arrayBuffer ? await blob.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => reader.error ? reject(reader.error) : resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  }));
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function errorSafeEmit(handler: (event: HostComposerEvent) => void, event: HostComposerEvent): void {
  try { handler(event); } catch { /* A host callback cannot interrupt the Chat runtime. */ }
}

/** Owns one opt-in declaration and the lifetimes attached to a single Chat surface. */
export class HostComposerBridge {
  static create(target: Window): HostComposerBridge | null {
    if (!(HOST_DECLARATION_NAME in target)) return null;
    const raw = (target as unknown as Record<string, unknown>)[HOST_DECLARATION_NAME];
    const handler = isObject(raw) && typeof raw.onEvent === 'function' ? raw.onEvent as (event: HostComposerEvent) => void : undefined;
    const malformed = !isObject(raw) || !Array.isArray(raw.versions) ||
      !raw.versions.every((version) => Number.isInteger(version) && typeof version === 'number') || !handler;
    if (malformed) {
      if (handler && isObject(raw) && !declinedDeclarations.has(raw)) {
        declinedDeclarations.add(raw);
        errorSafeEmit(handler, { event: 'declined', reason: 'malformed-declaration' });
      }
      return null;
    }
    const supported = (raw.versions as number[]).filter((version) => version === 1);
    if (!supported.length) {
      if (!declinedDeclarations.has(raw)) {
        declinedDeclarations.add(raw);
        errorSafeEmit(handler, { event: 'declined', reason: 'unsupported-version' });
      }
      return null;
    }
    return new HostComposerBridge(target, handler, declaresEvent(raw, HOST_RESTORE_REQUESTED_EVENT),
      declaresEvent(raw, HOST_AGENT_MODEL_EVENT), declaresEvent(raw, HOST_DRAFT_INSERT_REQUESTED_EVENT));
  }

  private readonly listeners = new Set<() => void>();
  private readonly priorCommand: PropertyDescriptor | undefined;
  private readonly command: HostComposerCommandEntry;
  private snapshot: HostComposerSnapshot;
  private current: Lifetime | undefined;
  // Preserve original wire identity even when image preparation replaces upload bytes.
  private readonly manifests = new WeakMap<ChatRuntime, Map<string, string>>();
  private suspendedRuntime: ChatRuntime | undefined;
  private disposed = false;
  private settingsRequestRevision = 0;
  private overlayOpen = false;
  private reportedOverlayOpen = false;

  private constructor(private readonly target: Window, private readonly onEvent: (event: HostComposerEvent) => void,
    private readonly restoreRequested: boolean, private readonly agentModel: boolean,
    private readonly draftInsertRequested: boolean) {
    this.snapshot = Object.freeze({ ...emptySnapshot, optedIn: true, restoreRequested, draftInsertRequested });
    this.priorCommand = Object.getOwnPropertyDescriptor(target, HOST_COMMAND_NAME);
    this.command = (command) => this.receive(command);
    Object.defineProperty(target, HOST_COMMAND_NAME, { configurable: true, writable: true, value: this.command });
    target.addEventListener('pagehide', this.onPageHide);
    target.addEventListener('pageshow', this.onPageShow);
  }

  getSnapshot = (): HostComposerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(): void {
    if (this.disposed) return;
    this.snapshot = Object.freeze({
      optedIn: true,
      composerHidden: this.snapshot.composerHidden,
      ready: Boolean(this.current?.ready),
      settingsRequestRevision: this.settingsRequestRevision,
      restoreRequested: this.restoreRequested,
      draftInsertRequested: this.draftInsertRequested,
    });
    for (const listener of this.listeners) listener();
  }

  private emitModel(lifetime: Lifetime, state: RuntimeState | null, force: boolean): void {
    if (!this.agentModel) return;
    const model = state ? composerModelText(state) : null;
    if (!force && lifetime.lastModel === model) return;
    lifetime.lastModel = model;
    this.emit({ event: 'agent-model', version: 1, lifetimeId: lifetime.lifetimeId, sessionKey: lifetime.sessionKey, model });
  }

  private emit(event: HostComposerEvent): void {
    errorSafeEmit(this.onEvent, event);
  }

  private markUnavailable(lifetime: Lifetime, reason: string): void {
    if (this.current !== lifetime || this.disposed) return;
    if (!lifetime.ready && lifetime.unavailableReason === reason) return;
    if (lifetime.hasBeenReady) this.emitModel(lifetime, null, false);
    lifetime.ready = false;
    lifetime.unavailableReason = reason;
    this.publish();
    this.emit({ event: 'unavailable', version: 1, lifetimeId: lifetime.lifetimeId, reason });
  }

  private markSendRefused(lifetime: Lifetime, detail?: string): void {
    const state = lifetime.runtime.getSnapshot();
    const reason = state.sessionNotFound ? 'session-not-found'
      : state.status === 'unauthorized' || detail === 'unauthorized' ? 'unauthorized'
        : 'send-refused';
    this.markUnavailable(lifetime, reason);
    // A typed per-message refusal can arrive after the runtime's last publish.
    // If the selected session is still ready and authorized, restore the same
    // lifetime now instead of waiting for unrelated activity to publish again.
    if (reason === 'send-refused') this.onRuntimeChange(lifetime);
  }

  attach(runtime: ChatRuntime, refreshBeforeReady = false): void {
    if (this.disposed) return;
    if (this.current?.runtime === runtime) return;
    if (this.current) this.detach('disposed');
    this.suspendedRuntime = undefined;
    this.reportedOverlayOpen = false;
    const lifetime: Lifetime = {
      runtime,
      lifetimeId: `l_${newUuid()}`,
      sessionKey: runtime.getSnapshot().sessionKey,
      attempts: new Map(),
      ready: false,
      hasBeenReady: false,
      unavailableReason: undefined,
      unsubscribe: () => {},
    };
    this.current = lifetime;
    lifetime.unsubscribe = runtime.subscribe(() => this.onRuntimeChange(lifetime));
    if (refreshBeforeReady) void runtime.rebuild({ restart: true });
    this.onRuntimeChange(lifetime);
  }

  detach(reason: 'target-changed' | 'identity-changed' | 'disposed' | 'unloading'): void {
    const lifetime = this.current;
    if (!lifetime) return;
    lifetime.runtime.endAttachmentLifetime?.(lifetime.lifetimeId, reason);
    const outcomeCanChange = reason === 'target-changed' || reason === 'identity-changed';
    for (const attempt of [...lifetime.attempts.values()]) {
      if (attempt.settled) continue;
      if (outcomeCanChange) {
        this.settle(lifetime, attempt, {
          event: 'uncertain', lifetimeId: lifetime.lifetimeId, correlationId: attempt.correlationId,
          attempt: attempt.number, reason: attempt.accepted ? 'accepted-unreconciled' : 'lifetime-ended',
        });
      } else {
        attempt.settled = true;
        attempt.stopObserving?.();
        attempt.stopObserving = undefined;
        lifetime.attempts.delete(attempt.correlationId);
      }
    }
    lifetime.unsubscribe();
    this.current = undefined;
    this.publish();
    this.emit({ event: 'lifetime-ended', version: 1, lifetimeId: lifetime.lifetimeId, reason });
  }

  private onRuntimeChange(lifetime: Lifetime): void {
    if (this.current !== lifetime || this.disposed) return;
    const state = lifetime.runtime.getSnapshot();
    if (state.identityChanged) {
      this.detach('identity-changed');
      return;
    }
    const unavailableReason = runtimeUnavailableReason(state);
    if (state.status === 'ready' && !unavailableReason) {
      lifetime.unavailableReason = undefined;
      if (!lifetime.ready) {
        const gatewayOrigin = this.gatewayOrigin(state.targetGateway);
        if (!gatewayOrigin) return;
        lifetime.ready = true;
        this.emit({
          event: 'ready', version: 1, lifetimeId: lifetime.lifetimeId, sessionKey: lifetime.sessionKey,
          gatewayOrigin, agentDisplayName: state.agentDisplayName ?? state.session?.displayName ?? '',
          capabilities: Object.freeze({ text: true, reconnect: true,
            ...(this.photoCapabilities(lifetime.runtime) ? { attachments: this.photoCapabilities(lifetime.runtime) } : {}) }),
        });
        lifetime.hasBeenReady = true;
        this.emitModel(lifetime, state, true);
        this.emitConnection(lifetime, state, true);
        if (this.overlayOpen) {
          this.reportedOverlayOpen = true;
          this.emit({ event: 'overlay', version: 1, lifetimeId: lifetime.lifetimeId, open: true });
        } else if (this.reportedOverlayOpen === true) {
          this.reportedOverlayOpen = false;
          this.emit({ event: 'overlay', version: 1, lifetimeId: lifetime.lifetimeId, open: false });
        }
        if (!this.snapshot.composerHidden) {
          this.snapshot = Object.freeze({ ...this.snapshot, composerHidden: true, ready: true });
          for (const listener of this.listeners) listener();
        } else this.publish();
        for (const attempt of lifetime.attempts.values()) {
          if (attempt.accepted && state.generation > attempt.lastCheckedGeneration) this.checkAccepted(lifetime, attempt, state.generation);
        }
      } else {
        this.emitModel(lifetime, state, false);
        this.emitConnection(lifetime, state);
      }
      return;
    }
    this.emitConnection(lifetime, state);
    // Chat's composer hides the model here too, so the host hears null (never after the lifetime ended).
    if (lifetime.hasBeenReady) this.emitModel(lifetime, state, false);
    if (unavailableReason) {
      this.markUnavailable(lifetime, unavailableReason);
      return;
    }
    // A live-feed or snapshot-status change alone does not refuse host sending.
    // Only authorization/session loss or an actual rejected send invalidates it.
  }

  private emitConnection(lifetime: Lifetime, state: RuntimeState, force = false): void {
    if (!lifetime.hasBeenReady) return;
    const next = liveFeedState(state);
    if (!force && lifetime.connectionState === next) return;
    lifetime.connectionState = next;
    this.emit({ event: 'connection', version: 1, lifetimeId: lifetime.lifetimeId, state: next });
  }

  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open;
    const lifetime = this.current;
    if (!lifetime?.ready || this.reportedOverlayOpen === open) return;
    this.reportedOverlayOpen = open;
    this.emit({ event: 'overlay', version: 1, lifetimeId: lifetime.lifetimeId, open });
  }

  private gatewayOrigin(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== 'null' ? url.origin : undefined;
    } catch { return undefined; }
  }

  private photoCapabilities(runtime: ChatRuntime): AttachmentCapabilities | undefined {
    if (!runtime.sendAttachments || !runtime.retryAttachmentSend || !runtime.recoverAttachmentSend) return undefined;
    const capabilities = runtime.getAttachmentCapabilities?.();
    if (!capabilities) return undefined;
    const mediaTypes = ['image/jpeg', 'image/png'].filter(type => !capabilities.mediaTypes || capabilities.mediaTypes.includes(type));
    return mediaTypes.length ? Object.freeze({ ...capabilities, mediaTypes: Object.freeze(mediaTypes) }) : undefined;
  }

  private decodeAttachments(raw: unknown, correlationId: string, runtime: ChatRuntime): readonly AttachmentInput[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new Error('Invalid attachment list.');
    if (!raw.length) return [];
    const capabilities = this.photoCapabilities(runtime);
    return Object.freeze(raw.map((item, index) => {
      if (!isObject(item) || typeof item.filename !== 'string' || !item.filename.trim() ||
          typeof item.mimeType !== 'string' || !capabilities?.mediaTypes?.includes(item.mimeType) ||
          typeof item.data !== 'string' || !item.data.length ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.data)) throw new Error('Invalid attachment.');
      const binary = atob(item.data);
      if (!binary.length || btoa(binary) !== item.data) throw new Error('Invalid attachment bytes.');
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      return Object.freeze({ id: `${correlationId}:${index}`, filename: item.filename,
        bytes: new Blob([bytes], { type: item.mimeType }) });
    }));
  }

  private receive(command: HostComposerCommand): void {
    if (this.disposed || !isObject(command)) return;
    if (command.type === 'reconnect') {
      const lifetime = this.current;
      if (!lifetime?.ready) return;
      const state = lifetime.runtime.getSnapshot();
      if (command.lifetimeId !== lifetime.lifetimeId || command.sessionKey !== lifetime.sessionKey ||
          state.sessionKey !== lifetime.sessionKey || state.identityChanged || runtimeUnavailableReason(state)) return;
      if (liveFeedState(state) === 'connected' && !state.liveError) return;
      // Explicit recovery supersedes a scheduled retry while keeping this runtime
      // and its retained transcript in place. Send attempts are owned separately.
      void lifetime.runtime.rebuild({ restart: true });
      return;
    }
    if (command.type !== 'send') return;
    const correlationId = command.correlationId;
    const reject = (reason: Extract<HostComposerEvent, { event: 'rejected' }>['reason']) => {
      this.emit({ event: 'rejected', lifetimeId: command.lifetimeId, correlationId, reason });
    };
    const hasAttachments = command.attachments !== undefined &&
      (!Array.isArray(command.attachments) || command.attachments.length > 0);
    if (!hasAttachments && isSettingsCommand(command.content)) {
      this.settingsRequestRevision++;
      this.publish();
      return reject('local-command');
    }
    const lifetime = this.current;
    if (!lifetime?.ready) return reject('not-ready');
    const state = lifetime.runtime.getSnapshot();
    if (state.sessionNotFound || state.status === 'unauthorized') {
      this.markUnavailable(lifetime, state.sessionNotFound ? 'session-not-found' : 'unauthorized');
      return reject('not-ready');
    }
    if (command.lifetimeId !== lifetime.lifetimeId || command.sessionKey !== lifetime.sessionKey) return reject('target-mismatch');
    if (typeof correlationId !== 'string' || !correlationPattern.test(correlationId)) return reject('invalid-correlation');
    if (typeof command.content !== 'string' || (!command.content.trim() && !hasAttachments)) return reject('empty');
    let inputs: readonly AttachmentInput[];
    try { inputs = this.decodeAttachments(command.attachments, correlationId, lifetime.runtime); }
    catch { return reject('invalid-attachments'); }
    const manifest = JSON.stringify(inputs.map((input, index) => ({ filename: input.filename,
      mimeType: input.bytes.type, data: (command.attachments as HostComposerAttachment[])[index].data })));
    let manifests = this.manifests.get(lifetime.runtime);
    if (!manifests) { manifests = new Map(); this.manifests.set(lifetime.runtime, manifests); }


    const retry = command.retry === true;
    const priorAttempt = lifetime.attempts.get(correlationId);
    if (priorAttempt) return reject('attempt-in-flight');
    const priorSend = lifetime.runtime.getSnapshot().sends.find((send) => send.clientMessageId === correlationId);
    if (priorSend?.hostSend?.lifetimeId === lifetime.lifetimeId && priorSend.hostSend.outcome === 'delivered') {
      return reject('already-delivered');
    }
    if (priorSend && (!priorSend.hostSend || !retry || priorSend.content !== command.content ||
        Boolean(priorSend.attachmentItems?.length) !== Boolean(inputs.length) ||
        (inputs.length > 0 && manifests.get(correlationId) !== manifest))) {
      return reject('correlation-conflict');
    }

    if (inputs.length) manifests.set(correlationId, manifest);
    const attempt: Attempt = {
      correlationId,
      number: priorSend?.hostSend?.lifetimeId === lifetime.lifetimeId ? priorSend.hostSend.attempt + 1 : 1,
      accepted: false, settled: false, lastCheckedGeneration: -1,
    };
    lifetime.attempts.set(correlationId, attempt);
    attempt.stopObserving = lifetime.runtime.observeHostSend(correlationId, (signal) => this.onSendSignal(lifetime, attempt, signal));
    this.publish();
    const hostSend = { lifetimeId: lifetime.lifetimeId, attempt: attempt.number } as const;
    if (inputs.length) {
      const context = { expectedSessionKey: lifetime.sessionKey, clientMessageId: correlationId, hostSend };
      if (retry) {
        const operation = priorSend
          ? lifetime.runtime.retryAttachmentSend!(correlationId, context)
          : lifetime.runtime.recoverAttachmentSend!(command.content, inputs, context);
        void operation.then(() => {
          if (this.current !== lifetime || attempt.settled || attempt.accepted) return;
          const send = lifetime.runtime.getSnapshot().sends.find(item => item.clientMessageId === correlationId);
          if (send?.status === 'failed' || send?.status === 'uncertain' || !send) {
            this.onSendSignal(lifetime, attempt, { kind: 'uncertain', reason: 'retry-unavailable' });
          }
        });
      } else if (!lifetime.runtime.sendAttachments!(command.content, inputs, context)) {
        this.onSendSignal(lifetime, attempt, { kind: 'failed', reason: 'refused', detail: 'send-not-started' });
      }
    } else if (retry) lifetime.runtime.retryHostSend(correlationId, command.content, hostSend);
    else if (!lifetime.runtime.send(command.content, correlationId, hostSend)) {
      this.settle(lifetime, attempt, { event: 'failed', lifetimeId: lifetime.lifetimeId,
        correlationId, attempt: attempt.number, reason: 'refused', detail: 'send-not-started' });
      this.markSendRefused(lifetime, 'send-not-started');
    }
  }

  private onSendSignal(lifetime: Lifetime, attempt: Attempt, signal: HostSendSignal): void {
    if (this.current !== lifetime || attempt.settled) return;
    switch (signal.kind) {
      case 'accepted':
        if (attempt.accepted) return;
        attempt.accepted = true;
        this.emit({ event: 'accepted', lifetimeId: lifetime.lifetimeId,
          correlationId: attempt.correlationId, attempt: attempt.number });
        this.checkAccepted(lifetime, attempt, lifetime.runtime.getSnapshot().generation);
        return;
      case 'reconciled':
        this.settle(lifetime, attempt, { event: 'delivered', lifetimeId: lifetime.lifetimeId,
          correlationId: attempt.correlationId, attempt: attempt.number });
        return;
      case 'failed':
        this.settle(lifetime, attempt, { event: 'failed', lifetimeId: lifetime.lifetimeId,
          correlationId: attempt.correlationId, attempt: attempt.number, reason: signal.reason, detail: signal.detail,
          ...(signal.attachmentIndex === undefined ? {} : { attachmentIndex: signal.attachmentIndex }) });
        if (signal.reason === 'refused') {
          this.markSendRefused(lifetime, signal.detail);
        }
        return;
      case 'uncertain':
        this.settle(lifetime, attempt, { event: 'uncertain', lifetimeId: lifetime.lifetimeId,
          correlationId: attempt.correlationId, attempt: attempt.number, reason: signal.reason });
        return;
    }
  }

  private checkAccepted(lifetime: Lifetime, attempt: Attempt, generation: number): void {
    if (this.current !== lifetime || attempt.settled || !attempt.accepted ||
        generation <= attempt.lastCheckedGeneration) return;
    attempt.lastCheckedGeneration = generation;
    void this.refreshAccepted(lifetime, attempt);
  }

  private async refreshAccepted(lifetime: Lifetime, attempt: Attempt): Promise<void> {
    const result = await lifetime.runtime.refreshHostSend(attempt.correlationId);
    if (this.current !== lifetime || attempt.settled) return;
    if (result === 'found') {
      this.settle(lifetime, attempt, { event: 'delivered', lifetimeId: lifetime.lifetimeId,
        correlationId: attempt.correlationId, attempt: attempt.number });
    }
    // The server acknowledgement is positive. A bounded history read can lag or
    // omit the row, so keep the accepted attempt open until a canonical row arrives.
  }

  private settle(lifetime: Lifetime, attempt: Attempt, event: HostComposerEvent): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.stopObserving?.();
    attempt.stopObserving = undefined;
    if (event.event === 'delivered' || event.event === 'failed' || event.event === 'uncertain') {
      lifetime.runtime.recordHostSendOutcome(attempt.correlationId,
        { lifetimeId: lifetime.lifetimeId, attempt: attempt.number }, event.event);
    }
    if (lifetime.attempts.get(attempt.correlationId) === attempt) lifetime.attempts.delete(attempt.correlationId);
    this.emit(event);
    this.publish();
  }

  requestDraftInsert(sessionKey: string, text: string): boolean {
    const lifetime = this.current;
    if (this.disposed || !this.draftInsertRequested || !this.snapshot.composerHidden || !lifetime?.ready ||
        sessionKey !== lifetime.sessionKey) return false;
    this.emit({ event: 'draft-insert-requested', version: 1, lifetimeId: lifetime.lifetimeId, sessionKey, text });
    return true;
  }

  /**
   * Hands one failed prompt to the host after a user tap. Emits at most one
   * `restore-requested` event per call, only for the current ready lifetime
   * and its selected session, and only when the host declared the event.
   */
  requestRestore(request: HostRestoreRequest): boolean {
    const lifetime = this.current;
    if (this.disposed || !this.restoreRequested || !this.snapshot.composerHidden || !lifetime?.ready ||
        request.sessionKey !== lifetime.sessionKey) return false;
    const base = {
      event: 'restore-requested', version: 1, lifetimeId: lifetime.lifetimeId, sessionKey: lifetime.sessionKey,
      messageId: request.messageId, ...(request.correlationId ? { correlationId: request.correlationId } : {}),
      content: request.content,
    } as const;
    const items = request.attachments ?? [];
    if (request.attachmentCount === 0) {
      this.emit(base);
      return true;
    }
    if (!items.length) {
      this.emit({ ...base, attachmentsUnavailable: true });
      return true;
    }
    void Promise.all(items.map(async item => Object.freeze({
      filename: item.filename, mimeType: item.bytes.type, data: await blobBase64(item.bytes),
    }))).then(
      attachments => attachments,
      () => undefined,
    ).then(attachments => {
      // The event names the lifetime current at the tap. If it ended while the
      // photos were read, the host could not apply it, so nothing is emitted.
      if (this.disposed || this.current !== lifetime) return;
      this.emit(attachments?.length ? { ...base, attachments: Object.freeze(attachments) }
        : { ...base, attachmentsUnavailable: true });
    });
    return true;
  }

  private onPageHide = (): void => {
    if (!this.current) return;
    this.suspendedRuntime = this.current.runtime;
    this.detach('unloading');
  };

  private onPageShow = (): void => {
    const runtime = this.suspendedRuntime;
    if (!runtime || this.disposed) return;
    this.suspendedRuntime = undefined;
    this.attach(runtime, true);
  };

  dispose(): void {
    if (this.disposed) return;
    if (this.current) this.detach('disposed');
    this.disposed = true;
    this.target.removeEventListener('pagehide', this.onPageHide);
    this.target.removeEventListener('pageshow', this.onPageShow);
    if ((this.target as unknown as Record<string, unknown>)[HOST_COMMAND_NAME] === this.command) {
      if (this.priorCommand) Object.defineProperty(this.target, HOST_COMMAND_NAME, this.priorCommand);
      else delete (this.target as unknown as Record<string, unknown>)[HOST_COMMAND_NAME];
    }
    this.listeners.clear();
    this.current = undefined;
    this.suspendedRuntime = undefined;
  }
}

export function getHostComposerSnapshot(bridge: HostComposerBridge | null): HostComposerSnapshot {
  return bridge?.getSnapshot() ?? emptySnapshot;
}

export function subscribeHostComposer(bridge: HostComposerBridge | null, listener: () => void): () => void {
  return bridge?.subscribe(listener) ?? (() => {});
}
