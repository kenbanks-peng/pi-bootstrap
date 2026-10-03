# Bootstrap context mechanisms

## Source and integration

The extension reads the complete transcript at Pi's `context_with_system` event. It scans string content, text blocks, and string values in structured sections, in every message role. Each text container is parsed independently; a tag path cannot span messages or blocks.

Changes affect outgoing text only. Tool declarations, executable tools, images, non-text blocks, resource files, stored messages, unrelated fields, and null section deletions remain unchanged.

[pi-baseline.md](pi-baseline.md) is the reference request hierarchy and an integration-test fixture. The file is not loaded at runtime. Configuration starts at the children of its `request` container.

## Literal paths

A scope combines its request-container ancestry with the literal nested tag path. `src/pi-context.ts` maps system content and system section values to `system-prompt`, and conversation text to `messages.message`. `src/prompt.ts` accepts that parent path without knowing any Pi section names. It has no fixed list of child tags and no scope aliases.

```toml
[system-prompt.one.two]
replacement = "New text."
```

This selects the body of `<two>` in system text `<one><two>Old text.</two></one>`. The baseline shows that text inside `<system-prompt>`. It does not select a standalone `<two>`, `<other><two>`, or the same tags in a conversation message. For conversation text, use `[messages.message.one.two]`.

The path includes the complete ancestry beneath the request root, including the transport container. The adapter supplies that container even when Pi stores only its body. Any nesting depth uses the same rule. Matching is case-sensitive. Inline tags and multiline bodies use the same rules. Attributes do not change the path.

Structured section names are storage fields, not implicit tags. A section field named `anything` with value `<one><two>Old</two></one>` in a system message has scope `system-prompt.one.two`. Untagged values have no scope, even in a field named `preamble`.

Within transport containers, names such as `tools`, `prime`, and `preamble` are ordinary tags. At the request root, `tools` is the separate structured declaration collection shown in the baseline. Prose replacements there are rejected; they never fall back to system guidance. Use `[system-prompt.tools]` for that guidance. `system_prompt` does not match `system-prompt`.

The transport containers themselves (`system-prompt`, `messages`, and `messages.message`) are not single tagged text bodies in Pi storage. Replacements directly on those containers are rejected with an explicit error. Select a tagged body inside them instead. This avoids duplicating a whole-container replacement across stored sections or text blocks.

## Configuration and discovery

The default contains comments only. It does not change text.

The extension reads config on every request. Discovery creates empty tables for paired tag paths, including nested paths and empty bodies. It retains existing comments and formatting. Existing files are not replaced with the default.

A string field named `replacement` supplies the body replacement for its table. It must contain non-whitespace text. Other values must be nested tables. A nested table named `replacement` is a literal child tag scope, not a replacement value:

```toml
[system-prompt.one.replacement]
replacement = "New text."
```

This selects `<one><replacement>Old</replacement></one>` within the system prompt. TOML cannot represent both a scalar replacement and a child table with that same key in one parent.

Missing replacements keep original bodies. Discovery does not depend on config scope names being present. Config tables without a matching tag do not change the request.

## Replacement rules

Only the selected tag's body is changed. Opening and closing tags, attributes, and surrounding bytes remain unchanged. Existing leading and trailing line breaks inside the body are retained, including CRLF. Inline bodies do not receive new line breaks.

Repeated paths receive the same replacement. Writes run from the last offset to the first. Input messages are not mutated; unrelated objects keep their identity.

Active replacements for a parent and its descendant in the same text are an error. The request stays unchanged. An empty parent table is not an active replacement and does not conflict with a child replacement. Matching parent and descendant paths in separate text containers do not overlap.

## Parser and failures

The parser recognizes XML-like paired tags, not complete XML or HTML documents. Names start with a letter or underscore; subsequent characters can include letters, digits, underscores, hyphens, periods, and colons. Quote TOML path segments that contain periods. The names `__proto__`, `prototype`, and `constructor` are rejected for object safety.

Backtick and tilde Markdown code fences are ignored. Put literal malformed tag examples in fenced blocks if they must not be parsed. Tags are parsed within one line; bodies can span lines. Self-closing tags have no body and are not replacement scopes.

Invalid TOML, invalid table types, invalid replacements, unsafe names, unbalanced tags in any scanned text, and overlapping active replacements stop all replacements for the request. Parsing and overlap checks run before config discovery writes.

Untagged text is retained and reported. It is not assigned a synthetic scope. The Pi adapter preserves the baseline request containers as path metadata, without writing wrapper tags into the outgoing text. Other capture fields such as headers, params, and response are outside transcript text. Provider tool declarations are structured data, not text-tag bodies.

Writes use a lock, a temporary file, and a source comparison. Save editor changes between requests. Remove a leftover lock only after all Pi processes that use the config have stopped.

Run `/bootstrap` to inspect errors, missing replacements, untagged text, and transcript text sizes. Sizes are bytes, not provider token counts.

## Convert older configuration

1. Keep a copy of the old config.
2. Start from [../default.toml](../default.toml).
3. Submit a request to discover actual tag paths.
4. Move replacement values to the full request paths. For docs in the baseline, use `[system-prompt.docs]`, not `[docs]` or `[system_prompt.docs]`.
5. Move system guidance replacements from `[tools]` to `[system-prompt.tools]`. Keep the system container prefix. Raw preamble text has no synthetic replacement scope.
6. Do not activate both a parent and a descendant replacement for the same text.
7. Submit another request and inspect `/bootstrap`.

There is no automatic conversion or backward-compatibility alias.
