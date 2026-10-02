# Bootstrap context mechanisms

## Source and integration point

`docs/pi-baseline.md` is a request capture, not runtime input. Its outer `meta`, `headers`, `request`, `system-prompt`, `messages`, and `response` tags belong to the logger. The extension does not process those wrappers.

The runtime source is the complete transcript from Pi's `context_with_system` event. This includes system section snapshots and deltas, tool declarations, and conversation messages. The extension discovers existing text and returns copy-on-write replacements before provider encoding. It keeps the leading system message and preserves section deletions.

One request-local hook is sufficient. There is no `before_agent_start` rewrite of prompt options. This lets the extension process the assembled context, including bootstrap messages that are not prompt options, without changing resource metadata or session history.

## Configuration

Set `version = 2`. Define named tables under `mechanisms`. Names are for the user; `kind` selects the behavior. An empty `[mechanisms]` table disables discovery. Unsupported fields, duplicate selectors, and unsafe tag names are errors.

### Preamble

```toml
[mechanisms.preamble]
kind = "preamble"
```

Selects the structured system `preamble`, or the text before the first outer tag in a flat system prompt. A flat prompt with no outer tags is all preamble. Its stable replacement key is `system_prompt.preamble`.

The baseline identity is part of this preamble. There is no separate synthetic identity selector.

### Tagged system sections

```toml
[mechanisms.system_sections]
kind = "tagged_sections"
```

Selects each outer tagged section in system text. Stable keys are `system_prompt.sections.<tag>`. The baseline has `tools`, `rules`, `docs`, `skills`, and `cwd`. Other tags, such as `project_context` and `addendum`, need no new mechanism.

Nested content belongs to its outer section. For example, `available_skills`, repeated `skill` entries, and their fields are all inside `skills`. They are not separate replacement keys.

Structured Pi section values already contain their tags. Flat system content uses the same keys. Replacements change only section bodies. Opening tags, attributes, closing tags, and surrounding text remain in place. Line breaks next to the body use the source LF or CRLF style.

If several snapshots contain the same section, the replacement applies to each occurrence. Null section deltas remain null. Text outside identified regions remains unchanged and is reported.

### Tagged bootstrap messages

```toml
[mechanisms.prime]
kind = "tagged_message"
role = "user"
tag = "prime_session"
```

Selects a user message whose entire text is a tagged envelope. The opening tag must occupy its own line. Attributes are allowed. The stable key is `bootstrap.<tag>`; the default is `bootstrap.prime_session`.

The selector does not use a message number. It ignores ordinary messages, assistant messages, fenced examples, and messages with text outside the envelope. Text blocks are supported, and image blocks remain unchanged.

A replacement changes the whole envelope body, including any memories and command output. It keeps the envelope and its attributes. There are no selectors for repeated memory or command records because the baseline supplies no stable record identifiers. Use a whole-envelope replacement only when you intend to replace all of that content.

The default does not select the context-mode message or session-state tags. To select another standalone user envelope, define another `tagged_message` mechanism with its tag. This does not select a tag embedded in surrounding prose.

## Tag parsing

These are XML-like context tags, not an HTML DOM. Outer tags occupy complete lines. Nested tags can be inline, as the baseline's memory and skill fields are. Parsing tracks nested open and close tags and ignores backtick and tilde code fences. It supports safe lowercase tag names with digits, underscores, and hyphens.

Malformed or unclosed tags stop all replacements for that request. Unsupported system content is reported and retained. The parser is not a general HTML parser and does not support HTML void-element rules.

## Replacement storage and failure behavior

Discovery adds empty tables only. It does not store generated prompt text. Replacement values must be nonempty strings. Stable context keys keep a replacement active when the upstream wording changes.

Config is read on every model request. Existing comments and formatting are retained. Writes use a lock, a temporary file, and a source comparison before commit. Save editor changes between requests; an editor does not use the extension's lock. Remove a leftover lock only after all Pi processes that use this config have stopped.

Invalid TOML, invalid mechanisms, wrong replacement types, or discovery errors leave the entire request unchanged. Unknown system text is also unchanged. Tool declarations and tool availability are outside the replacement interface. Replacing the tools summary does not change executable tools; replacing the cwd text does not change the execution directory.

The report measures transcript text bytes, including conversation text and structured system sections. It is not a provider token count and does not include tool schemas, image data, or HTTP metadata.

## Convert a version 1 config

1. Keep a copy of the old config.
2. Replace its mechanism definitions with `default.toml` and set `version = 2`.
3. Move whole-section replacements to `system_prompt.sections.<tag>`.
4. Move the preamble replacement to `system_prompt.preamble`.
5. Remove generic source paths, target paths, granular metadata selectors, and precedence definitions.
6. Submit a request. Inspect `/bootstrap` before you add more replacements.

There is no automatic conversion. This prevents old message-position assumptions from changing the new context.
