# Named-target Chat skill

[tightbeam-chat-link](tightbeam-chat-link/SKILL.md) lets an agent resolve a named Tightbeam target and construct a complete private Chat link. On the trusted VPN/tailnet, the user opens a provisioned target directly, without browser sign-in, pairing or token setup. The skill needs an authorized Tightbeam CLI context, a configured private Chat HTTPS base and a nonsecret mapping to the selected gateway; downloading or installing it does not provide those deployment settings.

## Download and install

Clone this repository and use `skills/tightbeam-chat-link/SKILL.md`. Its SHA-256 is:

```text
bd3502f48e1be4a55bc42f4a3b92970526d3cf60fdc18b73e26e592affb34f96
```

For a reproducible download, select the repository commit you intend to install and use its file permalink rather than a moving branch URL. Check the file against the checksum above from that same revision. No server package or executable installer is needed for this skill.

A Tightbeam administrator can install the body through the supported identity skill channel, substituting the intended archetype and local paths:

```sh
tightbeam identity edit <archetype> --skill tightbeam-chat-link --file <checkout>/skills/tightbeam-chat-link/SKILL.md
```

Content installation and election are separate. Preserve the archetype's current manifest and existing skill list, add `tightbeam-chat-link` to `skills`, and submit the updated manifest:

```sh
tightbeam identity edit <archetype> --manifest --file <updated-manifest.toml>
tightbeam identity apply <recipient-session>
```

These commands change served identity; use the installation's existing administrative authorization. New sessions receive the published identity. Applying to an existing session updates its skill files and asks it to reread them; it does not reload a running model context or prove that the session read the skill. Confirm the intended session has loaded it before relying on it.

## Use

Ask the agent: “Open Chat with my support assistant.” It resolves the current target, asks for a choice if the name is ambiguous, and returns a complete private link for direct entry on the trusted network. The user does not assemble gateway or session parameters.

If the private server address, selected canonical gateway origin, matching provisioned server-side connection or compatible deployed release is missing, the agent reports the selected target unavailable and routes the configuration gap to the deployment administrator. It does not silently switch targets or request credentials. No secrets belong in links, chat or records. A downloaded skill is not evidence of recipient installation, reachable private entry, selected-target history, live updates or a successful message.
