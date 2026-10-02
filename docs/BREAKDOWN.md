# Bootstrap context breakdown

Reference: [pi-baseline.md](pi-baseline.md).

| Captured area | Runtime source | Processing |
| --- | --- | --- |
| System opening text | System preamble | `system_prompt.preamble` |
| System `tools`, `rules`, `docs`, `skills`, `cwd` | Tagged system section text | `system_prompt.sections.<tag>` |
| Nested `available_skills` and `skill` fields | Body of the skills section | Kept inside the parent section |
| Provider tool declarations | Transcript tool declarations | Unchanged |
| User `prime_session` envelope | Bootstrap user message | `bootstrap.prime_session` |
| Ordinary user input | Conversation message | Unchanged |
| Context-mode prose and session-state tags | Extension-supplied conversation message | Unchanged by default |
| HTTP metadata and capture wrappers | Logger output only | Not runtime input |

Message indices in the capture are presentation details, not replacement keys.

## Mechanism reassessment

The old config implemented five generic kinds and eleven selectors. Most described mutable prompt inputs rather than the assembled bootstrap context.

- Replace repeated per-section delimiters with one tagged-section mechanism.
- Replace arbitrary prefix regular expressions with the system preamble mechanism.
- Remove map, record, and value selectors for tool snippets, tool guidelines, prompt guidelines, and skill metadata. Whole tagged sections contain their model-facing text.
- Remove arbitrary target paths, event selection, fallback metadata sources, and precedence paths. Replacements now address the text they identify.
- Remove the separate identity mechanism. The baseline identity is the preamble.
- Add a tagged-message mechanism for the standalone bootstrap envelope.
- Use one complete-transcript hook. Do not mutate prompt-building options.

This reduces configuration to three context mechanisms. No replacement is active until the user supplies its text. See [MECHANISMS.md](MECHANISMS.md) for the contract.
