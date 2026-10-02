# Startup context replacement plan

## Goal

Reduce and reword Pi startup context using a user-editable TOML lookup, without LLM calls. Cover the separate system prompt and Message3's sections. Leave Message1 (prime output) and Message2 (additional tools) unchanged.

Treat message numbers as labels from `BREAKDOWN.md`, not stable transcript indexes. The generated context changes as Pi, tools, skills, and configuration change.

## TOML layout

Keep replacement text outside extension source code in a standalone TOML file. Its location is to be decided.

```toml
[system_prompt]
original = """Current assistant identity text."""
# replacement = """Your revised identity text."""
source_hash = "..."

[message3.preamble]
original = """Current preamble."""
# replacement = """Your revised preamble."""
source_hash = "..."

[message3.tools]
original = """Current tools section."""
# replacement = """Your revised tools section."""
source_hash = "..."

[message3.rules]
original = """Current rules section."""
# replacement = """Your revised rules section."""
source_hash = "..."

[message3.docs]
original = """Current Pi documentation guidance."""
# replacement = """Your revised documentation guidance."""
source_hash = "..."

[message3.skills]
# Individual skill description replacements live below.

[message3.skills.entries.archify]
original = """Current skill description."""
# replacement = """Your revised skill description."""
source_hash = "..."

[message3.cwd]
original = "/actual/session/working/directory"
# Leave unchanged by default.
```

Also support granular tool replacements so installing a tool does not require rewriting the whole tools or rules section:

```toml
[message3.tools.entries.read.snippet]
original = "Read the contents of a file."
# replacement = "Read files."
source_hash = "..."

[message3.tools.entries.read.guidelines]
original = [
  "Use read to examine files instead of cat or sed."
]
# replacement = ["Read files with read, not shell commands."]
source_hash = "..."
```

- The extension populates original text and hashes; the user supplies replacements.
- An absent replacement preserves generated content. Empty replacements need explicit validation because Pi ignores empty custom sections rather than suppressing defaults.
- Prefer granular replacements for dynamic tools and skills. An explicit whole-section replacement takes precedence over granular entries for that section and should be flagged when its source changes.
- Skill replacements change advertised descriptions, not installed `SKILL.md` files.
- Working-directory text remains accurate by default; editing it does not change the execution directory.

## Discovery and review workflow

1. Inspect the current prompt inputs and tool inventory; do not assume a known installation.
2. Add newly discovered entries with their original text and no active replacement.
3. Notify the user in Pi's UI when entries are missing replacements or need review. Deduplicate notifications; do not add model-facing messages for reminders.
4. Reload the TOML when it changes and apply approved replacements on the next submission.
5. Detect upstream changes using source hashes. Preserve the user's replacement and its reviewed source; record the changed source separately for comparison. Use current original text until the stale replacement is reviewed.
6. On invalid TOML, report the problem in the UI and leave generated content unchanged.

Use comment-preserving TOML edits and safe writes for automatic additions. Never overwrite user edits or formatting. Repeated runs with unchanged inventory should not rewrite the file.

An optional slash command could show the file location and pending/stale entries. No command exists yet; `/bootstrap` was only a proposed name, not a Pi built-in.

## Extension integration

- **`before_agent_start`:** Main application point. Transform the current `systemPromptOptions` on each user submission, not each internal model/tool turn. Applying cached replacements is inexpensive local work.
- **`skills`:** Substitute descriptions while retaining current names, locations, and other metadata.
- **`toolSnippets` / `toolGuidelines` / `promptGuidelines`:** Apply granular prose replacements without changing tool availability.
- **`sections`:** Apply explicit section replacements for tools, rules, and docs. Cannot replace `preamble`; empty section values do not suppress defaults.
- **`pi.getAllTools()` / `getActiveTools()`:** Inspect current tool metadata and availability. Do not alter active tools merely to shorten prose.
- **`context_with_system`:** Potential fallback for the separate identity text and Message3's preamble. First verify how these are represented and whether they are extension-editable in the actual transcript. Preserve Message1/2 and a system message at index zero. Do not assume this can alter application-level trusted instructions.
- **`before_provider_request`:** Inspect the final request to verify replacements, detect other extension contributions, and measure savings. Avoid provider-specific rewriting unless structured mechanisms prove insufficient.

Avoid full prompt replacement as the default: it transfers responsibility for Pi's evolving generated instructions to this extension. Ordinary `context` cannot remove Pi's system instructions.

## Validation

- Verify Messages1/2 are unchanged in the final request.
- Verify missing, stale, and invalid replacements preserve current generated text.
- Exercise installation, removal, and description changes for tools and skills.
- Verify repeated submissions and TOML edits behave correctly without restarting Pi.
- Verify section precedence, comment preservation, and concurrent-edit safety.
- Check that tool declarations and execution availability are unchanged.
- Report before/after section sizes; measure hook latency rather than assuming a performance result.
