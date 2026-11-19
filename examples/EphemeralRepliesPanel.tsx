import type { EphemeralReply } from './devicePairing';

export interface ShownEphemeralReply extends EphemeralReply {
  readonly key: number;
}

/**
 * A recovery secret or pairing code returned only to this page. It is held in
 * React state alone: never in storage, never in the conversation, gone on reload.
 */
export function EphemeralRepliesPanel({ replies, onDismiss }: {
  readonly replies: readonly ShownEphemeralReply[];
  readonly onDismiss: (key: number) => void;
}) {
  if (!replies.length) return null;
  return <section className="chat-ephemeral-panel" aria-label="Shown only here">
    {replies.map((reply) => <div className="chat-ephemeral-reply" key={reply.key}>
      <p className="chat-ephemeral-warning">Shown only here, only now — write it down.</p>
      <pre className="chat-ephemeral-content">{reply.content}</pre>
      <button type="button" onClick={() => onDismiss(reply.key)}>Dismiss</button>
    </div>)}
  </section>;
}
