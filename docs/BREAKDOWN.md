# Bootstrap context breakdown

[pi-baseline.md](pi-baseline.md) is the reference for the request hierarchy. Configuration starts inside its `request` container.

| Baseline content | Scope or behavior |
| --- | --- |
| `system-prompt > docs` | `[system-prompt.docs]` |
| `system-prompt > tools` | `[system-prompt.tools]` — guidance |
| `system-prompt > skills > available_skills > skill > description` | `[system-prompt.skills.available_skills.skill.description]` |
| `system-prompt > one > two` | `[system-prompt.one.two]` — arbitrary nested tags |
| `messages > message > session_state > session_mode` | `[messages.message.session_state.session_mode]` |
| Peer `tools` | Structured declarations; prose replacement rejected |
| Raw preamble or other untagged text | Unchanged and reported |
| Images, non-text blocks, null section deletions | Unchanged |
| Stored history and resource files | Unchanged |
| Capture metadata, headers, params, response | Outside transcript text; not scanned |

`src/pi-context.ts` maps Pi transport fields to the baseline containers. Pi's system content and system section values have the parent path `system-prompt`. All conversation text has the parent path `messages.message`. The adapter does not add tags to the outgoing request.

`src/prompt.ts` is the generic matcher. It combines the supplied parent path with the literal nested tags. It has no list of section names and no tools/docs/preamble special cases.

The extension runs at `context_with_system`. Active parent/child replacements that overlap cause an error. See [MECHANISMS.md](MECHANISMS.md) for the full contract.
