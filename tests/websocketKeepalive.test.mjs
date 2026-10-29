import { afterEach, describe, expect, it, vi } from 'vitest';
import { startChangesFeedKeepalive } from '../server/chat-server.mjs';

afterEach(() => vi.useRealTimers());

describe('changes-feed keepalive', () => {
  it('sends a masked empty control ping every 30 seconds and stops with the connection', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const frames = [];
    const remote = {
      destroyed: false,
      writable: true,
      write: vi.fn((frame) => { frames.push(frame); return true; }),
    };
    const stop = startChangesFeedKeepalive({ kind: 'changes' }, remote);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toHaveLength(1);
    expect(frames[0][0] & 0x0f).toBe(9);
    expect(frames[0][0] & 0x80).toBe(0x80);
    expect(frames[0][1] & 0x80).toBe(0x80);
    expect(frames[0][1] & 0x7f).toBe(0);
    expect(frames[0]).toHaveLength(6);

    remote.writable = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(frames).toHaveLength(1);
    remote.writable = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(frames).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(frames).toHaveLength(2);
  });

  it('does not create a keepalive for the human-send socket', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const remote = { destroyed: false, writable: true, write: vi.fn() };
    const stop = startChangesFeedKeepalive({ kind: 'human' }, remote);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(remote.write).not.toHaveBeenCalled();
    stop();
  });
});
