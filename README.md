# pi-bootstrap

Bootstrap Pi sessions with user-managed memories and command output. Replace
tagged request text, or save it to a file and insert a reference, using `config.toml`.

## Session context

Global configuration lives under `~/.config/pi/agent/extensions/pi-bootstrap/`
(or `$PI_CODING_AGENT_DIR/extensions/pi-bootstrap/`):

- `memories/*.md`: user-authored guidance.
- `commands/*.toml`: direct command definitions.
- `protocol.toml`: versioned rules selecting session sources; created if missing.
- `config.toml`: existing request-time replacement/reference rules.

Project sources use `.agents/bootstrap/` with the same session layout. Global
sources precede project sources; a project `protocol.toml` overrides the global
policy for that project. Session sources are snapshotted on `session_start`, not
on every request. Commands execute with your permissions: review them before use.

Run `/bootstrap` for help, or `/bootstrap list`, `add`, `edit <id>`, and
`delete <id>`. Add/list accept optional `global|project` and `memory|command`
filters; add defaults to `project memory`. Edit/delete accept an optional type.
No model-callable management tools are registered.

See [session configuration and capability parity](docs/session-capabilities.md)
for protocol examples, execution limits, lifecycle, and migration decisions.

## Configuration

On the first request, the extension copies [default.toml](default.toml) to
`~/.config/pi/agent/extensions/pi-bootstrap/config.toml` if that file is missing.
Existing config files stay unchanged. Edit `config.toml` to set replacements.
If `PI_CODING_AGENT_DIR` is set, use that directory instead of `~/.config/pi/agent`.

```toml
[one]
replacement = "New content"
```

Changes `<one>Old content</one>` to `<one>New content</one>`.

For a nested tag:

```toml
[one.two]
replacement = "New content"
```

Changes `<one><two>Old content</two></one>` to
`<one><two>New content</two></one>`.

For text at the start or end of any tag body:

```toml
[abc.preamble]
replacement = "New start"

[abc.postamble]
replacement = "New end"
```

For `<abc>Before<def>hi</def>After</abc>`, this produces
`<abc>New start<def>hi</def>New end</abc>`.

- `preamble` selects text after the opening tag and before the first child tag.
- `postamble` selects text after the last child tag and before the closing tag.
- These suffixes are reserved references. They work at any depth, with any parent name.
- Self-closing tags form boundaries. Tags inside code fences and unmatched tags do not.
- If there are no child tags, either reference selects the complete body.
- Empty edge regions accept inserted text. Whitespace is part of the selected text.
- Whole-body replacements take precedence over these references.

For tools guidance in the system prompt:

```toml
[system_prompt.tools]
replacement = "TOOLS REPLACEMENT TEXT"
```

Pi stores system text without an outer tag. The extension supplies `system-prompt`
as its parent for matching, without adding it to the outgoing text.
`system_prompt` selects this parent through the generic underscore fallback.
The same rule applies to arbitrary nested tags: `[system_prompt.one.two]`.
`[system_prompt.preamble]` and `[system_prompt.postamble]` select the edges of
the system text without an outer tag. For structured prompts, the preamble reference
selects only the `preamble` section, not the start of each section or empty content.
The postamble reference selects the end of the final active section. Section updates
do not create new prompt edges. For text blocks, only the first and last text blocks
receive these references. Nested references still apply within each section.
Tool declarations stay unchanged.

- Paths match complete, case-sensitive tag ancestry.
  Each segment uses its exact name first. If that name is absent under the selected
  parent, `_` is changed to `-` as a fallback. For example, `[abc_def.ghi_jkl]`
  can select `<abc-def><ghi-jkl>…</ghi-jkl></abc-def>`.
  If both names exist, only the exact name is selected.
  System-specific paths take precedence over unprefixed paths such as `[one.two]`.
- Replacement strings are inserted exactly. An empty string removes the body.
- Tags, attributes, and text outside the selected body stay unchanged.
- Repeated matches are replaced. If both parent and child have replacements, the parent wins.
- Tags inside Markdown code fences are ignored. Self-closing tags have no body.
- All message text is processed, including system sections and text blocks.
  Other data and stored history stay unchanged.
- The config is read for each request. A missing config is created from `default.toml`.
  Invalid config causes a handler error; no partial result is returned.
  Unmatched tag-like text, such as `Map<string>`, stays unchanged.

## Save text and insert a reference

Use `refer` and `link` instead of `replacement`:

```toml
[system_prompt.docs]
refer = "Pi documentation can be found at $link. Read it only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI."
link = "~/.config/pi/agent/extensions/pi-bootstrap/links/docs.md"
```

The extension saves the original `<docs>` body to the link file. It then replaces
the body with the `refer` text. The outer tags stay unchanged. Each `$link` in
the reference becomes the exact configured link string.

- The saved text includes whitespace and child tags, but not the outer tags.
- `~/` uses your home directory for file writes. Relative links use the config
  directory. Absolute links use the specified path.
- Missing directories are created. Existing files are overwritten on each matching
  request. If multiple matches use the same file, the last match supplies its text.
- No match means no file write. Parent actions take precedence over child actions.
- References use the same path matching and edge selection rules as replacements.
- `refer` requires a string `link` that is not empty or only whitespace.
  Do not combine `refer` with `replacement` in the same table.
- Config and file-write errors cause a handler error; no transformed result is returned.
  Files already written before an error are not rolled back.

## Load

Add the absolute path to `index.ts` to the `extensions` array in your Pi settings.
Run `/reload`.

## Development

```sh
npm install
npm test
npm run typecheck
```
