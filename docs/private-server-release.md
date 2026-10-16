# Private Chat server releases

## Release contents

A `vMAJOR.MINOR.PATCH` tag runs the Chat checks, builds the browser application and packages a deployable server release. The published GitHub Release contains:

- `tightbeam-chat-<tag>.tar.gz`, with the browser assets, persistent server, checksum-verifying updater, hourly release watcher, Chat service and watcher units, license and dependency notices;
- `SHA256SUMS`, which records the bundle checksum; and
- `release-provenance.json`, which records the tag, exact source commit, asset name, checksum and build tool versions.

The release job creates a draft first, uploads the complete asset set, then publishes it. An incomplete draft is not accepted by the updater. No npm package is published.

## Server configuration

The server binds only to `127.0.0.1:4178`. To make it reachable from a browser, a deployment must provide private HTTPS ingress to that listener and forward the Chat browser assets plus same-origin HTTP and WebSocket requests to `/gateway/`. The development Vite server remains loopback-only and is not a production serving option. This source package does not configure an ingress proxy, certificate, DNS name or firewall, or establish a usable private server address.

Create `~/.config/tightbeam-chat/server.env` for the Chat service with nonsecret deployment values:

```sh
CHAT_PUBLIC_ORIGIN=https://chat.example
CHAT_DEFAULT_GATEWAY_ORIGIN=https://gateway.example
CHAT_DEFAULT_SESSION_KEY=agent:example:main
```

The default gateway must be an HTTP(S) origin, and the session is an existing opaque key. The values are not credentials. `/chat-config.json` returns these fields without caching so the page can resolve its configured root at runtime; a missing or invalid target is reported by the page. Tokens and other credentials never belong in this file or a link.

The unit file is `packaging/tightbeam-chat.service`. It supervises only `tightbeam-chat.service` in the user service manager and reads the environment file above. The service account's user manager must be configured to stay active without an interactive login for the server to remain available. The updater does not alter account, manager, gateway or ingress configuration.

## Updating and rollback

After the service configuration exists, use the updater included in a published Chat release:

```sh
node ~/.local/share/tightbeam-chat/current/bin/update-chat-release.mjs install v1.2.3
node ~/.local/share/tightbeam-chat/current/bin/update-chat-release.mjs rollback
```

For an initial installation, first download a published bundle and its `SHA256SUMS`, verify the bundle with `sha256sum -c SHA256SUMS`, and extract it into a temporary directory. Run that verified bundle's `bin/update-chat-release.mjs install <tag>` to fetch and verify the release again before it stages anything.

The updater accepts only a published Chat release with the exact requested version tag, one matching server archive, a matching checksum, and provenance whose source commit resolves from that GitHub tag. It stages a verified version under `~/.local/share/tightbeam-chat/releases`, atomically switches the `current` pointer, restarts only the Chat user service and checks the served tag and source commit. If staging, restart or the served-version check fails, it restores the prior Chat pointer and restarts that version. The first release containing the watcher installs a user-level hourly timer after Chat health passes; later releases keep its existing enabled or disabled state. An older installed updater cannot install the new timer during the first upgrade, so after that release is active, run its updater once for the same tag to install the timer:

```sh
~/.local/share/tightbeam-chat/current/bin/update-chat-release.mjs install v0.1.2
```

The watcher looks up the latest published stable Chat tag and delegates installation to the same checksum- and provenance-verifying updater. A failed activation that restores the prior release is held so the timer does not repeatedly activate the same failed tag; a newer release or an explicit operator retry remains available. Rolling back to a release without the watcher disables and removes its timer and service units. The explicit rollback command switches to the last verified Chat version and checks its served identity.

The updater does not change the gateway, other services, credentials, target configuration, HTTPS ingress or public repository refs. It reports only the release identity and failure reason; it does not log target values or authorization headers.

## Verification limits

The checks and local bundle exercise the source, package structure, checksum/provenance handling, bridge routes, staging and rollback. They do not publish a tag or release, configure private HTTPS ingress, start a persistent service, install a release on a deployment host, or establish device/browser reachability. Those facts require a later reviewed and merged source tag and separate delivery evidence.
