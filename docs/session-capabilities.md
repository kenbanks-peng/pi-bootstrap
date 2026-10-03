# Session configuration and capabilities

## Configuration layout

The global root is `$PI_CODING_AGENT_DIR/extensions/pi-bootstrap` when that
variable is nonempty, otherwise `~/.config/pi/agent/extensions/pi-bootstrap`
using Node's `homedir()`. It also holds request-time `config.toml`.
The project root is the current Pi working directory (`ctx.cwd`), not a Git-root
search. Project configuration lives in `<cwd>/.agents/bootstrap/`.
Both scopes use:

```text
protocol.toml
memories/
  memory-0123abcd.md
commands/
  command-0123abcd.toml
```

Management IDs are filename stems. New IDs use `memory-` or `command-` plus
eight UUID hex characters. User-chosen alphanumeric/hyphen/underscore stems
are valid. IDs may collide across scopes/types; edit/delete require an
unambiguous match. A type disambiguates a memory/command collision, but not two
memories in different scopes. List shows scope, type, full content and ID.

No legacy paths, filenames, slash commands, XML tags or custom message aliases
are supported. Existing configuration is never moved or rewritten.

## Protocol

On session start, the global protocol is installed exclusively if missing:

```toml

[[rule]]
glob = "*.md"
action = "memory"

[[rule]]
glob = "*.toml"
action = "command"
```

Global rules apply to global sources. Project sources inherit them unless a
project `protocol.toml` exists. Removing that override restores inheritance;
a malformed override is an error, not a fallback.

Each action selects direct regular files from its folder: `memory` selects
from `memories/`, `command` from `commands/`. Globs are basename patterns with
literal characters and `*`; no recursion, separators, `**`, `?`, bracket
classes or brace expansion. Command globs must end in `.toml`. Rules execute
in declaration order, files in lexical order, global scope before project.
Overlapping rules for the same action folder are rejected before that scope
executes. The same basename in different folders is not an overlap.
Unmatched files, subdirectories and source symlinks are ignored. Root-level
`config.toml` and `protocol.toml` are never command sources; inside `commands/`,
those basenames are ordinary selectable command files.

Memories are complete strict UTF-8 text, without filenames. Commands are strict
UTF-8 TOML with a non-empty single-line `description`, and
exactly one of `argv` or `expression`. Missing, blank, non-string, or multiline
descriptions are errors. Add this field to existing command files:

```toml
description = "Working tree status"
argv = ["git", "status", "--short"]
cwd = "."
```

Commands run directly without a shell; arguments are literal. Optional `cwd`
defaults to the project root, including for global commands. Relative
subdirectories must remain beneath that root after symlink resolution.
Absolute, escaping, missing and invalid working directories are errors.
Commands have a 1,000 ms timeout and a 1,048,576-byte stdout bound. Nonzero
exits, spawn failures, invalid definitions and non-UTF-8 stdout fail composition.
Stderr is drained, not injected. These limits are not a security sandbox:
commands inherit environment and permissions, can modify files and may spawn
descendants. Review both global and project commands.

### Expression commands

Create a file such as `commands/tools.toml`:

```toml
description = "Available tools"
expression = 'ALL_TOOLS.map(t => t.name).join("\n")'
```

The expression is JavaScript and must return a string synchronously. Empty strings
are valid results. Missing, empty, or non-string expressions, both execution
fields, neither execution field, and `cwd` on an expression file are errors.

The extension supplies these read-only values:

- `ALL_TOOLS`: JSON-copied tool metadata from `pi.getAllTools()`.
- `pi.getAllTools()`: returns the same frozen array.
- `pi.getActiveTools()`: returns frozen active tool names.
- `ALL_SKILLS` and `pi.getSkills()`: return frozen skill metadata, sorted by name,
  with duplicates and disabled skills excluded.

Tool values are snapshots taken when this extension's `session_start` handler runs.
Skill values come from Pi's first `before_agent_start` event. Expressions with
`section = "skills"`, or containing `ALL_SKILLS` or `getSkills`, are saved at
session start and evaluated once at that event. They do not rerun on later requests.
Tools registered later are included after the next session start or reload.
Registered metadata can include inactive or hidden tools; this `ALL_TOOLS` alias
does not reproduce codemode's visibility rules. JSON serialization preserves
data, not functions.

Each expression runs in a fresh Node VM context inside a worker thread. No host callbacks, filesystem
interface, `process`, `require`, or session-changing Pi methods are supplied.
Dynamic code generation is disabled. The parent terminates the worker after
1,000 ms, including worker startup and queued microtasks. Returned UTF-8 text has
a 1,048,576-byte bound.
These limits do not bound memory allocation. The Node VM is not a security
sandbox. Only use trusted expression configuration.

Expressions and external commands follow the same source ordering and error
handling. Each command item contains the XML-escaped description on one line,
then the XML-escaped output without `<run>` or `<output>` tags. Execution details
are not included. Failed evaluation clears the session snapshot and
reports the source filename and error. Neither execution method runs per request.

### Prompt sections

A command can set `section = "skills"` (or another lowercase section name).
Names must match `[a-z][a-z0-9_-]*`; `bootstrap` is reserved. Omit `section` to
use the normal bootstrap output. Both execution methods support this field.
Commands for the same section are joined in source order, with blank lines.
Their escaped description and output replace that request-copy section, including
historical section patches, before replacement/reference rules run. They are not
also inserted into bootstrap. See `examples/skills.toml` for a skill-list command.
Without this command, the extension removes full skill catalogs but supplies no
skill-list text. The `skill_search` tool stays registered.

## Snapshot lifecycle

The extension factory only registers handlers and creates empty runtime-local
state. Each `session_start` (startup, reload, new, resume or fork) first clears
the previous snapshot, then composes fresh content from the current cwd:

```xml
<bootstrap>
User-authored guidance

Working tree status
 M README.md
</bootstrap>
```

Memory text, description and output are XML-escaped; newlines are preserved. A blank line separates items. Empty or failed composition leaves no snapshot. Command errors notify
with filename and exit status or error details when available; other errors propagate to Pi's
handler error reporting. No partial result is injected.

Snapshots are closure-local, not module-global or persisted. Shutdown clears
them. Generation guards prevent a late asynchronous composition from restoring
state after shutdown or superseding a newer session. A new extension runtime
starts empty; resume/reload rebuilds from current files rather than recovering
historical snapshots. There is no legacy snapshot migration.

## Outgoing system prompt

The single `context_with_system` request handler:

1. Reads request-time replacement/reference configuration.
2. Transforms Pi's transcript without mutating input messages.
3. Transforms a copy of the bootstrap snapshot with explicit bootstrap paths.
4. Writes reference files.
5. Replays all system content and section patches into the leading message,
   then appends bootstrap last. Later system messages retain their tool deltas,
   positions and metadata; their prompt content and sections are folded into
   the leading message. Input messages and stored history stay unchanged.

Bootstrap is **last inside the system-prompt body**, logically immediately before
`</system-prompt>`, never a separate `<message>`. Memory and command items have no item tags; a blank line separates items.
There is no `context` reordering hook, `sendMessage`, `sendUserMessage`, or
persisted bootstrap entry. Requests, tool continuations and compaction-derived
histories reuse the snapshot without running commands again.

Pi 1.0.0 stores system prompts as `content` plus `sections`, without literal
outer `<system-prompt>` tags. Those tags denote the logical prompt container;
adding them around native API text would duplicate framing rather than change
its role. The real provider adapter emits the bootstrap-containing text as
system instructions (or developer instructions where the provider requires it).
Request-local section replay applies updates and removals before bootstrap is
appended. Both native system-delta adapters and adapters which collapse system
deltas receive bootstrap at the end of the assembled prompt. Empty snapshots
leave the original section and content layout unchanged.

Broad system preamble/postamble replacements and references process the original
prompt, not bootstrap. Explicit `[system_prompt.bootstrap]` or
`[bootstrap]` rules can replace/reference the request copy. Existing
matching, escaping, reference-file and reload semantics remain unchanged.
The original snapshot and conversation history remain immutable. A nonempty
snapshot requires Pi's leading system message; malformed transcripts are
reported rather than exposing bootstrap through a user-message fallback.

## User command

`/bootstrap` shows help. Operations:

- `list [global|project] [memory|command]`: optional filters, either order.
- `add [global|project] [memory|command]`: defaults to project memory.
- `edit <id> [memory|command]` and `delete <id> [memory|command]`.

Add/edit use the UI editor and reject non-interactive mode. Cancellation changes
nothing. Command addition supplies a description/argv/cwd template. The template also shows an expression example; remove `argv` and
`cwd` to use it. Editing an existing command shows its complete TOML. List/delete
work without interactive UI. Operations catch errors and notify the user.
There are no model-callable management tools. Edits affect the next session
snapshot, not the current one.

## Verification and boundaries

Validated with `npm test` (**93 passed, 0 failed**), `npm run typecheck`, and
`git diff --check`. API evidence: Pi 1.0.0 extension event declarations,
`core/messages.js`, pi-ai `utils/text.js`, `utils/transcript.js`, and
`api/openai-responses-shared.js`; cross-checked against Context7
`/earendil-works/pi`.

- Original replacement/reference tests remain unchanged.
- Protocol tests cover selection, execution order, inheritance, escaping,
  command limits/errors, symlink containment and exact `<bootstrap>` composition.
- Session tests cover CRUD, slash commands, paths, fresh lifecycle snapshots,
  no conversation messages, request immutability and replacement integration.
- Injection tests exercise Pi's real `convertToLlm` and OpenAI Responses request
  builder through an intercepted HTTP fetch. They verify actual outgoing JSON
  carries bootstrap only in system instructions, both with native system deltas
  and collapsed transcripts; tools and user messages remain intact. Real child
  process side effects prove commands execute once, not per request.
- Expression tests cover both scopes, mixed argv/expression sources, read-only
  tool snapshots, validation, errors, timeouts, UTF-8 byte limits, XML escaping,
  reload, and request reuse without reevaluation.
- Placement tests verify final prompt order after section updates, removals,
  additions and later system content; tool deltas keep their original positions.
- Frozen histories, explicit bootstrap references, empty/error starts, shutdown,
  isolated reload runtimes and overlapping asynchronous starts are covered.

No interactive TUI or live provider request is needed for these checks. Test
configuration and reference writes use temporary directories only. Tests do not change live user configuration, external source checkout, or Aven
state. The global command rule was separately changed from `*.command.toml` to
`*.toml` at the user's request.

The imported repository/protocol/CRUD capabilities originated in the read-only
`pi-prime-session` reference at `bc18712f619f286e83693df0aa292ddb229fd641`.
Their command limits and behavior remain intact; the conversation-message
lifecycle has intentionally been replaced, not retained for compatibility.

## Deployment note

Existing command rules such as `glob = "*.command.toml"` do not select renamed
`command-<id>.toml` files. Users must explicitly change that command rule to
`glob = "*.toml"`; fresh installations already receive it. The extension does
not silently translate existing protocols or modify live configuration.

The previously reported transitive `brace-expansion` advisory under the Pi host
peer is outside this lifecycle change. Session glob matching does not use
brace expansion; dependency upgrades remain separate work.
