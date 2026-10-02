# Startup context replacement plan

## Goal

Change Pi startup text through a user-editable TOML file, without model calls. Use stable names to select replacements. Do not use source text or hashes as identifiers.

Leave prime output, additional tool messages, tool declarations, skill files, and the actual working directory unchanged.

## Configuration

The extension uses `$PI_CODING_AGENT_DIR/extensions/pi-bootstrap/config.toml`, or `~/.pi/agent/extensions/pi-bootstrap/config.toml` by default.

```toml
[system_prompt]
replacement = "Your assistant identity."

[message3.preamble]
replacement = "Your preamble."

[message3.docs]
replacement = "Use the installed Pi documentation."

[message3.tools.entries.read.snippet]
replacement = "Read files."

[message3.tools.entries.read.guidelines]
replacement = ["Use read for files."]

[message3.rules.prompt_guidelines]
replacement = ["Be brief."]

[message3.skills.entries.archify]
replacement = "Draw system diagrams."
```

- Whole sections use `message3.<section>`: preamble, tools, rules, docs, skills, or cwd.
- Tools and skills use their registered names, including quoted names when necessary.
- Only `replacement` is required. Discovery does not add generated prompt text to the file.
- Replacements stay active when the source text changes. There is no hash approval or source-history table.
- An absent replacement keeps generated text. Empty strings, empty arrays, blank array items, and wrong replacement types are rejected.
- Whole-section replacements take precedence over granular entries. The tools section also takes precedence over tool guidelines.
- A cwd replacement changes only advertised text. It does not change the execution directory.

Message numbers are labels from `BREAKDOWN.md`, not fixed transcript indexes.

## Discovery and application

1. Read current prompt inputs and the installed tool inventory.
2. Read the TOML on each submission.
3. Add empty tables for new stable paths. Retain existing entries, comments, and formatting. Do not add generated text.
4. Apply active replacements by path, regardless of changes to source prose.
5. Report entries without replacements in the UI. Deduplicate notifications.
6. If the TOML or an active entry is invalid, report the error and keep generated text unchanged.

Use a lock, a temporary file, and a source comparison before writes. Do not rewrite unchanged files. Retain settings for removed tools and skills; apply them if the same name returns.

## Pi integration

- `before_agent_start` discovers sources and changes structured prompt options.
- `sections` replaces generated sections except preamble.
- `toolSnippets`, `toolGuidelines`, `promptGuidelines`, and `skills` support granular changes.
- `context_with_system` changes request-local preamble text and leading identity text when present.
- Do not set `customPrompt` to change only the preamble: it disables generated tools, rules, and docs.
- `/bootstrap` shows the file location, entries without replacements, section sizes, and hook times.

Identity text is editable only if Pi exposes it as leading system content. Trusted instructions outside Pi's transcript are not editable.

## Validation

- Source-text changes must not disable configured replacements.
- Replacement-only tables must work without original text or hashes.
- Test tool and skill installation, removal, and description changes.
- Test whole-section precedence, type validation, comment preservation, and lock safety.
- Preserve prime messages, tool declarations, tool selection, skill locations, and context files.
- Test repeated submissions and configuration edits with the real Pi prompt builder.
- Run `npm test` and `npm run typecheck`.
