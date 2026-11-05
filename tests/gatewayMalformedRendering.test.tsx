import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { TightbeamChat } from '../src/TightbeamChat';
import { createPublic019Transport, type Public019Channel, type Public019Host } from '../src/public019';
import { createTightbeamAdapter } from '../src/runtime';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

class ReadyChannel implements Public019Channel {
  private onFrame?: (frame: unknown) => void;
  send(frame: Readonly<Record<string, unknown>>) {
    if (frame.type === 'subscribe') {
      queueMicrotask(() => this.onFrame?.({ type: 'subscription_ready', subscriptionId: frame.subscriptionId }));
    }
  }
  listen(onFrame: (frame: unknown) => void) {
    this.onFrame = onFrame;
    return () => { this.onFrame = undefined; };
  }
  close() { this.onFrame = undefined; }
}

describe('malformed Gateway history rendering', () => {
  it('renders a usable message beside a row that cannot be placed', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sessionKey = 'fixture-session';
    const host: Public019Host = {
      currentIdentity: () => ({ principalKey: 'fixture', deviceId: 'fixture' }),
      fetch: async input => {
        const url = new URL(input);
        if (url.pathname.endsWith('/messages')) {
          return new Response(JSON.stringify({ schemaVersion: 1, resource: 'transcript messages',
            items: [
              { id: 'm_unusable', seq: 0, rowVersion: 1, sessionKey, role: 'assistant',
                content: 'This row has no usable position.', at: 1793779200000, attachments: [] },
              { id: 'm_readable', seq: 9, rowVersion: 1, sessionKey, role: 'user',
                sender: 'user:fixture', content: 'This usable message still renders.', at: 1793779201000, attachments: [] },
            ], page: { oldestCursor: null, newestCursor: 'newest', hasMoreBefore: false, hasMoreAfter: false } }));
        }
        if (url.pathname === `/api/sessions/${sessionKey}`) {
          return new Response(JSON.stringify({ schemaVersion: 1, resource: 'sessions', item: {
            sessionKey, rowVersion: 1, displayName: 'Fixture assistant', state: 'idle',
          } }));
        }
        if (url.pathname.endsWith('/record-events')) {
          return new Response(JSON.stringify({ schemaVersion: 1, resource: 'record events', items: [],
            page: { oldestCursor: null, hasMoreBefore: false } }));
        }
        if (url.pathname.endsWith('/tool-calls')) {
          return new Response(JSON.stringify({ schemaVersion: 1, resource: 'tool calls', items: [],
            page: { oldestCursor: null, hasMoreBefore: false } }));
        }
        return new Response('{}', { status: 404 });
      },
      openAuthenticatedChanges: async () => new ReadyChannel(),
      openAuthenticatedHuman: async () => new ReadyChannel(),
    };
    const { transport, profile } = createPublic019Transport({ baseUrl: 'https://gateway.example', host });
    const adapter = createTightbeamAdapter(transport, profile);
    const runtime = adapter.open(sessionKey);

    render(<TightbeamChat sessionKey={sessionKey} adapter={{ open: () => runtime }} />);

    await waitFor(() => expect(runtime.getSnapshot().records.map(record => record.id)).toEqual(['m_readable']));
    expect(await screen.findByText('This usable message still renders.')).toBeTruthy();
    expect(screen.queryByText('This row has no usable position.')).toBeNull();
    expect(log).toHaveBeenCalledWith('[Chat] Gateway data incompatibility',
      expect.objectContaining({ site: 'transcript history item' }));
  });
});
