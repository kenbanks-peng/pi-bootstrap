# pi-bootstrap

Reprocess the current Pi bootstrap context with tag-based TOML replacements. No model calls are made.

## Use

Add the absolute path to `index.ts` to the `extensions` array in your Pi settings. Run `/reload`, or start a new session.

On the next model request, the extension copies [default.toml](default.toml) to `$PI_CODING_AGENT_DIR/extensions/pi-bootstrap/config.toml`, or `~/.pi/agent/extensions/pi-bootstrap/config.toml` by default. The default contains tables for the system preamble, `tools`, `rules`, `docs`, `skills`, `cwd`, and the `prime_session` message. Discovery adds empty tables for other context it finds.

Add a nonempty string `replacement` to a discovered table:

```toml
[system_prompt.sections.docs]
replacement = "Use the installed Pi documentation."
```

An absent replacement keeps the original text. Save changes between requests. Run `/bootstrap` to see missing replacements, unidentified system text, errors, and text sizes.

## Scope

The reference capture is [docs/pi-baseline.md](docs/pi-baseline.md). Section tags and message envelopes identify context; message numbers do not. New tagged system sections are discovered automatically. Nested tags stay inside their parent section.

Changes apply to the outgoing request only. Tool declarations, tool access, skill files, and stored session history remain unchanged. Ordinary conversation messages are not selected. The default enables tools and skills text replacements. The skills example replaces the whole section with new instructions and removes the original skill list from the outgoing text. Remove either `replacement` value to keep that section unchanged. Existing config files are not overwritten.

Version 2 replaces the old generic path configuration. Existing version 1 configs are rejected without changes. See [docs/MECHANISMS.md](docs/MECHANISMS.md) for the mechanism contract and config conversion steps.

## Development

Install dependencies with `npm install`. Run `npm test` and `npm run typecheck`. Pi supplies the extension API at runtime.
