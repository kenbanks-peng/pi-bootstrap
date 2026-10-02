# Bootstrap context mechanisms

## Source and integration

The extension reads the complete transcript from Pi's `context_with_system` event. It changes outgoing text only. Tool declarations, tool access, resource files, stored messages, and null section deletions remain unchanged.

`docs/pi-baseline.md` is a reference capture, not runtime input. Its logger wrappers are not context selectors.

## Configuration

Configuration contains replacement tables only:

```toml
[system_prompt.preamble]

[system_prompt.sections.docs]
replacement = "Use the installed Pi documentation."

[message.prime_session]
```

An absent replacement keeps the original text. A replacement must be a nonempty string. The extension reads configuration on every request and adds empty tables for discovered content in enabled scopes. An empty `[system_prompt]` or `[message]` enables that scope. Omit a scope to disable its discovery.

Format and role rules stay inside the extension. Do not set `kind`, `role`, `version`, or `mechanisms`.

## System context

System sections have outer tags. Their stable keys are `system_prompt.sections.<tag>`. Nested tags belong to their outer section.

The preamble is untagged text before the first section. A flat system prompt with no sections is all preamble. Pi's structured `preamble` field uses the same `system_prompt.preamble` key.

Structured section values contain their tags. Flat and structured context use the same replacement keys. Section replacements change the body only and keep tags, attributes, and surrounding text. Repeated sections receive the same replacement. Unknown text remains unchanged and is reported.

## Message content

`prime_session` is a tag inside a user message, not a message type. The extension selects standalone tagged envelopes in user message text. It does not assign a role to messages or change existing roles. Other roles are not selected.

The stable key is `message.<tag>`. Other standalone user envelopes are discovered without new format settings. Opening tags must occupy their own line; attributes are allowed. Ordinary prose, fenced examples, inline envelopes, and text outside an envelope are not selected.

A replacement changes the entire envelope body and keeps its tags and attributes. Text blocks are supported; image blocks remain unchanged. Nested memories and commands stay inside their envelope and have no separate replacement keys.

## Parsing and failures

Tags are XML-like context tags, not HTML. Parsing tracks nested tags and ignores backtick and tilde code fences. Safe names use lowercase letters, digits, underscores, and hyphens.

Invalid TOML, unsupported fields, unsafe names, invalid replacements, and malformed tags stop all replacements for the request. The original request remains unchanged.

Discovery retains existing comments and formatting. Writes use a lock, a temporary file, and a source comparison. Save editor changes between requests. Remove a leftover lock only after all Pi processes that use the config have stopped.

Run `/bootstrap` to inspect missing replacements, unidentified system text, errors, and transcript text sizes. Sizes are bytes, not provider token counts.

## Convert older configuration

1. Keep a copy of the old config.
2. Remove `kind` from `[system_prompt]`.
3. Remove `kind` and `role` from `[message]`.
4. Keep replacements under `system_prompt.preamble`, `system_prompt.sections.<tag>`, and `message.<tag>`.
5. For older mechanism-based configs, start from `default.toml` and move whole-envelope replacements from `bootstrap.<tag>` to `message.<tag>`. Remove old mechanism, version, and generic path settings.
6. Submit a request and inspect `/bootstrap`.

There is no automatic conversion. Existing config files are not overwritten.
