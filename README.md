# pi-bootstrap

Bootstrap Pi sessions with user-managed memories and command output. Replace
tagged request text, or save it to a file and insert a reference, using `config.toml`.

## Session context

Global configuration lives under `~/.config/pi/agent/extensions/pi-bootstrap/`
(or `$PI_CODING_AGENT_DIR/extensions/pi-bootstrap/`):

- `memories/*.md`: user-authored guidance.
- `commands/*.toml`: external command or JavaScript expression definitions.
- `protocol.toml`: rules selecting session sources; created if missing.
- `config.toml`: existing request-time replacement/reference rules.

Project sources use `.agents/bootstrap/` with the same session layout. Global
sources precede project sources; a project `protocol.toml` overrides the global
policy for that project. Session sources are saved on `session_start`, not
on every request. Skill expressions run once before the first agent run, when Pi supplies skill metadata. Commands execute with your permissions: review them before use.

Each outgoing system prompt receives `<bootstrap>…</bootstrap>`
at the end of its system-prompt body, after all current prompt sections—not a
separate `<message>`, custom message, or user message. Memory and command items have no item tags and are separated by a blank line. The snapshot is runtime-local: startup, reload, new, resume, and fork
compose fresh content; empty/failed starts and shutdown clear it. Nothing is
persisted into conversation history, and commands do not rerun per request.

Request replacements/references run before injection. Explicit
`[system_prompt.bootstrap]` (or `[bootstrap]`) rules can transform
the request copy; broad system preamble/postamble rules cannot remove bootstrap.
Management edits affect the next session snapshot, not the current one.

Run `/bootstrap` for help, or `/bootstrap list`, `add`, `edit <id>`, and
`delete <id>`. Add/list accept optional `global|project` and `memory|command`
filters; add defaults to `project memory`. Edit/delete accept an optional type.
No model-callable management tools are registered.

Each command file must contain a non-empty single-line
`description`, and exactly one of `argv` or `expression`. Add a description to
existing command files. Each command item contains the description line followed
by the XML-escaped output, without `<run>` or `<output>` tags. Execution details
are not included. To list registered
tools, create `commands/tools.toml` in either scope:

```toml

description = "Available tools"
expression = 'ALL_TOOLS.map(t => t.name).join("\n")'
```

Expressions can also use `pi.getAllTools()` and `pi.getActiveTools()`. These
methods return read-only session snapshots, not the full Pi extension interface.
`ALL_TOOLS` is an alias for `pi.getAllTools()`, not codemode's visibility-filtered
list. Expressions must return a string synchronously. Do not set `cwd` in an
expression file. Review expressions as executable configuration; the Node VM
is not a security sandbox.

The command rule in `protocol.toml` must use `glob = "*.toml"` to select these
files. Run `/reload` after you change sources or the protocol.

See [session configuration and capability parity](docs/session-capabilities.md)
for protocol examples, execution limits, lifecycle, and migration decisions.

## Tool guidance

The agent can retrieve a configured tool's current `promptGuidelines` metadata:

```js
const result = await tools.getToolGuidance({ name: "read" });
text(result);
```

This codemode call returns only guidance text, with guidelines separated by
newlines. The tool is also directly available to the model. Names must match
exactly; inactive tools are included. Missing metadata returns an empty string. Unknown names cause an error.
Each call reads Pi's current registry, not the session snapshot. Tool descriptions,
global prompt rules, and request-time guidance changes are not included.
This lookup does not change or remove the system prompt's `<rules>` section.

Run `/reload` after installing this change.

## Command-defined prompt sections

Set `section = "skills"` in a command file to replace the system prompt's
`<skills>` section instead of adding the item to `<bootstrap>`.
Both `argv` and `expression` commands support sections. Section names must
start with a lowercase letter and contain only lowercase letters, digits,
underscores, or hyphens. `bootstrap` is reserved; omit `section` to use it.

Commands for the same section are joined with blank lines in source order,
global before project. The description and output are XML-escaped. Section
commands replace existing and historical request-copy sections, without changing
stored history. Replacement and reference rules such as
`[system_prompt.skills]` run after section injection.

## Lazy skill discovery

The skill list and instructions now come from a command file, not extension code.
Copy [examples/skills.toml](examples/skills.toml) to `commands/skills.toml`
in the global or project configuration directory:

```toml
description = "Available skill names:"
section = "skills"
expression = '''
[
  ALL_SKILLS.map(s => s.name).join(", "),
  "Before specialized work, use skill_search to get descriptions and paths.",
  "Read the selected SKILL.md. Resolve supporting paths against baseDir."
].join("\\n")
'''
```

`ALL_SKILLS` and `pi.getSkills()` provide the same frozen metadata array:
`name`, `description`, `filePath`, and `baseDir`, sorted by name.
Duplicate names and disabled skills are excluded.

Pi supplies this metadata before the first agent run. Expressions targeting
`skills`, or containing `ALL_SKILLS` or `getSkills`, are saved at session start
and evaluated once before that run. Tool metadata still comes from session start.
Other commands run at session start. No commands rerun per request.
Run `/reload` after changes.

Without a section command, the extension removes Pi's full skill catalog and
does not insert a skill list. Before specialized work, the model uses the directly
available `skill_search` tool to find the relevant instructions:

```json
{ "query": "code review", "limit": 5 }
```

Search returns each matching skill's `name`, `description`, `filePath`, and
`baseDir`. The model then uses `read` to load the selected `SKILL.md`. Supporting
file paths are relative to `baseDir`. Search does not load or execute skill
instructions, and there is no separate skill-loading tool.

- Search uses Pi's discovered skill metadata; it does not scan directories again.
- Exact names rank first. Other results use case-insensitive name and description
  keywords. Search returns up to five results by default; `limit` accepts 1–20.
- Skills with `disable-model-invocation: true` are absent from the name list and
  search. Explicit `/skill:name` commands continue to work.
- Each agent run refreshes the search catalog from Pi's current metadata. The command output stays fixed for the session. Session start and shutdown clear both.
- Request copies of earlier system skill sections receive the command output,
  so an old full catalog does not remain in the outgoing transcript. Stored
  history, tool declarations, and skill resource files stay unchanged.
- Skill transformations run before the configured request replacements.
  A replacement for `[system_prompt.skills]` therefore receives the command output.

This reduces prompt size. It does not remove Pi's startup skill scan or skill
instructions already read into conversation history.

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
  Bootstrap is transformed separately. Current system content and section patches
  are folded into the leading system message, with bootstrap last. Tool deltas
  keep their transcript positions. Tool declarations, stored history, and the
  session snapshot stay unchanged.
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
