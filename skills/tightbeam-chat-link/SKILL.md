---
name: tightbeam-chat-link
description: Resolve a named Tightbeam target to its current session and return a private Tightbeam Chat link with separate human sign-in. Use when the user wants to open a conversation in Chat.
---

# Open a Tightbeam conversation

Give the user one complete link to the intended existing conversation, followed by its target identity and the human sign-in step. Resolve the selection for them; do not ask them to assemble gateway or session parameters.

## Resolve the target

Use the installed Tightbeam CLI in the authorized context for the requested gateway. `tightbeam list` returns current `roles` and `sessions`. For a role, follow its `boundSessionKey` to the matching session. For a display name, `tightbeam transcript --name '<display name>'` returns candidates without conversation content. Use the returned exact `sessionKey`; a friendly name, role name, host name or handle is not a substitute.

Check the current session's identity and state. If multiple current candidates fit, ask the user to choose among their names and distinguishing context. If a role is unbound, do not silently select its `fallbackTarget`. If a target is missing or retired, explain that result rather than create or wake a session. For “Main,” use the originating session identified by current records; do not assume that this skill's own session is Main. If that context is ambiguous, ask a focused question.

A CLI lookup describes the gateway to which that CLI context is connected. Match it to a nonsecret deployment record that identifies that gateway's canonical HTTP(S) origin. `tightbeam list` does not itself supply that origin. Do not infer it from the execution host, read credential files, change the CLI connection, or invent a gateway-discovery command. For another compatible gateway, use its existing authorized lookup context and deployment information. If either is unavailable, name the missing capability to the deployment administrator.

## Build the private link

Take the persistent private Chat server base URL from its installed deployment information, together with the gateway mapping and supported target profile. The Chat server and gateway are separate endpoints. Do not infer one from the other or substitute a loopback development preview. The deployed Chat release must support the selected gateway; a version family alone does not establish compatibility.

Use the shared link format:

```text
<privateChatBase>/?gateway=<encoded gateway origin>&session=<encoded exact session key>
```

Construct the URL with a URL/query library, placing exactly one `gateway` and one `session` parameter. Percent-encode their values once; preserve the full opaque session key. The gateway value is an HTTP(S) origin, optionally with a port, with no user information, query, fragment or path beyond `/`. The Chat base is the configured private entry address, with no credentials, query or fragment. Do not put tokens, cookies, passwords or other authentication material anywhere in the link.

Return the actual constructed clickable URL, the resolved target name and gateway/session identity, and “Sign in separately in Chat with your approved human device identity.” Do not present placeholders as a usable link. If the private server address or its gateway mapping has not been supplied, report exactly that deployment gap instead of asking the user to compose parameters.

## Separate access from acceptance

The user signs in on the Chat page through its supported human flow. Do not collect credentials in conversation, copy agent credentials, automatically pair a device or send a message. An existing approved human device identity is distinct from the agent identity used for lookup.

After sign-in, the page should identify the selected gateway and session, show retained conversation across context resets, and subscribe to its live changes. Older history, actual transition markers and chat acknowledgments belong to Chat; do not substitute the CLI's agent-context transcript. A send acknowledgment establishes post acceptance, not completion of an agent turn. Opening a link does not authorize a test message or resending a saved draft.

Describe only observed results: link construction, reachable sign-in, authenticated history, live-change readiness and a real human post are separate facts. Do not claim the latter from source inspection, synthetic evidence or an HTTP success response. If the browser shows another target, an unsupported gateway or a connection failure, report it without switching targets or weakening authentication.

## Availability

The supported CLI lookups and existing browser example establish target lookup and the nonsecret query seam. Persistent private serving, configured root-page recovery and release deployment must be supplied by the Chat installation; this skill does not deploy them. Use an installed, tagged, published, checksum-verified Chat release and its actual deployment evidence. Do not expose the development server, install an unpublished candidate or change a gateway to make a link work. If deployment evidence is absent, the named-target journey remains unavailable even though this skill is installed.
