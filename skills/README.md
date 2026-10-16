# Named-target Chat skill

[tightbeam-chat-link](tightbeam-chat-link/SKILL.md) lets an agent resolve a named Tightbeam target and construct a complete private Chat link. The user signs in separately in Chat. The skill needs an authorized Tightbeam CLI context, a configured private Chat HTTPS base and a nonsecret mapping to the selected gateway; downloading or installing it does not provide those deployment settings.

## Download and install

Clone this repository and use `skills/tightbeam-chat-link/SKILL.md`. Its SHA-256 is:

```text
f2998c9d1a8f1ad19d2a8a3c3ef7cf3df427f5ada3e0bb901c99c1f40dfa718c
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

Ask the agent: “Open Chat with my support assistant.” It resolves the current target, asks for a choice if the name is ambiguous, and returns a complete private link with separate human sign-in. The user does not assemble gateway or session parameters.

If the private server address, gateway mapping or compatible deployed release is missing, the agent reports that prerequisite rather than inventing a URL. A downloaded skill is not evidence of recipient installation, reachable sign-in, authenticated history, live updates or a successful message.
