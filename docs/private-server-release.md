# Private Chat server releases

## Release contents

A `vMAJOR.MINOR.PATCH` tag runs the Chat checks, builds the browser application and packages a deployable server release. The published GitHub Release contains:

- `tightbeam-chat-<tag>.tar.gz`, with the browser assets, persistent server, checksum-verifying updater, hourly release watcher, Chat service and watcher units, license and dependency notices;
- `SHA256SUMS`, which records the bundle checksum; and
- `release-provenance.json`, which records the tag, exact source commit, asset name, checksum and build tool versions.

The release job creates a draft first, uploads the complete asset set, then publishes it. An incomplete draft is not accepted by the updater. No npm package is published.

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

For Gateway requests, the Chat server reads the provisioned `gateway.json` descriptor inside the server process. It resolves the Gateway base directory using the same precedence as the Gateway and CLI: `TIGHTBEAM_BASE_DIR`, then `TIGHTBEAM_HOME`, then `$HOME/.tightbeam`. The descriptor supplies the internal `cliToken` and its provisioned Gateway endpoint; the server uses the token only for its own Gateway requests and requires that endpoint to match `CHAT_DEFAULT_GATEWAY_ORIGIN`. A missing descriptor, missing token, invalid endpoint, or mismatch leaves the authenticated service routes unavailable. The server does not search `.tightbeam-session`, use `TIGHTBEAM_URL`/`TIGHTBEAM_TOKEN`, or read a token from `server.env`. If the Gateway uses a nondefault base directory, set `TIGHTBEAM_BASE_DIR` to that same directory in the Chat service environment. The service must already run with access to the owner-private descriptor; do not copy its token or weaken the descriptor's file permissions.

The configured default and link-selected sessions use the same provisioned Gateway origin and owner identity. A complete valid link to another session on that Gateway selects the linked session; the Gateway still decides whether the configured owner may read or post to it. A link to a different Gateway is shown as selected but unavailable in this service because this release has no provisioned origin-to-credential mapping for it. The page offers an explicit route back to the configured conversation and never silently substitutes it.

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
