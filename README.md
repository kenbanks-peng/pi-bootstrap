# pi-bootstrap

Use named TOML mechanisms to identify and replace Pi startup text. No model calls are made.

## Use

Add the absolute path to `index.ts` to the `extensions` array in your Pi global settings. Run `/reload`, or start a new session.

On the next submission, the extension copies [default.toml](default.toml) to `$PI_CODING_AGENT_DIR/extensions/pi-bootstrap/config.toml`, or `~/.pi/agent/extensions/pi-bootstrap/config.toml` by default. The file names each mechanism and defines its source, selector, replacement path, target, and precedence.

Add `replacement` to a discovered empty table to change its text. Save between submissions. An absent replacement keeps the generated text. Empty replacements are rejected.

Unidentified sections remain unchanged. A UI warning and `/bootstrap` show their locations and text. Add a mechanism to the TOML to identify new content without a code change. See [the mechanism reference](docs/MECHANISMS.md) for parameters and examples.

The default mechanisms support whole sections, tool snippets and guidelines, prompt guidelines, and skill descriptions. Their precedence is defined in the TOML. Tool declarations and skill files remain unchanged.

## Stable replacement keys

Mechanisms define replacement keys. The default file uses section names, tool names, and skill names. Replacements remain active when generated text changes. No hashes or source approval are required.

```toml
[message3.docs]
replacement = "Use the installed Pi documentation."
```

A replacement table needs only `replacement`, but a mechanism must identify its source. Discovery adds empty tables for identified paths, not generated prompt text. Existing entries and comments are retained. Existing replacement-only configs must add the mechanism definitions from `default.toml`; there is no hidden fallback.

Invalid TOML, mechanism definitions, or configured value types prevent new replacements. Automatic discovery retains existing comments and formatting. Writes use a lock, a temporary file, and a source comparison before commit. An editor does not use the Pi lock: save edits between submissions to avoid the small check-to-rename race. Remove a leftover `config.toml.lock` only after all Pi processes that use this extension have stopped.

## Scope

The default mechanisms change structured Pi sections on submission. A request-local transcript hook changes preamble text without disabling generated sections. Prime output and tool declarations are not rewritten. Additional system text requires an explicit mechanism.

A separate identity is editable only if Pi exposes it as text in the leading system message. The extension cannot change trusted instructions added outside Pi's transcript. Pi 1.0.0 normally has empty leading content and stores its identity in the preamble; in that case no separate `system_prompt` entry is created.

No replacements are enabled automatically. Discovery follows the user configuration. Measurements describe prompt and transcript text sizes before provider-specific encoding.

## Development

Install dependencies with `npm install`. Run `npm test` and `npm run typecheck`. Pi supplies the extension API at runtime.
