# pi-bootstrap

Replace tagged bodies in Pi's outgoing request with TOML values. No model calls are made.

## Request hierarchy

[docs/pi-baseline.md](docs/pi-baseline.md) is the reference layout:

```xml
<request>
  <system-prompt>
    <tools>Tools guidance</tools>
    <docs>Documentation</docs>
  </system-prompt>
  <tools>Provider tool declarations</tools>
  <messages>
    <message role="user">User text</message>
  </messages>
</request>
```

Configuration starts at the children of `request`. Thus, docs use:

```toml
[system-prompt.docs]
replacement = "Use the installed Pi documentation."
```

Use `[system-prompt.tools]` for tools guidance. The peer `[tools]` contains structured declarations, not guidance. Text replacements there are rejected; tool names, schemas, and execution remain unchanged.

Pi supplies system text without the capture's outer `system-prompt` tag. The adapter restores that ancestry for matching. It also supplies `messages.message` for conversation text. These containers are never inserted into outgoing text.

Within each container, paths are generic. For system text `<one><two>Old</two></one>`, use `[system-prompt.one.two]`. For the same tags in a conversation message, use `[messages.message.one.two]`. There is no fixed list of child tags or nesting depths.

## Use

Add the absolute path to `index.ts` to the `extensions` array in your Pi settings. Run `/reload`, or start a new session.

On the next model request, the extension creates `$PI_CODING_AGENT_DIR/extensions/pi-bootstrap/config.toml`, or `~/.pi/agent/extensions/pi-bootstrap/config.toml` by default. [default.toml](default.toml) contains comments only. Discovery adds empty tables for actual tag paths, with their request containers. Existing config files are not overwritten.

Add a nonempty string `replacement` to a discovered table. Save changes between requests. Run `/bootstrap` to inspect errors, missing replacements, untagged text, and text sizes.

## Rules

- Match the complete path, including the request container. Names are case-sensitive. `system-prompt` and `system_prompt` are different names.
- Scan every message role, string content, text blocks, and string section values. Section storage keys do not add another path segment.
- Preserve tags, attributes, surrounding text, images, tool declarations, and stored history.
- Apply repeated matches. Reject active parent/child replacements that overlap.
- Keep untagged text unchanged. Ignore tags inside Markdown code fences.
- Malformed tags or invalid configuration stop all replacements for the request.
- Select tagged bodies inside transport containers; replacing an entire transport container with prose is not supported.

## Existing configurations

For this baseline, change `[docs]` or `[system_prompt.docs]` to `[system-prompt.docs]`. Change a guidance replacement under `[tools]` to `[system-prompt.tools]`.

There is no automatic conversion. Use the hierarchy in [docs/pi-baseline.md](docs/pi-baseline.md), not field names or capture metadata. The event remains `context_with_system`; no `event` setting is needed.

See [docs/MECHANISMS.md](docs/MECHANISMS.md) for the full contract.

## Development

Install dependencies with `npm install`. Run `npm test` and `npm run typecheck`. Pi supplies the extension API at runtime.
