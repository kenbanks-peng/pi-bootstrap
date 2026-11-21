import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./session-fixture.ts";
import { loadSnippets, installSnippetDefaults } from "../src/bootstrap-snippet-storage.ts";
import { parseSnippet, snippetTemplate } from "../src/bootstrap-snippet-model.ts";
import { registerSnippets } from "../src/bootstrap-snippets.ts";
import { runBootstrapCommand } from "../src/bootstrap-command.ts";

const content = (name: string, placement = "append", order = 9999) =>
  `---\nname: ${name}\nplacement: ${placement}\norder: ${order}\n---\n${name}`;

test("snippet parsing matches prompt-snippets frontmatter and strips metadata", () => {
  assert.equal(parseSnippet("x.md", " \n\t"), null);
  assert.equal(parseSnippet("x.md", "# Plain Markdown"), null);
  assert.equal(parseSnippet("x.md", "---\nname: Empty\n---\n "), null);
  assert.deepEqual(parseSnippet("x.md", content("Title", "prepend", 5)), {
    id: "x.md", name: "Title",
    placement: "prepend", order: 5, body: "Title",
  });
  assert.deepEqual(parseSnippet("fallback.MD", "---\r\nname: ''\r\norder: invalid\r\nplacement: other\r\n---\r\n Body \r\n"), {
    id: "fallback.MD", name: "fallback",
    placement: "append", order: 9999, body: "Body",
  });
  assert.equal(parseSnippet("x.md", "---\nname: 'Quoted'\n---\nBody")!.name, "Quoted");
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
    const raw = await f.repository.read("global", source);
    assert.ok(parseSnippet(source.id + ".md", raw));
    assert.doesNotMatch(raw, /^description:/m);
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

test("placement, order and name sorting span scopes; duplicate names remain independent", async t => {
  const f = await fixture(t);
  await f.repository.create("global", "snippet", content("Same"));
  await f.repository.create("project", "snippet", content("Same"));
  await f.repository.create("project", "snippet", content("Before"));
  await f.repository.create("project", "snippet", content("First", "prepend", 50));
  await f.repository.create("global", "snippet", content("Second", "append", 1));
  const snippets = await loadSnippets(f.repository);
  assert.deepEqual(snippets.map(s => [s.name, s.scope]), [["First", "project"], ["Second", "global"], ["Before", "project"], ["Same", "global"], ["Same", "project"]]);
  assert.equal(new Set(snippets.map(s => s.id)).size, 5);
});

test("/bootstrap snippet add/list/edit/delete and cancellation", async t => {
  const f = await fixture(t);
  const notifications: string[] = [];
  const values: Array<string | undefined> = ["New body", "Edited body", undefined, " "];
  const names = ["New", "Edited", "Cancelled", "Empty"];
  const ui = { hasUI: true,
    input: async () => names.shift(),
    select: async (_title: string, options: string[]) => { assert.deepEqual(new Set(options), new Set(["prepend", "append"])); return "append"; },
    editor: async (_title: string, initial: string) => {
    assert.doesNotMatch(initial, /---|placement:|order:/); return values.shift();
  }, notify: (message: string) => { notifications.push(message); } };
  await runBootstrapCommand("add snippet", f.repository, ui);
  const [source] = (await f.repository.list("project")).filter(s => s.type === "snippet");
  await runBootstrapCommand("list snippet", f.repository, ui);
  assert.equal(notifications.at(-1), `global: none\n\nproject:\n- New: New body [${source.id}]`);
  await runBootstrapCommand(`edit ${source.id} snippet`, f.repository, ui);
  const edited = parseSnippet(source.id, await f.repository.read("project", source))!;
  assert.equal(edited.name, "Edited");
  assert.equal(edited.body, "Edited body");
  assert.equal(edited.order, 1);
  await runBootstrapCommand("add global snippet", f.repository, ui);
  assert.match(notifications.at(-1)!, /cancelled/);
  await runBootstrapCommand("add global snippet", f.repository, ui);
  assert.match(notifications.at(-1)!, /nonempty/);
  await runBootstrapCommand(`delete ${source.id} snippet`, f.repository, ui);
  assert.equal((await loadSnippets(f.repository)).length, 0);
});

test("snippet prompts cancel without writes and assign order across scopes", async t => {
  const f = await fixture(t);
  await f.repository.create("project", "snippet", content("Existing", "append", 20));
  const notifications: string[] = [];
  const ui = {
    hasUI: true,
    input: async (): Promise<string | undefined> => 'Say "yes": please',
    select: async (): Promise<string | undefined> => "append",
    editor: async (): Promise<string | undefined> => "Text only",
    notify: (message: string) => { notifications.push(message); },
  };
  await runBootstrapCommand("add global snippet", f.repository, ui);
  const [source] = await f.repository.list("global");
  const saved = parseSnippet(source.id, await f.repository.read("global", source))!;
  assert.equal(saved.name, 'Say "yes": please');
  assert.equal(saved.order, 21);
  assert.doesNotMatch(await f.repository.read("global", source), /description:/);
  assert.equal(saved.body, "Text only");
  for (const stage of ["input", "select", "editor"] as const) {
    await runBootstrapCommand("add global snippet", f.repository, { ...ui, [stage]: async () => undefined });
    assert.match(notifications.at(-1)!, /cancelled/);
    assert.equal((await f.repository.list("global")).length, 1);
  }
  await runBootstrapCommand(`edit ${source.id} snippet`, f.repository, { ...ui, select: async () => "prepend" });
  const moved = parseSnippet(source.id, await f.repository.read("global", source))!;
  assert.equal(moved.placement, "prepend");
  assert.equal(moved.order, 1);
});

test("menu preview/cancel, widget, live reload, transformation and reset", async t => {
  const f = await fixture(t);
  await installSnippetDefaults(f.repository);
  for (const s of (await f.repository.list("global")).filter(s => s.type === "snippet"))
    await f.repository.delete("global", s);
  const before = await f.repository.create("global", "snippet", content("Before", "prepend"));
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
      const rows = component.render(120).join("\n");
      assert.match(rows, /Before|Updated/);
      assert.doesNotMatch(rows, /Description for/);
      assert.match(rows, /\[global\]/);
      assert.doesNotMatch(rows, /\[ \] ---/);
      for (const key of keys) { component.render(120); component.handleInput(key); }
    }),
  } };
  await handlers.get("session_start")({}, ctx);
  await commands.get("snippets").handler("", ctx);
  assert.equal(widget!.length, 2);
  // Cancelling edits in the menu keeps the prior selection; preview returns to the list.
  keys = [" ", "\t", "\u001b", "\u001b"];
  await shortcuts.get("alt+s").handler(ctx);
  assert.equal(widget!.length, 2);
  await f.repository.edit("global", { id: before, type: "snippet" }, content("Updated", "prepend"));
  assert.deepEqual(await handlers.get("input")({ text: "Message" }, ctx), { action: "transform", text: "Updated\n\nMessage\n\nAfter" });
  assert.equal(widget, undefined);
  assert.equal(await handlers.get("input")({ text: "Again" }, ctx), undefined);
  keys = [" ", "\r"];
  await commands.get("snippets").handler("", ctx);
  await handlers.get("session_start")({}, ctx);
  assert.equal(await handlers.get("input")({ text: "New session" }, ctx), undefined);
  ctx.mode = "print";
  await commands.get("snippets").handler("", ctx);
});
