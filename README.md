# pi-bootstrap

This extension provides configurable transformations of the Pi agent system prompt.

## Setup

```sh
pi install npm:@npn-ken/pi-bootstrap
```

On first use, if the global `config.toml` is missing, the extension installs:

- `config.toml`: enables all Markdown memories and TOML commands.
- `commands/repo.toml`: adds tracked repository files to `system_prompt.repo`.
- `memories/memory-example.md`: requests ASD-STE100 Simplified Technical English.

These files go in the agent directory under `pi-bootstrap`. Existing files are not overwritten. An existing configuration does not receive these defaults.

## Snippets

Toggle one-message prompt instructions with **Alt+S** or **/snippets**.
Use arrows to navigate, Space to toggle, Tab to preview, Enter to apply,
and Esc to cancel. Active snippets appear above the editor and reset after
sending or starting a session. Files reload when the menu opens or a message is sent.

Manage snippets alongside memories and commands:

```text
/bootstrap list [global|project] snippet
/bootstrap add [global|project] snippet
/bootstrap edit <id> snippet
/bootstrap delete <id> snippet
```

Add defaults to project scope. Add/edit opens plain Markdown:

```markdown
Respond concisely.
```

Files use `snippet-<8 UUID characters>.md`. Global files live in the agent's
`pi-bootstrap/snippets/` (respects `PI_CODING_AGENT_DIR`); project files live in
`.agents/bootstrap/snippets/`. Six defaults install when the global snippets
folder is missing or empty. Nonempty folders are left untouched.
No config rule is required, and snippets are not injected
into the system prompt.

Selected snippets are appended to your message, separated by blank lines.
Global snippets precede project snippets; each scope sorts by its first line,
which also serves as the display name. No frontmatter is used.
Disable standalone pi-snippets before using this integration.

## Skill search

Keyword search remains the default. The [opt-in semantic reranking contract](docs/skill-search-reranking.md)
defines global-only configuration, privacy bounds, and adapter behavior. Reranking
uses `@typesafe-ai/sdk` only after explicit opt-in, an explicit model, and a
`TYPESAFE_API_KEY` environment credential. Failures retain keyword results;
no automatic prompts or skill instruction loading change. Adoption requires
repository-specific accuracy, latency, and cost evaluation. The
[rollout evaluation status and operator guide](docs/skill-search-rollout.md)
records offline measurements and the explicitly blocked live comparison; it does
not recommend adoption.

## Example transformations

Save each TOML example below as a separate file in `commands/`.

### Replace a prompt section

```toml
description = "Tool discovery instructions"
section = "system_prompt.tools"
replacement = "Use tool discovery to find the required tools. Read each tool definition before use."
```

```xml
### Remove a section

```toml
section = "system_prompt.rules"
replacement = ""
```

### Move documentation into a link 

Save the original section body to a file and replace it with a reference:

```toml
section = "system_prompt.docs"
refer = "Pi documentation is at $link. Read it when you work on Pi."
link = "~/.config/pi/agent/pi-bootstrap/links/pi-docs.md"
```


### Add current project context

Capture command output at session start and add it to `<commands>`:

```toml
description = "Working tree status"
argv = ["git", "status", "--short"]
```
