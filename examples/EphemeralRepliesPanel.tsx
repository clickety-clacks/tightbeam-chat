import type { EphemeralReply } from './devicePairing';

export type ShownEphemeralReply =
  | (EphemeralReply & { readonly key: number; readonly kind: 'reply' })
  | { readonly key: number; readonly kind: 'cut-short'; readonly sessionKey: string; readonly clientMessageId: string };

export const CUT_SHORT_NOTICE = "This command's reply may have been cut short. " +
  'If you expected a code or secret and none is shown, run the command again.';

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
    {replies.map((reply) => reply.kind === 'reply'
      ? <div className="chat-ephemeral-reply" key={reply.key}>
        <p className="chat-ephemeral-warning">Shown only here, only now — write it down.</p>
        <pre className="chat-ephemeral-content">{reply.content}</pre>
        <button type="button" onClick={() => onDismiss(reply.key)}>Dismiss</button>
      </div>
      : <div className="chat-ephemeral-reply" key={reply.key} data-ephemeral-notice="cut-short">
        <p role="status">{CUT_SHORT_NOTICE}</p>
        <button type="button" onClick={() => onDismiss(reply.key)}>Dismiss</button>
      </div>)}
  </section>;
}
