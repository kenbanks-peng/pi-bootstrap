# Pi extension prompt and API capabilities

This document describes how an extension can change prompt content and tool access in Pi 1.0.0. It does not describe changes to the application’s trusted system instructions.

## Change the assembled system prompt

The main callback is `before_agent_start`. It runs after prompt submission and before the agent loop. It exposes mutable structured options:

| Field | What it controls |
|---|---|
| `customPrompt` | Replaces the default opening prompt. When set, Pi does not build its default `tools`, `rules`, or `docs` sections. |
| `forceSystemPrompt` | Uses exact text as the complete system prompt. |
| `selectedTools` | Selects the active tools. This affects prompt content and executable provider tools. |
| `toolSnippets` | Changes short tool descriptions in the prompt. |
| `toolGuidelines` | Changes instruction bullets contributed by tools. |
| `promptGuidelines` | Changes additional instruction bullets. |
| `appendSystemPrompt` | Changes or removes appended instructions. |
| `contextFiles` | Filters or rewrites loaded project instructions, such as `AGENTS.md`. |
| `skills` | Filters or changes skill metadata advertised to the model. |
| `sections` | Adds named prompt sections or replaces generated sections, except `preamble`. |
| `cwd` | Changes the working-directory text in the prompt. It does not change the actual execution directory. |

Example:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;

    options.skills = options.skills.filter(
      (skill) => skill.name === "diagnosing-bugs",
    );
    options.toolGuidelines.read = [];
    options.promptGuidelines.push("Use short, direct answers.");
    options.sections.policy = "Do not change files unless asked.";
  });
}
```

To replace the whole prompt for a run, return `systemPrompt`:

```ts
pi.on("before_agent_start", () => ({
  systemPrompt: "You are a coding assistant. Follow the user's instructions.",
}));
```

You can also set `forceSystemPrompt`. Full replacement changes prompt text; it does not disable tools. Tool declarations and execution have separate controls.

Empty custom sections are ignored. To omit the generated default sections, set `customPrompt` and add only the sections you need, or replace the whole prompt.

## Change model request content

| Callback | Capability |
|---|---|
| `input` | Pass input through, transform its text or images, or handle it without an agent run. |
| `before_agent_start` | Change the prompt for a run and optionally add a persistent custom message. |
| `context` | Add, remove, or rewrite conversation messages before each model call. Pi restores system-prompt and tool state afterward. |
| `context_with_system` | Change the full transcript, including system messages and tool declarations. The returned transcript is sent. Keep a system message at index zero. |
| `before_provider_request` | Inspect or replace the provider-specific request payload. |
| `before_provider_headers` | Change request headers in place. Set a header value to `null` to remove it. |

The `context` callback cannot remove Pi's system instructions. Use `before_agent_start` or `context_with_system` for that.

Bootstrap or memory content may be an ordinary conversation message, not part of `systemPromptOptions`. Filter or rewrite such messages in `context`. To stop their source from adding them, change or disable the extension that supplies them. Filtering a request does not delete stored session history.

## Add, remove, or change tools

- `pi.registerTool()` adds a model-callable tool with a description, parameter schema, and implementation.
- `pi.getAllTools()` returns configured tool metadata, including exposure and guidelines.
- `pi.getActiveTools()` and `pi.setActiveTools()` inspect or change active tool declarations.
- A tool's `prepareLoadout()` can replace declared descriptions or hide declarations while tools remain callable.
- `tool_call` can change arguments in place or block execution.
- `tool_result` can change result content, details, structured data, error state, or usage.

Exposure controls how tools are available:

| Exposure | Effect |
|---|---|
| `direct` | Declared to the model and callable while active. |
| `model-only` | Declared while active; not callable by another tool. |
| `codemode` | Callable through other tools while registered; normally not declared directly. |
| `deferred` | Like `codemode`, but discovered through tool search. |
| `hidden` | Registered but unreachable. |

Removing a tool from the active set does not necessarily disable it. `codemode` and `deferred` tools remain callable while registered. There is no general tool-unregister API. Re-register a tool with `exposure: "hidden"` to withdraw it. MCP servers have `registerMcpServer()` and `unregisterMcpServer()`.

## Other callbacks and APIs

- `message_end` can replace a completed message while preserving its role.
- `session_before_compact` can cancel compaction or supply a custom result.
- `turn_end` and `agent_before_settle` can append context edits, custom messages, or compaction entries, and request one continuation.
- Session events cover startup, shutdown, switching, forking, and tree navigation.
- Other events report messages, turns, tool execution, model selection, and provider responses.

For model-facing content, use `pi.sendMessage()` or `pi.sendUserMessage()`. `pi.appendEntry()` stores extension state but does not send it to the model. Rendering APIs change terminal display, not model input.

## SDK startup controls

When you create the Pi session, the SDK provides broader startup control:

- `DefaultResourceLoader` supports `systemPromptOverride`, `appendSystemPromptOverride`, `skillsOverride`, `agentsFilesOverride`, `extensionsOverride`, and `promptsOverride`.
- It also supports `noSkills`, `noContextFiles`, and `noExtensions`.
- You can provide a custom `ResourceLoader`.
- `createAgentSession()` accepts `tools`, `noTools`, `excludeTools`, `customTools`, and custom settings and session managers.
- `session.systemPrompt` is read-only. Use resource-loader settings or extension callbacks to change it.

## References

Based on Pi 1.0.0 documentation and declarations: `docs/extensions.md`, `docs/sdk.md`, `dist/core/extensions/types.d.ts`, `dist/core/system-prompt.js`, and `dist/core/resource-loader.d.ts`. Cross-checked with Context7 library `/earendil-works/pi`.
