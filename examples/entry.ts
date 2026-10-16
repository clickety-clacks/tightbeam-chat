export interface ChatTarget {
  readonly gateway: string;
  readonly sessionKey: string;
}

export interface ConfiguredChatTarget {
  readonly gateway?: string;
  readonly sessionKey?: string;
}

export type EntryResolution =
  | { readonly kind: 'selected'; readonly target: ChatTarget; readonly source: 'link' | 'configured' }
  | { readonly kind: 'invalid-selection'; readonly message: string; readonly canRecoverToConfigured: boolean }
  | { readonly kind: 'configuration-error'; readonly message: string };

function canonicalGateway(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function targetFrom(gateway: string | undefined, sessionKey: string | undefined): ChatTarget | undefined {
  const normalizedGateway = canonicalGateway(gateway);
  if (!normalizedGateway || !sessionKey?.trim()) return undefined;
  return { gateway: normalizedGateway, sessionKey };
}

function configuredTarget(value: ConfiguredChatTarget | undefined): ChatTarget | undefined {
  return targetFrom(value?.gateway, value?.sessionKey);
}

function wellFormedQuery(search: string): boolean {
  try {
    decodeURIComponent(search.replace(/\+/g, ' '));
    return true;
  } catch {
    return false;
  }
}

/** Selects only a complete link target or an explicitly configured root target. */
export function resolveEntrySelection(
  search: string,
  configured: ConfiguredChatTarget | undefined,
): EntryResolution {
  const fallback = configuredTarget(configured);
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];

  if (keys.length === 0) {
    return fallback
      ? { kind: 'selected', target: fallback, source: 'configured' }
      : { kind: 'configuration-error', message: 'This Chat entry has no valid default target configured.' };
  }

  const invalid = (): EntryResolution => ({
    kind: 'invalid-selection',
    message: fallback
      ? 'This Chat link is invalid. Its requested target was not selected.'
      : 'This Chat link is invalid, and no configured default target is available.',
    canRecoverToConfigured: Boolean(fallback),
  });

  if (!wellFormedQuery(search) || keys.some((key) => key !== 'gateway' && key !== 'session') ||
      params.getAll('gateway').length !== 1 || params.getAll('session').length !== 1) return invalid();

  const target = targetFrom(params.get('gateway') ?? undefined, params.get('session') ?? undefined);
  return target ? { kind: 'selected', target, source: 'link' } : invalid();
}

function loopback(hostname: string): boolean {
  const unwrapped = hostname.replace(/^\[|\]$/g, '');
  return unwrapped === 'localhost' || unwrapped === '::1' || /^127(?:\.\d{1,3}){3}$/.test(unwrapped);
}

/** Private network sign-in requires HTTPS; secure localhost remains usable for development. */
export function canUseBrowserCredentials(pageHref: string, isSecureContext: boolean): boolean {
  if (!isSecureContext) return false;
  try {
    const page = new URL(pageHref);
    return page.protocol === 'https:' || (page.protocol === 'http:' && loopback(page.hostname));
  } catch {
    return false;
  }
}

/** Builds the same-origin bridge URL used for gateway HTTP and WebSocket traffic. */
export function gatewayBridgeUrl(
  pageHref: string,
  gateway: string,
  request: string,
  transport: 'http' | 'websocket',
): URL {
  const normalizedGateway = canonicalGateway(gateway);
  if (!normalizedGateway) throw new Error('The selected gateway origin is invalid.');

  let page: URL;
  let target: URL;
  try {
    page = new URL(pageHref);
    target = new URL(request, `${normalizedGateway}/`);
  } catch {
    throw new Error('Chat requires an HTTP(S) page and gateway origin.');
  }
  if (!['http:', 'https:'].includes(page.protocol) || !page.hostname ||
      target.origin !== normalizedGateway || target.username || target.password || target.hash) {
    throw new Error('The bridge request must stay on the selected gateway.');
  }
  if (transport === 'websocket' && target.pathname !== '/ws' && !target.pathname.startsWith('/ws/')) {
    throw new Error('The WebSocket bridge supports only gateway WebSocket routes.');
  }

  const bridge = new URL(`/gateway/${encodeURIComponent(normalizedGateway)}${target.pathname}${target.search}`, page.origin);
  if (transport === 'websocket') bridge.protocol = page.protocol === 'https:' ? 'wss:' : 'ws:';
  return bridge;
}

export interface GatewayBridgeTarget {
  readonly gateway: string;
  readonly path: string;
}

/** Resolves the same-origin bridge route back to its selected gateway request. */
export function parseGatewayBridgeTarget(requestUrl: string): GatewayBridgeTarget | undefined {
  try {
    const request = new URL(requestUrl, 'http://chat-bridge.invalid');
    if (request.origin !== 'http://chat-bridge.invalid') return undefined;
    const match = /^\/gateway\/([^/]+)(\/.*)$/.exec(request.pathname);
    if (!match) return undefined;

    const gateway = canonicalGateway(decodeURIComponent(match[1]));
    if (!gateway) return undefined;
    const path = `${match[2]}${request.search}`;
    const pathname = new URL(path, gateway).pathname;
    if (pathname !== '/version' && pathname !== '/ws' && pathname !== '/ws/changes' &&
        pathname !== '/api/sessions' && !pathname.startsWith('/api/sessions/')) return undefined;
    return { gateway, path };
  } catch {
    return undefined;
  }
}

/** The bridge accepts browser requests only when their Origin matches its own origin. */
export function sameOriginBridgeOrigin(origin: string, requestOrigin: string): boolean {
  try {
    const candidate = new URL(origin);
    const expected = new URL(requestOrigin);
    return ['http:', 'https:'].includes(candidate.protocol) && candidate.username === '' && candidate.password === '' &&
      candidate.pathname === '/' && candidate.search === '' && candidate.hash === '' &&
      candidate.origin === expected.origin;
  } catch {
    return false;
  }
}
