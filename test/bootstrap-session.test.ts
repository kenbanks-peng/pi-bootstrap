import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import bootstrap, { getConfigPath, registerBootstrap } from "../index.ts";
import { getBootstrapDirectory } from "../src/bootstrap-paths.ts";
import { createBootstrapRepository, registerBootstrapSession } from "../src/bootstrap-session.ts";
import { runBootstrapCommand, type BootstrapCommandUI } from "../src/bootstrap-command.ts";
import { fixture, memory, command, executable, protocol } from "./session-fixture.ts";

function harness(repositoryFor?: Parameters<typeof registerBootstrapSession>[1]) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { description: string; handler: (...args: any[]) => any }>();
  const messages: any[] = [];
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerCommand: (name: string, spec: any) => commands.set(name, spec),
    sendMessage: (message: any) => messages.push(message),
    getAllTools: () => [{ name: "read", description: "Read files" }],
    getActiveTools: () => ["read"],
  };
  const snapshot = registerBootstrapSession(pi as never, repositoryFor);
  return { handlers, commands, messages, pi, snapshot };
}

function ui(values: Array<string | undefined> = []) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const editors: Array<{ title: string; initial: string }> = [];
  const api: BootstrapCommandUI = {
    hasUI: true,
    editor: async (title, initial) => { editors.push({ title, initial }); return values.shift(); },
    notify: (message, level) => { notifications.push({ message, level }); },
  };
  return { api, editors, notifications };
}

test("portable default paths, agent override and renamed project scope", () => {
  assert.equal(getBootstrapDirectory("/home/someone", ""), "/home/someone/.config/pi/agent/extensions/pi-bootstrap");
  assert.equal(getBootstrapDirectory("/home/someone", "/custom/pi"), "/custom/pi/extensions/pi-bootstrap");
  assert.equal(getConfigPath(), join(getBootstrapDirectory(), "config.toml"));
  assert.equal(getBootstrapDirectory(), join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".config", "pi", "agent"), "extensions", "pi-bootstrap"));
  assert.deepEqual(createBootstrapRepository("/workspace/product", "/home/someone", "").directories, {
    globalDirectory: "/home/someone/.config/pi/agent/extensions/pi-bootstrap",
    projectDirectory: "/workspace/product/.agents/bootstrap",
  });
});

test("full extension registers both existing transformation and session capabilities without IO", () => {
  const h = harness();
  h.handlers.clear();
  h.commands.clear();
  bootstrap(h.pi as never);
  assert.deepEqual([...h.handlers.keys()], ["session_shutdown", "session_start", "context_with_system"]);
  assert.deepEqual([...h.commands.keys()], ["bootstrap"]);
  assert.match(h.commands.get("bootstrap")!.description, /protocol.toml/);
  assert.deepEqual(h.messages, []);
});

test("session snapshots and existing request replacements compose without changing stored history", async t => {
  const f = await fixture(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(f.root, "agent");
  try {
    const repository = createBootstrapRepository(f.projectRoot);
    await repository.create("global", "memory", "Session guidance");
    await writeFile(getConfigPath(), '[system_prompt.tools]\nreplacement = "New tools"\n[system_prompt.preamble]\nreplacement = "New preamble"\n[system_prompt.postamble]\nrefer = "Read $link"\nlink = "prompt.md"\n');
    const h = harness();
    h.handlers.clear();
    bootstrap(h.pi as never);
    await h.handlers.get("session_start")!({}, { cwd: f.projectRoot, hasUI: false, ui: ui().api });
    const user = { role: "user", content: "Question" };
    const system = { role: "system", content: "", sections: { preamble: "Old preamble", tools: "<tools>Old tools</tools>Tail" }, toolsAdded: [{ name: "read" }] };
    const result = await h.handlers.get("context_with_system")!({ messages: [system, user] });
    assert.match(result.messages[0].content, /<tools>\nNew tools\n<\/tools>Read prompt.md[\s\S]*<bootstrap/);
    assert.equal(result.messages[0].sections, undefined);
    assert.match(result.messages[0].content, /<\/bootstrap>$/);
    assert.equal(await readFile(join(getBootstrapDirectory(), "prompt.md"), "utf8"), "Tail");
    assert.equal(result.messages[0].toolsAdded, system.toolsAdded);
    assert.match(result.messages[0].content, /<bootstrap version="1">[\s\S]*Session guidance[\s\S]*<\/bootstrap>/);
    assert.equal(system.sections.tools, "<tools>Old tools</tools>Tail");
    assert.equal(result.messages[1].content, "Question");
    assert.deepEqual(h.messages, []);
    assert.equal(h.handlers.has("context"), false);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("session start snapshots once and request injection does not mutate history", async t => {
  const f = await fixture(t);
  await memory(f.project, "test.md", "First snapshot");
  let compositions = 0;
  const h = harness(cwd => { assert.equal(cwd, f.projectRoot); compositions++; return f.repository; });
  const ctx = { cwd: f.projectRoot, hasUI: false, ui: ui().api };
  await h.handlers.get("session_start")!({}, ctx);
  assert.equal(compositions, 1);
  assert.deepEqual(h.messages, []);
  assert.match(h.snapshot(), /<bootstrap version="1">/);
  const config = join(f.root, "config.toml");
  await writeFile(config, "");
  registerBootstrap(h.pi as never, config, h.snapshot);
  await memory(f.project, "test.md", "Later snapshot");
  const first = h.snapshot();
  const other = { role: "custom", customType: "other", content: "Other" };
  const user = { role: "user", content: "Question" };
  const event = { messages: [{ role: "system", content: "Prompt" }, user, other] };
  const before = structuredClone(event);
  for (let i = 0; i < 2; i++) {
    const result = await h.handlers.get("context_with_system")!(event);
    assert.equal(result.messages[0].content, `Prompt\n\n${first}`);
    assert.deepEqual(result.messages.slice(1), [user, other]);
  }
  assert.deepEqual(event, before);
  assert.equal(compositions, 1);
  assert.match(first, /First snapshot/);
  // Pi invokes session_start again on a new runtime/session; there is no module-global cache.
  await h.handlers.get("session_start")!({}, ctx);
  assert.equal(compositions, 2);
  assert.match(h.snapshot(), /Later snapshot/);
  assert.deepEqual(h.messages, []);
});

test("every Pi session-start reason recomposes from the current cwd without runtime state", async t => {
  const f = await fixture(t);
  const h = harness(() => f.repository);
  const ctx = { cwd: f.projectRoot, hasUI: false, ui: ui().api };
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    await memory(f.project, "reason.md", reason);
    await h.handlers.get("session_start")!({ reason }, ctx);
    assert.match(h.snapshot(), new RegExp(`<memory>\n${reason}\n  </memory>`));
    assert.equal((h.snapshot().match(/<memory>/g) ?? []).length, 1);
  }
  assert.deepEqual(h.messages, []);
});

test("empty composition sends no message and command failures notify without partial injection", async t => {
  const f = await fixture(t);
  const h = harness(() => f.repository);
  const notices = ui();
  const ctx = { cwd: f.projectRoot, hasUI: true, ui: notices.api };
  await h.handlers.get("session_start")!({}, ctx);
  assert.equal(h.messages.length, 0);
  await memory(f.project, "first.md", "not partially injected");
  await command(f.project, "bad.toml", executable("process.exit(7)"));
  await h.handlers.get("session_start")!({}, ctx);
  assert.deepEqual(notices.notifications.pop(), { message: "bad.toml returned error code 7.", level: undefined });
  await command(f.project, "bad.toml", "version = 1\nargv = []");
  await h.handlers.get("session_start")!({}, ctx);
  const failure = notices.notifications.pop()!;
  assert.match(failure.message, /bad.toml had an error:.*non-empty argv/);
  assert.equal(failure.level, "error");
  assert.equal(h.messages.length, 0);
  await protocol(f.project, "invalid =");
  await assert.rejects(h.handlers.get("session_start")!({}, ctx), /not valid TOML/);
});

test("repository CRUD uses commands/*.toml and memories/*.md with type-prefixed IDs", async t => {
  const f = await fixture(t);
  for (const scope of ["global", "project"] as const) {
    for (const type of ["memory", "command"] as const) {
      const id = await f.repository.create(scope, type, "original");
      assert.match(id, new RegExp(`^${type}-[0-9a-f]{8}$`));
      const source = { id, type };
      const path = join(f.repository.directories[`${scope}Directory`], type === "memory" ? "memories" : "commands", id + (type === "memory" ? ".md" : ".toml"));
      assert.equal(await readFile(path, "utf8"), "original");
      assert.ok((await f.repository.list(scope)).some(s => s.id === id && s.type === type));
      await f.repository.edit(scope, source, "edited");
      assert.equal(await f.repository.read(scope, source), "edited");
      await f.repository.delete(scope, source);
      assert.deepEqual(await f.repository.list(scope), []);
      await assert.rejects(f.repository.read(scope, source), /does not exist/);
      await assert.rejects(f.repository.edit(scope, source, "no"), /does not exist/);
      await assert.rejects(f.repository.delete(scope, source), /does not exist/);
      await assert.rejects(f.repository.read(scope, { id: "../escape", type }), /Invalid Bootstrap ID/);
    }
  }
});

test("repository listing ignores invalid names, symlinks, subdirectories and root files", async t => {
  const f = await fixture(t);
  await memory(f.project, "z.md", "Z");
  await command(f.project, "a.toml", "A");
  await memory(f.project, "bad name.md", "bad");
  await memory(f.project, ".md", "bad");
  await command(f.project, "other.txt", "bad");
  await writeFile(join(f.project, "root.md"), "bad");
  await mkdir(join(f.project, "memories", "folder.md"));
  await symlink(join(f.project, "memories", "z.md"), join(f.project, "memories", "linked.md"));
  assert.deepEqual(await f.repository.list("project"), [{ id: "a", type: "command" }, { id: "z", type: "memory" }]);
  const empty = createBootstrapRepository(join(f.root, "absent"), f.root, join(f.root, "empty"));
  assert.deepEqual(await empty.list("global"), []);
  assert.deepEqual(await empty.list("project"), []);
  await empty.create("project", "memory", "creates directories");
  assert.equal((await empty.list("project")).length, 1);
});

test("slash command uses the same repository factory and offers only /bootstrap", async t => {
  const f = await fixture(t);
  const h = harness(() => f.repository);
  const notices = ui(["New memory", 'argv = ["git", "status"]\n']);
  const ctx = { cwd: f.projectRoot, hasUI: true, ui: notices.api };
  const run = h.commands.get("bootstrap")!.handler;
  await run("", ctx);
  assert.match(notices.notifications[0].message, /\/bootstrap list/);
  await run("add global memory", ctx);
  await run("add global command", ctx);
  assert.match(notices.notifications[1].message, /^Added Global memory Bootstrap "memory-[0-9a-f]{8}"\.$/);
  assert.match(notices.notifications[2].message, /^Added Global command Bootstrap "command-[0-9a-f]{8}"\.$/);
  assert.doesNotMatch(notices.editors[1].initial, /version/);
  const sources = await f.repository.list("global");
  const added = sources.find(s => s.type === "command")!;
  assert.equal(await f.repository.read("global", added), 'version = 1\nargv = ["git", "status"]\n');
  await run("list global", ctx);
  assert.match(notices.notifications.at(-1)!.message, /memory: New memory/);
  assert.match(notices.notifications.at(-1)!.message, /command: version = 1/);
});

test("command defaults, filters, edits, deletion, cancellation and non-UI operation", async t => {
  const f = await fixture(t);
  const notices = ui(["Initial", "Edited", undefined, undefined]);
  const run = (args: string) => runBootstrapCommand(args, f.repository, notices.api);
  await run("add");
  const [source] = await f.repository.list("project");
  assert.equal(source.type, "memory");
  assert.equal(await f.repository.read("project", source), "Initial");
  await run(`edit ${source.id}`);
  assert.equal(notices.editors[1].initial, "Initial");
  assert.equal(await f.repository.read("project", source), "Edited");
  await run(`edit ${source.id} memory`);
  assert.match(notices.notifications.at(-1)!.message, /cancelled/);
  assert.equal(await f.repository.read("project", source), "Edited");
  await run("add command project");
  assert.match(notices.notifications.at(-1)!.message, /cancelled/);
  assert.equal((await readdir(join(f.project, "commands"))).length, 0);
  await run("list command");
  assert.equal(notices.notifications.at(-1)!.message, "global: none\n\nproject: none");
  notices.api.hasUI = false;
  await run("add");
  assert.match(notices.notifications.at(-1)!.message, /requires interactive UI/);
  await run(`edit ${source.id}`);
  assert.match(notices.notifications.at(-1)!.message, /requires interactive UI/);
  await run(`delete ${source.id}`);
  assert.deepEqual(await f.repository.list("project"), []);
  await run(`delete ${source.id}`);
  assert.match(notices.notifications.at(-1)!.message, /does not exist/);
});

test("slash-created commands use renamed filenames and execute on the next session only", async t => {
  const f = await fixture(t);
  const h = harness(() => f.repository);
  const notices = ui([executable('process.stdout.write("created")').replace(/^version = 1\n/, ""), executable('process.stdout.write("edited")')]);
  const ctx = { cwd: f.projectRoot, hasUI: true, ui: notices.api };
  const run = h.commands.get("bootstrap")!.handler;
  await run("add command", ctx);
  const [source] = await f.repository.list("project");
  assert.match(source.id, /^command-[0-9a-f]{8}$/);
  assert.deepEqual(await readdir(join(f.project, "commands")), [`${source.id}.toml`]);
  assert.equal(h.messages.length, 0);
  await h.handlers.get("session_start")!({}, ctx);
  const original = h.snapshot();
  assert.match(original, /<output>\ncreated\n    <\/output>/);
  await run(`edit ${source.id} command`, ctx);
  assert.match(notices.editors[1].initial, /^version = 1/);
  assert.equal(h.snapshot(), original);
  await h.handlers.get("session_start")!({}, ctx);
  assert.match(h.snapshot(), /<output>\nedited\n    <\/output>/);
  assert.match(original, /<output>\ncreated\n    <\/output>/);
  await run(`delete ${source.id} command`, ctx);
  await h.handlers.get("session_start")!({}, ctx);
  assert.equal(h.snapshot(), "");
  assert.deepEqual(h.messages, []);
});

test("command argument validation and ambiguous IDs never mutate files", async t => {
  const f = await fixture(t);
  await memory(f.global, "same.md", "Global");
  await memory(f.project, "same.md", "Project");
  await command(f.project, "same.toml", "Command");
  const notices = ui();
  const run = (args: string) => runBootstrapCommand(args, f.repository, notices.api);
  for (const args of ["wat", "list global project", "list memory command", "list junk", "list global memory extra", "edit", "delete", "edit same bad", "delete same memory extra"]) {
    await run(args);
    assert.equal(notices.notifications.at(-1)!.level, "error");
    assert.match(notices.notifications.at(-1)!.message, /Usage:/);
  }
  await run("delete same");
  assert.match(notices.notifications.at(-1)!.message, /ambiguous/);
  await run("delete same memory");
  assert.match(notices.notifications.at(-1)!.message, /ambiguous/);
  await run("delete same command");
  assert.match(notices.notifications.at(-1)!.message, /Deleted Project command/);
  assert.equal(await f.repository.read("project", { id: "same", type: "memory" }), "Project");
});
