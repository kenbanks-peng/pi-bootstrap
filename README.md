# pi-bootstrap

Reprocess the current Pi bootstrap context with tag-based TOML replacements. No model calls are made.

## Use

Add the absolute path to `index.ts` to the `extensions` array in your Pi settings. Run `/reload`, or start a new session.

On the next model request, the extension copies [default.toml](default.toml) to `$PI_CODING_AGENT_DIR/extensions/pi-bootstrap/config.toml`, or `~/.pi/agent/extensions/pi-bootstrap/config.toml` by default. The default contains direct system tables for `preamble`, `tools`, `rules`, `docs`, `skills`, `cwd`, and `prime`, plus a separate empty `[tools]` table. Discovery adds empty tables for other system tags it finds.

Add a nonempty string `replacement` to a discovered table:

```toml
[system_prompt.docs]
replacement = "Use the installed Pi documentation."
```

An absent replacement keeps the original text. Save changes between requests. Run `/bootstrap` to see missing replacements, unidentified system text, errors, and text sizes.

## Scope

System section tags identify context. New tagged system sections are discovered automatically. Nested tags stay inside their parent section. `prime` is a system section. The capture in [docs/pi-baseline.md](docs/pi-baseline.md) records the older layout.

Changes apply to the outgoing request only. Tool declarations, tool access, skill files, and stored session history remain unchanged. Conversation messages are not scanned or changed, including tagged user messages. The separate `[tools]` table is reserved and must remain empty; it does not control the system `<tools>` text. The default enables only the tools text replacement. Remove its `replacement` value to keep that section unchanged. Existing config files are not overwritten.

System sections, including `<preamble>` and `<prime>`, use direct `system_prompt.<tag>` replacement tables. Untagged opening text and Pi’s untagged structured preamble also use `system_prompt.preamble`. Configuration does not declare `kind` or `role`. Older `system_prompt.sections` and `message` configurations are rejected without changes. See [docs/MECHANISMS.md](docs/MECHANISMS.md) for the replacement contract and conversion steps.

## Development

Install dependencies with `npm install`. Run `npm test` and `npm run typecheck`. Pi supplies the extension API at runtime.
