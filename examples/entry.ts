export interface ChatTarget {
  readonly gateway: string;
  readonly sessionKey: string;
  readonly principalKey: string;
  readonly deviceId: string;
}

export interface RequestedChatTarget {
  readonly gateway: string;
  readonly sessionKey: string;
}

export interface ConfiguredChatTarget {
  readonly gateway?: string;
  readonly sessionKey?: string;
  readonly principalKey?: string;
  readonly deviceId?: string;
}

/** Loads the deployment-owned, nonsecret default from the same origin as the page. */
export async function loadConfiguredChatTarget(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ChatTarget> {
  let response: Response;
  try {
    response = await fetcher('/chat-config.json', {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
  } catch {
    throw new Error('The configured Chat target could not be loaded.');
  }
  if (!response.ok) throw new Error('The configured Chat target could not be loaded.');

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error('The Chat server returned invalid target configuration.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The Chat server returned invalid target configuration.');
  }

  const config = value as Record<string, unknown>;
  const target = targetFrom(
    typeof config.gateway === 'string' ? config.gateway : undefined,
    typeof config.sessionKey === 'string' ? config.sessionKey : undefined,
    typeof config.principalKey === 'string' ? config.principalKey : undefined,
    typeof config.deviceId === 'string' ? config.deviceId : undefined,
  );
  if (!target) throw new Error('The Chat server returned an invalid default target.');
  return target;
}

export type EntryResolution =
  | { readonly kind: 'selected'; readonly target: ChatTarget; readonly source: 'link' | 'configured' }
  | {
    readonly kind: 'unavailable-selection';
    readonly target: RequestedChatTarget;
    readonly message: string;
    readonly canRecoverToConfigured: boolean;
  }
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

function targetFrom(
  gateway: string | undefined,
  sessionKey: string | undefined,
  principalKey: string | undefined,
  deviceId: string | undefined,
): ChatTarget | undefined {
  const normalizedGateway = canonicalGateway(gateway);
  if (!normalizedGateway || !sessionKey?.trim() || !principalKey?.trim() || !deviceId?.trim()) return undefined;
  return { gateway: normalizedGateway, sessionKey, principalKey, deviceId };
}

function configuredTarget(value: ConfiguredChatTarget | undefined): ChatTarget | undefined {
  return targetFrom(value?.gateway, value?.sessionKey, value?.principalKey, value?.deviceId);
}

function wellFormedQuery(search: string): boolean {
  try {
    decodeURIComponent(search.replace(/\+/g, ' '));
    return true;
  } catch {
    return false;
  }
}

/** Selects a complete link target or an explicitly configured root target. */
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

  const gateway = canonicalGateway(params.get('gateway') ?? undefined);
  const sessionKey = params.get('session') ?? undefined;
  if (!gateway || !sessionKey?.trim()) return invalid();
  if (!fallback || gateway !== fallback.gateway) {
    return {
      kind: 'unavailable-selection',
      target: { gateway, sessionKey },
      message: 'This Chat service has no provisioned Gateway access for the selected target.',
      canRecoverToConfigured: Boolean(fallback),
    };
  }
  return {
    kind: 'selected',
    target: { ...fallback, sessionKey },
    source: 'link',
  };
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
