import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMMAND_OUTPUT_LIMIT_BYTES, CommandSourceError } from "../src/bootstrap-protocol.ts";
import { registerBootstrapSession } from "../src/bootstrap-session.ts";
import { registerBootstrap } from "../index.ts";
import { fixture, command, executable, memory } from "./session-fixture.ts";

const data = {
  allTools: [{ name: "read", description: "<read>&", parameters: { type: "object" } }, { name: "bash" }],
  activeTools: ["read"],
};
const expression = (code: string) => `description = "Test command"\nexpression = ${JSON.stringify(code)}\n`;

test("expressions and argv are peers in both scopes, with descriptions and escaped output", async t => {
  const f = await fixture(t);
  await command(f.global, "a.toml", expression('ALL_TOOLS.map(t => t.name).join("\\n")'));
  await command(f.project, "a.toml", expression('pi.getAllTools().find(t => t.name === "read").description'));
  await command(f.project, "b.toml", expression('pi.getActiveTools().join(",")'));
  await command(f.project, "c.toml", executable('process.stdout.write("external")'));
  const output = await f.repository.compose(data);
  assert.match(output, /Test command\nread\nbash\n/);
  assert.match(output, /Test command\n&lt;read&gt;&amp;\n/);
  assert.match(output, /Test command\nread\n/);
  assert.match(output, /Test command\nexternal\n/);
  assert.doesNotMatch(output, /<run>|<output>|ALL_TOOLS\.map|process\.stdout/);
  assert.deepEqual(data.activeTools, ["read"]);
});

test("command definitions require exactly one valid execution field", async t => {
  const f = await fixture(t);
  for (const [body, expected] of [
    ['description = "Test command"', /exactly one/],
    [expression('"ok"') + 'argv = ["git"]\n', /exactly one/],
    ["description = \"Test command\"\nexpression = 42", /non-empty string/],
    ['description = "Test command"\nexpression = " "', /non-empty string/],
    [expression('"ok"') + 'cwd = "."\n', /cwd is only supported with argv/],
  ] as const) {
    await command(f.project, "case.toml", body);
    await assert.rejects(f.repository.compose(data), expected);
  }
  await command(f.project, "case.toml", expression('"ok"'));
  await assert.rejects(f.repository.compose(), /require a Pi session context/);
});

test("expression failures are typed, bounded, and never return partial bootstrap", async t => {
  const f = await fixture(t);
  await memory(f.global, "first.md", "not partially returned");
  for (const [code, expected] of [
    ["(", /Unexpected token/],
    ['(() => { throw new Error("failure"); })()', /failure/],
    ["42", /return a string synchronously/],
    ['Promise.resolve("async")', /return a string synchronously/],
    ['(() => { while (true) {} })()', /timed out/],
    ['(Promise.resolve().then(() => { while (true) {} }), "queued")', /timed out/],
    [`"é".repeat(${COMMAND_OUTPUT_LIMIT_BYTES / 2 + 1})`, /output exceeded/],
  ] as const) {
    await command(f.project, "case.toml", expression(code));
    await assert.rejects(f.repository.compose(data), error => {
      assert.ok(error instanceof CommandSourceError);
      assert.equal(error.sourceName, "case.toml");
      assert.match(error.message, expected);
      return true;
    });
  }
  await command(f.project, "case.toml", expression('"recovered"'));
  assert.match(await f.repository.compose(data), /Test command\nrecovered\n/);
});

test("expressions get read-only copies, not host capabilities or session mutation methods", async t => {
  const f = await fixture(t);
  for (const code of [
    'ALL_TOOLS.push({name: "changed"})',
    'ALL_TOOLS[0].parameters.type = "changed"',
    'pi.getActiveTools().push("changed")',
    'pi.setActiveTools([])',
    'process.cwd()',
    'require("node:fs")',
    'pi.getAllTools.constructor("return process")()',
  ]) {
    await command(f.project, "case.toml", expression(code));
    await assert.rejects(f.repository.compose(data), CommandSourceError);
  }
  assert.equal(data.allTools[0].parameters!.type, "object");
  assert.deepEqual(data.activeTools, ["read"]);
  await command(f.project, "case.toml", expression('String(ALL_TOOLS === pi.getAllTools())'));
  assert.match(await f.repository.compose(data), /Test command\ntrue\n/);
});

test("session expressions snapshot tools once, refresh on reload, and clear on error", async t => {
  const f = await fixture(t);
  await command(f.project, "tools.toml", expression('ALL_TOOLS.map(t => t.name).join(",")'));
  const handlers = new Map<string, (...args: any[]) => any>();
  let names = ["read"];
  let reads = 0;
  const pi = {
    on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    registerCommand: () => {},
    getAllTools: () => { reads++; return names.map(name => ({ name })); },
    getActiveTools: () => names,
  };
  const snapshot = registerBootstrapSession(pi as never, () => f.repository);
  const notices: string[] = [];
  const ctx = { cwd: f.projectRoot, ui: { notify: (message: string) => notices.push(message) } };
  await handlers.get("session_start")!({}, ctx);
  assert.match(snapshot(), /Test command\nread\n/);
  names = ["bash"];
  const config = join(f.root, "config.toml");
  await writeFile(config, "");
  registerBootstrap(pi as never, config, snapshot);
  for (let i = 0; i < 2; i++) {
    const result = await handlers.get("context_with_system")!({ messages: [{ role: "system", content: "" }] });
    assert.match(result.messages[0].content, /Test command\nread\n/);
  }
  assert.equal(reads, 1);
  await handlers.get("session_start")!({ reason: "reload" }, ctx);
  assert.match(snapshot(), /Test command\nbash\n/);
  await command(f.project, "tools.toml", expression('pi.unknown()'));
  await handlers.get("session_start")!({}, ctx);
  assert.equal(snapshot(), "");
  assert.match(notices[0], /tools.toml had an error:.*pi.unknown/);
  assert.match(await readFile(join(f.project, "commands", "tools.toml"), "utf8"), /expression/);
});
