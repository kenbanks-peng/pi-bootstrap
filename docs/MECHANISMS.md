# Bootstrap context mechanisms

## Source and integration

The extension reads the complete transcript from Pi's `context_with_system` event. It changes outgoing system text only. Tool declarations, tool access, resource files, stored messages, conversation messages, and null section deletions remain unchanged.

`docs/pi-baseline.md` is a historical capture of the older layout, not runtime input.

## Configuration

Configuration contains direct system replacement tables and a reserved tools table:

```toml
[system_prompt.preamble]

[system_prompt.tools]
replacement = "TOOLS REPLACEMENT TEXT"

[system_prompt.rules]

[system_prompt.docs]

[system_prompt.skills]

[system_prompt.cwd]

[system_prompt.prime]

[tools]
```

An absent replacement keeps the original text. A replacement must be a nonempty string. The extension reads configuration on every request and adds empty tables for discovered system content. An empty `[system_prompt]` enables system discovery. Omit that scope to disable discovery.

Do not set `kind`, `role`, `version`, or `mechanisms`. The separate `[tools]` table is reserved and must remain empty. Tool declarations are outside the system prompt and remain unchanged. `system_prompt.tools` controls only the text inside the system `<tools>` tag.

## System context

All system sections use outer tags. Their stable keys are `system_prompt.<tag>`, including `preamble` and `prime`. Nested memories, commands, and skill fields belong to their outer section.

Structured section values contain their tags. Flat and structured context use the same replacement keys. Section replacements change the body only and keep tags, attributes, and surrounding text. Repeated sections receive the same replacement. Unknown text remains unchanged and is reported.

Untagged text before the first section and Pi's untagged structured `preamble` field also use `system_prompt.preamble`. A flat system prompt with no tags is all preamble.

## Conversation messages

Conversation messages are outside the system prompt. The extension does not scan, discover, or replace their content. Tagged user envelopes, text blocks, images, and malformed tag examples remain unchanged. There is no `message` configuration scope.

## Parsing and failures

Tags are XML-like context tags, not HTML. Parsing tracks nested tags and ignores backtick and tilde code fences. Safe names use lowercase letters, digits, underscores, and hyphens.

Invalid TOML, unsupported fields, unsafe names, invalid replacements, and malformed system tags stop all replacements for the request. The original request remains unchanged.

Discovery retains existing comments and formatting. Writes use a lock, a temporary file, and a source comparison. Save editor changes between requests. Remove a leftover lock only after all Pi processes that use the config have stopped.

Run `/bootstrap` to inspect missing replacements, unidentified system text, errors, and transcript text sizes. Sizes are bytes, not provider token counts.

## Convert older configuration

1. Keep a copy of the old config.
2. Start from `default.toml`.
3. Move replacements from `system_prompt.sections.<tag>` to `system_prompt.<tag>`.
4. Keep the `system_prompt.preamble` replacement.
5. If appropriate, move the old prime-envelope replacement to `system_prompt.prime`. It now affects the system `<prime>` body, not a user message.
6. Remove `message`, `bootstrap`, format metadata, and old mechanism settings. Keep `[tools]` empty.
7. Submit a request and inspect `/bootstrap`.

There is no automatic conversion. Existing config files are not overwritten.
