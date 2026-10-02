# Bootstrap context breakdown

The current system prompt uses tagged sections. [pi-baseline.md](pi-baseline.md) is a historical capture of the older layout.

| Area | Processing |
| --- | --- |
| System `preamble` | `system_prompt.preamble` |
| System `tools`, `rules`, `docs`, `skills`, `cwd` | `system_prompt.<tag>` |
| System `prime` | `system_prompt.prime` |
| Nested skill fields, memories, and commands | Kept inside the parent section |
| New tagged system sections | Discovered as `system_prompt.<tag>` |
| Provider tool declarations outside the system prompt | Unchanged; `[tools]` is reserved and empty |
| Conversation messages, including tagged user envelopes | Not scanned or changed |
| HTTP metadata and capture wrappers | Not runtime input |

The extension uses one complete-transcript hook and changes only system text in the outgoing request. It does not change prompt-building options, tool access, resource files, or stored session history.

See [MECHANISMS.md](MECHANISMS.md) for the configuration and replacement contract.
