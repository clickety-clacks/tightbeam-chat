# Public 0.1.9 source profile

`createPublic019Transport` maps the verified public `clickety-clacks/tightbeam` `0.1.9` branch at [`d33c510fb62b0baa51e6b89021b064d8091800b8`](https://github.com/clickety-clacks/tightbeam/tree/d33c510fb62b0baa51e6b89021b064d8091800b8). This is a source-backed **partial transport**, not Chat backend acceptance, a release claim, or a route to an approved gateway. The host supplies authenticated `fetch` and fresh, already authenticated sockets; this package never acquires or stores credentials. `baseUrl` must be an approved HTTP(S) route without embedded credentials. A host can use a same-origin browser route or another separately approved route.

The mapping covers:

| Public source | Implemented behavior |
| --- | --- |
| [`GET /version`](https://github.com/clickety-clacks/tightbeam/blob/d33c510fb62b0baa51e6b89021b064d8091800b8/lib/tightbeam/wire/router.ex#L166-L182) | Compare exact `version`, `build`, and `sha` to the host's expected identity. `/version.protocolVersion: 1` describes human chat, not Firehose protocol 2. |
| [`GET /api/sessions/:sessionKey`](https://github.com/clickety-clacks/tightbeam/blob/d33c510fb62b0baa51e6b89021b064d8091800b8/lib/tightbeam/wire/router.ex#L395-L410) | Decode `schemaVersion:1`, `resource:sessions`, `item` and retain raw metadata including `clearedThroughSeq`. |
| [`/ws/changes?protocolVersion=2`](https://github.com/clickety-clacks/tightbeam/blob/d33c510fb62b0baa51e6b89021b064d8091800b8/lib/tightbeam/wire/change_socket.ex#L176-L210) | On a fresh host-authenticated socket, send a selected-session subscription and wait for `subscription_ready`; decode source-backed `message.created`/`session.*` notices, preserve row versions, and signal sequence or connection doubt. Unknown selected-session classes request a rebuild. |
| [Human `/ws` message/ack/error](https://github.com/clickety-clacks/tightbeam/blob/d33c510fb62b0baa51e6b89021b064d8091800b8/lib/tightbeam/wire/socket.ex#L418-L467) | On a fresh host-authenticated human socket after `sync_complete`, send the exact `c_` client ID, selected session, and content. Correlated `ack` means accepted; correlated `error.messageId` means refused; disconnect, abort or timeout stays uncertain. The runtime retains the exact submission for an authorized retry. |

The source [collection route](https://github.com/clickety-clacks/tightbeam/blob/d33c510fb62b0baa51e6b89021b064d8091800b8/lib/tightbeam/wire/router.ex#L753-L831) selects every session message ascending, starts at numeric offset zero, and accepts only `after`, not stable `before`. It cannot furnish a bounded newest tail or safe older-page anchor. The source [message serializer](https://github.com/clickety-clacks/tightbeam/blob/d33c510fb62b0baa51e6b89021b064d8091800b8/lib/tightbeam/state_resources.ex#L1347-L1385) omits `markerKind`, `markerFrom`, and `markerTo` despite their [stored columns](https://github.com/clickety-clacks/tightbeam/blob/d33c510fb62b0baa51e6b89021b064d8091800b8/lib/tightbeam/schema.ex#L594-L602). A `messageType:marker` row is rejected rather than guessed from content or current session settings. The collection retains pre-reset human rows; `clearedThroughSeq` is an agent-context boundary, not a Chat visibility filter. No source-backed snapshot-to-notice coverage proof is available here, so `proveCoverage` returns `false`.

The exported profile sets `newestTail`, `stableOlderCursor`, `orderedTransitions`, and `snapshotCoverage` to `false`. `createTightbeamAdapter` therefore reports **unsupported** before opening a socket, loading history, or enabling the composer. `readTail` and `readOlder` also throw `UnsupportedTargetError` if called directly. Version string or exact `/version` match cannot override these gates.

```ts
import { createPublic019Transport, createTightbeamAdapter } from '@clickety-clacks/tightbeam-chat';

const { transport, profile } = createPublic019Transport({
  baseUrl: approvedBaseUrl,
  build: expectedBuild,
  sha: expectedSha,
  host: {
    currentIdentity: () => hostIdentity,
    fetch: hostAuthenticatedFetch,
    openAuthenticatedChanges: hostChangesSocket, // fresh /ws/changes socket after auth_result
    openAuthenticatedHuman: hostHumanSocket,     // fresh /ws socket after auth_result and sync_complete
  },
});
const adapter = createTightbeamAdapter(transport, profile);
// Opening a runtime shows unsupported until the missing source capabilities exist.
```

The source-shaped tests use literal synthetic responses and controlled channels. They prove local mapping and fail-closed behavior only. They do not show a real 0.1.9 response, authorized principal, browser route, send, reconnect, or backend acceptance. Those need separate source repair, isolated real-response validation, and product review.
