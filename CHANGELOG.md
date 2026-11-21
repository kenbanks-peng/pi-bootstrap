# Changelog

## Unreleased

### Changed

- Remove snippet descriptions; names alone identify snippets in the menu.

## 2.1.0

### Added

- One-message prompt snippets, selectable with **Alt+S** or **/snippets**, with previews and an active-snippet indicator. Selections reset after sending or starting a session.
- Manage global and project snippets with `/bootstrap list|add|edit|delete ... snippet`. Markdown frontmatter controls name, description, prepend/append placement, and order.
- Six default snippets installed globally once; edits and deletions persist. Snippets reload when the menu opens or a message is sent and modify the user message, not the system prompt.

## 2.0.0

### Breaking changes

- Move global Bootstrap configuration from `<pi-agent-folder>/extensions/pi-bootstrap` to `<pi-agent-folder>/pi-bootstrap`.
- The agent folder is set by `PI_CODING_AGENT_DIR`, falling back to `~/.config/pi/agent` when unset or empty.

### Migration

Move existing configuration to the new location and update any explicit paths, including documentation links. Configuration is not migrated automatically; the old location is no longer read.
