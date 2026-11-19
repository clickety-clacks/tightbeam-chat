# Host-supplied composer protocol

Version 1 lets an embedding host provide the message composer while Chat renders one selected conversation. The API is page-local and accepts text plus advertised JPEG/PNG attachments. The host owns the draft and all host-side retry decisions; Chat keeps send state in the current page lifetime only.

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

A declaration may also list optional events the host handles in `events`, keyed by event name, each with the event versions it accepts. The only optional event is `restore-requested` (see [Failed-turn restore](#failed-turn-restore)):

```ts
window.__TIGHTBEAM_CHAT_HOST__ = {
  versions: [1],
  events: { 'restore-requested': [1] },
  onEvent(event) { /* ... */ },
};
```

An absent, non-object or unrecognized `events` field, or a list without version 1, declares no optional events. It never makes the declaration malformed and never causes `declined`; Chat then behaves exactly as it does for a host without the field.

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
  capabilities: { text: true, reconnect: true },
}
```

Those are the six ready fields: `version`, `lifetimeId`, `sessionKey`, `gatewayOrigin`, `agentDisplayName`, and `capabilities`. The event also has its `event` discriminator. No attachment capability is present in V1. No credential, token or device secret is included; model and harness details are omitted while opted in.

Chat sends these lifetime events:

```ts
{ event: 'declined', reason: 'unsupported-version' | 'malformed-declaration' }
{ event: 'connection', version: 1, lifetimeId,
  state: 'connected' | 'reconnecting' | 'disconnected' }
{ event: 'unavailable', version: 1, lifetimeId, reason }
{ event: 'overlay', version: 1, lifetimeId, open }
{ event: 'lifetime-ended', version: 1, lifetimeId,
  reason: 'target-changed' | 'identity-changed' | 'disposed' | 'unloading' }
```

The HTML composer stays visible until the page's first `ready`. After Chat hides it, it stays hidden for every later lifetime in that page load. `unavailable` disables host Send only when Chat has an actual reason that a send cannot be accepted; a later `ready` re-enables it for the same lifetime when sending can be attempted again. A target or identity change ends the lifetime, and the next `ready` uses a new lifetime ID. A page reload needs a new declaration and a new `ready` before Chat hides the HTML composer again.

`ready` means Chat can accept a host send command for the selected lifetime; it does not promise that the Gateway will accept every message. A live-change-feed disconnect or reconnect by itself does not make host sending unavailable: Chat keeps the same lifetime ready, emits no `unavailable` event for that feed change, and accepts sends while authorized. A missing selected session, loss of authorization, or an actual send-endpoint refusal does make sending unavailable. For a refused send, Chat reports the attempt as `failed/refused` with its endpoint detail, then emits `unavailable` with reason `send-refused`. If that refusal is specific to the message and the selected session remains ready and authorized, Chat emits `ready` again immediately for the same lifetime so another message can be sent without an unrelated runtime update. A command received before sending is ready is rejected as `not-ready` and posts nothing. Once Chat can accept commands again, it emits `ready` for that lifetime; feed-only reconnects do not create an unavailable/ready cycle.

Immediately after each `ready`, Chat sends `connection` for that lifetime with the current live-feed state: `connected`, `reconnecting`, or `disconnected`. It sends one more event only when that state changes. This matches the state shown by standalone Chat's status dot. The `connection` event is independent of send readiness and never changes a send attempt or outcome. Keep the host Send control enabled while the current lifetime is ready, even during a feed reconnect or disconnection.

When the latest connection state is `reconnecting` or `disconnected`, reconnect the live feed in place with the current ready target:

```ts
window.__TIGHTBEAM_CHAT_COMMAND__({
  type: 'reconnect',
  lifetimeId: latestReady.lifetimeId,
  sessionKey: latestReady.sessionKey,
});
```

Chat starts the existing recovery immediately, replacing a scheduled retry. The command has no effect when the feed is already connected, the seam is not ready, the lifetime is unavailable, or either identifier is stale. Recovery keeps the same lifetime, visible messages, and the newest or reader position. Its progress appears only through `connection`; it does not emit `unavailable`, `ready`, `lifetime-ended`, or `overlay`, and does not settle, cancel, or repeat a send. Chat does not reload the page or open a host-send connection for this command.

The host's connection dot is the only connection indicator: green means connected, yellow means reconnecting, and red means disconnected. In standalone Chat, its existing details action continues to offer Reconnect for a disconnected or reconnecting feed. In the Chat surface, connection state is not repeated as text in the conversation or composer. A pending message reads `Sending…` while Chat retries its human-send path; that text does not mean the Gateway acknowledged it. A feed-only reconnect does not change the send state or add a connection notice. If a page lifetime ends before delivery is settled, the host may say that delivery status is unknown while retaining the draft and correlation; it must not present that as a disconnected indicator or a terminal send failure.

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

`accepted` is a non-terminal Gateway send result. `delivered` is emitted only after Chat reconciles the canonical row named by `messageId` for the selected session, device and correlation. It does not mean the agent read, started or answered a turn. Each attempt has at most one terminal event: `delivered`, `failed`, or `uncertain`. A typed Gateway refusal becomes `failed/refused`, with the Gateway code in `detail`; this is the only terminal delivery-failure outcome. `retry-unavailable` reports that a user-requested retry did not submit another REST request; it does not turn an earlier ambiguous delivery into a failure. If a REST request has an ambiguous result, Chat repeats the exact same submission with the same client ID when the selected profile advertises the existing Gateway deduplication capability. An unavailable response does not settle a possibly recorded message; Chat retries the same send or checks canonical history until a recorded result, refusal, canonical row, or authorization/target change settles or blocks it. These internal re-asks do not create another host attempt or logical message. A user-requested same-correlation retry first checks canonical history; if no matching row exists, Chat posts again only when deduplication is supported. Otherwise that retry is rejected as `retry-unavailable` without resubmitting; an earlier ambiguous attempt remains unresolved. Chat never creates a new ID or changes the content automatically.

Rejection reasons are checked in the order shown above. A rejection posts nothing and changes no attempt or outcome already reported for that correlation. `not-ready` applies while the seam is not ready. `target-mismatch` applies when the lifetime or selected session differs from the current one. A correlation must be a `c_` UUIDv4. Content containing only whitespace is empty. `attempt-in-flight` preserves the active attempt. `already-delivered` prevents a second attempt after a canonical match. `correlation-conflict` covers a known correlation sent without `retry: true` or with edited content.

Before hiding or replacing the page, Chat emits `lifetime-ended` as best effort. Page hiding or replacement alone does not create a failed or uncertain delivery outcome. An acknowledgement or canonical row settles a send when Chat can still observe it; if the page disappears first, the host must not show a delivery warning solely because no terminal event arrived. When Chat returns, it settles by the same client ID from the Gateway acknowledgement or canonical history. The host retains the draft and correlation it still has and waits for a fresh `ready`; a same-correlation retry remains an explicit user action after Chat checks canonical history. The host does not automatically submit a new attempt after a ready event.

## Host behavior and page-origin rules

The host follows these rules:

1. Send only with the `lifetimeId` and `sessionKey` from the latest `ready`. After `lifetime-ended`, send nothing until another `ready`.
2. Keep the host composer hidden until `ready`. A page replacement, load failure, or web-process termination alone is not evidence that a message failed or was not delivered; do not show a delivery warning solely for missing terminal events.
3. Offer retry only after a user action and use the same correlation and content with `retry: true`. Edited text gets a new correlation. Text received in `restore-requested` is always a new message: a new correlation and no `retry` flag.
4. After app restart, a restored draft without its original correlation is a new user-initiated send with a new correlation and no retry flag; it may duplicate an earlier canonical message.
5. After `declined`, no response, or an older Chat version, let Chat's HTML composer serve.
6. Never automatically submit a new host attempt. Chat may internally re-ask the identical submission after an ambiguous REST result when Gateway deduplication is supported.
7. Pass no keyboard geometry. Resize the Chat view when the native keyboard or safe area changes; Chat retains the newest or reader position. Keep the host's existing landscape side-inset variables unchanged.
8. On `overlay` with `open: true`, give the keyboard to the Chat page so the focused dialog receives Escape. On `overlay` with `open: false`, return focus to the host composer. Chat emits this event only for a ready lifetime and sends the required `connection` event before `open: true` when a dialog is already open at readiness. Switching between Chat dialogs does not emit a close between them.

The host injects the declaration only into the main frame of the configured private Chat origin and ignores events from any other frame or origin. The seam is top-level and in-page only; Chat accepts no `postMessage` or other cross-window commands. No credentials cross the seam. Existing Chat server origin checks protect the browser service and do not cover this interface. V1 adds no signatures, nonces, replay mechanism or separate origin-verification layer.

The host uses `ready` and `unavailable` for Send readiness, and `connection` for its connection indicator. It may send `reconnect` from that indicator while disconnected or reconnecting. While opted in, Chat shows no live-feed Reconnect action in the transcript; feature-specific recovery notices retain their own recovery actions.

While opted in, Chat removes the composer and its reserved bottom space only after `ready`, preserves the transcript anchor through host resizing, and shows no status dot, popup, connection-state text, or inline Reconnect control for feed-only errors in the transcript. Feature-specific notices remain. Host-originated local bubbles show `Sending…` while pending and show failed or uncertain delivery without Chat retry or text-restore actions. Host mode offers no Chat retry and never restores text into Chat's hidden composer. The one exception is a failed turn: for a host that declares `restore-requested`, Chat may hand the failed prompt's text to the host when the person taps Edit and resend (below). The host owns the connection dot and its recovery action. Standalone Chat keeps its dot and details action; the dot turns yellow while live updates reconnect and green after recovery.

## Failed-turn restore

A failed turn is a person's prompt that the Gateway accepted and Chat reported `delivered`, after which the agent's turn failed. Chat shows it as the prompt bubble followed by `Message failed.` and the verbatim failure reason. This is separate from a refused send, which the host learns from `failed` and whose draft it already holds. `restore-requested` is in addition to the attempt events, not a replacement: a declared host still receives `accepted`, `delivered`, `failed` and `uncertain` exactly as above, and a refused send is still reported only by `failed`. No other host event reports a failed turn.

**Declaration.** The host opts in with `events: { 'restore-requested': [1] }` on its declaration. Without it, host mode is unchanged: the failed bubble and reason show with no action.

**When the action shows.** While Chat's composer is hidden (after the first `ready`) and the current lifetime is ready, Chat shows `Edit and resend` on a failed turn when all of these hold:

- the host declared `restore-requested` version 1;
- the prompt is a human prompt from the signed-in person (the owner-scoped rows standalone Chat's Edit and resend covers; prompts from other people and batch members are excluded);
- the prompt is in the selected session of the current lifetime.

Unlike standalone Chat, host mode also shows the action when the prompt had photos Chat no longer holds; the event then says the photos cannot be restored. While the lifetime is unavailable or ended, the action is hidden. The failed bubble, `Message failed.` and the reason are the same with or without the action.

**When the event fires.** Each tap on that action emits exactly one event, and nothing else emits it: not readiness, history loading, a reconnect, a new lifetime or a repeated failure row. Two taps emit two identical events; the host may ignore a repeat by `messageId`. Chat does not send, retry, upload or change any send state, and does not write into its own composer. The event goes only to the lifetime that was ready at the tap. If that lifetime ends while Chat reads the photo bytes, nothing is emitted and the person taps again after the next `ready`.

**Event, version 1:**

```ts
{
  event: 'restore-requested',
  version: 1,
  lifetimeId,            // current ready lifetime
  sessionKey,            // its selected session
  messageId,             // canonical row ID of the failed prompt
  correlationId?,        // the row's client message ID, present only when the row has one
  content,               // the row's content, exactly what standalone Edit and resend restores
  attachments?,          // [{ filename, mimeType, data }] when the row had photos Chat holds
  attachmentsUnavailable?: true, // when the row had photos Chat cannot restore
}
```

- `correlationId` is the client message ID recorded on the row. It may belong to another device or to standalone Chat, so it need not be a `c_` UUIDv4 or one of the host's own correlations. It identifies the failed prompt; it is never reused for the resend.
- `content` may be empty for a photo-only prompt. It is the row's text unchanged, without trimming.
- A text-only prompt carries neither photo field. A prompt with photos carries exactly one of them. `attachments` lists the photos in row order in the same shape as the `send` command's `attachments`: `data` is standard base64 without a data-URL prefix, of the bytes Chat retained for that send (after image preparation), with that item's MIME type. Chat holds them only for a prompt sent from this page while the runtime is open. Otherwise, or when a byte read fails, `attachmentsUnavailable: true` says the photos cannot be restored.

**Host behavior.** Apply the event only when `lifetimeId` and `sessionKey` match the latest `ready`. Put `content`, and any `attachments`, into the host composer as a draft for the person to edit, and keep any text the person had already typed. The host must send it only on a later user action, as a new message with a new `c_` UUIDv4 correlation and no `retry` flag, never reusing `correlationId` or retrying the failed prompt. Tell the person when `attachmentsUnavailable` is set. The failed row stays in the transcript; the resend is a new row.

The runnable browser example is [host-composer.html](../examples/host-composer.html). It demonstrates the page-local protocol; it is not a native app or live-service acceptance result.

## Native photos

`ready.capabilities.attachments` is present only when this lifetime supports attachment sending and retry. It carries `mediaTypes` (JPEG/PNG only in this version) and any supplied `maxAttachments`, `maxAttachmentBytes`, `maxTotalBytes`, `maxInlineImageBytes` and `maxInlineImageTotalBytes`. No limits are invented. An empty capability object means uploads are available without supplied restrictions; absence means the native host must hide attachment controls.

Add photos to the existing command:

```ts
window.__TIGHTBEAM_CHAT_COMMAND__({
  type: 'send', lifetimeId, sessionKey, correlationId, content: '',
  attachments: [{ filename: 'photo.jpg', mimeType: 'image/jpeg', data: rawBase64 }],
});
```

`data` is standard base64 without a data-URL prefix. Each item must decode to nonempty bytes and have a nonblank filename and an advertised MIME type. Malformed or unsupported attachment inputs produce `rejected/invalid-attachments` without uploading or posting. Absent attachments or an empty array is a text-only send. Empty text is accepted with photos. `/settings` with photos is message text; only text-only Settings commands open the local dialog.

Chat derives attachment IDs from the correlation and ordered index, then uses the same image preparation, upload and canonical reference pipeline as web composition. The native host need not downscale before handing over the photo. Local pending photos and canonical photos use the same transcript thumbnail viewer.

A user retry repeats the exact content and ordered filename/MIME/byte manifest with the original correlation and `retry:true`. Changed photos on a retained correlation produce `correlation-conflict`. Chat retries retained prepared bytes and uploaded references. On a new page lifetime, recovery checks canonical history without blindly uploading fresh references; when delivery cannot be established, it may report `uncertain/retry-unavailable`. Keep the native draft and correlation on failed, uncertain or interrupted attempts. Do not automatically retry on readiness.

Photo attempts use the same accepted/delivered/failed/uncertain events as text. Preparation and upload failures add `failed` reasons `image-unreadable` and `upload-failed`, with `detail` and optional zero-based `attachmentIndex`. Accepted means Gateway acknowledgement; delivered means canonical reconciliation, not agent reading.

This version does not implement other file types or native attach-time assessment commands. Without the Gateway assessment verb, or when a host-send assessment is unknown or fails, photos post normally with no new assessment warning or confirmation. Native sends never enter the hidden web-composer confirmation step.
