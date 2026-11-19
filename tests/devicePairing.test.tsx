// Spec stage2-v5 §C1/§C1a, tests T13 and T13a (browser side, jsdom), both flag states.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HostPage } from '../examples/HostPage';
import { browserHost } from '../examples/browserHost';
import { newBrowserDeviceId, pairingClaimedName } from '../examples/devicePairing';

const baseTarget = {
  gateway: 'https://gateway.example:8443',
  sessionKey: 'agent:main:george',
  principalKey: 'george',
  deviceId: 'chat_service_device',
};
const pairedTarget = { ...baseTarget, devicePairingEnabled: true };
const PAIRED_DEVICE = `chat-web-${'ab'.repeat(16)}`;

interface Call { readonly method: string; readonly path: string; readonly url: URL; readonly headers: Headers; readonly body?: unknown }

class ReadyWebSocket {
  static instances: ReadyWebSocket[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: unknown[] = [];
  constructor(readonly url: string) {
    ReadyWebSocket.instances.push(this);
    const path = new URL(url).pathname;
    queueMicrotask(() => {
      this.onopen?.(new Event('open'));
      if (path === '/__chat/ws/changes') {
        this.onmessage?.({ data: JSON.stringify({ type: 'auth_result', success: true,
          userId: baseTarget.principalKey, sessionKey: baseTarget.sessionKey }) } as MessageEvent);
      }
    });
  }
  close() {}
  send(data: string) {
    const frame = JSON.parse(data);
    this.sent.push(frame);
    if (frame.type === 'subscribe') {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'subscription_ready',
        subscriptionId: frame.subscriptionId }) } as MessageEvent));
    }
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/** A same-origin Chat service fake: history reads, device bridge routes, and every call recorded. */
function chatService({ status = { paired: false } as Record<string, unknown>, transcript = [] as unknown[],
  pair = (_body: unknown) => json({ success: true, userId: 'george', deviceId: PAIRED_DEVICE, scope: 'decide', signedIn: true }),
  send = (body: Record<string, unknown>) => json({ outcome: 'accepted', ack: { type: 'ack', id: body.id, messageId: 'm_sent' } }),
} = {}) {
  const calls: Call[] = [];
  const fetchSpy = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, url, headers: new Headers(init?.headers), body });
    const path = url.pathname;
    if (path === '/__chat/device/status') return json(status);
    if (path === '/__chat/device/pair') return pair(body);
    if (path === '/__chat/device/send') return send(body);
    if (path === '/__chat/device/forget') return json({ paired: false });
    if (path.endsWith('/tool-calls')) return json({ schemaVersion: 1, resource: 'tool calls', items: [], page: { hasMoreBefore: false } });
    if (path.endsWith('/turns')) return json({ schemaVersion: 1, resource: 'turns', items: [], page: { hasMoreBefore: false } });
    if (path.endsWith('/messages')) {
      return json({ schemaVersion: 1, resource: 'transcript messages', items: url.searchParams.has('after') ? [] : transcript,
        page: { oldestCursor: null, newestCursor: null, hasMoreBefore: false, hasMoreAfter: false } });
    }
    if (path.endsWith('/agent/dispatch')) return json({ error: { code: 'not_found' } }, 404);
    return json({ schemaVersion: 1, resource: 'sessions', item: { sessionKey: baseTarget.sessionKey, rowVersion: 1,
      displayName: 'Main', ownerUserId: 'george' } });
  });
  vi.stubGlobal('fetch', fetchSpy);
  vi.stubGlobal('WebSocket', ReadyWebSocket);
  return { calls, fetchSpy };
}

function deviceBar() {
  return screen.getByRole('region', { name: 'Browser device' });
}

async function sendFromComposer(text: string) {
  const input = await screen.findByRole('textbox', { name: /message to/i });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest('form')!);
}

function humanSockets() {
  return ReadyWebSocket.instances.filter((socket) => new URL(socket.url).pathname === '/__chat/ws');
}

beforeEach(() => {
  ReadyWebSocket.instances = [];
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('browser fetch helper', () => {
  it.each(['POST', 'PUT', 'DELETE', 'post'])('adds X-Tightbeam-Chat: 1 to a %s request', async (method) => {
    const { calls } = chatService();
    await browserHost(baseTarget).fetch('/__chat/device/forget', { method });
    expect(calls[0].headers.get('x-tightbeam-chat')).toBe('1');
  });

  it.each(['GET', 'HEAD', undefined])('does not add it to a %s request', async (method) => {
    const { calls } = chatService();
    await browserHost(baseTarget).fetch('/__chat/device/status', method ? { method } : {});
    expect(calls[0].headers.has('x-tightbeam-chat')).toBe(false);
  });

  it('builds the chat-web device id and claimed name', () => {
    expect(newBrowserDeviceId()).toMatch(/^chat-web-[0-9a-f]{32}$/);
    expect(newBrowserDeviceId((bytes) => bytes.fill(0xab))).toBe(PAIRED_DEVICE);
    expect(pairingClaimedName(' Desk Chrome ', ' TB-ABCD-EFGH-JKLM ')).toBe('Desk Chrome TB-ABCD-EFGH-JKLM');
  });
});

describe('Pair this browser (flag on)', () => {
  it('pairs with a name and code through the bridge and shows the paired state', async () => {
    const { calls } = chatService();
    render(<HostPage defaultTarget={pairedTarget} />);

    expect(await within(deviceBar()).findByText(/This browser is not paired/)).toBeTruthy();
    fireEvent.click(within(deviceBar()).getByRole('button', { name: 'Pair this browser' }));
    fireEvent.change(screen.getByLabelText('Name for this browser'), { target: { value: 'Desk Chrome' } });
    fireEvent.change(screen.getByLabelText('Pairing code from Clawline'), { target: { value: 'TB-ABCD-EFGH-JKLM' } });
    fireEvent.click(within(deviceBar()).getByRole('button', { name: 'Pair' }));

    expect(await within(deviceBar()).findByText(/This browser is paired as its own device/)).toBeTruthy();
    expect(within(deviceBar()).getByText(/\(decide\)/)).toBeTruthy();
    const pairCalls = calls.filter((call) => call.path === '/__chat/device/pair');
    expect(pairCalls).toHaveLength(1);
    expect(pairCalls[0].method).toBe('POST');
    expect(pairCalls[0].headers.get('x-tightbeam-chat')).toBe('1');
    expect(pairCalls[0].url.searchParams.get('gateway')).toBe(baseTarget.gateway);
    const request = pairCalls[0].body as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(['claimedName', 'deviceId', 'deviceInfo', 'protocolVersion', 'type']);
    expect(request).toMatchObject({ type: 'pair_request', protocolVersion: 1, claimedName: 'Desk Chrome TB-ABCD-EFGH-JKLM' });
    expect(request.deviceId).toMatch(/^chat-web-[0-9a-f]{32}$/);
    expect(document.cookie).toBe('');
  });

  it.each([
    [{ success: false, reason: 'pairing_code_invalid', message: 'That code has expired.' }, /Code not accepted \(pairing_code_invalid\)\. That code has expired\./],
    [{ success: false, reason: 'pairing_code_required' }, /pairing_code_required/],
    [{ success: false, reason: 'already_paired' }, /already_paired.*does not pair again automatically/],
    [{ success: false, reason: 'rate_limited' }, /rate_limited.*Try again shortly/],
    [{ success: false, reason: 'unexpected_reason' }, /unexpected_reason/],
  ])('shows pairing failure %j and never retries on its own', async (reply, text) => {
    const { calls } = chatService({ pair: () => json(reply) });
    render(<HostPage defaultTarget={pairedTarget} />);
    fireEvent.click(await within(deviceBar()).findByRole('button', { name: 'Pair this browser' }));
    fireEvent.change(screen.getByLabelText('Pairing code from Clawline'), { target: { value: 'TB-ABCD-EFGH-JKLM' } });
    fireEvent.click(within(deviceBar()).getByRole('button', { name: 'Pair' }));

    const alert = await within(deviceBar()).findByRole('alert');
    expect(alert.textContent).toMatch(text);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.path === '/__chat/device/pair')).toHaveLength(1);
    expect(within(deviceBar()).getByText(/This browser is not paired/)).toBeTruthy();
  });

  it('checks the form before anything is sent', async () => {
    const { calls } = chatService();
    render(<HostPage defaultTarget={pairedTarget} />);
    fireEvent.click(await within(deviceBar()).findByRole('button', { name: 'Pair this browser' }));
    fireEvent.click(within(deviceBar()).getByRole('button', { name: 'Pair' }));
    expect((await within(deviceBar()).findByRole('alert')).textContent).toContain('Enter the pairing code');
    expect(calls.some((call) => call.path === '/__chat/device/pair')).toBe(false);
  });

  it('shows token_revoked from the status read and does not re-pair', async () => {
    const { calls } = chatService({ status: { paired: false, reason: 'token_revoked' } });
    render(<HostPage defaultTarget={pairedTarget} />);
    const alert = await within(deviceBar()).findByRole('alert');
    expect(alert.textContent).toContain('token_revoked');
    expect(calls.some((call) => call.path === '/__chat/device/pair')).toBe(false);
  });

  it('pauses Chat with a visible retry when the pairing status cannot be read', async () => {
    const { calls } = chatService({ status: { error: 'x' } });
    calls.length = 0;
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchSpy.mockImplementationOnce(async () => json({ error: { code: 'boom' } }, 500));
    render(<HostPage defaultTarget={pairedTarget} />);
    expect((await within(deviceBar()).findByRole('alert')).textContent).toContain('could not be checked');
    expect(screen.queryByRole('textbox', { name: /message to/i })).toBeNull();
    fireEvent.click(within(deviceBar()).getByRole('button', { name: 'Check again' }));
    expect(await within(deviceBar()).findByText(/This browser is not paired/)).toBeTruthy();
  });
});

describe('sending while paired (flag on)', () => {
  it.each([false, true])('sends messages and /tightbeam commands only through /__chat/device/send (REST flag %s)', async (rest) => {
    const { calls } = chatService({ status: { paired: true, deviceId: PAIRED_DEVICE, verified: true, scope: 'decide' } });
    render(<HostPage defaultTarget={{ ...pairedTarget, ...(rest ? { restHumanSendEnabled: true } : {}) }} />);
    expect(await within(deviceBar()).findByText(/This browser is paired as its own device/)).toBeTruthy();

    await sendFromComposer('hello from this browser');
    await waitFor(() => expect(calls.filter((call) => call.path === '/__chat/device/send')).toHaveLength(1));
    await sendFromComposer('/tightbeam rule dr_x accept');
    await waitFor(() => expect(calls.filter((call) => call.path === '/__chat/device/send')).toHaveLength(2));

    const sends = calls.filter((call) => call.path === '/__chat/device/send');
    for (const call of sends) {
      expect(call.method).toBe('POST');
      expect(call.headers.get('x-tightbeam-chat')).toBe('1');
      expect(call.headers.has('authorization')).toBe(false);
      expect(Object.keys(call.body as object).sort()).toEqual(['content', 'id', 'sessionKey']);
      expect((call.body as { id: string }).id).toMatch(/^c_/);
    }
    expect(sends.map((call) => (call.body as { content: string }).content))
      .toEqual(['hello from this browser', '/tightbeam rule dr_x accept']);
    expect(calls.some((call) => call.path.endsWith('/agent/dispatch') && (call.body as { verb?: string })?.verb === 'post')).toBe(false);
    expect(humanSockets()).toHaveLength(0);
  });

  it('retries an unconfirmed send with the same client message id', async () => {
    let attempts = 0;
    const { calls } = chatService({
      status: { paired: true, deviceId: PAIRED_DEVICE, verified: true },
      send: (body) => (++attempts === 1 ? json({ error: { code: 'gateway_unavailable', sent: false } }, 503)
        : json({ outcome: 'accepted', ack: { type: 'ack', id: body.id, messageId: 'm_retry' } })),
    });
    render(<HostPage defaultTarget={pairedTarget} />);
    await within(deviceBar()).findByText(/This browser is paired/);
    await sendFromComposer('retry me');
    await waitFor(() => expect(calls.filter((call) => call.path === '/__chat/device/send')).toHaveLength(2), { timeout: 5000 });
    const ids = calls.filter((call) => call.path === '/__chat/device/send').map((call) => (call.body as { id: string }).id);
    expect(ids[0]).toBe(ids[1]);
  });

  it('shows token_revoked when a send finds the credential dead, without re-pairing or switching credentials', async () => {
    const { calls } = chatService({
      status: { paired: true, deviceId: PAIRED_DEVICE, verified: true },
      send: () => json({ error: { code: 'token_revoked', reason: 'token_revoked' } }, 401),
    });
    render(<HostPage defaultTarget={pairedTarget} />);
    await within(deviceBar()).findByText(/This browser is paired/);
    await sendFromComposer('after revocation');
    const alert = await within(deviceBar()).findByRole('alert');
    expect(alert.textContent).toContain('token_revoked');
    expect(within(deviceBar()).getByRole('button', { name: 'Pair this browser' })).toBeTruthy();

    // Another composer send stays on the device route; nothing silently moves to the service credential.
    await sendFromComposer('still not on the service path');
    await waitFor(() => expect(calls.filter((call) => call.path === '/__chat/device/send')).toHaveLength(2));
    expect(calls.some((call) => call.path === '/__chat/device/pair')).toBe(false);
    expect(calls.some((call) => call.path.endsWith('/agent/dispatch'))).toBe(false);
    expect(humanSockets()).toHaveLength(0);
  });

  it('forgets this browser on request and then uses the service path', async () => {
    const { calls } = chatService({ status: { paired: true, deviceId: PAIRED_DEVICE, verified: true } });
    render(<HostPage defaultTarget={pairedTarget} />);
    fireEvent.click(await within(deviceBar()).findByRole('button', { name: 'Forget this browser' }));
    expect(await within(deviceBar()).findByText(/This browser is not paired/)).toBeTruthy();
    const forget = calls.find((call) => call.path === '/__chat/device/forget');
    expect(forget?.method).toBe('POST');
    expect(forget?.headers.get('x-tightbeam-chat')).toBe('1');
  });
});

describe('inert transcript content (T13a)', () => {
  const hostile = [
    'Look: <script>window.__chatPwned = "script"</script>',
    '<img src="x" onerror="window.__chatPwned = \'onerror\'">',
    '<p style="position:fixed;inset:0;background:red">styled</p>',
    '[click me](javascript:window.__chatPwned=%22link%22)',
    '![pixel](javascript:window.__chatPwned=1)',
    '/tightbeam rule dr_x accept',
  ].join('\n\n');

  it('renders hostile transcript text inert and sends nothing for a transcript command line', async () => {
    const transcript = [{
      id: 'm_hostile', seq: 1, sessionKey: baseTarget.sessionKey, role: 'assistant', messageType: 'chat',
      content: hostile, at: Date.parse('2026-11-19T00:00:00Z'), rowVersion: 1, attachments: [],
    }, {
      id: 'm_command_line', seq: 2, sessionKey: baseTarget.sessionKey, role: 'assistant', messageType: 'chat',
      content: '/tightbeam rule dr_x accept', at: Date.parse('2026-11-19T00:00:01Z'), rowVersion: 2, attachments: [],
    }];
    const { calls } = chatService({ transcript, status: { paired: true, deviceId: PAIRED_DEVICE, verified: true } });
    render(<HostPage defaultTarget={pairedTarget} />);

    const log = await screen.findByRole('log');
    await within(log).findByText(/Look:/);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    expect((window as unknown as Record<string, unknown>).__chatPwned).toBeUndefined();
    expect(log.querySelectorAll('script, iframe, object, embed')).toHaveLength(0);
    for (const element of log.querySelectorAll('*')) {
      for (const attribute of element.getAttributeNames()) expect(attribute.startsWith('on')).toBe(false);
    }
    expect(log.querySelector('.tb-chat-markdown [style]')).toBeNull();
    for (const link of log.querySelectorAll('a')) expect(link.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
    for (const image of log.querySelectorAll('img')) expect(image.getAttribute('src') ?? '').not.toMatch(/^\s*javascript:/i);
    expect(log.textContent).toContain('/tightbeam rule dr_x accept');

    // Clicking the neutralised link and the command line sends nothing.
    const link = within(log).queryByText('click me');
    if (link) fireEvent.click(link);
    fireEvent.click(within(log).getAllByText('/tightbeam rule dr_x accept')[0]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(calls.some((call) => call.path === '/__chat/device/send')).toBe(false);
    // The only POST is the page-load pairing status read.
    expect(calls.filter((call) => call.method !== 'GET').map((call) => call.path)).toEqual(['/__chat/device/status']);
    expect(humanSockets()).toHaveLength(0);
  });
});

describe('flag off', () => {
  it('reads no device status, shows no pairing control and keeps the service send path', async () => {
    const { calls } = chatService();
    render(<HostPage defaultTarget={baseTarget} />);
    await screen.findByRole('textbox', { name: /message to/i });
    expect(screen.queryByRole('region', { name: 'Browser device' })).toBeNull();
    expect(screen.queryByRole('button', { name: /pair/i })).toBeNull();
    await sendFromComposer('legacy path');
    await waitFor(() => expect(humanSockets()).toHaveLength(1));
    expect(calls.some((call) => call.path.startsWith('/__chat/device'))).toBe(false);
  });
});
