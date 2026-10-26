# Host-supplied composer protocol

Version 1 lets an embedding host provide the message composer while Chat renders one selected conversation. The API is page-local and text-only. The host owns the draft and all host-side retry decisions; Chat keeps send state in the current page lifetime only.

The public names are fixed in V1:

- declaration: `window.__TIGHTBEAM_CHAT_HOST__`;
- command entry: `window.__TIGHTBEAM_CHAT_COMMAND__`.

Set the declaration in the top-level Chat page before the Chat component starts:

```ts
window.__TIGHTBEAM_CHAT_HOST__ = {
  versions: [1],
  onEvent(event) {
    // Retain the latest ready lifetime and selected session.
  },
};
```

If versions do not overlap or the declaration is malformed, Chat calls `onEvent` once with `declined` when a callable handler was supplied, then behaves as standalone Chat. With no declaration, Chat does not install a command entry. An older Chat release that does not know the declaration leaves its HTML composer in place; a host must keep its own composer hidden unless it receives `ready`.

## Ready and lifetime messages

After the selected-session subscription is established and canonical history has caught up, Chat emits:

```ts
{
  event: 'ready',
  version: 1,
  lifetimeId: 'opaque-per-runtime-value',
  sessionKey: 'selected-session-key',
  gatewayOrigin: 'https://gateway.example',
  agentDisplayName: 'Selected agent',
  capabilities: { text: true },
}
```

Those are the six ready fields: `version`, `lifetimeId`, `sessionKey`, `gatewayOrigin`, `agentDisplayName`, and `capabilities`. The event also has its `event` discriminator. No attachment capability is present in V1. No credential, token or device secret is included; model and harness details are omitted while opted in.

Chat sends these lifetime events:

```ts
{ event: 'declined', reason: 'unsupported-version' | 'malformed-declaration' }
{ event: 'unavailable', version: 1, lifetimeId, reason }
{ event: 'overlay', version: 1, lifetimeId, open }
{ event: 'lifetime-ended', version: 1, lifetimeId,
  reason: 'target-changed' | 'identity-changed' | 'disposed' | 'unloading' }
```

The HTML composer stays visible until the page's first `ready`. After Chat hides it, it stays hidden for every later lifetime in that page load. `unavailable` disables host Send only when Chat has an actual reason that a send cannot be accepted; a later `ready` re-enables it for the same lifetime when sending can be attempted again. A target or identity change ends the lifetime, and the next `ready` uses a new lifetime ID. A page reload needs a new declaration and a new `ready` before Chat hides the HTML composer again.

`ready` means Chat can accept a host send command for the selected lifetime; it does not promise that the Gateway will accept every message. A live-change-feed disconnect or reconnect by itself does not make host sending unavailable: Chat keeps the same lifetime ready, emits no `unavailable` event for that feed change, and accepts sends while authorized. A missing selected session, loss of authorization, or an actual send-endpoint refusal does make sending unavailable. For a refused send, Chat reports the attempt as `failed/refused` with its endpoint detail, then emits `unavailable` with reason `send-refused`. A command received before sending is ready is rejected as `not-ready` and posts nothing. Once Chat can accept commands again, it emits `ready` for that lifetime; feed-only reconnects do not create an unavailable/ready cycle.

## Send command and attempt messages

The host calls the command entry only after a user action. A new message uses `c_` plus a UUIDv4 correlation ID:

```ts
window.__TIGHTBEAM_CHAT_COMMAND__({
  type: 'send',
  lifetimeId: latestReady.lifetimeId,
  sessionKey: latestReady.sessionKey,
  correlationId: `c_${crypto.randomUUID()}`,
  content: draft,
});
```

For a user retry of a failed or uncertain logical message, retain its exact content and correlation, then call:

```ts
window.__TIGHTBEAM_CHAT_COMMAND__({
  type: 'send', lifetimeId, sessionKey, correlationId, content, retry: true,
});
```

Chat numbers attempts per `(lifetimeId, correlationId)`, beginning at 1. A retry is accepted only after the previous attempt settled `failed` or `uncertain`; its content must match the first attempt byte for byte. A new page lifetime starts numbering at 1 again. On page reload, a host-held correlation may be retried after fresh readiness. After app restart, if the correlation was lost, a retained draft is sent only on a new user action with a new correlation and no retry flag. It may produce a second canonical row; the host presents it as a new user-initiated send.

Chat recognizes a Settings command when the text, after trimming leading and trailing whitespace, is exactly `/settings` with the same letter case. It opens Settings without posting a message and answers with `rejected` using reason `local-command`. This check runs before readiness, target, correlation and send-attempt checks, and it records no attempt. Other slash-prefixed text is sent unchanged.

Each attempt event carries `lifetimeId`, `correlationId`, and `attempt`:

```ts
{ event: 'accepted', lifetimeId, correlationId, attempt }
{ event: 'delivered', lifetimeId, correlationId, attempt }
{ event: 'failed', lifetimeId, correlationId, attempt,
  reason: 'refused' | 'retry-unavailable', detail? }
{ event: 'uncertain', lifetimeId, correlationId, attempt,
  reason: 'ack-lost' | 'accepted-unreconciled' | 'lifetime-ended' }
{ event: 'rejected', lifetimeId, correlationId,
  reason: 'local-command' | 'not-ready' | 'target-mismatch' | 'invalid-correlation' | 'empty' |
    'attempt-in-flight' | 'already-delivered' | 'correlation-conflict' }
```

`accepted` is a non-terminal Gateway acknowledgement. `delivered` is emitted only after Chat reconciles a canonical row for the selected session, device and correlation. It does not mean the agent read, started or answered a turn. Each attempt has at most one terminal event: `delivered`, `failed`, or `uncertain`. A typed Gateway refusal becomes `failed/refused`, with the Gateway code in `detail`; this is the only terminal delivery-failure outcome. `retry-unavailable` reports that a user-requested retry did not submit another frame; it does not turn an earlier ambiguous delivery into a failure. If a human send socket drops before acknowledgement, Chat paces a reconnect and repeats the exact same submission with the same client ID when the selected profile advertises the existing Gateway deduplication capability. A failed reconnect does not settle a possibly posted message; Chat keeps trying until an acknowledgement, refusal, canonical row, or authorization/target change settles or blocks it. These internal re-asks do not create another host attempt or logical message. A user-requested same-correlation retry first checks canonical history; if no matching row exists, Chat posts again only when deduplication is supported. Otherwise that retry is rejected as `retry-unavailable` without posting another frame; an earlier ambiguous attempt remains unresolved. Chat never creates a new ID or changes the content automatically.

Rejection reasons are checked in the order shown above. A rejection posts nothing and changes no attempt or outcome already reported for that correlation. `not-ready` applies while the seam is not ready. `target-mismatch` applies when the lifetime or selected session differs from the current one. A correlation must be a `c_` UUIDv4. Content containing only whitespace is empty. `attempt-in-flight` preserves the active attempt. `already-delivered` prevents a second attempt after a canonical match. `correlation-conflict` covers a known correlation sent without `retry: true` or with edited content.

Before hiding or replacing the page, Chat emits `lifetime-ended` as best effort. Page hiding or replacement alone does not create a failed or uncertain delivery outcome. While the delivery outcome is unknown because Chat cannot reach the server, the host shows a plain, nonterminal “Not connected” notice that continues resolving on reconnect; it does not show a terminal delivery failure. An acknowledgement or canonical row settles a send when Chat can still observe it; if the page disappears first, the host must not show a delivery warning solely because no terminal event arrived. When Chat returns, it settles by the same client ID from the Gateway acknowledgement or canonical history. The host retains the draft and correlation it still has and waits for a fresh `ready`; a same-correlation retry remains an explicit user action after Chat checks canonical history. The host does not automatically submit a new attempt after a ready event.

## Host behavior and page-origin rules

The host follows these rules:

1. Send only with the `lifetimeId` and `sessionKey` from the latest `ready`. After `lifetime-ended`, send nothing until another `ready`.
2. Keep the host composer hidden until `ready`. A page replacement, load failure, or web-process termination alone is not evidence that a message failed or was not delivered; do not show a delivery warning solely for missing terminal events.
3. Offer retry only after a user action and use the same correlation and content with `retry: true`. Edited text gets a new correlation.
4. After app restart, a restored draft without its original correlation is a new user-initiated send with a new correlation and no retry flag; it may duplicate an earlier canonical message.
5. After `declined`, no response, or an older Chat version, let Chat's HTML composer serve.
6. Never automatically submit a new host attempt. Chat may internally re-ask the identical submission after a dropped human-send socket when Gateway deduplication is supported.
7. Pass no keyboard geometry. Resize the Chat view when the native keyboard or safe area changes; Chat retains the newest or reader position. Keep the host's existing landscape side-inset variables unchanged.
8. On `overlay` with `open: true`, give the keyboard to the Chat page so the focused dialog receives Escape. On `overlay` with `open: false`, return focus to the host composer. Chat emits this event only for a ready lifetime and sends `open: true` immediately after `ready` if a dialog is already open. Switching between Chat dialogs does not emit a close between them.

The host injects the declaration only into the main frame of the configured private Chat origin and ignores events from any other frame or origin. The seam is top-level and in-page only; Chat accepts no `postMessage` or other cross-window commands. No credentials cross the seam. Existing Chat server origin checks protect the browser service and do not cover this interface. V1 adds no signatures, nonces, replay mechanism or separate origin-verification layer.

While opted in, Chat removes the composer and its reserved bottom space only after `ready`, preserves the transcript anchor through host resizing, shows no status dot or popup, and keeps exceptional notices plus the existing Reconnect action in the transcript. Host-originated local bubbles show failed or uncertain status without Chat retry or text-restore actions. Standalone behavior remains unchanged.

The runnable browser example is [host-composer.html](../examples/host-composer.html). It demonstrates only the page-local protocol and synthetic fixture profile; it is not a native app or live-service acceptance result.
