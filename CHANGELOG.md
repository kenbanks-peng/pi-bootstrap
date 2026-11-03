# Changelog

## 2.0.0

### Breaking changes

- Move global Bootstrap configuration from `<pi-agent-folder>/extensions/pi-bootstrap` to `<pi-agent-folder>/pi-bootstrap`.
- The agent folder is set by `PI_CODING_AGENT_DIR`, falling back to `~/.config/pi/agent` when unset or empty.

### Migration

Move existing configuration to the new location and update any explicit paths, including documentation links. Configuration is not migrated automatically; the old location is no longer read.
