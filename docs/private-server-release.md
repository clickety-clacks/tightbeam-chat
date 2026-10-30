# Private Chat server releases

## Release contents

A `vMAJOR.MINOR.PATCH` tag runs the Chat checks, builds the browser application and packages a deployable server release. The published GitHub Release contains:

- `tightbeam-chat-<tag>.tar.gz`, with the browser assets, persistent server, checksum-verifying updater, hourly release watcher, Chat service and watcher units, license and dependency notices;
- `SHA256SUMS`, which records the bundle checksum; and
- `release-provenance.json`, which records the tag, exact source commit, asset name, checksum and build tool versions.

The tag workflow creates a draft and uploads the complete asset set, then stops. Its summary and the draft notes show the exact source commit, package name and SHA-256. Review the package against that checksum and publish the draft explicitly after approving that exact change. The updater accepts only published releases, so the draft is retained for review without becoming available for automatic installation. No npm package is published.

## Server configuration

The server binds only to `127.0.0.1:4178`. To make it reachable from a browser, a deployment must provide private HTTPS ingress to that listener and forward the Chat browser assets plus same-origin authenticated HTTP and WebSocket requests under `/__chat/`. The existing `/gateway/` bridge remains available for its supported public-client flow. The development Vite server remains loopback-only and is not a production serving option. This source package does not configure an ingress proxy, certificate, DNS name or firewall, or establish a usable private server address.

Create `~/.config/tightbeam-chat/server.env` for the Chat service with nonsecret deployment values:

```sh
CHAT_PUBLIC_ORIGIN=https://chat.example
CHAT_DEFAULT_GATEWAY_ORIGIN=https://gateway.example
CHAT_DEFAULT_PRINCIPAL_KEY=example-user
CHAT_DEFAULT_SESSION_KEY=agent:example:main
```

The default gateway must be an HTTP(S) origin, and the principal and session identify an existing owner and opaque session key. These values are not credentials. `/chat-config.json` returns the configured target without caching so the page can resolve its root at runtime; it also returns a stable nonsecret device identifier used by the server bridge. A missing or invalid target is reported by the page. Tokens and other credentials never belong in this file or a link.

For Gateway requests, the Chat server reads each provisioned `gateway.json` descriptor inside the server process. To provision more than one Gateway, set `CHAT_GATEWAY_MAP_FILE` to a deployment-owned JSON file with this shape:

```json
{
  "version": 1,
  "gateways": [
    {
      "origin": "https://gateway.example",
      "baseDir": "/srv/tightbeam/gateway-a",
      "aliases": ["https://gateway-alias.example"]
    }
  ]
}
```

Each `baseDir` points to a separately provisioned Gateway base containing its owner-private `gateway.json`. Origins and aliases must be HTTP(S) origins with no credentials, path beyond `/`, query or fragment. The server canonicalizes each origin, rejects invalid or duplicate canonical keys, and requires `CHAT_DEFAULT_GATEWAY_ORIGIN` to resolve to an origin or explicit alias in the map. The descriptor endpoint must match the entry's origin or one of its explicit aliases; host-name similarity is never used to select a Gateway. A missing or unreadable descriptor, missing token, invalid endpoint or endpoint mismatch leaves only that mapped Gateway unavailable. An invalid supplied map fails closed and does not fall back to the single-descriptor configuration.

When `CHAT_GATEWAY_MAP_FILE` is absent, the server preserves the single-Gateway configuration: it reads the descriptor under the base directory selected by `TIGHTBEAM_BASE_DIR`, then `TIGHTBEAM_HOME`, then `$HOME/.tightbeam`, and requires its provisioned endpoint to exactly match `CHAT_DEFAULT_GATEWAY_ORIGIN`. The server does not search `.tightbeam-session`, use `TIGHTBEAM_URL`/`TIGHTBEAM_TOKEN`, or read a token from `server.env`. The service must already run with access to the owner-private descriptors; do not copy their tokens or weaken their file permissions.

The configured default and a complete valid link both preserve the link's exact Gateway origin and session. The server selects only the descriptor mapped to that canonical origin, uses the configured owner identity, and leaves authorization to the Gateway. A link to an unmapped or unavailable Gateway remains visibly selected but unavailable; the page offers an explicit route back to the configured conversation and never silently substitutes it. The map path, base directories and descriptor contents are server-only: they are not returned by `/chat-config.json` or exposed to the browser. The browser receives only the nonsecret default target and sends the selected Gateway origin to the same-origin Chat bridge.

The unit file is `packaging/tightbeam-chat.service`. It supervises only `tightbeam-chat.service` in the user service manager and reads the environment file above. The service account's user manager must be configured to stay active without an interactive login for the server to remain available. The updater does not alter account, manager, gateway or ingress configuration.

## Updating and rollback

For an initial installation, download a published bundle and its `SHA256SUMS`, verify the bundle with `sha256sum -c SHA256SUMS`, and extract it into a temporary directory. Run that verified bundle's updater with Node; the updater fetches the release again and verifies its publication, checksum, provenance, and tag source before staging anything.

The first watcher release needs a specific bootstrap when upgrading from v0.1.1. The installed v0.1.1 updater predates the watcher service and timer paths, so it rejects that archive before activation. Use the updater from the checksum-verified v0.1.2 bundle for this one transition:

```sh
mkdir -p "$HOME/tmp/tightbeam-chat-v0.1.2"
cd "$HOME/tmp/tightbeam-chat-v0.1.2"
curl -fsSLO https://github.com/clickety-clacks/tightbeam-chat/releases/download/v0.1.2/tightbeam-chat-v0.1.2.tar.gz
curl -fsSLO https://github.com/clickety-clacks/tightbeam-chat/releases/download/v0.1.2/SHA256SUMS
sha256sum -c SHA256SUMS
mkdir verified
tar -xzf tightbeam-chat-v0.1.2.tar.gz -C verified
node verified/bin/update-chat-release.mjs install v0.1.2
```

This single install invocation uses the newer updater to verify and stage the published release, activate Chat, and install the watcher units after the served version passes its health check. Do not invoke the v0.1.1 updater for this transition. Once a watcher-capable release is active, use its updater for later updates and rollback:

```sh
node ~/.local/share/tightbeam-chat/current/bin/update-chat-release.mjs install v1.2.3
node ~/.local/share/tightbeam-chat/current/bin/update-chat-release.mjs rollback
```

The updater accepts only a published Chat release with the exact requested version tag, one matching server archive, a matching checksum, and provenance whose source commit resolves from that GitHub tag. It stages a verified version under `~/.local/share/tightbeam-chat/releases`, atomically switches the `current` pointer, restarts only the Chat user service and checks the served tag and source commit. If staging, restart or the served-version check fails, it restores the prior Chat pointer and restarts that version. The first release containing the watcher installs a user-level hourly timer after Chat health passes; later releases keep its existing enabled or disabled state.

The watcher looks up the latest published stable Chat tag and delegates installation to the same checksum- and provenance-verifying updater. A failed activation that restores the prior release is held so the timer does not repeatedly activate the same failed tag; a newer release or an explicit operator retry remains available. Rolling back to a release without the watcher disables and removes its timer and service units. The explicit rollback command switches to the last verified Chat version and checks its served identity.

The updater does not change the gateway, other services, credentials, target configuration, HTTPS ingress or public repository refs. It reports only the release identity and failure reason; it does not log target values or authorization headers.

## Verification limits

The checks and local bundle exercise the source, package structure, checksum/provenance handling, bridge routes, staging and rollback. They do not publish a tag or release, configure private HTTPS ingress, start a persistent service, install a release on a deployment host, or establish device/browser reachability. Those facts require a later reviewed and merged source tag and separate delivery evidence.

### Stored activity summaries

The server summarizes loaded agent messages, remedies, readable attest notes,
wake prompts and decision questions. Original text remains visible until a result
arrives and remains available on hover. Fixed activity labels are unchanged.
Library hosts without an `activitySummaries` adapter continue showing originals.

The default model endpoint is `http://127.0.0.1:8080/v1/chat/completions`, with
no model name in the request (the endpoint uses its loaded model). Optional
non-secret environment settings are:

- `CHAT_SUMMARY_ENDPOINT`: an OpenAI-compatible chat-completions URL.
- `CHAT_SUMMARY_MODEL`: model name, omitted by default.
- `CHAT_SUMMARY_TIMEOUT_MS`: whole-attempt timeout, default 60000.
- `CHAT_SUMMARY_CREDENTIAL_FILE`: path to an owner-private file containing an
  endpoint credential. The environment file contains the path, never the key.
- `CHAT_SUMMARY_DATA_DIR`: durable summary directory, default
  `$XDG_DATA_HOME/tightbeam-chat/summaries`, or
  `$HOME/.local/share/tightbeam-chat/summaries` when XDG_DATA_HOME is absent.

Keep the data directory outside release directories and retain it through upgrades
and rollbacks. Exactly one Chat server process owns a directory. Each source key
has an atomically replaced, synced record. A first attempt is durably reserved
before inference. Failures retry after five minutes, then after sixty minutes;
a third failure keeps original text permanently. A restart treats an interrupted
attempt as failed at startup. Pending sources are retained for scheduled retries
without a viewer and removed from the record on success or final failure.
Stored results and final failures never expire or regenerate on model changes.

`POST /__chat/summaries` streams a loaded batch's states as newline-delimited JSON.
Model requests stay server-side. Waiting retries do not animate or poll; a lost
answer stream reopens once, then waits for visibility, network or live-feed
recovery. A model or store outage leaves the rest of Chat usable. The existing
principal-scoped `GET /__chat/api/attests/:id` proxy supplies readable notes;
unreadable notes retain their fixed activity wording.

Source verification with controlled endpoints does not establish the serving
host's model availability, summary quality or real-view acceptance. Those require
separate served evidence before claiming availability.

### Record-event history

Chat reads the selected conversation's `/api/sessions/:session_key/record-events`
collection and subscribes to `session_record_event.created`. Durable event pills
are distinct from tool calls. Exact notice coverage replaces a duplicate event
pill with the notice already in the transcript. An unavailable event collection
leaves the conversation usable and offers an activity-history retry.

Each event kind starts at the Gateway release that activates it. Earlier events
of that kind remain omitted permanently, including events between staged
releases. An older conversation without those earlier pills is expected; Chat
does not backfill them from message text, tool output, or storage. Work-item filed
and assignment opened are the first stage; later kinds use the same feed.
