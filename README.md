# Tightbeam Chat

An original, embeddable TypeScript/React transcript and plain-text composer for **one session selected by the host application**. The package also exports a React-free runtime and a host transport interface. It does not select sessions, acquire credentials, or manage a gateway.

## Current status

The browser example connects the existing component to a selected Tightbeam 0.1.9 build `2476` or source-assessed build `2844` gateway and session. It loads the newest 50 retained messages, pages backward, subscribes to live changes, renders stored switch/restart markers, and sends human messages. Other builds are shown as unsupported. See the [wire mapping and coverage limits](docs/public-019-profile.md). Automated validation uses synthetic wire responses; live-gateway acceptance remains to be done.

The repository has a standard [MIT LICENSE](LICENSE) with Copyright (c) 2026 Mike Manzano. Dependency and distribution notices are inventoried separately in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Open a real session

Run on your development computer with Node 24 or later:

```sh
npm ci
npm run example
```

Open a link with this shape:

```text
http://127.0.0.1:5173/?gateway=https%3A%2F%2Fgateway.example&session=SESSION_KEY
```

URL-encode the gateway origin and full session key. `gateway` accepts an HTTP(S) origin including an optional port, without a path, query, fragment, or credentials. The local server must be able to reach that gateway and trust its TLS certificate. Only `gateway` and `session` are accepted in the link. Never add a token to a URL.

Sign in separately on the page. You need an approved **device ID and device token** belonging to a user who can access the selected session. An administrator device can access other users' sessions. To create a credential, keep the generated device ID, click **Pair device**, ask the gateway administrator to approve that displayed ID through their normal device-approval workflow, then click **Pair device** again. The gateway fills the token field after approval. Click **Sign in**. Alternatively enter an existing paired device's matching ID and token.

A session credential alone is insufficient: the release accepts it for selected-session reads and changes, but human sending requires a paired device token. The org CLI token is also unsuitable. Do not copy an agent's credential files to use this page. Pairing creates a device on the selected gateway; it may require approval before any chat can be shown.

The example stores credentials only in memory. Sign-out or reload discards them. It loads the newest tail in chronological order with the viewport at the newest end; scrolling upward or choosing **Load earlier messages** prepends older history while preserving the reading position. Sending posts a real human message to the selected session and can wake its agent. The local Vite server supplies a same-origin HTTP/WebSocket bridge, so no gateway CORS changes are required. Keep it on loopback. A static HTML deployment alone does not include this bridge.

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

`renderMessage` receives the intact canonical record and its stable key, session, default renderer, and copy operation. Return `undefined` for the default. Message `role`/`sender` remain attribution; only optional `messageType` distinguishes a message kind. Unknown and legacy kinds remain readable and copyable. Recorded transitions are separate canonical entries, ordered with messages and never inferred from message text or current session settings. Attachment metadata is displayed as text; no attachment action is promised.

## Conversation and send behavior

The runtime waits for target inspection and selected-session change subscription readiness before reading a candidate session and bounded newest tail. It publishes a candidate only if the host transport proves the elected target's snapshot/notice coverage rule. Newer row versions win; canonical identity prevents duplicate rows. The viewport opens at the newest end, and scrolling upward or using **Load earlier messages** passes the opaque `oldestCursor` unchanged as `before`. The reading anchor is preserved when earlier rows are prepended. Agent context resets, including changes to `clearedThroughSeq`, never filter retained human history.

On disconnect or change-stream doubt, the runtime marks the view stale and rebuilds from a fresh tail and fresh older pages. Late work from a disposed session or changed principal is discarded. It does not use Firehose as token streaming or replay, and it does not accept incoming human `/ws` replay as transcript authority.

Sending uses the host's separate human `/ws` transport. Each submission has a stable `c_` client ID, selected session, device identity, and unchanged content. An ack means post acceptance, not turn completion. The runtime keeps pending, accepted, refused, and uncertain outcomes distinct and reconciles accepted sends against canonical rows by session/device/client ID. An uncertain retry first rebuilds/querys the canonical slice, then reuses the exact submission only when the same device and target deduplication capability are established. Absence from a bounded tail is never treated as proof of nonacceptance. Failed or uncertain text can be restored to the composer.

If a history response makes the target unsupported, the component blocks new sends and retries but retains local submissions for the same principal; an interrupted pending send becomes uncertain, while a known accepted outcome stays accepted. Principal change or authorization loss clears that data.

## Evidence and limits

The automated tests use controlled synthetic transports, source-shaped wire frames, and DOM fixtures. They cover readiness ordering, snapshot overlap, paging across resets and switches, reconnect, retries, target/principal changes, wire decoding, rendering, copy, composer, and disposal. Browser checks against a simulated gateway exercise the local bridge and sign-in flow. Live-gateway use still needs owner validation with an approved credential and reachable gateway.

The example does not provide session discovery, token persistence, attachment upload/download, Markdown rendering, or token streaming. Attachment metadata and plain text remain readable. An ack confirms gateway acceptance, not completion of the agent's turn.

All application source and fixture content here was authored for this repository. No T3 Code or production T3 Chat source, assets, or runtime were copied. Dependency/license details are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
