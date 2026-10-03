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
version = 1

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
UTF-8 TOML:

```toml
version = 1
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

## Snapshot lifecycle

The extension factory only registers handlers and creates empty runtime-local
state. Each `session_start` (startup, reload, new, resume or fork) first clears
the previous snapshot, then composes fresh content from the current cwd:

```xml
<bootstrap version="1">
  <memory>User-authored guidance</memory>
  <command>
    <run>git status --short</run>
    <output> M README.md</output>
  </command>
</bootstrap>
```

Memory text, invocation and output are XML-escaped; newlines are preserved and
indented. Empty or failed composition leaves no snapshot. Command errors notify
with filename and exit status when available; other errors propagate to Pi's
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
4. Writes reference files and appends bootstrap to the leading system message's
   content, preserving its sections, timestamps and tool declarations.

Bootstrap is **inside the system-prompt body**, never a separate `<message>`.
There is no `context` reordering hook, `sendMessage`, `sendUserMessage`, or
persisted bootstrap entry. Requests, tool continuations and compaction-derived
histories reuse the snapshot without running commands again.

Pi 1.0.0 stores system prompts as `content` plus `sections`, without literal
outer `<system-prompt>` tags. Those tags denote the logical prompt container;
adding them around native API text would duplicate framing rather than change
its role. The real provider adapter emits the bootstrap-containing text as
system instructions (or developer instructions where the provider requires it).
Later system section patches cannot remove content injected into the leading
system message. Adapters which collapse system deltas retain it too.

Broad system preamble/postamble replacements and references process the original
prompt, not bootstrap. Explicit `[system_prompt.bootstrap.memory]` or
`[bootstrap.memory]` rules can replace/reference the request copy. Existing
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
nothing. Command addition supplies an argv/cwd template and prepends `version = 1`
after editing; editing an existing command shows its complete TOML. List/delete
work without interactive UI. Operations catch errors and notify the user.
There are no model-callable management tools. Edits affect the next session
snapshot, not the current one.

## Verification and boundaries

Validated with `npm test` (**66 passed, 0 failed**), `npm run typecheck`, and
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
- Frozen histories, explicit bootstrap references, empty/error starts, shutdown,
  isolated reload runtimes and overlapping asynchronous starts are covered.

No interactive TUI or live provider request is needed for these checks. Test
configuration and reference writes use temporary directories only. Live user
configuration, external source checkout and Aven state remain untouched.

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
