# Feature flags

Flags that hide unfinished features on `main`. See the feature-flag rules in [AGENTS.md](../AGENTS.md). Add a row when you add a flag, update it when the default changes, and delete the row in the pull request that removes the flag.

| Flag | Purpose | Owner | Work item | Default | Remove when |
| --- | --- | --- | --- | --- | --- |
| `CHAT_REST_HUMAN_SEND` | Use Gateway REST `/agent/dispatch` for human sends and read-marker writes, and enable optional prompt submitter attribution, when set to `1`; otherwise retain the authenticated WebSocket send path, device-authenticated marker-write path, and generic human labels. | Chat maintainers | WIeb082 (`wi_eb08260c-73f9-45e3-a1ff-eed51a4b0f85`) | `0` (unset; only `1` enables) | Gateway 0.1.16 installed |
| `CHAT_WORK_ITEM_PILLS` | Unless set to `0`, show work item pills above the message box and serve the bounded reads and the work item change connection they use; otherwise the pills, routes and connection do not exist. | Chat maintainers | WId9a2b0 (`wi_d9a2b0a8-fddf-4e10-8685-9c2f454ab666`) | `1` (unset; only `0` disables) | Pills accepted in a published release |
