import crypto from 'node:crypto';

const CHANGE_FEED_KEEPALIVE_INTERVAL_MS = 30_000;

function websocketClientPingFrame() {
  const mask = crypto.randomBytes(4);
  return Buffer.from([0x89, 0x80, ...mask]);
}

export function startChangesFeedKeepalive(target, remote) {
  if (target.kind !== 'changes') return () => {};

  const keepalive = setInterval(() => {
    if (!remote.destroyed && remote.writable) remote.write(websocketClientPingFrame());
  }, CHANGE_FEED_KEEPALIVE_INTERVAL_MS);
  keepalive.unref?.();
  return () => clearInterval(keepalive);
}
