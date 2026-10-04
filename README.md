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

These files go in the agent directory under `extensions/pi-bootstrap`. Existing files are not overwritten. An existing configuration does not receive these defaults.

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
link = "~/.config/pi/agent/extensions/pi-bootstrap/links/pi-docs.md"
```


### Add current project context

Capture command output at session start and add it to `<commands>`:

```toml
description = "Working tree status"
argv = ["git", "status", "--short"]
```
