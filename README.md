# Tightbeam Chat

An original, embeddable TypeScript/React conversation and Markdown composer for **one session selected by the host application**. The package also exports a React-free runtime and a host transport interface. It does not select sessions, acquire credentials, or manage a gateway.

## Current status

The browser example connects the component to one selected Tightbeam 0.1.9 gateway and session. The reviewed compatibility floor is build `2887` and later on the same line and protocol. It loads retained history, follows source-backed turn provenance, renders the human exchange with safe Markdown, subscribes to live changes, and sends human messages. See the [wire mapping and coverage limits](docs/public-019-profile.md). Automated validation uses synthetic wire responses; live-gateway acceptance remains separate.

The repository has a standard [MIT LICENSE](LICENSE) with Copyright (c) 2026 Mike Manzano. Dependency and distribution notices are inventoried separately in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Open Chat with a selected target

To ask an agent for a complete link by target name, install the [named-target Chat skill](skills/README.md). It resolves the exact Gateway and session for the link.

The browser entry accepts a nonsecret `gateway` origin and exact `session` key. It uses URL query APIs so reserved characters in either value round-trip. The gateway must be an HTTP(S) origin without credentials, path, query, or fragment. Only those two parameters are accepted; tokens and other credentials never belong in the link.

For a configured root with no query string, the private server supplies `GET /chat-config.json` at the Chat origin. It returns JSON with a canonical `gateway` origin and the exact nonempty `sessionKey`, for example `{ "gateway": "https://gateway.example", "sessionKey": "agent:example/chat" }`. These values select a target; they are not credentials. The browser fetches this configuration at runtime, so one built asset set can serve different private deployments. A complete valid link overrides the configured default. A malformed, incomplete, duplicate, or extra query parameter is rejected without displaying its raw value or connecting to the requested target; when a valid default exists, Chat offers an explicit link back to the configured entry. Missing or invalid configuration is shown as an error rather than replaced with a placeholder target.

On the authorized private network, opening a complete link loads the selected conversation through the Chat service's deployment-owned Gateway provisioning. The browser does not sign in, pair a device, or accept a token; Gateway credentials remain inside the server. A target without a matching provisioned Gateway stays selected and is reported unavailable, with no substitution to the configured default.

Use the private HTTPS entry on the authorized network. Localhost remains available for development. The browser sends gateway HTTP and WebSocket traffic through the Chat origin's same-origin bridge; HTTPS pages use HTTPS/WSS on that origin, avoiding browser mixed-content requests to the selected gateway.

For local development, use Node 24 or later and open a named target with a complete nonsecret link such as `/?gateway=https%3A%2F%2Fgateway.example&session=agent%3Aexample%2Fchat`:

```sh
npm ci
npm run example
```

The Vite example binds to loopback and its bridge is development-only. Do not expose it to a network or put a proxy/tunnel in front of it. A private production origin must serve the built example, runtime config, and same-origin `/gateway/` HTTP and WebSocket bridge over HTTPS. This candidate does not establish a deployed server, device route, or certificate.

The example loads the newest tail in chronological order with the viewport at the newest end; scrolling to the oldest loaded edge automatically prepends older history while preserving the reading position. The conversation hides non-human activity and structural transition bubbles while retaining canonical history. The floating composer stays usable during refresh, shows recoverable send failures in their own bubbles, and renders Markdown safely with selectable text. The private entry provides this surface through the provisioned Chat service without a separate browser sign-in. Sending still depends on the selected Gateway connection and its ordinary operation rules; opening a link does not authorize an automated test message.

```sh
npm run check
npm test
npm run build
```

`npm run build` emits the component library into `dist`. It does not build or deploy the example server. This repository is not published to npm.

## Embed one selected session

```tsx
import { TightbeamChat, createTightbeamAdapter } from '@clickety-clacks/tightbeam-chat';
import '@clickety-clacks/tightbeam-chat/style.css';

// transport and profile must be verified against the exact elected target.
// createPublic019Transport supplies the released 0.1.9 wire mapping.
const adapter = createTightbeamAdapter(transport, profile);

<TightbeamChat
  sessionKey={hostSelectedSessionKey}
  identityKey={hostPrincipalGeneration}
  adapter={adapter}
  renderMessage={(record, context) =>
    record.kind === 'message' && record.messageType === 'my-kind'
      ? <MyKindView record={record} copyText={context.copyText} />
      : undefined}
/>;
```

The host chooses `sessionKey`, owns the human principal and authenticated REST/Firehose/human `/ws` connections, and changes `identityKey` when that principal or transport lifetime changes. The component opens one isolated runtime for that selection and disposes it on switch or unmount. There is no sidebar, picker, terminal, provider control, attachment composition, or credential UI. See [the browser example](examples/main.tsx) for a complete local host and [the adapter contract](docs/adapter-contract.md) before connecting a real target.

## Host-supplied composer, version 1

An embedding page may supply its own composer while Chat keeps rendering the transcript. The full [version 1 protocol contract](docs/host-composer.md) defines every command and event. The opt-in is in the top-level Chat page itself; Chat does not accept these commands through `postMessage` or another cross-window channel. A page without a declaration behaves as standalone Chat. An unsupported or malformed declaration is declined and also leaves the normal web composer available.

Set the declaration before mounting Chat. The public names are fixed for version 1:

```js
window.__TIGHTBEAM_CHAT_HOST__ = {
  versions: [1],
  onEvent(event) {
    if (event.event === 'ready') {
      // Show the native composer only now, and retain this lifetime and target.
    }
  },
};
```

Chat exposes `window.__TIGHTBEAM_CHAT_COMMAND__`. When the host user submits text, call it with a fresh `c_` plus UUIDv4 correlation. The command is synchronous; rejections post nothing and do not change an existing attempt. Sending exactly `/settings` after trimming surrounding whitespace opens Settings and returns `rejected` with reason `local-command`; Chat records no send attempt. Other slash-prefixed text is sent unchanged.

```js
window.__TIGHTBEAM_CHAT_COMMAND__({
  type: 'send',
  lifetimeId: latestReady.lifetimeId,
  sessionKey: latestReady.sessionKey,
  correlationId: `c_${crypto.randomUUID()}`,
  content: draft,
});
```

The first `ready` arrives only after the selected-session subscription and canonical history catch-up are ready. Its fields are `version: 1`, `lifetimeId`, `sessionKey`, `gatewayOrigin`, `agentDisplayName`, and `capabilities: { text: true }`. It carries no credential, token, device secret, model or harness detail. V1 accepts text only; attachment composition is not advertised and may be added in a future version.

Every attempt event carries `lifetimeId`, `correlationId`, and its per-lifetime `attempt` number. `accepted` only means the Gateway acknowledged the post. `delivered` means Chat later reconciled the canonical conversation row for the selected session, device and correlation; it says nothing about whether the agent read or answered. One attempt ends with exactly one `delivered`, `failed`, or `uncertain` event. A typed refusal is `failed` with reason `refused` and its Gateway code in `detail`. A terminal delivery failure means the Gateway definitely refused that send. `retry-unavailable` means Chat did not submit another frame for that user-requested retry; it does not settle the delivery outcome of an earlier ambiguous post. Uncertain reasons are `ack-lost`, `accepted-unreconciled`, and `lifetime-ended`.

The command rejection reasons are checked in this order: `local-command`, `not-ready`, `target-mismatch`, `invalid-correlation`, `empty`, `attempt-in-flight`, `already-delivered`, and `correlation-conflict`. Each rejection preserves all prior attempt state. A user-requested retry uses `retry: true`, the same correlation and byte-for-byte content. Chat first checks canonical history; it posts again only if the current profile supports the existing human-send deduplication. If a human-send socket drops before acknowledgement, Chat automatically reconnects and re-asks with the same client ID and content when that deduplication capability is present; a failed reconnect does not turn a possibly posted message into a final failure. Chat never creates a new ID or changes content automatically. Edited content is a new logical message with a new correlation.

When a Settings or What's new dialog opens or closes, Chat sends `overlay` with `open: true` or `open: false` for the current ready lifetime. If a dialog is already open when `ready` arrives, Chat sends `overlay` with `open: true` immediately after it. While a dialog is open, the host gives keyboard input to the Chat page; when the last dialog closes, the host returns focus to its composer. Hosts that ignore `overlay` continue to work as before.

On `unavailable`, disable host sending and keep the host draft. A later `ready` in that same lifetime re-enables it. While delivery is unknown and Chat cannot reach the server, show a plain, nonterminal “Not connected” notice and keep resolving on reconnect; do not report a terminal delivery failure unless the Gateway definitely refused the send. On `lifetime-ended`, send nothing until the next `ready`; target or principal changes create a new opaque lifetime. On page reload Chat requires a fresh declaration and fresh `ready` before it hides the HTML composer again. Page hiding, replacement, or process termination alone does not prove a send failed; do not show a delivery warning solely because no terminal event arrived. When Chat returns, settle by the same client ID from the Gateway acknowledgement or canonical history before offering an explicit same-correlation retry. Keep the draft and any correlation still held. If an app restart loses the correlation, a restored draft is sent only after a new user action with a new correlation and without `retry`; that may create a second canonical row, so present it as a new send.

Chat removes its HTML composer and reserved bottom space only after the first `ready`. It keeps the transcript at the newest message or the reader's visible anchor as the host resizes the web view; the host passes no keyboard geometry and leaves its existing landscape side-inset variables unchanged. Host-originated local bubbles show failure or uncertainty without Chat retry or text-restore controls. While opted in, Chat shows no status dot or popup; exceptional notices remain in the transcript with Reconnect on a disconnected notice. Without a supported opt-in, the standalone status details and composer remain unchanged.

The host injects the declaration only into the top-level main frame for the configured private Chat origin and ignores events from other frames or origins. The seam is in-page only: do not use cross-window messaging, and send no credentials through it. The Chat server's existing origin checks protect its browser service; they do not cover this seam. V1 adds no signatures, nonces, replay controls, or separate origin-verification protocol.

The [minimal host-composer page](examples/host-composer.html) demonstrates the handshake, text send, same-correlation retry and ready/unavailable handling. It is a source example, not an exercised native app or live service. `npm run example` serves it locally at `/host-composer.html`; the Vite server and bridge remain loopback-only and development-only.

`renderMessage` receives the intact canonical record and its stable key, session, default renderer, and copy operation. Return `undefined` for the default. For a human `role=user` row, an exact `sender=user:<principalKey>` match labels it “You”; a missing or different sender leaves it visible as “User” without inferring identity. Explicit agent, process, substrate, marker, and batch-carrier records remain hidden. Missing reply provenance does not hide a provisional reply while older history loads; authoritative evidence can still exclude replies to nonhuman activity. Recorded transitions are separate canonical entries, ordered with messages and never inferred from message text or current session settings; transition bubbles are hidden. Attachment metadata is displayed as text; no attachment action is promised. Default message bodies support headings, emphasis, lists, links, inline and block code, quotes, and tables. Raw HTML is not activated, and wide code or tables scroll within their bubble.

## Conversation and send behavior

The runtime waits for target inspection and selected-session change subscription readiness before reading a candidate session and bounded newest tail. It publishes a candidate only if the host transport proves the elected target's snapshot/notice coverage rule. Newer row versions win; canonical identity prevents duplicate rows. The viewport opens at the newest end, and reaching the oldest loaded edge passes the opaque `oldestCursor` unchanged as `before`. The reading anchor is preserved when earlier rows are prepended, including pages with no displayable human exchange. Agent context resets, including changes to `clearedThroughSeq`, never filter retained human history. Authoritative turn/trigger data determines which human prompts and selected-agent replies appear; other agents, substrate notices and unproven replies stay hidden without being removed from canonical state.

On disconnect or change-stream doubt, the runtime marks the view stale and rebuilds from a fresh tail and fresh older pages. Wake and unknown event kinds still consume stream sequence but do not force a rebuild or reject snapshot coverage. Late work from a disposed session or changed principal is discarded. It does not use Firehose as token streaming or replay, and it does not accept incoming human `/ws` replay as transcript authority.

Sending uses the host's separate human `/ws` transport. Each submission has a stable `c_` client ID, selected session, device identity, and unchanged content. An ack means post acceptance, not turn completion. The runtime keeps pending, accepted, refused, and uncertain outcomes distinct and reconciles accepted sends against canonical rows by session/device/client ID. An uncertain retry first rebuilds/querys the canonical slice, then reuses the exact submission only when the same device and target deduplication capability are established. Absence from a bounded tail is never treated as proof of nonacceptance. The composer remains editable during stale refresh while Send waits for current history; failed or uncertain submissions remain in their own bubbles with retry and restore actions.

If a history response makes the target unsupported, the component blocks new sends and retries but retains local submissions for the same principal; an interrupted pending send becomes uncertain, while a known accepted outcome stays accepted. Principal change or authorization loss clears that data.

## Evidence and limits

The automated tests use controlled synthetic transports, source-shaped wire frames, and DOM fixtures. They cover readiness ordering, snapshot overlap, provenance and trigger reads, paging across resets and switches, reconnect, retries, target/principal changes, safe Markdown, hidden-only paging, focus/caret/draft retention, popup access and disposal. Fixture checks exercise only their declared behavior and do not establish acceptance of a deployed browser journey. Any live history, live-change or authorized human-send observation remains separate evidence.

The example does not provide session discovery, token persistence, attachment upload/download, or token streaming. Attachment metadata remains readable. An ack confirms gateway acceptance, not completion of the agent's turn.

All application source and fixture content here was authored for this repository. No T3 Code or production T3 Chat source, assets, or runtime were copied. Dependency/license details are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
