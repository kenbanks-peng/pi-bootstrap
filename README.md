# pi-bootstrap

Replace tagged text in Pi requests with values from `config.toml`.

## Configuration

On the first request, the extension copies [default.toml](default.toml) to
`~/.pi/agent/extensions/pi-bootstrap/config.toml` if that file is missing.
Existing config files stay unchanged. Edit `config.toml` to set replacements.
If `PI_CODING_AGENT_DIR` is set, use that directory instead of `~/.pi/agent`.

```toml
[one]
replacement = "New content"
```

Changes `<one>Old content</one>` to `<one>New content</one>`.

For a nested tag:

```toml
[one.two]
replacement = "New content"
```

Changes `<one><two>Old content</two></one>` to
`<one><two>New content</two></one>`.

For text at the start or end of any tag body:

```toml
[abc.preamble]
replacement = "New start"

[abc.postamble]
replacement = "New end"
```

For `<abc>Before<def>hi</def>After</abc>`, this produces
`<abc>New start<def>hi</def>New end</abc>`.

- `preamble` selects text after the opening tag and before the first child tag.
- `postamble` selects text after the last child tag and before the closing tag.
- These suffixes are reserved references. They work at any depth, with any parent name.
- Self-closing tags form boundaries. Tags inside code fences and unmatched tags do not.
- If there are no child tags, either reference selects the complete body.
- Empty edge regions accept inserted text. Whitespace is part of the selected text.
- Whole-body replacements take precedence over these references.

For tools guidance in the system prompt:

```toml
[system_prompt.tools]
replacement = "TOOLS REPLACEMENT TEXT"
```

Pi stores system text without an outer tag. The extension supplies `system-prompt`
as its parent for matching, without adding it to the outgoing text.
`system_prompt` selects this parent through the generic underscore fallback.
The same rule applies to arbitrary nested tags: `[system_prompt.one.two]`.
`[system_prompt.preamble]` and `[system_prompt.postamble]` select the edges of\nthe system text without an outer tag. Tool declarations stay unchanged.

- Paths match complete, case-sensitive tag ancestry.
  Each segment uses its exact name first. If that name is absent under the selected
  parent, `_` is changed to `-` as a fallback. For example, `[abc_def.ghi_jkl]`
  can select `<abc-def><ghi-jkl>…</ghi-jkl></abc-def>`.
  If both names exist, only the exact name is selected.
  System-specific paths take precedence over unprefixed paths such as `[one.two]`.
- Replacement strings are inserted exactly. An empty string removes the body.
- Tags, attributes, and text outside the selected body stay unchanged.
- Repeated matches are replaced. If both parent and child have replacements, the parent wins.
- Tags inside Markdown code fences are ignored. Self-closing tags have no body.
- All message text is processed, including system sections and text blocks.
  Other data and stored history stay unchanged.
- The config is read for each request. A missing config is created from `default.toml`.
  Invalid config causes a handler error; no partial result is returned.
  Unmatched tag-like text, such as `Map<string>`, stays unchanged.

## Load

Add the absolute path to `index.ts` to the `extensions` array in your Pi settings.
Run `/reload`.

## Development

```sh
npm install
npm test
npm run typecheck
```
