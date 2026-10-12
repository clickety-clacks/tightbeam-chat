# Tightbeam Chat

An original, embeddable TypeScript/React transcript and plain-text composer for **one session selected by the host application**. The package also exports a React-free runtime and a host transport interface. It does not select sessions, acquire credentials, or manage a gateway.

## Current status

The component and local fixture are runnable. **No Tightbeam backend version is supported or claimed compatible yet.** The source-pinned [public 0.1.9 transport profile](docs/public-019-profile.md) maps verified REST detail, protocol-2 notice, and human `/ws` frame shapes at `d33c510fb62b0baa51e6b89021b064d8091800b8`. Its message collection is still oldest-first numeric-offset pagination without stable `before` access, and its REST/Firehose message projection omits the stored transition fields. The profile therefore fails the runtime's required capability gate. Snapshot/notice coverage, an approved browser principal/route, and real-response evidence remain open. The example is a **local synthetic fixture**, not a gateway response.

The intended repository license is MIT, but the copyright holder's exact text has not been provided. No guessed `LICENSE` is included. This source is not ready for a license-complete release until the holder and required notices are confirmed.

## Run the fixture example

Node 24 or later is recommended. In a fresh checkout:

```sh
npm ci
npm run example
```

Open the local URL printed by Vite. The page embeds `TightbeamChat` beside unrelated host controls. Its 124 synthetic messages include old history, source-shaped switch records, an unknown message kind, attachment metadata, an agent-context reset, and a simulated send acknowledgement. The controls are visibly labelled as fixture actions. No credentials or network gateway are involved.

```sh
npm run check
npm test
npm run build
```

`npm run build` emits `dist/index.js`, declarations, and `dist/index.css`. This repository is not published to npm. A consuming app can import the source or built package and its CSS after the license is settled.

## Embed one selected session

```tsx
import { TightbeamChat, createTightbeamAdapter } from '@clickety-clacks/tightbeam-chat';
import '@clickety-clacks/tightbeam-chat/style.css';

// transport and profile must be verified against the exact elected target.
// The shipped public 0.1.9 profile is deliberately unsupported for this UI.
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

The host chooses `sessionKey`, owns the human principal and authenticated REST/Firehose/human `/ws` connections, and changes `identityKey` when that principal or transport lifetime changes. The component opens one isolated runtime for that selection and disposes it on switch or unmount. There is no sidebar, picker, terminal, provider control, attachment composition, or credential UI. See [the runnable fixture](examples/main.tsx) for a complete local host and [the adapter contract](docs/adapter-contract.md) before connecting a real target.

`renderMessage` receives the intact canonical record and its stable key, session, default renderer, and copy operation. Return `undefined` for the default. Message `role`/`sender` remain attribution; only optional `messageType` distinguishes a message kind. Unknown and legacy kinds remain readable and copyable. Recorded transitions are separate canonical entries, ordered with messages and never inferred from message text or current session settings. Attachment metadata is displayed as text; no attachment action is promised.

## Conversation and send behavior

The runtime waits for target inspection and selected-session change subscription readiness before reading a candidate session and bounded newest tail. It publishes a candidate only if the host transport proves the elected target's snapshot/notice coverage rule. Newer row versions win; canonical identity prevents duplicate rows. The viewport opens at the newest end, and scrolling upward or using **Load earlier messages** passes the opaque `oldestCursor` unchanged as `before`. The reading anchor is preserved when earlier rows are prepended. Agent context resets, including changes to `clearedThroughSeq`, never filter retained human history.

On disconnect or change-stream doubt, the runtime marks the view stale and rebuilds from a fresh tail and fresh older pages. Late work from a disposed session or changed principal is discarded. It does not use Firehose as token streaming or replay, and it does not accept incoming human `/ws` replay as transcript authority.

Sending uses the host's separate human `/ws` transport. Each submission has a stable `c_` client ID, selected session, device identity, and unchanged content. An ack means post acceptance, not turn completion. The runtime keeps pending, accepted, refused, and uncertain outcomes distinct and reconciles accepted sends against canonical rows by session/device/client ID. An uncertain retry first rebuilds/querys the canonical slice, then reuses the exact submission only when the same device and target deduplication capability are established. Absence from a bounded tail is never treated as proof of nonacceptance. Failed or uncertain text can be restored to the composer.

If a history response makes the target unsupported, the component blocks new sends and retries but retains local submissions for the same principal; an interrupted pending send becomes uncertain, while a known accepted outcome stays accepted. Principal change or authorization loss clears that data.

## Evidence and limits

The automated tests use controlled synthetic transports, literal source-shaped wire frames, and DOM fixtures. They exercise readiness ordering, snapshot overlap, older history across resets and switches, reconnect, exact retry identity, unsupported targets, principal changes, wire decoding, send outcomes, rendering, copy, composer, and session disposal. They do **not** establish browser access to an authorized Tightbeam gateway, a usable real transition projection, or a released backend contract. Before claiming compatibility, the delivery owner must elect an exact source/build and obtain approved real-response and browser evidence for these paths. The runtime deliberately reports an unsupported target when its pinned identity or required capabilities fail inspection or coverage proof.

All application source and fixture content here was authored for this repository. No T3 Code or production T3 Chat source, assets, or runtime were copied. Dependency/license details are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
