# pi-bootstrap

Bootstrap Pi sessions with user-managed memories and command output. Replace
tagged request text, or save it to a file and insert a reference, using `commands/*.toml`.

## Session context

Global configuration lives under `~/.config/pi/agent/extensions/pi-bootstrap/`
(or `$PI_CODING_AGENT_DIR/extensions/pi-bootstrap/`):

- `memories/*.md`: user-authored guidance.
- `commands/*.toml`: executable commands, replacements, or references.
- `config.toml`: `enabled` flag and rules that select sources; created if missing.

Set top-level `enabled = false` to skip memories, executable commands, and request
actions for that scope. The default is `enabled = true`. Project sources inherit
the global configuration unless a project `config.toml` exists. Reload after
changing `enabled` to rebuild the session snapshot. Tool guidance and skill
discovery stay registered.

Project sources use `.agents/bootstrap/` with the same session layout. Global
sources precede project sources; a project `config.toml` overrides the global
policy for that project. Memories and executable command output are saved on `session_start`, not
on every request. Replacement and reference actions are read on each request. Skill expressions run once before the first agent run, when Pi supplies skill metadata. Commands execute with your permissions: review them before use.

Each outgoing system prompt receives memories in `<memory>…</memory>` and commands without a section specification in `<commands>…</commands>`
at the end of its system-prompt body, after all current prompt sections—not a
separate `<message>`, custom message, or user message. Commands with a section specification use that section. Memory and command items have no item tags and are separated by a blank line. The snapshot is runtime-local: startup, reload, new, resume, and fork
compose fresh content; empty/failed starts and shutdown clear it. Nothing is
persisted into conversation history, and executable commands do not rerun per request.

Request replacements/references run before injection. Explicit
`section = "system_prompt.memory"` (or `section = "memory"`) actions can transform
the request copy; broad system preamble/postamble rules cannot remove bootstrap.
Memory and executable command edits affect the next session snapshot.
Replacement and reference edits affect the next request.

Run `/bootstrap` for help, or `/bootstrap list`, `add`, `edit <id>`, and
`delete <id>`. Add/list accept optional `global|project` and `memory|command`
filters; add defaults to `project memory`. Edit/delete accept an optional type.
No model-callable management tools are registered.

Each command file may contain a non-empty single-line
`description`, and must contain exactly one of `argv`, `expression`, `replacement`, or `refer`.
Executable command items contain the optional description line followed
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

The command rule in `config.toml` must use `glob = "*.toml"` to select these
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

Set `section = "system_prompt.skills"` in a command file to replace the system prompt's
`<skills>` section instead of adding the item to `<commands>`.
Both `argv` and `expression` commands use the same `section` path format as
replacement and reference actions. Omit `section` to add output to bootstrap.
A direct path such as `system_prompt.skills` creates or replaces that system
section. Nested paths and unprefixed paths transform matching existing tags;
they do not create missing tag ancestry. Edge paths select preamble or postamble
text. Arrays preserve literal dots in tag names.

Commands for the same section are joined with blank lines in source order,
global before project. The description and output are XML-escaped. Section
commands replace existing and historical request-copy sections, without changing
stored history. Replacement and reference actions such as
`section = "system_prompt.skills"` run after section injection.

## Lazy skill discovery

The skill list and instructions now come from a command file, not extension code.
Copy [examples/skills.toml](examples/skills.toml) to `commands/skills.toml`
in the global or project configuration directory:

```toml
description = "Available skill names:"
section = "system_prompt.skills"
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
Other executable commands run at session start. Neither execution method reruns per request.
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
  An action with `section = "system_prompt.skills"` therefore receives the command output.

This reduces prompt size. It does not remove Pi's startup skill scan or skill
instructions already read into conversation history.

## Request actions

Put one action in each `commands/*.toml` file, in the global or project scope.
The command rule in `config.toml` must select the file. Use `glob = "*.toml"`
to select all command files.

Each file accepts an optional non-empty, single-line `description` and requires exactly one of:

| Field | Purpose | When it runs |
| --- | --- | --- |
| `argv` | Execute an external command | Session start |
| `expression` | Evaluate JavaScript | Session start, or first agent run for skills |
| `replacement` | Replace selected request text | Every request |
| `refer` | Save selected text and insert a reference | Every matching request |

Replacement and reference actions also require `section`. They do not accept
`cwd` or execution fields. Their descriptions are management labels,
not inserted prompt text. Unknown fields in these actions are errors.

### Replace text

For example, `commands/tools.toml`:

```toml
description = "Tool discovery instructions"
section = "system_prompt.tools"
replacement = """
Use tool discovery to find the required tools.
Read each tool definition before use.
"""
```

The action replaces the body of the system prompt's `<tools>` section.
It does not change tool declarations. Non-empty whole-body replacements retain
the outer tag and add a newline before and after the replacement text.
Replacement text is not XML-escaped or scanned again.

Use an empty replacement to **remove the complete selected tag**:

```toml
description = "Remove the rules section"
section = "system_prompt.rules"
replacement = ""
```

See [replacement](examples/replacement.toml) and [removal](examples/removal.toml)
examples.

### Save text and insert a reference

For example, `commands/docs.toml`:

```toml
description = "Pi documentation reference"
section = "system_prompt.docs"
refer = "Pi documentation is at $link. Read it when you work on Pi."
link = "links/pi-docs.md"
```

The extension saves the selected original body to the link file, then inserts
the reference text. The outer tags stay unchanged. Every `$link` becomes the
exact configured link string. See the [reference example](examples/reference.toml).

- `refer` must be a string. `link` must be a non-blank string.
- Saved text includes whitespace and child tags, but not outer tags.
- Relative links use the source scope's bootstrap root, **not** its `commands/`
  directory. Thus `links/pi-docs.md` goes under that scope's `links/`.
- `~/` expands to the home directory for file writes only. Absolute links use
  the specified path. The reference text retains the configured link.
- Missing directories are created. Existing files are overwritten on each
  matching request. For several matches that write to the same path, the last
  match supplies the saved text. No match means no write.
- Invalid sources cause a handler error before reference writes. Write errors
  cause a handler error; files already written are not rolled back.

### Targets and precedence

`section` is a dot-separated path of complete, case-sensitive tag ancestry:

```toml
description = "Nested replacement"
section = "one.two"
replacement = "New content"
```

This changes `<one><two>Old</two></one>`, but not a root `<two>`.
Use an array for literal dots in a tag name: `section = ["one.two"]`.

- `system_prompt` selects Pi's implicit system-prompt container, without
  adding an outer tag. For example, `system_prompt.one.two` selects a nested
  system tag. Unprefixed paths can match any message role.
- Each segment uses its exact name first. If absent under that parent,
  underscores change to hyphens as a fallback. Exact matches take precedence.
- A project action overrides a global action with the **same target path**.
  Duplicate target paths within one scope cause an error. Different filenames
  do not resolve that conflict. String and array forms of the same path are
  duplicates.
- Parent actions take precedence over child actions. System-specific actions
  take precedence over unprefixed actions. Exact-name paths take precedence
  over underscore fallbacks.
- `section = "abc.preamble"` selects text before the first child tag.
  `section = "abc.postamble"` selects text after the last child tag.
  These suffixes are reserved at any depth. With no child tags, either suffix
  selects the complete body. Empty edge regions accept inserted text.
  An empty replacement removes only the selected edge region.
- Self-closing tags form edge boundaries, but have no replaceable body.
  Tags inside Markdown fences and unmatched tags are ignored.
- Structured system prompts have one preamble and one postamble across all
  active sections, not one pair per section or text block.
- Section command output is inserted before these actions. A reference action
  can therefore save generated section text. A whole-section replacement
  discards that output; use only the replacement if the output is not needed.
- Explicit `system_prompt.memory` or `bootstrap` actions transform a copy
  of the session snapshot. Broad system prompt edge actions cannot remove it.
- Only outgoing request copies change. Stored history, tool declarations,
  and the session snapshot stay unchanged.

### Management and migration

Use `/bootstrap add global command` or `/bootstrap add project command`.
The editor template shows all four action forms. Keep only the fields for the
selected action. Use `/bootstrap list`, `edit <id> command`, and
`delete <id> command` to manage these files.

Action and protocol definitions are read on each request. No reload is needed
for replacement/reference edits. Memory and executable command edits still
require a new session snapshot, such as `/reload`.

`config.toml` contains the enabled flag and source-selection rules, not request
actions. There is no `default.toml`, and there are no default replacement actions.
To migrate from `protocol.toml`:

1. Rename `protocol.toml` to `config.toml` in each configured scope.
2. Add `enabled = true` before the first `[[rule]]` table.
3. Run `/reload`.

Keep replacement and reference actions in separate `commands/*.toml` files.
The extension does not read the old `protocol.toml` filename.

Relative link destinations remain unchanged for global actions. The extension
does not migrate user files automatically. The `target` field is not supported;
use `section` for every command destination, including executable commands.
For example, change `section = "skills"` to `section = "system_prompt.skills"`.

## Load

Add the absolute path to `index.ts` to the `extensions` array in your Pi settings.
Run `/reload`.

## Development

```sh
npm install
npm test
npm run typecheck
```
