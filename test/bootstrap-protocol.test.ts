import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BootstrapRepository } from "../src/bootstrap-repository.ts";
import { COMMAND_OUTPUT_LIMIT_BYTES, COMMAND_TIMEOUT_MS, DEFAULT_PROTOCOL, CommandSourceError } from "../src/bootstrap-protocol.ts";
import { fixture, protocol, memory, command, executable, memoryProtocol, commandProtocol } from "./session-fixture.ts";

test("default protocol is installed exclusively, inherited, overridden and restored", async t => {
  const f = await fixture(t);
  await memory(f.global, "global.md", "Global");
  await memory(f.project, "project.md", "Project");
  assert.equal(await f.repository.compose(), '<memory>\nGlobal\n\nProject\n</memory>');
  assert.equal(await readFile(join(f.global, "config.toml"), "utf8"), DEFAULT_PROTOCOL);
  assert.match(DEFAULT_PROTOCOL, /glob = "\*\.toml"/);
  await protocol(f.project, '[[rule]]\nglob = "only-*.md"\naction = "memory"\n');
  await memory(f.project, "only-one.md", "Selected");
  assert.match(await f.repository.compose(), /Selected/);
  assert.doesNotMatch(await f.repository.compose(), /Project/);
  await rm(join(f.project, "config.toml"));
  assert.match(await f.repository.compose(), /Project/);
  await protocol(f.global, memoryProtocol);
  await f.repository.compose();
  assert.equal(await readFile(join(f.global, "config.toml"), "utf8"), memoryProtocol);
});

test("missing roots are empty and concurrent default installation does not clobber", async t => {
  const f = await fixture(t);
  await rm(f.global, { recursive: true });
  await rm(f.project, { recursive: true });
  assert.deepEqual(await Promise.all([f.repository.compose(), f.repository.compose()]), ["", ""]);
});

test("only direct regular files in action-specific folders are selected, sorted and escaped", async t => {
  const f = await fixture(t);
  await memory(f.project, "z.md", "Z\nlast");
  await memory(f.project, "a.md", '<tag>&</memory>"\'');
  await memory(f.project, "ignore.txt", "Ignore");
  await writeFile(join(f.project, "root.md"), "Ignore root");
  await command(f.project, "wrong.md", "Ignore wrong folder");
  await symlink(join(f.project, "memories", "a.md"), join(f.project, "memories", "linked.md"));
  await mkdir(join(f.project, "memories", "folder.md"));
  await writeFile(join(f.project, "memories", "folder.md", "hidden.md"), "Hidden");
  assert.equal(await f.repository.compose(), '<memory>\n&lt;tag&gt;&amp;&lt;/memory&gt;&quot;&apos;\n\nZ\nlast\n</memory>');
  await memory(f.project, "later.md", "Added directly");
  assert.match(await f.repository.compose(), /Added directly/);
});

test("items have one blank line between them after trailing source line breaks", async t => {
  const f = await fixture(t);
  await memory(f.project, "trailing.md", "First\nlast\r\n\r\n");
  await command(f.project, "trailing.toml", executable('process.stdout.write("First\\nlast\\n\\n")'));
  assert.equal(await f.repository.compose(), '<memory>\nFirst\nlast\n</memory>\n\n<commands>\nTest command\nFirst\nlast\n</commands>');
});

test("rule order precedes filename order and overlap is scoped to the action folder", async t => {
  const f = await fixture(t);
  await protocol(f.project, '[[rule]]\nglob = "z.md"\naction = "memory"\n[[rule]]\nglob = "a.md"\naction = "memory"\n');
  await memory(f.project, "a.md", "A");
  await memory(f.project, "z.md", "Z");
  const output = await f.repository.compose();
  assert.ok(output.indexOf("\nZ\n") < output.indexOf("\nA\n"));
  await protocol(f.project, '[[rule]]\nglob = "*.toml"\naction = "memory"\n[[rule]]\nglob = "*.toml"\naction = "command"\n');
  await memory(f.project, "same.toml", "Memory");
  await command(f.project, "same.toml", executable('process.stdout.write("Command")'));
  assert.match(await f.repository.compose(), /Memory[\s\S]*Test command\nCommand/);
});

test("command argv is literal, output preserves lines and XML cannot introduce markup", async t => {
  const f = await fixture(t);
  await command(f.project, "command-test.toml", `description = "Test command"\nargv = ${JSON.stringify([process.execPath, "-e", "process.stdout.write(process.argv[1])", "literal; $HOME <tag>&\nnext"])}\ncwd = "."\n`);
  const output = await f.repository.compose();
  assert.doesNotMatch(output, /<run>|<output>|process\.stdout/);
  assert.match(output, /Test command\nliteral; \$HOME &lt;tag&gt;&amp;\nnext/);
  assert.doesNotMatch(output, /<tag>/);
});

test("both scopes run commands relative to the project root, including contained cwd", async t => {
  const f = await fixture(t);
  await mkdir(join(f.projectRoot, "child"));
  await writeFile(join(f.projectRoot, "child", "marker.txt"), "child-marker");
  await command(f.global, "global.toml", executable('process.stdout.write(require("fs").readFileSync("child/marker.txt"))'));
  await command(f.project, "project.toml", executable('process.stdout.write(require("fs").readFileSync("marker.txt"))', "child"));
  assert.equal((await f.repository.compose()).match(/Test command\nchild-marker/g)?.length, 2);
});

test("commands execute in scope, rule and filename order and overlap is preflighted", async t => {
  const f = await fixture(t);
  const record = (label: string) => executable(`require("fs").appendFileSync("order.txt", "${label}\\n")`);
  await command(f.global, "command-global.toml", record("global"));
  await command(f.project, "command-a.toml", record("a"));
  await command(f.project, "command-b.toml", record("b"));
  await command(f.project, "command-z.toml", record("z"));
  await protocol(f.project, '[[rule]]\nglob = "command-z.toml"\naction = "command"\n[[rule]]\nglob = "command-a.toml"\naction = "command"\n[[rule]]\nglob = "command-b.toml"\naction = "command"\n');
  await f.repository.compose();
  assert.equal(await readFile(join(f.projectRoot, "order.txt"), "utf8"), "global\nz\na\nb\n");
  await rm(join(f.projectRoot, "order.txt"));
  await rm(join(f.global, "commands", "command-global.toml"));
  await protocol(f.project, commandProtocol);
  await f.repository.compose();
  assert.equal(await readFile(join(f.projectRoot, "order.txt"), "utf8"), "a\nb\nz\n");
  await rm(join(f.projectRoot, "order.txt"));
  await protocol(f.project, commandProtocol + '\n[[rule]]\nglob = "command-z.toml"\naction = "command"\n');
  await assert.rejects(f.repository.compose(), /rules overlap/);
  await assert.rejects(readFile(join(f.projectRoot, "order.txt")), { code: "ENOENT" });
});

test("command failures are typed and never return partial composition", async t => {
  const f = await fixture(t);
  await memory(f.global, "first.md", "must not be returned");
  await command(f.project, "bad.toml", executable("process.exit(7)"));
  await assert.rejects(f.repository.compose(), error => {
    assert.ok(error instanceof CommandSourceError);
    assert.equal(error.sourceName, "bad.toml");
    assert.equal(error.exitCode, 7);
    assert.match(error.message, /exited with status 7/);
    return true;
  });
});

test("command timeout, output bound, invalid UTF-8, spawn errors and noisy stderr", async t => {
  const f = await fixture(t);
  for (const [code, expected] of [
    ['setTimeout(() => {}, 10000)', new RegExp(`timed out after ${COMMAND_TIMEOUT_MS}ms`)],
    [`process.stdout.write('x'.repeat(${COMMAND_OUTPUT_LIMIT_BYTES + 1}))`, /stdout exceeded/],
    ['process.stdout.write(Buffer.from([255]))', /invalid UTF-8 stdout/],
  ] as const) {
    await command(f.project, "case.toml", executable(code));
    await assert.rejects(f.repository.compose(), expected);
  }
  await command(f.project, "case.toml", 'description = "Test command"\nargv = ["/nonexistent/bootstrap-executable"]\n');
  await assert.rejects(f.repository.compose(), /execution failed/);
  await command(f.project, "case.toml", executable('process.stderr.write("x".repeat(2000000), () => process.stdout.write("ok"))'));
  assert.match(await f.repository.compose(), /Test command\nok/);
});

test("command definitions and cwd containment are validated", async t => {
  const f = await fixture(t);
  await symlink(f.global, join(f.projectRoot, "escape"));
  for (const [body, expected] of [
    ['description =', /not valid TOML/],
    ['description = "Test command"\nargv = []', /non-empty argv/],
    ['description = "Test command"\nargv = [2]', /non-empty argv/],
    [executable("", ""), /invalid cwd/],
    [executable("", f.projectRoot), /cwd must be relative/],
    [executable("", "../outside"), /must not escape/],
    [executable("", "escape"), /must not escape/],
    [executable("", "absent"), /cannot be resolved/],
  ] as const) {
    await command(f.project, "case.toml", body);
    await assert.rejects(f.repository.compose(), expected);
  }
});

test("invalid protocols, globs, actions, overlap and UTF-8 fail explicitly", async t => {
  const f = await fixture(t);
  await memory(f.project, "guide.md", "ambiguous");
  for (const [text, expected] of [
    ['description =', /not valid TOML/],
    ['rule = []', /one or more/],
    ...["**/*.md", "../*.md", "a?.md", "[ab].md", "{a,b}.md", "", ".", "..", "a\\b"].map(glob => [
      `[[rule]]\nglob = ${JSON.stringify(glob)}\naction = "memory"`, /unsupported direct-file glob/,
    ] as const),
    ['[[rule]]\nglob = "*.md"\naction = "unknown"', /invalid action/],
    ['[[rule]]\nglob = "*"\naction = "command"', /must select \*\.toml/],
    [memoryProtocol + '\n[[rule]]\nglob = "guide*"\naction = "memory"', /rules overlap on source "guide.md"/],
  ] as const) {
    await protocol(f.project, text);
    await assert.rejects(f.repository.compose(), expected);
  }
  await writeFile(join(f.project, "config.toml"), Buffer.from([255]));
  await assert.rejects(f.repository.compose(), /not valid UTF-8/);
  await protocol(f.project, memoryProtocol);
  await memory(f.project, "guide.md", Buffer.from([255]));
  await assert.rejects(f.repository.compose(), /not valid UTF-8/);
  await rm(join(f.project, "memories"), { recursive: true });
  await writeFile(join(f.project, "memories"), "not a directory");
  await assert.rejects(f.repository.compose(), /cannot be read/);
});

test("existing unmatched command globs remain unchanged rather than being silently migrated", async t => {
  const f = await fixture(t);
  const existing = commandProtocol.replace('*.toml', '*.command.toml');
  await protocol(f.global, existing);
  await command(f.global, "command-0123abcd.toml", executable('process.stdout.write("Selected")'));
  assert.equal(await f.repository.compose(), "");
  assert.equal(await readFile(join(f.global, "config.toml"), "utf8"), existing);
  await protocol(f.global, commandProtocol);
  assert.match(await f.repository.compose(), /Test command\nSelected/);
});

test("command files named protocol and config are ordinary sources inside commands", async t => {
  const f = await fixture(t);
  for (const scope of ["global", "project"] as const) {
    const root = f.repository.directories[`${scope}Directory`];
    for (const id of ["protocol", "config"]) {
      await command(root, `${id}.toml`, executable(`process.stdout.write("${scope}-${id}")`));
      assert.ok((await f.repository.list(scope)).some(source => source.id === id));
      await f.repository.edit(scope, { id, type: "command" }, executable(`process.stdout.write("edited-${scope}-${id}")`));
    }
  }
  const output = await f.repository.compose();
  for (const scope of ["global", "project"]) {
    for (const id of ["protocol", "config"]) {
      assert.ok(output.includes(`Test command\nedited-${scope}-${id}`));
    }
  }
});

test("contained cwd names beginning with two dots are not parent traversal", async t => {
  const f = await fixture(t);
  await mkdir(join(f.projectRoot, "..cache"));
  await writeFile(join(f.projectRoot, "..cache", "marker.txt"), "contained");
  await symlink(join(f.projectRoot, "..cache"), join(f.projectRoot, "alias"));
  for (const cwd of ["..cache", "alias"]) {
    await command(f.project, "command-contained.toml", executable('process.stdout.write(require("fs").readFileSync("marker.txt"))', cwd));
    assert.match(await f.repository.compose(), /Test command\ncontained/);
  }
});

test("protocols never select config.toml or protocol.toml at the extension root", async t => {
  const f = await fixture(t);
  await writeFile(join(f.global, "protocol.toml"), "invalid source");
  await protocol(f.global, commandProtocol);
  assert.equal(await f.repository.compose(), "");
  const isolated = new BootstrapRepository({ globalDirectory: f.global, projectDirectory: f.project });
  assert.equal(await isolated.compose(), "");
});
