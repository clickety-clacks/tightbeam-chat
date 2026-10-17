---
name: tightbeam-chat-link
description: Resolve a named Tightbeam target to its current session and return a private Tightbeam Chat link for direct entry over the trusted VPN/tailnet. Use when the user wants to open a conversation in Chat.
---

# Open a Tightbeam conversation

Give the user one complete link to the intended existing conversation, followed by its target identity. The trusted VPN/tailnet is the user-facing access boundary; opening a provisioned target requires no browser login, pairing, approval or Device ID/token setup. Resolve the selection for them; do not ask them to assemble gateway or session parameters.

## Resolve the target

Use the installed Tightbeam CLI in the authorized context for the requested gateway. `tightbeam list` returns current `roles` and `sessions`. For a role, follow its `boundSessionKey` to the matching session. For a display name, `tightbeam transcript --name '<display name>'` returns candidates without conversation content. Use the returned exact `sessionKey`; a friendly name, role name, host name or handle is not a substitute.

Check the current session's identity and state. If multiple current candidates fit, ask the user to choose among their names and distinguishing context. If a role is unbound, do not silently select its `fallbackTarget`. If a target is missing or retired, explain that result rather than create or wake a session. For “Main,” use the originating session identified by current records; do not assume that this skill's own session is Main. If that context is ambiguous, ask a focused question.

A CLI lookup describes the gateway to which that CLI context is connected. Match it to a nonsecret deployment record that identifies that gateway's canonical HTTP(S) origin. `tightbeam list` does not itself supply that origin. Do not infer it from the execution host, read credential files, change the CLI connection, or invent a gateway-discovery command. For another compatible gateway, use its existing authorized lookup context and deployment information. If the lookup context or canonical origin is unavailable, report the selected target unavailable and name the missing configuration to the deployment administrator; do not substitute another target or request credentials.

## Build the private link

Take the persistent private Chat server base URL from its installed deployment information, together with the provisioned server-side mapping for the selected canonical gateway origin and supported target profile. The service handles its gateway connectivity and required protocol credentials internally, under ordinary gateway operation rules. Use nonsecret deployment evidence to confirm the matching connection; do not read or export its descriptor or credentials. Explicit deployment-associated aliases are supported; guessed substitutions are not. The Chat server and gateway are separate endpoints. Do not infer one from the other or substitute a loopback development preview. The deployed Chat release must support the selected gateway; a version family alone does not establish compatibility.

Use the shared link format:

```text
<privateChatBase>/?gateway=<encoded gateway origin>&session=<encoded exact session key>
```

Construct the URL with a URL/query library, placing exactly one `gateway` and one `session` parameter. Percent-encode their values once; preserve the full opaque session key. The gateway value is an HTTP(S) origin, optionally with a port, with no user information, query, fragment or path beyond `/`. The Chat base is the configured private entry address, with no credentials, query or fragment. Never put tokens, cookies, passwords or other secrets in links, chat or records; server descriptor paths are not link parameters or browser setup.

Return the actual constructed clickable URL and the resolved target name and gateway/session identity for direct entry on the trusted network. Do not present placeholders as a usable link. If the private server address, selected canonical origin or matching provisioned server-side connection is missing or unavailable, report the selected target unavailable and route the concrete configuration gap to the deployment administrator. Preserve the requested selection: never silently use the configured default or another gateway, ask the user to assemble parameters, or request credentials.

## Separate access from acceptance

The provisioned private Chat service supplies the connection internally. Do not ask the user to sign in, pair a device, approve browser access or copy a Device ID/token. This skill resolves a link; it does not provision connections, copy agent credentials, impersonate an agent or send a message.

On direct entry, the page should identify the selected gateway and session, show retained conversation across context resets, and subscribe to its live changes. Older history, actual transition markers and chat acknowledgments belong to Chat; do not substitute the CLI's agent-context transcript. A send acknowledgment establishes post acceptance, not completion of an agent turn. Opening a link does not authorize a test message or resending a saved draft.

Describe only observed results: link construction, reachable private entry, selected-target history, live-change readiness and a real human post are separate facts. Do not claim the latter from source inspection, synthetic evidence or an HTTP success response. If the browser shows another target, an unsupported gateway or a connection failure, report it without switching targets, requesting credentials or changing gateway rules.

## Availability

The supported CLI lookups and existing browser example establish target lookup and the nonsecret query seam. Persistent private serving, configured root-page recovery and release deployment must be supplied by the Chat installation; this skill does not deploy them. Use an installed, tagged, published, checksum-verified Chat release and its actual deployment evidence. Do not expose the development server, install an unpublished candidate or change a gateway to make a link work. If deployment evidence is absent, the named-target journey remains unavailable even though this skill is installed.
