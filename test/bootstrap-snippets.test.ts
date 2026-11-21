import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./session-fixture.ts";
import { loadSnippets, installSnippetDefaults } from "../src/bootstrap-snippet-storage.ts";
import { parseSnippet, snippetTemplate } from "../src/bootstrap-snippet-model.ts";
import { registerSnippets } from "../src/bootstrap-snippets.ts";
import { runBootstrapCommand } from "../src/bootstrap-command.ts";

const content = (name: string) => name;

test("snippet parsing accepts plain Markdown and rejects empty bodies", () => {
  assert.equal(parseSnippet("x.md", " \n\t"), null);
  assert.deepEqual(parseSnippet("x.md", "  # Title\nBody\n"), {
    id: "x.md", name: "Title", body: "# Title\nBody",
  });
  const markdown = "---\nname: Literal text\n---\nBody";
  assert.equal(parseSnippet("x.md", markdown)!.body, markdown);
});

test("snippet CRUD uses UUID IDs, validates writes, lists scopes and never injects snippets", async t => {
  const f = await fixture(t);
  const id = await f.repository.create("project", "snippet", snippetTemplate);
  assert.match(id, /^snippet-[a-f0-9]{8}$/);
  const source = { id, type: "snippet" as const };
  assert.equal(await f.repository.read("project", source), snippetTemplate);
  await assert.rejects(f.repository.edit("project", source, "  "), /nonempty/);
  await assert.rejects(f.repository.create("global", "snippet", ""), /nonempty/);
  assert.equal(await f.repository.read("project", source), snippetTemplate);
  await f.repository.edit("project", source, content("Edited"));
  assert.doesNotMatch(await f.repository.compose(), /Edited/);
  await f.repository.delete("project", source);
  assert.deepEqual(await loadSnippets(f.repository), []);
});

test("defaults seed missing folders with stable UUID filenames and preserve nonempty folders", async t => {
  const f = await fixture(t);
  await Promise.all([installSnippetDefaults(f.repository), installSnippetDefaults(f.repository)]);
  const sources = (await f.repository.list("global")).filter(s => s.type === "snippet");
  assert.equal(sources.length, 6);
  assert.ok(!(await readdir(f.global)).includes(".snippet-defaults-installed"));
  for (const source of sources) {
    assert.match(source.id, /^snippet-[a-f0-9]{8}$/);
    assert.doesNotMatch(await f.repository.read("global", source), /^---/);
  }
  await f.repository.edit("global", sources[0], content("Custom"));
  await f.repository.delete("global", sources[1]);
  await installSnippetDefaults(f.repository);
  assert.equal((await loadSnippets(f.repository)).length, 5);
  assert.equal(await f.repository.read("global", sources[0]), content("Custom"));
  assert.equal((await f.repository.list("project")).filter(s => s.type === "snippet").length, 0);
});

test("defaults seed empty folders again after all snippets are deleted", async t => {
  const f = await fixture(t);
  const directory = join(f.global, "snippets");
  await mkdir(directory);
  await installSnippetDefaults(f.repository);
  const sources = (await f.repository.list("global")).filter(s => s.type === "snippet");
  assert.equal(sources.length, 6);
  for (const source of sources) await f.repository.delete("global", source);
  assert.deepEqual(await readdir(directory), []);
  await installSnippetDefaults(f.repository);
  assert.equal((await loadSnippets(f.repository)).length, 6);
});

test("defaults leave any nonempty snippets folder untouched", async t => {
  const f = await fixture(t);
  const directory = join(f.global, "snippets");
  await mkdir(directory);
  await writeFile(join(directory, "notes.txt"), "Keep");
  await installSnippetDefaults(f.repository);
  assert.deepEqual(await readdir(directory), ["notes.txt"]);
});

test("scope ordering precedes alphabetical ordering and duplicate names remain independent", async t => {
  const f = await fixture(t);
  await f.repository.create("global", "snippet", content("Same"));
  await f.repository.create("project", "snippet", content("Same"));
  await f.repository.create("project", "snippet", content("Before"));
  const snippets = await loadSnippets(f.repository);
  assert.deepEqual(snippets.map(s => [s.name, s.scope]), [["Same", "global"], ["Before", "project"], ["Same", "project"]]);
  assert.equal(new Set(snippets.map(s => s.id)).size, 3);
});

test("/bootstrap snippet add/list/edit/delete and cancellation", async t => {
  const f = await fixture(t);
  const notifications: string[] = [];
  const values: Array<string | undefined> = [content("New"), content("Edited"), undefined, " "];
  const ui = { hasUI: true, editor: async (_title: string, initial: string) => {
    assert.ok(!initial.includes("---")); return values.shift();
  }, notify: (message: string) => { notifications.push(message); } };
  await runBootstrapCommand("add snippet", f.repository, ui);
  const [source] = (await f.repository.list("project")).filter(s => s.type === "snippet");
  await runBootstrapCommand("list snippet", f.repository, ui);
  assert.match(notifications.at(-1)!, /New/);
  await runBootstrapCommand(`edit ${source.id} snippet`, f.repository, ui);
  assert.equal(await f.repository.read("project", source), content("Edited"));
  await runBootstrapCommand("add global snippet", f.repository, ui);
  assert.match(notifications.at(-1)!, /cancelled/);
  await runBootstrapCommand("add global snippet", f.repository, ui);
  assert.match(notifications.at(-1)!, /nonempty/);
  await runBootstrapCommand(`delete ${source.id} snippet`, f.repository, ui);
  assert.equal((await loadSnippets(f.repository)).length, 0);
});

test("menu preview/cancel, widget, live reload, transformation and reset", async t => {
  const f = await fixture(t);
  await installSnippetDefaults(f.repository);
  for (const s of (await f.repository.list("global")).filter(s => s.type === "snippet"))
    await f.repository.delete("global", s);
  const before = await f.repository.create("global", "snippet", content("Before"));
  await f.repository.create("project", "snippet", content("After"));
  const handlers = new Map<string, any>(), commands = new Map<string, any>(), shortcuts = new Map<string, any>();
  registerSnippets({ on: (name: string, fn: any) => handlers.set(name, fn),
    registerCommand: (name: string, spec: any) => commands.set(name, spec),
    registerShortcut: (name: string, spec: any) => shortcuts.set(name, spec),
  } as never, () => f.repository);
  let keys = [" ", "\u001b[B", " ", "\r"];
  let widget: string[] | undefined;
  const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
  const ctx = { cwd: f.projectRoot, hasUI: true, mode: "tui", ui: {
    theme, notify: () => {}, setWidget: (_: string, lines: string[] | undefined) => { widget = lines; },
    custom: async (factory: any) => new Promise(resolve => {
      const component = factory({ terminal: { rows: 20 }, requestRender() {} }, theme, {}, resolve);
      for (const key of keys) { component.render(60); component.handleInput(key); }
    }),
  } };
  await handlers.get("session_start")({}, ctx);
  await commands.get("snippets").handler("", ctx);
  assert.equal(widget!.length, 1);
  // Cancelling edits in the menu keeps the prior selection; preview returns to the list.
  keys = [" ", "\t", "\u001b", "\u001b"];
  await shortcuts.get("alt+s").handler(ctx);
  assert.equal(widget!.length, 1);
  await f.repository.edit("global", { id: before, type: "snippet" }, content("Updated"));
  assert.deepEqual(await handlers.get("input")({ text: "Message" }, ctx), { action: "transform", text: "Message\n\nUpdated\n\nAfter" });
  assert.equal(widget, undefined);
  assert.equal(await handlers.get("input")({ text: "Again" }, ctx), undefined);
  keys = [" ", "\r"];
  await commands.get("snippets").handler("", ctx);
  await handlers.get("session_start")({}, ctx);
  assert.equal(await handlers.get("input")({ text: "New session" }, ctx), undefined);
  ctx.mode = "print";
  await commands.get("snippets").handler("", ctx);
});
