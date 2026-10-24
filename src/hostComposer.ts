import type { ChatRuntime, HostSendSignal, RuntimeState } from './types';

/** Public, fixed in-page names for host-composer protocol version 1. */
export const HOST_DECLARATION_NAME = '__TIGHTBEAM_CHAT_HOST__';
export const HOST_COMMAND_NAME = '__TIGHTBEAM_CHAT_COMMAND__';

export type HostComposerEvent =
  | { readonly event: 'declined'; readonly reason: 'malformed-declaration' | 'unsupported-version' }
  | { readonly event: 'ready'; readonly version: 1; readonly lifetimeId: string; readonly sessionKey: string;
      readonly gatewayOrigin: string; readonly agentDisplayName: string; readonly capabilities: { readonly text: true } }
  | { readonly event: 'unavailable'; readonly version: 1; readonly lifetimeId: string; readonly reason: string }
  | { readonly event: 'lifetime-ended'; readonly version: 1; readonly lifetimeId: string;
      readonly reason: 'target-changed' | 'identity-changed' | 'disposed' | 'unloading' }
  | { readonly event: 'rejected'; readonly lifetimeId: unknown; readonly correlationId: unknown;
      readonly reason: 'not-ready' | 'target-mismatch' | 'invalid-correlation' | 'empty' |
        'attempt-in-flight' | 'already-delivered' | 'correlation-conflict' }
  | { readonly event: 'accepted'; readonly lifetimeId: string; readonly correlationId: string; readonly attempt: number }
  | { readonly event: 'delivered'; readonly lifetimeId: string; readonly correlationId: string; readonly attempt: number }
  | { readonly event: 'failed'; readonly lifetimeId: string; readonly correlationId: string; readonly attempt: number;
      readonly reason: 'refused' | 'retry-unavailable'; readonly detail?: string }
  | { readonly event: 'uncertain'; readonly lifetimeId: string; readonly correlationId: string; readonly attempt: number;
      readonly reason: 'ack-lost' | 'accepted-unreconciled' | 'lifetime-ended' };

export interface HostComposerDeclaration {
  readonly versions: readonly number[];
  readonly onEvent: (event: HostComposerEvent) => void;
}

export interface HostComposerCommand {
  readonly type: 'send';
  readonly lifetimeId: unknown;
  readonly sessionKey: unknown;
  readonly correlationId: unknown;
  readonly content: unknown;
  readonly retry?: unknown;
}

export type HostComposerCommandEntry = (command: HostComposerCommand) => void;

export interface HostComposerSnapshot {
  readonly optedIn: boolean;
  readonly composerHidden: boolean;
  readonly ready: boolean;
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
  unsubscribe: () => void;
}

const emptySnapshot: HostComposerSnapshot = Object.freeze({
  optedIn: false, composerHidden: false, ready: false,
});
const correlationPattern = /^c_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const declinedDeclarations = new WeakSet<object>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function runtimeUnavailableReason(state: RuntimeState): string {
  switch (state.status) {
    case 'loading': return 'connecting';
    case 'stale': return 'reconnecting';
    case 'error': return 'disconnected';
    case 'unsupported': return 'unsupported';
    case 'unauthorized': return 'unauthorized';
    case 'ready': return 'ready';
  }
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
    return new HostComposerBridge(target, handler);
  }

  private readonly listeners = new Set<() => void>();
  private readonly priorCommand: PropertyDescriptor | undefined;
  private readonly command: HostComposerCommandEntry;
  private snapshot: HostComposerSnapshot = Object.freeze({ ...emptySnapshot, optedIn: true });
  private current: Lifetime | undefined;
  private suspendedRuntime: ChatRuntime | undefined;
  private disposed = false;

  private constructor(private readonly target: Window, private readonly onEvent: (event: HostComposerEvent) => void) {
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
    });
    for (const listener of this.listeners) listener();
  }

  private emit(event: HostComposerEvent): void {
    errorSafeEmit(this.onEvent, event);
  }

  attach(runtime: ChatRuntime, refreshBeforeReady = false): void {
    if (this.disposed) return;
    if (this.current?.runtime === runtime) return;
    if (this.current) this.detach('disposed');
    this.suspendedRuntime = undefined;
    const lifetime: Lifetime = {
      runtime,
      lifetimeId: `l_${crypto.randomUUID()}`,
      sessionKey: runtime.getSnapshot().sessionKey,
      attempts: new Map(),
      ready: false,
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
    for (const attempt of [...lifetime.attempts.values()]) {
      if (attempt.settled) continue;
      this.settle(lifetime, attempt, {
        event: 'uncertain', lifetimeId: lifetime.lifetimeId, correlationId: attempt.correlationId,
        attempt: attempt.number, reason: attempt.accepted ? 'accepted-unreconciled' : 'lifetime-ended',
      });
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
    if (state.status === 'ready') {
      if (!lifetime.ready) {
        const gatewayOrigin = this.gatewayOrigin(state.targetGateway);
        if (!gatewayOrigin) return;
        lifetime.ready = true;
        this.emit({
          event: 'ready', version: 1, lifetimeId: lifetime.lifetimeId, sessionKey: lifetime.sessionKey,
          gatewayOrigin, agentDisplayName: state.agentDisplayName ?? state.session?.displayName ?? '',
          capabilities: Object.freeze({ text: true }),
        });
        if (!this.snapshot.composerHidden) {
          this.snapshot = Object.freeze({ ...this.snapshot, composerHidden: true, ready: true });
          for (const listener of this.listeners) listener();
        } else this.publish();
        for (const attempt of lifetime.attempts.values()) {
          if (attempt.accepted && state.generation > attempt.lastCheckedGeneration) this.checkAccepted(lifetime, attempt, state.generation);
        }
      }
      return;
    }
    if (!lifetime.ready) return;
    lifetime.ready = false;
    this.publish();
    this.emit({ event: 'unavailable', version: 1, lifetimeId: lifetime.lifetimeId,
      reason: runtimeUnavailableReason(state) });
  }

  private gatewayOrigin(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== 'null' ? url.origin : undefined;
    } catch { return undefined; }
  }

  private receive(command: HostComposerCommand): void {
    if (this.disposed || !isObject(command) || command.type !== 'send') return;
    const lifetime = this.current;
    const correlationId = command.correlationId;
    const reject = (reason: Extract<HostComposerEvent, { event: 'rejected' }>['reason']) => {
      this.emit({ event: 'rejected', lifetimeId: command.lifetimeId, correlationId, reason });
    };
    if (!lifetime?.ready || lifetime.runtime.getSnapshot().status !== 'ready') return reject('not-ready');
    if (command.lifetimeId !== lifetime.lifetimeId || command.sessionKey !== lifetime.sessionKey) return reject('target-mismatch');
    if (typeof correlationId !== 'string' || !correlationPattern.test(correlationId)) return reject('invalid-correlation');
    if (typeof command.content !== 'string' || !command.content.trim()) return reject('empty');

    const retry = command.retry === true;
    const priorAttempt = lifetime.attempts.get(correlationId);
    if (priorAttempt) return reject('attempt-in-flight');
    const priorSend = lifetime.runtime.getSnapshot().sends.find((send) => send.clientMessageId === correlationId);
    if (priorSend?.hostSend?.lifetimeId === lifetime.lifetimeId && priorSend.reconciled) {
      return reject('already-delivered');
    }
    if (priorSend && (!priorSend.hostSend || !retry || priorSend.content !== command.content)) {
      return reject('correlation-conflict');
    }

    const attempt: Attempt = {
      correlationId,
      number: priorSend?.hostSend?.lifetimeId === lifetime.lifetimeId ? priorSend.hostSend.attempt + 1 : 1,
      accepted: false, settled: false, lastCheckedGeneration: -1,
    };
    lifetime.attempts.set(correlationId, attempt);
    attempt.stopObserving = lifetime.runtime.observeHostSend(correlationId, (signal) => this.onSendSignal(lifetime, attempt, signal));
    this.publish();
    const hostSend = { lifetimeId: lifetime.lifetimeId, attempt: attempt.number } as const;
    if (retry) lifetime.runtime.retryHostSend(correlationId, command.content, hostSend);
    else if (!lifetime.runtime.send(command.content, correlationId, hostSend)) {
      this.settle(lifetime, attempt, { event: 'failed', lifetimeId: lifetime.lifetimeId,
        correlationId, attempt: attempt.number, reason: 'refused', detail: 'send-not-started' });
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
          correlationId: attempt.correlationId, attempt: attempt.number, reason: signal.reason, detail: signal.detail });
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
    } else if (result === 'absent') {
      lifetime.runtime.markHostSendUncertain(attempt.correlationId, 'accepted-unreconciled');
    }
  }

  private settle(lifetime: Lifetime, attempt: Attempt, event: HostComposerEvent): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.stopObserving?.();
    attempt.stopObserving = undefined;
    if (lifetime.attempts.get(attempt.correlationId) === attempt) lifetime.attempts.delete(attempt.correlationId);
    this.emit(event);
    this.publish();
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
