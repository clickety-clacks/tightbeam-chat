import type { HumanSendResult, HumanSubmission } from '../src/types';

/** The bridge-held device credential's route; the token itself never reaches the page. */
export const DEVICE_ROUTE = '/__chat/device';

export type DeviceFetch = (input: string, init: RequestInit) => Promise<Response>;

export type DeviceStatus =
  | { readonly paired: false; readonly reason?: string }
  | { readonly paired: true; readonly deviceId: string; readonly userId?: string; readonly scope?: string;
      readonly verified: boolean };

export type PairOutcome =
  | { readonly success: true; readonly deviceId: string; readonly userId: string; readonly scope?: string;
      readonly signedIn: boolean }
  | { readonly success: false; readonly reason: string; readonly message?: string };

/** Called when the bridge reports this browser's device credential is gone (cookie cleared). */
export type DeviceCredentialLost = (reason: string) => void;

const DEVICE_ID_PATTERN = /^chat-web-[0-9a-f]{32}$/;

/** A fresh `chat-web-<32 hex>` device id for one pairing attempt. */
export function newBrowserDeviceId(randomValues: (bytes: Uint8Array) => Uint8Array =
  (bytes) => crypto.getRandomValues(bytes)): string {
  const bytes = randomValues(new Uint8Array(16));
  return `chat-web-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** The Gateway's claimed name: the human's label followed by the Clawline code. */
export function pairingClaimedName(name: string, code: string): string {
  return `${name.trim()} ${code.trim()}`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json();
    return plainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchDeviceStatus(fetcher: DeviceFetch, signal?: AbortSignal): Promise<DeviceStatus> {
  // A POST, so the browser sends Origin (it omits it on same-origin GETs) and the anti-forgery header.
  const response = await fetcher(`${DEVICE_ROUTE}/status`, { method: 'POST', cache: 'no-store', signal });
  const body = await readJson(response);
  if (!response.ok || !body) throw new Error("This browser's pairing could not be checked.");
  if (body.paired === true && typeof body.deviceId === 'string' && DEVICE_ID_PATTERN.test(body.deviceId)) {
    return {
      paired: true,
      deviceId: body.deviceId,
      verified: body.verified === true,
      ...(typeof body.userId === 'string' ? { userId: body.userId } : {}),
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    };
  }
  return { paired: false, ...(typeof body.reason === 'string' ? { reason: body.reason } : {}) };
}

/** Sends the browser-built pair_request through the bridge, which forwards it unchanged. */
export async function pairBrowser(fetcher: DeviceFetch, input: {
  readonly name: string;
  readonly code: string;
  readonly deviceId?: string;
}): Promise<PairOutcome> {
  const deviceId = input.deviceId ?? newBrowserDeviceId();
  const request = {
    type: 'pair_request',
    protocolVersion: 1,
    deviceId,
    claimedName: pairingClaimedName(input.name, input.code),
    deviceInfo: { platform: 'web', model: 'Tightbeam Chat' },
  };
  let response: Response;
  try {
    response = await fetcher(`${DEVICE_ROUTE}/pair`, {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    return { success: false, reason: 'chat_unreachable' };
  }
  const body = await readJson(response);
  if (body?.success === true && typeof body.deviceId === 'string' && typeof body.userId === 'string') {
    return { success: true, deviceId: body.deviceId, userId: body.userId, signedIn: body.signedIn === true,
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}) };
  }
  if (body?.success === false && typeof body.reason === 'string') {
    return { success: false, reason: body.reason, ...(typeof body.message === 'string' ? { message: body.message } : {}) };
  }
  const error = plainObject(body?.error) ? body.error : undefined;
  return { success: false, reason: typeof error?.code === 'string' ? error.code : `http-${response.status}` };
}

export async function forgetBrowserDevice(fetcher: DeviceFetch): Promise<void> {
  const response = await fetcher(`${DEVICE_ROUTE}/forget`, { method: 'POST', cache: 'no-store' });
  if (!response.ok) throw new Error('This browser could not forget its device.');
}

/**
 * Sends one human submission with this browser's device credential (W5). The
 * same `c_` id is reused by the runtime on retry, so a repeated send is deduplicated.
 */
export async function sendWithBrowserDevice(
  fetcher: DeviceFetch,
  submission: HumanSubmission,
  signal: AbortSignal,
  onSubmitted?: () => void,
  onCredentialLost?: DeviceCredentialLost,
): Promise<HumanSendResult> {
  let request: Promise<Response>;
  try {
    request = fetcher(`${DEVICE_ROUTE}/send`, {
      method: 'POST', signal, cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionKey: submission.sessionKey,
        id: submission.clientMessageId,
        content: submission.content,
        ...(submission.attachments?.length ? { attachments: submission.attachments } : {}),
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
  const body = await readJson(response);
  const error = plainObject(body?.error) ? body.error : undefined;
  const code = typeof error?.code === 'string' && error.code ? error.code : undefined;
  if (response.status === 401) {
    const reason = code === 'token_revoked' || code === 'not_paired' ? code : 'token_revoked';
    onCredentialLost?.(reason);
    return { outcome: 'refused', reason };
  }
  if (response.ok && body?.outcome === 'accepted' && plainObject(body.ack) && body.ack.id === submission.clientMessageId) {
    return { outcome: 'accepted',
      ...(typeof body.ack.messageId === 'string' && body.ack.messageId ? { messageId: body.ack.messageId } : {}) };
  }
  if (response.ok && body?.outcome === 'refused') {
    return { outcome: 'refused', reason: code ?? 'refused' };
  }
  if (response.status === 504 || error?.sent === true) {
    return { outcome: 'uncertain', reason: code ?? 'send_unconfirmed' };
  }
  if (response.status >= 500) return { outcome: 'retryable', reason: code ?? `http-${response.status}` };
  if (response.ok) return { outcome: 'uncertain', reason: 'invalid-send-response' };
  return { outcome: 'refused', reason: code ?? `http-${response.status}` };
}
