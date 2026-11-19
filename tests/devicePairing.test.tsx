// Spec stage2-v5 §C1/§C1a, tests T13 and T13a (browser side, jsdom), both flag states.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HostPage } from '../examples/HostPage';
import { browserHost } from '../examples/browserHost';
import { ephemeralCommandReplies, newBrowserDeviceId, pairingClaimedName } from '../examples/devicePairing';
import { splitNameAndCode } from '../examples/DevicePairingBar';

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
  pair = (_body: unknown) => json({ success: true, userId: 'george', deviceId: PAIRED_DEVICE, signedIn: true }),
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
  vi.restoreAllMocks();
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
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'TB-ABCD-EFGH-JKLM' } });
    fireEvent.click(within(deviceBar()).getByRole('button', { name: 'Pair' }));

    const status = await within(deviceBar()).findByText(/^Paired\. This browser is its own device/);
    // Stage 1 has no scopes: nothing about a scope is assumed or shown.
    expect(status.textContent).not.toMatch(/\(|decide|full/);
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
    fireEvent.change(screen.getByLabelText('Name for this browser'), { target: { value: 'Duo' } });
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'TB-ABCD-EFGH-JKLM' } });
    fireEvent.click(within(deviceBar()).getByRole('button', { name: 'Pair' }));

    const alert = await within(deviceBar()).findByRole('alert');
    expect(alert.textContent).toMatch(text);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.path === '/__chat/device/pair')).toHaveLength(1);
    expect(within(deviceBar()).getByText(/This browser is not paired/)).toBeTruthy();
  });

  it('accepts "<name> <code>" typed in the name box, as the install note says', async () => {
    const { calls } = chatService();
    render(<HostPage defaultTarget={pairedTarget} />);
    fireEvent.click(await within(deviceBar()).findByRole('button', { name: 'Pair this browser' }));
    fireEvent.change(screen.getByLabelText('Name for this browser'), { target: { value: 'Duo TB-4KQ7-H2WX-9DNM ' } });
    fireEvent.click(within(deviceBar()).getByRole('button', { name: 'Pair' }));
    expect(await within(deviceBar()).findByText(/^Paired\./)).toBeTruthy();
    const pairCall = calls.find((call) => call.path === '/__chat/device/pair');
    expect((pairCall?.body as { claimedName: string }).claimedName).toBe('Duo TB-4KQ7-H2WX-9DNM');
  });

  it('splits a trailing code from the name only when the code box is empty', () => {
    expect(splitNameAndCode('Duo TB-4KQ7-H2WX-9DNM', '')).toEqual({ name: 'Duo', code: 'TB-4KQ7-H2WX-9DNM' });
    expect(splitNameAndCode(' My iPhone  tb-4kq7-h2wx-9dnm ', '')).toEqual({ name: 'My iPhone', code: 'tb-4kq7-h2wx-9dnm' });
    expect(splitNameAndCode('Duo', ' TB-AAAA-BBBB-CCCC ')).toEqual({ name: 'Duo', code: 'TB-AAAA-BBBB-CCCC' });
    expect(splitNameAndCode('TB-4KQ7-H2WX-9DNM', '')).toEqual({ name: 'TB-4KQ7-H2WX-9DNM', code: '' });
    expect(splitNameAndCode('Duo TB-4KQ7-H2WX', '')).toEqual({ name: 'Duo TB-4KQ7-H2WX', code: '' });
  });

  it('shows no product name in its pairing guidance', async () => {
    chatService({ status: { paired: false, reason: 'token_revoked' } });
    render(<HostPage defaultTarget={pairedTarget} />);
    fireEvent.click(await within(deviceBar()).findByRole('button', { name: 'Pair this browser' }));
    fireEvent.change(screen.getByLabelText('Name for this browser'), { target: { value: 'Duo' } });
    fireEvent.click(within(deviceBar()).getByRole('button', { name: 'Pair' }));
    await within(deviceBar()).findByText(/Enter the pairing code/);
    expect(deviceBar().textContent).toContain('/tightbeam approve-device from a paired device, or the root pairing code on Sirius');
    expect(deviceBar().textContent).not.toMatch(/Clawline/);
  });

  it('checks the form before anything is sent', async () => {
    const { calls } = chatService();
    render(<HostPage defaultTarget={pairedTarget} />);
    fireEvent.click(await within(deviceBar()).findByRole('button', { name: 'Pair this browser' }));
    fireEvent.click(within(deviceBar()).getByRole('button', { name: 'Pair' }));
    expect((await within(deviceBar()).findByRole('alert')).textContent).toContain('Enter a name');
    fireEvent.change(screen.getByLabelText('Name for this browser'), { target: { value: 'Duo' } });
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
    const { calls } = chatService({ status: { paired: true, deviceId: PAIRED_DEVICE, verified: true } });
    render(<HostPage defaultTarget={{ ...pairedTarget, ...(rest ? { restHumanSendEnabled: true } : {}) }} />);
    expect(await within(deviceBar()).findByText(/^Paired\./)).toBeTruthy();

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
    await within(deviceBar()).findByText(/^Paired\./);
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
    await within(deviceBar()).findByText(/^Paired\./);
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

describe('ephemeral recovery secret and pairing code (S6.4, P13)', () => {
  const SECRET = 'TBR-7K3MQ-9ZD2W-H8XAP-4RN6T';
  const commandReply = (body: Record<string, unknown>) => json({
    outcome: 'accepted', complete: true, ack: { type: 'ack', id: body.id, messageId: 'm_enroll' },
    messages: [
      { type: 'message', seq: 41, sessionKey: baseTarget.sessionKey, role: 'user', content: body.content },
      { type: 'message', seq: 42, sessionKey: baseTarget.sessionKey, role: 'system', content: 'Recovery secret issued.' },
      { type: 'message', sessionKey: baseTarget.sessionKey, role: 'assistant', content: 'not ephemeral, transcript only' },
      { type: 'message', ephemeral: true, role: 'assistant', sessionKey: baseTarget.sessionKey,
        replyToClientMessageId: 'c_some_other_send', content: 'belongs to another send' },
      { type: 'message', ephemeral: true, role: 'assistant', sessionKey: baseTarget.sessionKey,
        replyToClientMessageId: body.id, content: `Recovery secret ${SECRET}. It is shown only this once.` },
    ],
  });

  it('matches only W7 ephemeral frames for the sending command, in one function', () => {
    const submission = { sessionKey: 's', clientMessageId: 'c_1' };
    expect(ephemeralCommandReplies([
      { type: 'message', ephemeral: true, sessionKey: 's', replyToClientMessageId: 'c_1', content: 'yes' },
      { type: 'message', ephemeral: true, sessionKey: 's', replyToClientMessageId: 'c_2', content: 'other send' },
      { type: 'message', ephemeral: true, sessionKey: 'other', replyToClientMessageId: 'c_1', content: 'other session' },
      { type: 'message', ephemeral: true, seq: 3, sessionKey: 's', content: 'persisted' },
      { type: 'message', ephemeral: 'true', sessionKey: 's', content: 'not boolean' },
      { type: 'message', sessionKey: 's', content: 'ordinary' },
      'garbage',
    ], submission)).toEqual([{ sessionKey: 's', clientMessageId: 'c_1', content: 'yes' }]);
    expect(ephemeralCommandReplies(undefined, submission)).toEqual([]);
  });

  it('shows the secret only in this page, as inert text, never stored, gone on reload', async () => {
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    }
    window.localStorage.clear();
    window.sessionStorage.clear();
    chatService({ status: { paired: true, deviceId: PAIRED_DEVICE, verified: true }, send: commandReply });
    const first = render(<HostPage defaultTarget={pairedTarget} />);
    await within(deviceBar()).findByText(/^Paired\./);
    await sendFromComposer('/tightbeam recovery-enroll');

    const panel = await screen.findByRole('region', { name: 'Shown only here' });
    expect(panel.textContent).toContain('Shown only here, only now — write it down');
    expect(panel.querySelector('pre')?.textContent).toBe(`Recovery secret ${SECRET}. It is shown only this once.`);
    expect(panel.textContent).not.toContain('belongs to another send');
    expect(panel.textContent).not.toContain('not ephemeral');
    // Not in the conversation transcript, storage, or logs.
    expect(screen.getByRole('log').textContent).not.toContain(SECRET);
    const stored = [window.localStorage, window.sessionStorage].flatMap((storage) =>
      Array.from({ length: storage.length }, (_, index) => `${storage.key(index)}=${storage.getItem(storage.key(index)!)}`));
    expect(stored.join('\n')).not.toContain(SECRET);
    expect(logged.join('\n')).not.toContain(SECRET);

    fireEvent.click(within(panel).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Shown only here' })).toBeNull();

    await sendFromComposer('/tightbeam approve-device');
    await screen.findByRole('region', { name: 'Shown only here' });
    first.unmount();
    // A reload, or another tab, has no copy.
    render(<HostPage defaultTarget={pairedTarget} />);
    await within(deviceBar()).findByText(/^Paired\./);
    expect(screen.queryByRole('region', { name: 'Shown only here' })).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it.each([
    ['a cut-short command with no ephemeral reply', '/tightbeam recovery-enroll', false, false, true],
    ['a cut-short command whose secret did arrive', '/tightbeam recovery-enroll', false, true, false],
    ['a complete command with no ephemeral reply', '/tightbeam status', true, false, false],
    ['a cut-short ordinary message', 'hello', false, false, false],
  ])('cut-short notice for %s', async (_name, content, complete, withSecret, expectNotice) => {
    const notice = "This command's reply may have been cut short. If you expected a code or secret and none is shown, run the command again.";
    chatService({ status: { paired: true, deviceId: PAIRED_DEVICE, verified: true },
      send: (body) => json({ outcome: 'accepted', complete, ack: { type: 'ack', id: body.id },
        messages: [
          { type: 'message', seq: 7, sessionKey: baseTarget.sessionKey, role: 'user', content: body.content },
          ...(withSecret ? [{ type: 'message', ephemeral: true, role: 'assistant', sessionKey: baseTarget.sessionKey,
            replyToClientMessageId: body.id, content: `Recovery secret ${SECRET}.` }] : []),
        ] }) });
    window.localStorage.clear();
    window.sessionStorage.clear();
    const first = render(<HostPage defaultTarget={pairedTarget} />);
    await within(deviceBar()).findByText(/^Paired\./);
    await sendFromComposer(content);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    const panel = screen.queryByRole('region', { name: 'Shown only here' });
    if (!expectNotice) {
      expect(panel?.textContent ?? '').not.toContain('cut short');
      return;
    }
    expect(panel).not.toBeNull();
    expect(within(panel!).getByRole('status').textContent).toBe(notice);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    fireEvent.click(within(panel!).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Shown only here' })).toBeNull();
    // Memory only: a reload (here into another conversation) has no notice.
    await sendFromComposer(content);
    await screen.findByRole('region', { name: 'Shown only here' });
    first.unmount();
    window.history.replaceState({}, '', `/?${new URLSearchParams({ gateway: baseTarget.gateway, session: 'agent:main:other' })}`);
    render(<HostPage defaultTarget={pairedTarget} />);
    await within(deviceBar()).findByText(/^Paired\./);
    expect(screen.queryByRole('region', { name: 'Shown only here' })).toBeNull();
  });

  it('shows nothing when an accepted send has no ephemeral reply', async () => {
    chatService({ status: { paired: true, deviceId: PAIRED_DEVICE, verified: true },
      send: (body) => json({ outcome: 'accepted', ack: { type: 'ack', id: body.id } }) });
    render(<HostPage defaultTarget={pairedTarget} />);
    await within(deviceBar()).findByText(/^Paired\./);
    await sendFromComposer('hello');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.queryByRole('region', { name: 'Shown only here' })).toBeNull();
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
