import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerBootstrap } from "../index.ts";
import { runBootstrapCommand } from "../src/bootstrap-command.ts";
import { fixture, command, actions, executable, protocol, memoryProtocol, commandProtocol } from "./session-fixture.ts";

function hook(repository: Awaited<ReturnType<typeof fixture>>["repository"], cwd: string) {
  let handler: any;
  registerBootstrap({ on: (_name: string, fn: any) => { handler = fn; } } as never, () => repository);
  return (event: any) => handler(event, { cwd });
}

test("command replacement actions are request-local and refresh without a session restart", async t => {
  const f = await fixture(t);
  const run = hook(f.repository, f.projectRoot);
  const event = { messages: [{ role: "system", content: "<tools>Original</tools><rules>Rules</rules>" }] };
  await command(f.global, "tools.toml", 'description = "Tools"\nsection = "system_prompt.tools"\nreplacement = "New"');
  assert.equal(await f.repository.compose(), "");
  assert.equal((await run(event)).messages[0].content, "<tools>\nNew\n</tools><rules>Rules</rules>");
  await command(f.global, "tools.toml", 'description = "Tools"\nsection = "system_prompt.tools"\nreplacement = ""');
  assert.equal((await run(event)).messages[0].content, "<rules>Rules</rules>");
  await rm(join(f.global, "commands", "tools.toml"));
  assert.deepEqual((await run(event)).messages, event.messages);
  assert.equal(event.messages[0].content, "<tools>Original</tools><rules>Rules</rules>");
});

test("request actions save exact bodies, refresh files, and preserve configured reference links", async t => {
  const f = await fixture(t);
  const run = hook(f.repository, f.projectRoot);
  await actions(f.global, { "system_prompt.docs": { refer: "Read $link and $link", link: "nested/docs.md" } });
  await actions(f.project, { "system_prompt.rules": { refer: "Read $link", link: "nested/docs.md" } });
  for (const body of ["\nOriginal <child>docs</child>\n", "Updated", ""]) {
    const event = { messages: [{ role: "system", sections: { docs: "<docs>" + body + "</docs>", rules: "<rules>Project rules</rules>" } }] };
    const result = await run(event);
    assert.equal(result.messages[0].sections.docs, "<docs>\nRead nested/docs.md and nested/docs.md\n</docs>");
    assert.equal(await readFile(join(f.global, "nested/docs.md"), "utf8"), body);
    assert.equal(await readFile(join(f.project, "nested/docs.md"), "utf8"), "Project rules");
    assert.equal(event.messages[0].sections.docs, "<docs>" + body + "</docs>");
  }
  await run({ messages: [{ role: "system", content: "<docs>First</docs><docs>Last</docs>" }] });
  assert.equal(await readFile(join(f.global, "nested/docs.md"), "utf8"), "Last");
  await rm(join(f.global, "nested"), { recursive: true });
  await run({ messages: [{ role: "user", content: "<docs>Not system docs</docs>" }] });
  await assert.rejects(readFile(join(f.global, "nested/docs.md")), { code: "ENOENT" });
});

test("absolute and home reference links write to their destinations; write errors propagate", async t => {
  const f = await fixture(t);
  const home = await mkdtemp(join(homedir(), ".pi-bootstrap-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const run = hook(f.repository, f.projectRoot);
  const homeLink = "~/" + home.slice(homedir().length + 1) + "/docs.md";
  for (const link of [join(home, "docs.md"), homeLink]) {
    await actions(f.global, { docs: { refer: "Read $link", link } });
    const result = await run({ messages: [{ role: "user", content: [{ type: "text", text: "<docs>Original</docs>" }] }] });
    assert.equal(result.messages[0].content[0].text, "<docs>\nRead " + link + "\n</docs>");
    assert.equal(await readFile(join(home, "docs.md"), "utf8"), "Original");
  }
  await actions(f.global, { docs: { refer: "Read $link", link: join(home, "docs.md/child.md") } });
  await assert.rejects(run({ messages: [{ role: "system", content: "<docs>Fail</docs>" }] }));
});

test("project targets override global targets; duplicates within one scope fail before writes", async t => {
  const f = await fixture(t);
  const run = hook(f.repository, f.projectRoot);
  await actions(f.global, { "system_prompt.docs": { refer: "Global $link", link: "global.md" } });
  await actions(f.project, { "system_prompt.docs": { refer: "Project $link", link: "project.md" } });
  const event = { messages: [{ role: "system", content: "<docs>Original</docs>" }] };
  assert.equal((await run(event)).messages[0].content, "<docs>\nProject project.md\n</docs>");
  assert.equal(await readFile(join(f.project, "project.md"), "utf8"), "Original");
  await assert.rejects(readFile(join(f.global, "global.md")), { code: "ENOENT" });
  await actions(f.project, {});
  assert.equal((await run(event)).messages[0].content, "<docs>\nGlobal global.md\n</docs>");
  await rm(join(f.global, "global.md"));
  await command(f.global, "duplicate.toml", 'description = "Duplicate"\nsection = ["system_prompt", "docs"]\nreplacement = "Other"');
  await assert.rejects(run(event), /Global conflicting actions.*request-0.toml.*duplicate.toml|Global conflicting actions.*duplicate.toml.*request-0.toml/);
  await assert.rejects(readFile(join(f.global, "global.md")), { code: "ENOENT" });
});

test("request action validation rejects mixed actions, invalid fields and malformed targets", async t => {
  const f = await fixture(t);
  const run = hook(f.repository, f.projectRoot);
  for (const body of [
    'section = "docs"\nreplacement = "Text"',
    'description = ""\nsection = "docs"\nreplacement = "Text"',
    'description = "Line\\nbreak"\nsection = "docs"\nreplacement = "Text"',
    'description = "Action"\nsection = "docs"',
    'description = "Action"\nreplacement = "Text"',
    ...['""', '"one..two"', '".one"', '"one."', '"one two"', '42', '[]', '["one", 2]'].map(target =>
      'description = "Action"\nsection = ' + target + '\nreplacement = "Text"'),
    ...[
      'replacement = 42',
      'refer = "Read"',
      'refer = 42\nlink = "docs.md"',
      'refer = "Read"\nlink = ""',
      'refer = "Read"\nlink = "   "',
      'refer = "Read"\nlink = 42',
      'replacement = "Text"\nrefer = "Read"\nlink = "docs.md"',
      'replacement = "Text"\nargv = ["echo"]',
      'refer = "Read"\nlink = "docs.md"\nexpression = \'"text"\'',
      'replacement = "Text"\nsection = "docs"',
      'replacement = "Text"\ncwd = "."',
      'replacement = "Text"\nlink = "docs.md"',
      'replacement = "Text"\nunknown = "typo"',
      'replacement = "Text"\ntarget = "docs"',
    ].map(fields => 'description = "Action"\nsection = "docs"\n' + fields),
    '[invalid',
  ]) {
    await command(f.global, "bad.toml", body);
    await assert.rejects(run({ messages: [{ role: "system", content: "<docs>Original</docs>" }] }), /bad.toml/);
  }
});

test("target arrays preserve literal dots and parent actions win over child actions", async t => {
  const f = await fixture(t);
  const run = hook(f.repository, f.projectRoot);
  await command(f.global, "literal.toml", 'description = "Literal"\nsection = ["one.two"]\nreplacement = "Literal"');
  await actions(f.global, { "one.two": "Child", one: "Parent" });
  const result = await run({ messages: [{ role: "user", content: "<one.two>Old</one.two><one><two>Old</two></one>" }] });
  assert.equal(result.messages[0].content, "<one.two>\nLiteral\n</one.two><one>\nParent\n</one>");
});

test("protocol selection applies to actions without running executable sources on requests", async t => {
  const f = await fixture(t);
  const run = hook(f.repository, f.projectRoot);
  const marker = join(f.root, "must-not-run");
  await command(f.global, "execute.toml", executable(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`));
  await command(f.global, "expression.toml", 'description = "Must not evaluate"\nexpression = "missingFunction()"');
  await actions(f.global, { docs: "Global" });
  await actions(f.project, { docs: "Project" });
  const event = { messages: [{ role: "user", content: "<docs>Original</docs>" }] };
  assert.equal((await run(event)).messages[0].content, "<docs>\nProject\n</docs>");
  await protocol(f.project, memoryProtocol);
  assert.equal((await run(event)).messages[0].content, "<docs>\nGlobal\n</docs>");
  await protocol(f.global, memoryProtocol);
  assert.deepEqual((await run(event)).messages, event.messages);
  await protocol(f.project, commandProtocol);
  assert.equal((await run(event)).messages[0].content, "<docs>\nProject\n</docs>");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  await protocol(f.project, commandProtocol + commandProtocol);
  await assert.rejects(run(event), /overlap/);
});

test("request selection ignores symlinks and subdirectories and never creates config.toml", async t => {
  const f = await fixture(t);
  const run = hook(f.repository, f.projectRoot);
  await writeFile(join(f.global, "config.toml"), "invalid legacy config");
  await command(f.global, "ignored.txt", "invalid");
  await mkdir(join(f.global, "commands", "folder.toml"));
  await symlink(join(f.global, "config.toml"), join(f.global, "commands", "linked.toml"));
  const event = { messages: [{ role: "system", content: "<tools>Unchanged</tools>" }] };
  assert.deepEqual((await run(event)).messages, event.messages);
  assert.equal(await readFile(join(f.global, "config.toml"), "utf8"), "invalid legacy config");
  await rm(join(f.global, "config.toml"));
  assert.deepEqual((await run(event)).messages, event.messages);
  assert.ok(!(await readdir(f.global)).includes("config.toml"));
  await rm(f.global, { recursive: true });
  assert.deepEqual((await run(event)).messages, event.messages);
  assert.deepEqual(await readdir(f.global), ["protocol.toml"]);
});

test("/bootstrap manages action files and changes take effect on the next request", async t => {
  const f = await fixture(t);
  const run = hook(f.repository, f.projectRoot);
  const values = [
    'description = "Replace docs"\nsection = "docs"\nreplacement = "First"',
    'description = "Reference docs"\nsection = "docs"\nrefer = "Read $link"\nlink = "docs.md"',
  ];
  const notices: string[] = [];
  const ui = {
    hasUI: true,
    editor: async (_title: string, initial: string) => {
      if (values.length === 2) assert.match(initial, /replacement[\s\S]*refer[\s\S]*link/);
      return values.shift();
    },
    notify: (message: string) => { notices.push(message); },
  };
  const event = { messages: [{ role: "user", content: "<docs>Original</docs>" }] };
  await runBootstrapCommand("add project command", f.repository, ui);
  const [source] = await f.repository.list("project");
  assert.equal((await run(event)).messages[0].content, "<docs>\nFirst\n</docs>");
  await runBootstrapCommand("list project command", f.repository, ui);
  assert.match(notices.at(-1)!, /Replace docs/);
  await runBootstrapCommand(`edit ${source.id} command`, f.repository, ui);
  assert.equal((await run(event)).messages[0].content, "<docs>\nRead docs.md\n</docs>");
  assert.equal(await readFile(join(f.project, "docs.md"), "utf8"), "Original");
  await runBootstrapCommand(`delete ${source.id} command`, f.repository, ui);
  assert.deepEqual((await run(event)).messages, event.messages);
});
