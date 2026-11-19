// A fake Tightbeam Gateway speaking the stage-2 device wire contract (W1, W2, W5):
// coded pairing, device auth with one live socket per deviceId (takeover),
// replay before sync_complete, message ack/error and /tightbeam command frames.
import crypto from 'node:crypto';
import http from 'node:http';

/** The ephemeral replies (proposed W7) for /tightbeam recovery-enroll and approve-device. */
export const FAKE_RECOVERY_SECRET = 'TBR-7K3MQ-9ZD2W-H8XAP-4RN6T';
export const FAKE_ISSUED_CODE = 'TB-9QXR-T4MB-K2WD';

function serverFrame(opcode, payload) {
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function takeClientFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { opcode, payload, rest: buffer.subarray(offset + length) };
}

function historyReply(url, history) {
  const path = url.pathname;
  const session = `/api/sessions/${encodeURIComponent(history.sessionKey)}`;
  if (path === '/version') return { version: '0.1.16' };
  if (path === session) {
    return { schemaVersion: 1, resource: 'sessions', item: { sessionKey: history.sessionKey, rowVersion: 1,
      displayName: 'Main', ownerUserId: history.userId } };
  }
  if (path === `${session}/messages`) {
    return { schemaVersion: 1, resource: 'transcript messages', items: url.searchParams.has('after') ? [] : history.messages ?? [],
      page: { oldestCursor: null, newestCursor: null, hasMoreBefore: false, hasMoreAfter: false } };
  }
  if (path === `${session}/tool-calls`) return { schemaVersion: 1, resource: 'tool calls', items: [], page: { hasMoreBefore: false } };
  return undefined;
}

/** The protocol-2 change feed: provisioned auth, then subscription_ready for every subscribe. */
function changesSocket(request, socket, history) {
  const accept = crypto.createHash('sha1')
    .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = (value) => socket.write(serverFrame(1, Buffer.from(JSON.stringify(value))));
  socket.on('error', () => {});
  let bytes = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    for (let frame = takeClientFrame(bytes); frame; frame = takeClientFrame(bytes)) {
      bytes = frame.rest;
      if (frame.opcode === 8) { socket.end(serverFrame(8, Buffer.from([0x03, 0xe8]))); return; }
      if (frame.opcode === 9) { socket.write(serverFrame(10, frame.payload)); continue; }
      if (frame.opcode !== 1) continue;
      let value;
      try { value = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
      if (value.type === 'auth') send({ type: 'auth_result', success: true, userId: history.userId, sessionKey: value.sessionKey });
      else if (value.type === 'subscribe') send({ type: 'subscription_ready', subscriptionId: value.subscriptionId });
    }
  });
}

/**
 * Starts the fake Gateway. Options:
 * - pairReply(frame, state): returns the reply frame for a pair_request (default: success)
 * - ackDelayMs: delay before a message ack
 * - replay: frames pushed between auth_result and sync_complete
 * - messageError(frame): returns an error frame to send instead of an ack
 * - ephemeralDelayMs: delay before the ephemeral reply to recovery-enroll / approve-device
 * - ephemeralBeforeAck: send that ephemeral reply first, before the ack
 * - ephemeralSessionKey: the session key the ephemeral reply names (W7: the socket's)
 * - history: { sessionKey, userId, messages } serves the read API and /ws/changes the
 *   Chat page loads through its provisioned (organization) credential
 */
export async function startFakeDeviceGateway(options = {}) {
  const state = {
    upgrades: [],
    httpRequests: [],
    rawPairTexts: [],
    clientFrames: [],
    devices: new Map(),
    live: new Map(),
    recorded: new Map(),
    takeovers: 0,
  };
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    state.httpRequests.push({ method: request.method, url: request.url });
    const reply = options.history && historyReply(new URL(request.url, 'http://gateway.invalid'), options.history);
    if (reply) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":"not_found"}}');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const defaultPairReply = (frame) => {
    const token = `tbt_${crypto.randomBytes(24).toString('hex')}`;
    // Stage 1 has no device scopes: no scope field.
    state.devices.set(token, { deviceId: frame.deviceId, userId: 'george' });
    return { type: 'pair_result', success: true, token, userId: 'george' };
  };

  server.on('upgrade', (request, socket) => {
    state.upgrades.push({ path: request.url, origin: request.headers.origin });
    if (options.history && request.url.startsWith('/ws/changes')) {
      changesSocket(request, socket, options.history);
      return;
    }
    if (request.url !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const connection = { socket, deviceId: undefined, replaced: false, closed: false };
    const send = (value) => { if (!connection.closed) socket.write(serverFrame(1, Buffer.from(JSON.stringify(value)))); };
    const close = () => {
      if (connection.closed) return;
      connection.closed = true;
      socket.end(serverFrame(8, Buffer.from([0x03, 0xe8])));
    };
    socket.on('close', () => {
      connection.closed = true;
      if (connection.deviceId && state.live.get(connection.deviceId) === connection) state.live.delete(connection.deviceId);
    });
    socket.on('error', () => {});

    const onText = (text) => {
      let frame;
      try { frame = JSON.parse(text); } catch { return; }
      state.clientFrames.push(frame);
      if (frame.type === 'pair_request') {
        state.rawPairTexts.push(text);
        send((options.pairReply ?? defaultPairReply)(frame, state) ?? defaultPairReply(frame));
        close();
        return;
      }
      if (frame.type === 'auth') {
        const device = state.devices.get(frame.token);
        if (!device || device.deviceId !== frame.deviceId) {
          send({ type: 'auth_result', success: false, reason: 'auth_failed' });
          close();
          return;
        }
        if (device.dead) {
          send({ type: 'auth_result', success: false, reason: device.dead });
          close();
          return;
        }
        const previous = state.live.get(device.deviceId);
        if (previous && !previous.closed) {
          state.takeovers += 1;
          previous.replaced = true;
          previous.socket.write(serverFrame(1, Buffer.from(JSON.stringify({ type: 'error', code: 'session_replaced' }))));
          previous.closed = true;
          previous.socket.end(serverFrame(8, Buffer.from([0x0f, 0xa0])));
        }
        connection.deviceId = device.deviceId;
        state.live.set(device.deviceId, connection);
        send({ type: 'auth_result', success: true, userId: device.userId, deviceId: device.deviceId,
          ...(device.scope ? { scope: device.scope } : {}), sessionId: `conn_${device.deviceId}` });
        for (const replayed of options.replay ?? []) send(replayed);
        send({ type: 'sync_complete' });
        return;
      }
      if (frame.type === 'message') {
        if (!connection.deviceId) { send({ type: 'error', code: 'not_authenticated' }); return; }
        const refusal = options.messageError?.(frame);
        if (refusal) { send(refusal); return; }
        const duplicate = state.recorded.has(frame.id);
        if (!duplicate) state.recorded.set(frame.id, { ...frame, deviceId: connection.deviceId });
        const messageId = `m_${[...state.recorded.keys()].indexOf(frame.id) + 1}`;
        const ephemeral = frame.content === '/tightbeam recovery-enroll'
          ? `Recovery secret ${FAKE_RECOVERY_SECRET}. It is shown only this once.`
          : frame.content === '/tightbeam approve-device'
            ? `Pairing code ${FAKE_ISSUED_CODE}, valid 10 minutes.` : undefined;
        const sendEphemeral = () => send({ type: 'message', ephemeral: true, id: `e_${frame.id}`, timestamp: Date.now(),
          role: 'assistant', sessionKey: options.ephemeralSessionKey ?? frame.sessionKey, replyToClientMessageId: frame.id, content: ephemeral });
        if (ephemeral && options.ephemeralBeforeAck) sendEphemeral();
        setTimeout(() => {
          if (connection.closed || connection.replaced) return;
          send({ type: 'ack', id: frame.id, messageId, ...(duplicate ? { duplicate: true } : {}) });
          if (frame.content.startsWith('/tightbeam')) {
            send({ type: 'message', sessionKey: frame.sessionKey, role: 'user', content: frame.content });
            send({ type: 'message', sessionKey: frame.sessionKey, role: 'system', content: `outcome for ${frame.content}` });
            if (ephemeral && !options.ephemeralBeforeAck) setTimeout(sendEphemeral, options.ephemeralDelayMs ?? 0);
          }
        }, options.ackDelayMs ?? 0);
      }
    };

    let bytes = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      for (let frame = takeClientFrame(bytes); frame; frame = takeClientFrame(bytes)) {
        bytes = frame.rest;
        if (frame.opcode === 1) onText(frame.payload.toString('utf8'));
        else if (frame.opcode === 8) close();
        else if (frame.opcode === 9) socket.write(serverFrame(10, frame.payload));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    port: server.address().port,
    state,
    /** Marks every token for a device dead with a W2 failure reason. */
    kill(deviceId, reason = 'token_revoked') {
      for (const device of state.devices.values()) if (device.deviceId === deviceId) device.dead = reason;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
