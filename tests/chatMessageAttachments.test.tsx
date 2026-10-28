import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TightbeamChat } from '../src/TightbeamChat';
import type { CanonicalMessage, ChatRuntime, RuntimeState, TightbeamAdapter } from '../src/types';

afterEach(cleanup);

class AttachmentRuntime implements ChatRuntime {
  private readonly listeners = new Set<() => void>();
  private readonly snapshot: RuntimeState;

  constructor(records: readonly CanonicalMessage[]) {
    this.snapshot = {
      sessionKey: 'image-transcript', principalKey: 'person', generation: 1, status: 'ready',
      records, provenance: [], provenanceAvailable: false, hasOlder: false, loadingOlder: false,
      sends: [], targetLabel: 'Fixture',
      session: { sessionKey: 'image-transcript', rowVersion: 1, displayName: 'Research assistant',
        model: 'Model A', harness: 'Harness A', raw: { ownerUserId: 'person' } },
    };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  loadOlder = async () => {};
  send = () => 'fixture-send';
  retrySend = async () => {};
  observeHostSend = () => () => {};
  refreshHostSend = async () => 'absent' as const;
  retryHostSend = () => {};
  recordHostSendOutcome = () => {};
  markHostSendUncertain = () => {};
  rebuild = async () => {};
  dispose = () => this.listeners.clear();
}

function row(id: string, role: 'user' | 'assistant', sender: string, content: string,
  attachments: readonly unknown[], extra: Partial<CanonicalMessage> = {}): CanonicalMessage {
  return {
    kind: 'message', id, sessionKey: 'image-transcript', seq: role === 'user' ? 1 : 2,
    rowVersion: 1, role, sender, messageType: role === 'user' ? 'chat' : 'assistant', content,
    createdAt: '2026-10-28T12:00:00.000Z', attachments, raw: { id }, ...extra,
  };
}

describe('transcript image attachments', () => {
  it('renders inline image attachments on both human and agent messages', () => {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFqkAAAAASUVORK5CYII=';
    const human = row('human', 'user', 'user:person', 'Here is a photo', [
      { mimeType: 'image/png', filename: 'human.png', data },
    ]);
    const agent = row('agent', 'assistant', 'assistant-service', 'I can see it', [
      { mediaType: 'image/png', filename: 'agent.png', data },
    ], { replyToMessageId: human.id, turnSeq: 7 });
    const runtime = new AttachmentRuntime([human, agent]);
    const adapter: TightbeamAdapter = { open: () => runtime };

    render(<TightbeamChat sessionKey="image-transcript" adapter={adapter} />);

    expect(screen.getByRole('img', { name: 'Image: human.png' }).getAttribute('src'))
      .toBe(`data:image/png;base64,${data}`);
    expect(screen.getByRole('img', { name: 'Image: agent.png' }).getAttribute('src'))
      .toBe(`data:image/png;base64,${data}`);
  });
});
