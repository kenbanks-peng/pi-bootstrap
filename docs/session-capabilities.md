# Session configuration and capability parity

## Configuration layout

The portable global root is `$PI_CODING_AGENT_DIR/extensions/pi-bootstrap` when
that environment variable is nonempty, otherwise
`~/.config/pi/agent/extensions/pi-bootstrap` using Node's `homedir()`.
This root also holds the existing request-time `config.toml`.

The project root is the current Pi working directory (`ctx.cwd`), not a Git-root
search. Project session configuration lives in `<cwd>/.agents/bootstrap/`.
This preserves the source extension's project-scope convention with renamed
branding. Both scopes use:

```text
protocol.toml
memories/
  memory-0123abcd.md
commands/
  command-0123abcd.toml
```

Management IDs are the filename stem. New IDs use `memory-` or `command-` plus
eight UUID hex characters. Existing user-chosen alphanumeric/hyphen/underscore
stems are valid. IDs may collide across types/scopes; edit/delete require an
unambiguous match. A type disambiguates a memory/command collision, but not two
memories in different scopes. List shows scope, type, complete content and ID.

No legacy path, filename, slash command, custom message type, or XML tag alias
is provided. Replacement `config.toml` content and semantics are unchanged;
its default root changes to the requested layout, while the agent-dir override
continues working. No existing configuration is moved or rewritten.

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

Global rules apply to global sources. Project sources inherit those rules unless
`<cwd>/.agents/bootstrap/protocol.toml` exists. Removing the project protocol
restores inheritance. A malformed override is an error, not a fallback.

Each action selects direct regular files from its own folder: `memory` selects
from `memories/`, `command` from `commands/`. Globs are basename patterns with
literal characters and `*`; no recursion, path separators, `**`, `?`, bracket
classes, or brace expansion. Command globs must end in `.toml`. Rules execute in
declaration order, files in lexical order, global scope before project scope.
Two rules selecting the same file in the same action folder are rejected before
that scope executes. The same basename in different folders is not an overlap.
Unmatched files, child directories and source-file symlinks are ignored.
Root-level `config.toml` and `protocol.toml` are never command sources.

Memory content is complete, strict UTF-8, without its filename. Command sources
are strict UTF-8 TOML:

```toml
version = 1
argv = ["git", "status", "--short"]
cwd = "."
```

Commands run directly, without a shell; arguments are literal. `cwd` is optional
and defaults to the current **project root**, including for global commands.
Relative subdirectories must remain beneath that root after resolving symlinks.
Absolute, escaping, missing or invalid working directories are errors.
Commands have a 1,000 ms timeout and a 1,048,576-byte stdout bound. Nonzero exits,
spawn failures, invalid definitions and non-UTF-8 stdout fail composition.
Stderr is drained, not injected. These limits are not a security sandbox:
commands inherit the process environment and permissions, can modify files, and
may spawn descendants. Review both global and project command configuration.

## Lifecycle and user command

The factory registers handlers only: it does not read files or run commands.
On each Pi `session_start` (startup, reload, new, resume or fork), composition
reads fresh files and sends one hidden `bootstrap_session` custom message when
nonempty. That message contains:

```xml
<bootstrap_session version="1">
  <memory>User-authored guidance</memory>
  <command>
    <run>git status --short</run>
    <output> M README.md</output>
  </command>
</bootstrap_session>
```

Memory text, invocation and output are XML-escaped; newlines are preserved and
indented. No partial snapshot is sent on failure. Command-source failures notify
with the filename and exit status when available; other protocol/filesystem
errors propagate to Pi's handler error reporting.

The `context` handler stably moves all existing `bootstrap_session` messages to
the beginning of conversation context without changing persisted history. It
does not reread files or execute commands. As in the source implementation,
existing persisted snapshots are retained on resume; there is no deduplication,
compaction reinjection, shutdown resource, or global in-memory cache.
Pi restores system state after `context`; the existing `context_with_system`
replacement/reference handler then handles request-local text as before.

`/bootstrap` shows help. Supported operations:

- `list [global|project] [memory|command]`: optional filters, either order.
- `add [global|project] [memory|command]`: defaults to project memory.
- `edit <id> [memory|command]` and `delete <id> [memory|command]`.

Add/edit use the UI editor and reject non-interactive mode. Cancellation changes
nothing. Command addition supplies an argv/cwd template and prepends `version = 1`
after editing; editing an existing command shows its complete TOML. List/delete
do not require interactive UI. Operations catch errors and notify the user.
There is no model-callable memory-management tool or agent authoring workflow.
Edits affect the next session snapshot, not the current one.

## Inventory and parity evidence

Reference: read-only `pi-prime-session` at
`bc18712f619f286e83693df0aa292ddb229fd641`. Runtime behavior was checked against
its four source modules and both test files; the source README's command-cwd
statement was stale, so the implementation and tests are authoritative.

| Source capability | Bootstrap component | Evidence |
| --- | --- | --- |
| Global/project repositories, safe IDs, exclusive creation, CRUD, sorted listing, missing-file errors | `src/bootstrap-repository.ts` | `bootstrap-session.test.ts`: CRUD, paths, ignored entries, missing directories, validation |
| Scope/type filters, help/usage, editor template, automatic command version, cancellation, ambiguous IDs, notifications | `src/bootstrap-command.ts` | `bootstrap-session.test.ts`: slash dispatch, defaults/filters, editing/deletion, non-UI guards, ambiguity |
| Default protocol creation, inheritance, override/removal | `src/bootstrap-protocol.ts` | `bootstrap-protocol.test.ts`: exclusive/concurrent install, inheritance and restoration |
| Strict protocol schema, direct globs, rule/file ordering, overlap errors | `src/bootstrap-protocol.ts` | Protocol tests: invalid versions/TOML/globs/actions/overlap, ordered files and rules |
| Complete UTF-8 memories, directly added sources, ignored symlinks/directories | Repository/protocol modules | Protocol tests: strict UTF-8, direct files, later additions, ignored sources |
| Direct command argv, root-relative cwd, output/error handling and fixed limits | `src/bootstrap-protocol.ts` | Protocol tests: literal argv, global/project cwd, symlink containment, exit/spawn/timeout/output/UTF-8 errors |
| Global-before-project XML composition, commands with run/output, escaping/line indentation, no partial result | `src/bootstrap-repository.ts` | Protocol tests: exact output and failed composition; session tests: no partial injection |
| Session-start snapshot, hidden message, stable context ordering, no per-turn recomposition | `src/bootstrap-session.ts` | Session tests: registration, snapshots, stable ordering, repeated starts, empty/error handling |
| Renamed command, symbols, tags and state; new file/folder layout | All `src/bootstrap-*` modules | Path/ID/default-protocol and full registration tests; runtime branding scan |
| Existing tag replacement and reference writing, defaults/reload, immutability, system/tool handling | `index.ts`, unchanged `src/replace.ts` | All 33 original `bootstrap.test.ts` tests unchanged; added combined session/request integration test |

Intentional changes beyond renaming/layout: reuse the existing `smol-toml`
dependency rather than adding a second TOML parser; slash-command dispatch uses
the same repository factory as startup; stderr is drained so a verbose command
cannot deadlock on its pipe. The dependency lockfile now includes the previously
omitted declared Pi peer, enabling ordinary `npm ci`.

## Verification

- `npm ci --ignore-scripts`: passes after refreshing the incomplete lockfile;
  installs 155 packages. npm reports the transitive advisory noted below.
- `npm test`: 56 passed, 0 failed/skipped (33 original, 23 new).
- `npm run typecheck`: passes.
- `git diff --check`: passes.
- Runtime and test source branding scan: no old branding remains.
- `src/replace.ts`, `default.toml`, and the 33 original tests are unchanged.

Lifecycle/UI tests use Pi API doubles plus real temporary filesystem and child
processes; no interactive TUI or model-provider session was launched.

## Deployment observations

The installed layout inspected read-only already uses `command-<id>.toml`, but
its `protocol.toml` still has `glob = "*.command.toml"`. That rule does not select
the renamed files. The user must change it to `*.toml` to enable those commands;
this extension preserves existing protocols and does not silently translate
legacy globs. Neither the external source checkout nor live user configuration
was modified during implementation.

Dependency audit reports a transitive high-severity `brace-expansion` advisory
under the Pi host peer. This is separate from session glob matching (which does
not use brace expansion). Updating the host dependency is follow-up work, not
part of this capability migration.
