import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerBootstrap } from "../index.ts";
import { registerBootstrapSession } from "../src/bootstrap-session.ts";
import { fixture, memory, command, executable, protocol, actions } from "./session-fixture.ts";

// Exercise the installed host's real conversion and provider request builder, not
// a hand-written approximation of how system sections reach an API.
const hostEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const hostRequire = createRequire(hostEntry);
const aiRoot = hostRequire.resolve.paths("@earendil-works/pi-ai")!
  .map(path => join(path, "@earendil-works/pi-ai/dist"))
  .find(path => existsSync(join(path, "index.js")))!;
const { stream } = await import(pathToFileURL(join(aiRoot, "api/openai-responses.js")).href);
const { convertToLlm } = await import(pathToFileURL(join(dirname(hostEntry), "core/messages.js")).href);

function harness(repositoryFor: Parameters<typeof registerBootstrapSession>[1]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    registerCommand: () => {},
    getAllTools: () => [{ name: "read" }],
    getActiveTools: () => ["read"],
    sendMessage: () => assert.fail("Bootstrap must never call sendMessage"),
    sendUserMessage: () => assert.fail("Bootstrap must never call sendUserMessage"),
    appendEntry: () => assert.fail("Bootstrap must not persist snapshots"),
  };
  const snapshot = registerBootstrapSession(pi as never, repositoryFor);
  return { handlers, pi, snapshot };
}
const context = (cwd: string) => ({ cwd, hasUI: false, ui: { notify() {} } });
function freeze(value: any): any {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test("real outgoing provider payload keeps bootstrap in system instructions, never user messages", async t => {
  const f = await fixture(t);
  const marker = join(f.root, "executions");
  await memory(f.project, "guidance.md", "Only system <guidance>");
  await command(f.project, "skills.toml", "description = \"Skills:\"\nsection = \"system_prompt.skills\"\nexpression = 'ALL_SKILLS.map(s => s.name).join(\", \")'");
  await command(f.project, "tools.toml", 'description = "Test command"\nexpression = \'"Registered tools: " + ALL_TOOLS.map(t => t.name).join(",")\'\n');
  await command(f.project, "once.toml", executable(`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('Snapshot output')`));
  const h = harness(() => f.repository);
  await actions(f.global, { "system_prompt.preamble": "Replaced", "system_prompt.rules": { refer: "Read $link", link: "rules.md" }, "system_prompt.postamble": "Tail" });
  registerBootstrap(h.pi as never, () => f.repository, h.snapshot, messages => messages, h.snapshot.sections);
  await h.handlers.get("session_start")!({}, context(f.projectRoot));
  await h.handlers.get("before_agent_start")!({ systemPromptOptions: { skills: [{ name: "alpha", description: "Private description", filePath: "/alpha/SKILL.md", baseDir: "/alpha" }] } }, context(f.projectRoot));
  const history = freeze([
    { role: "system", content: [{ type: "text", text: "Original" }], sections: { rules: "<rules>Keep me</rules>", skills: "<skills>Old catalog</skills>" }, toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }], timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "Question" }], timestamp: 1 },
    { role: "system", content: "", sections: { rules: "<rules>Updated rules</rules>", skills: "<skills>Historical catalog</skills>" }, timestamp: 2 },
  ]);
  const before = structuredClone(history);
  for (const supportsMidConvoSystemMessages of [false, true]) {
    const result = await h.handlers.get("context_with_system")!({ messages: history }, { cwd: f.projectRoot });
    let payload: any;
    const response = await stream({
      id: "test", name: "test", api: "openai-responses", provider: "openai", baseUrl: "https://example.invalid/v1",
      reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsMidConvoSystemMessages },
    }, { messages: convertToLlm(result.messages) }, {
      apiKey: "test-not-a-real-key",
      fetch: async (_url: unknown, init: RequestInit) => {
        payload = JSON.parse(init.body as string);
        // Capture actual outgoing JSON without contacting a provider.
        return new Response(JSON.stringify({ error: { message: "intentional test response" } }), { status: 400, headers: { "content-type": "application/json" } });
      },
    }).result();
    assert.equal(response.stopReason, "error");
    assert.ok(payload, "provider must reach the HTTP request boundary");
    assert.equal(payload.input[0].role, "system");
    assert.match(payload.input[0].content, /<memory>[\s\S]*Only system &lt;guidance&gt;[\s\S]*Snapshot output[\s\S]*<\/commands>/);
    assert.match(payload.input[0].content, /Test command\nRegistered tools: read/);
    assert.match(payload.input[0].content, /<skills>\nSkills:\nalpha\n<\/skills>/);
    assert.doesNotMatch(payload.input[0].content, /Old catalog|Historical catalog|Private description|\/alpha\/SKILL.md/);
    assert.equal(payload.input[0].content.split("<skills>").length - 1, 1);
    assert.match(payload.input[0].content, /<\/commands>$/);
    assert.doesNotMatch(payload.input[0].content, /<\/?(?:bootstrap|command)>/);
    assert.match(payload.input[0].content, /Test command\nSnapshot output/);
    assert.match(payload.input[0].content, /Read rules.md[\s\S]*<memory/);
    assert.equal(JSON.stringify(payload).split('<memory>').length - 1, 1);
    assert.deepEqual(payload.input.filter((m: any) => m.role === "user"), [{ role: "user", content: [{ type: "input_text", text: "Question" }] }]);
    assert.ok(payload.tools.some((tool: any) => tool.name === "read"));
    assert.deepEqual(history, before);
  }
  assert.equal(await readFile(marker, "utf8"), "x");
  assert.equal(await readFile(join(f.global, "rules.md"), "utf8"), "Updated rules");
  assert.doesNotMatch(await readFile(join(f.global, "rules.md"), "utf8"), /bootstrap/);
});

test("explicit memory replacements and references are request-local and keep the container", async t => {
  const f = await fixture(t);
  await memory(f.project, "one.md", "Original memory");
  const h = harness(() => f.repository);
  registerBootstrap(h.pi as never, () => f.repository, h.snapshot);
  await h.handlers.get("session_start")!({}, context(f.projectRoot));
  const stored = h.snapshot();
  await actions(f.global, { "system_prompt.memory": { refer: "See $link", link: "memory.md" }, "system_prompt.preamble": "New preamble", "system_prompt.postamble": "New postamble" });
  const event = freeze({ messages: [{ role: "system", content: "Prompt", timestamp: 0 }] });
  const referenced = await h.handlers.get("context_with_system")!(event, { cwd: f.projectRoot });
  assert.match(referenced.messages[0].content, /<memory>\nSee memory.md\n<\/memory>/);
  assert.equal(await readFile(join(f.global, "memory.md"), "utf8"), "\nOriginal memory\n");
  await actions(f.global, { memory: "Request-only" });
  const replaced = await h.handlers.get("context_with_system")!(event, { cwd: f.projectRoot });
  assert.match(replaced.messages[0].content, /<memory>\nRequest-only\n<\/memory>/);
  assert.equal(h.snapshot(), stored);
  assert.match(stored, /Original memory/);
  assert.equal(event.messages[0].content, "Prompt");
});

test("failed, empty and shutdown starts clear previous snapshots; reload runtimes are isolated", async t => {
  const f = await fixture(t);
  await memory(f.project, "one.md", "Current");
  const h = harness(() => f.repository);
  const ctx = context(f.projectRoot);
  await h.handlers.get("session_start")!({}, ctx);
  assert.match(h.snapshot(), /Current/);
  const reload = harness(() => f.repository);
  assert.equal(reload.snapshot(), "");
  await command(f.project, "fail.toml", executable("process.exit(7)"));
  await h.handlers.get("session_start")!({ reason: "resume" }, ctx);
  assert.equal(h.snapshot(), "");
  await protocol(f.project, "invalid =");
  await assert.rejects(h.handlers.get("session_start")!({}, ctx));
  assert.equal(h.snapshot(), "");
  await protocol(f.project, '[[rule]]\nglob = "absent.md"\naction = "memory"\n');
  await h.handlers.get("session_start")!({}, ctx);
  assert.equal(h.snapshot(), "");
  await protocol(f.project, '[[rule]]\nglob = "*.md"\naction = "memory"\n');
  await reload.handlers.get("session_start")!({}, ctx);
  assert.match(reload.snapshot(), /Current/);
  await reload.handlers.get("session_shutdown")!({}, ctx);
  assert.equal(reload.snapshot(), "");
});

test("switching cwd replaces rather than accumulates session snapshots", async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  await memory(first.project, "one.md", "First project");
  await memory(second.project, "two.md", "Second project");
  const h = harness(cwd => cwd === first.projectRoot ? first.repository : second.repository);
  await h.handlers.get("session_start")!({ reason: "startup" }, context(first.projectRoot));
  assert.match(h.snapshot(), /First project/);
  await h.handlers.get("session_start")!({ reason: "new" }, context(second.projectRoot));
  assert.match(h.snapshot(), /Second project/);
  assert.doesNotMatch(h.snapshot(), /First project/);
  await h.handlers.get("session_start")!({ reason: "resume" }, context(first.projectRoot));
  assert.match(h.snapshot(), /First project/);
  assert.doesNotMatch(h.snapshot(), /Second project/);
});

test("late composition cannot repopulate shutdown or superseded session state", async () => {
  const pending: Array<(value: string) => void> = [];
  const h = harness(() => ({ composeSnapshot: () => new Promise(resolve => pending.push(value => resolve({ bootstrap: value, sections: {}, entries: [] }))) }) as never);
  const first = h.handlers.get("session_start")!({}, context("first"));
  const second = h.handlers.get("session_start")!({}, context("second"));
  pending[1]("Second");
  await second;
  pending[0]("Stale first");
  await first;
  assert.equal(h.snapshot(), "Second");
  const third = h.handlers.get("session_start")!({}, context("third"));
  assert.equal(h.snapshot(), "");
  h.handlers.get("session_shutdown")!({}, context("third"));
  pending[2]("Stale third");
  await third;
  assert.equal(h.snapshot(), "");
});

test("bootstrap injects into the first system message after shell history without reordering messages", async t => {
  const f = await fixture(t);
  const h = harness(() => f.repository);
  registerBootstrap(h.pi as never, () => f.repository, () => '<memory>Snapshot</memory>');
  const messages = freeze([
    { role: "bashExecution", command: "pwd", output: "/project", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 },
    { role: "system", content: "Prompt", sections: { rules: "<rules>Old</rules>" }, toolsAdded: [{ name: "read" }], timestamp: 1 },
    { role: "user", content: "Question", timestamp: 2 },
    { role: "system", content: "", sections: { rules: "<rules>Updated</rules>" }, toolsAdded: [{ name: "bash" }], timestamp: 3 },
  ]);
  const before = structuredClone(messages);
  const result = await h.handlers.get("context_with_system")!({ messages }, { cwd: f.projectRoot });
  assert.deepEqual(result.messages.map((message: any) => message.role), ["bashExecution", "system", "user", "system"]);
  assert.deepEqual(result.messages[0], messages[0]);
  assert.deepEqual(result.messages[2], messages[2]);
  assert.equal(result.messages[1].content, "Prompt\n\n<rules>Updated</rules>\n\n<memory>Snapshot</memory>");
  assert.deepEqual(result.messages[1].toolsAdded, messages[1].toolsAdded);
  assert.deepEqual(result.messages[3], { role: "system", content: "", toolsAdded: [{ name: "bash" }], timestamp: 3 });
  assert.deepEqual(messages, before);
});

test("string, empty and section-only system prompts inject without changing conversation order", async t => {
  const f = await fixture(t);
  const h = harness(() => f.repository);
  registerBootstrap(h.pi as never, () => f.repository, () => '<memory>Snapshot</memory>');
  for (const content of ["Plain", "", []]) {
    const messages = freeze([{ role: "system", content, sections: { rules: "<rules>Rules</rules>" }, timestamp: 0 }, { role: "user", content: "User", timestamp: 1 }]);
    const result = await h.handlers.get("context_with_system")!({ messages }, { cwd: f.projectRoot });
    assert.match(JSON.stringify(result.messages[0]), /Snapshot/);
    assert.deepEqual(result.messages.slice(1), messages.slice(1));
    assert.equal(result.messages[0].sections, undefined);
    assert.match(result.messages[0].content, /<rules>Rules<\/rules>[\s\S]*<memory/);
    assert.match(result.messages[0].content, /<\/memory>$/);
    assert.deepEqual(messages[0].sections, { rules: "<rules>Rules</rules>" });
  }
  await assert.rejects(h.handlers.get("context_with_system")!({ messages: [{ role: "user", content: "User" }] }, { cwd: f.projectRoot }), /requires a system message/);
});
