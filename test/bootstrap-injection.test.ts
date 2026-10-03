import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { registerBootstrap } from "../index.ts";
import { registerBootstrapSession } from "../src/bootstrap-session.ts";
import { fixture, memory, command, executable, protocol } from "./session-fixture.ts";

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
  await command(f.project, "tools.toml", 'version = 1\ndescription = "Test command"\nexpression = \'"Registered tools: " + ALL_TOOLS.map(t => t.name).join(",")\'\n');
  await command(f.project, "once.toml", executable(`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('Snapshot output')`));
  const h = harness(() => f.repository);
  const config = join(f.root, "config.toml");
  await writeFile(config, '[system_prompt.preamble]\nreplacement = "Replaced"\n[system_prompt.rules]\nrefer = "Read $link"\nlink = "rules.md"\n[system_prompt.postamble]\nreplacement = "Tail"\n');
  registerBootstrap(h.pi as never, config, h.snapshot);
  await h.handlers.get("session_start")!({}, context(f.projectRoot));
  const history = freeze([
    { role: "system", content: [{ type: "text", text: "Original" }], sections: { rules: "<rules>Keep me</rules>" }, toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }], timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "Question" }], timestamp: 1 },
    { role: "system", content: "", sections: { rules: "<rules>Updated rules</rules>" }, timestamp: 2 },
  ]);
  const before = structuredClone(history);
  for (const supportsMidConvoSystemMessages of [false, true]) {
    const result = await h.handlers.get("context_with_system")!({ messages: history });
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
    assert.match(payload.input[0].content, /<bootstrap version="1">[\s\S]*Only system &lt;guidance&gt;[\s\S]*Snapshot output[\s\S]*<\/bootstrap>/);
    assert.match(payload.input[0].content, /Test command\nRegistered tools: read\n  <\/command>/);
    assert.match(payload.input[0].content, /<\/bootstrap>$/);
    assert.equal((payload.input[0].content.match(/<command>/g) ?? []).length, 2);
    assert.equal((payload.input[0].content.match(/<\/command>/g) ?? []).length, 2);
    assert.match(payload.input[0].content, /<command>\nTest command\nSnapshot output\n  <\/command>/);
    assert.match(payload.input[0].content, /Read rules.md[\s\S]*<bootstrap/);
    assert.equal(JSON.stringify(payload).split('<bootstrap version=').length - 1, 1);
    assert.deepEqual(payload.input.filter((m: any) => m.role === "user"), [{ role: "user", content: [{ type: "input_text", text: "Question" }] }]);
    assert.ok(payload.tools.some((tool: any) => tool.name === "read"));
    assert.deepEqual(history, before);
  }
  assert.equal(await readFile(marker, "utf8"), "x");
  assert.equal(await readFile(join(f.root, "rules.md"), "utf8"), "Updated rules");
  assert.doesNotMatch(await readFile(join(f.root, "rules.md"), "utf8"), /bootstrap/);
});

test("explicit bootstrap replacements and references are request-local and keep the container", async t => {
  const f = await fixture(t);
  await memory(f.project, "one.md", "Original memory");
  const h = harness(() => f.repository);
  const config = join(f.root, "config.toml");
  registerBootstrap(h.pi as never, config, h.snapshot);
  await h.handlers.get("session_start")!({}, context(f.projectRoot));
  const stored = h.snapshot();
  await writeFile(config, '[system_prompt.bootstrap.memory]\nrefer = "See $link"\nlink = "memory.md"\n[system_prompt.preamble]\nreplacement = "New preamble"\n[system_prompt.postamble]\nreplacement = "New postamble"\n');
  const event = freeze({ messages: [{ role: "system", content: "Prompt", timestamp: 0 }] });
  const referenced = await h.handlers.get("context_with_system")!(event);
  assert.match(referenced.messages[0].content, /<bootstrap version="1">\n  <memory>\nSee memory.md\n  <\/memory>\n<\/bootstrap>/);
  assert.equal(await readFile(join(f.root, "memory.md"), "utf8"), "\nOriginal memory\n  ");
  await writeFile(config, '[bootstrap.memory]\nreplacement = "Request-only"\n');
  const replaced = await h.handlers.get("context_with_system")!(event);
  assert.match(replaced.messages[0].content, /<memory>\nRequest-only\n  <\/memory>/);
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
  await protocol(f.project, 'version = 1\n[[rule]]\nglob = "absent.md"\naction = "memory"\n');
  await h.handlers.get("session_start")!({}, ctx);
  assert.equal(h.snapshot(), "");
  await protocol(f.project, 'version = 1\n[[rule]]\nglob = "*.md"\naction = "memory"\n');
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
  const h = harness(() => ({ compose: () => new Promise<string>(resolve => pending.push(resolve)) }) as never);
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

test("string, empty and section-only system prompts inject without changing conversation order", async t => {
  const f = await fixture(t);
  const config = join(f.root, "config.toml");
  await writeFile(config, "");
  const h = harness(() => f.repository);
  registerBootstrap(h.pi as never, config, () => '<bootstrap version="1">Snapshot</bootstrap>');
  for (const content of ["Plain", "", []]) {
    const messages = freeze([{ role: "system", content, sections: { rules: "<rules>Rules</rules>" }, timestamp: 0 }, { role: "user", content: "User", timestamp: 1 }]);
    const result = await h.handlers.get("context_with_system")!({ messages });
    assert.match(JSON.stringify(result.messages[0]), /Snapshot/);
    assert.deepEqual(result.messages.slice(1), messages.slice(1));
    assert.equal(result.messages[0].sections, undefined);
    assert.match(result.messages[0].content, /<rules>Rules<\/rules>[\s\S]*<bootstrap/);
    assert.match(result.messages[0].content, /<\/bootstrap>$/);
    assert.deepEqual(messages[0].sections, { rules: "<rules>Rules</rules>" });
  }
  await assert.rejects(h.handlers.get("context_with_system")!({ messages: [{ role: "user", content: "User" }] }), /leading system message/);
});
