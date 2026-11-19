# Feature flags

Flags that hide unfinished features on `main`. See the feature-flag rules in [AGENTS.md](../AGENTS.md). Add a row when you add a flag, update it when the default changes, and delete the row in the pull request that removes the flag.

| Flag | Purpose | Owner | Work item | Default | Remove when |
| --- | --- | --- | --- | --- | --- |
| `CHAT_REST_HUMAN_SEND` | Use Gateway REST `/agent/dispatch` for human sends and read-marker writes, and enable optional prompt submitter attribution, when set to `1`; otherwise retain the authenticated WebSocket send path, device-authenticated marker-write path, and generic human labels. | Chat maintainers | WIeb082 (`wi_eb08260c-73f9-45e3-a1ff-eed51a4b0f85`) | `0` (unset; only `1` enables) | Gateway 0.1.16 installed |
| `CHAT_DEVICE_PAIRING` | When set to `1`, offer "Pair this browser": the browser pairs as its own Tightbeam device with a one-time pairing code, the device token is held only in an HttpOnly, host-only `__Secure-tb-chat-device` cookie scoped to `/__chat/device`, and every human message and `/tightbeam` command is sent with that device credential through `/__chat/device/send` instead of the organization credential. Also serves a strict Content-Security-Policy on pages and assets. Otherwise Chat is unchanged. | Chat maintainers | wi_02a391dd (`wi_02a391dd-cbc7-4eeb-a1d8-c61e661fde0a`) | `0` (unset; only `1` enables) | The flag has been on in a published release and the feature is accepted |
