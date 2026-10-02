# pi-bootstrap

Use a local TOML lookup to change Pi startup text. No model calls are made.

## Use

Add the absolute path to `index.ts` to the `extensions` array in your Pi global settings. Run `/reload`, or start a new session.

On the next submission, the extension creates `$PI_CODING_AGENT_DIR/extensions/pi-bootstrap/config.toml`, or `~/.pi/agent/extensions/pi-bootstrap/config.toml` by default. Use `/bootstrap` to see its location, entries without replacements, prompt sizes in bytes, and hook times.

To change text, remove the comment marker from an entry's `replacement` line and edit the value. Save the file. The change applies on the next submission. An absent replacement keeps the generated text. Empty strings and empty replacement arrays are rejected.

Whole-section replacements take precedence over granular entries. Tool snippets, tool guidelines, extra prompt guidelines, and skill descriptions can also be changed separately. Skill files and tool declarations are not changed. A cwd replacement changes only prompt text, not the actual working directory.

## Stable replacement keys

Replacements use section names, tool names, and skill names. They remain active when generated text changes. No hashes or source approval are required.

```toml
[message3.docs]
replacement = "Use the installed Pi documentation."
```

Only `replacement` is required. Discovery adds empty tables for active paths. It does not add generated prompt text. Existing entries and comments are retained.

Invalid TOML or invalid active entries leave generated text unchanged. Automatic discovery retains existing comments and formatting. Writes use a lock, a temporary file, and a source comparison before commit. An editor does not use the Pi lock: save edits between submissions to avoid the small check-to-rename race. Remove a leftover `config.toml.lock` only after all Pi processes that use this extension have stopped.

## Scope

The extension changes structured Pi sections on submission. A request-local transcript hook changes preamble text without disabling the generated sections. Prime output and additional tool messages are not rewritten.

A separate identity is editable only if Pi exposes it as text in the leading system message. The extension cannot change trusted instructions added outside Pi's transcript. Pi 1.0.0 normally has empty leading content and stores its identity in the preamble; in that case no separate `system_prompt` entry is created.

No replacements are enabled automatically. Discovery is based on the current installation, not a fixed list of tools or skills. Measurements describe Pi's outgoing transcript, before provider-specific encoding.

## Development

Install dependencies with `npm install`. Run `npm test` and `npm run typecheck`. Pi supplies the extension API at runtime.
