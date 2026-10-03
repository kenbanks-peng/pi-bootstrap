import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerBootstrap } from "../index.ts";
import { registerBootstrapSession } from "../src/bootstrap-session.ts";
import { registerLazySkills } from "../src/bootstrap-skills.ts";
import { fixture, command, memory, executable, actions } from "./session-fixture.ts";

function harness(repository: any) {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const tools = new Map<string, any>();
  const pi = {
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {},
    getAllTools: () => [{ name: "read" }],
    getActiveTools: () => ["read"],
  };
  const snapshot = registerBootstrapSession(pi as never, () => repository);
  const transform = registerLazySkills(pi as never);
  const run = async (name: string, event: any, ctx: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  return { pi, snapshot, transform, run, tools };
}
const skills = [
  { name: "zebra", description: "Private description", filePath: "/z/SKILL.md", baseDir: "/z" },
  { name: "alpha", description: "Alpha instructions", filePath: "/a/SKILL.md", baseDir: "/a" },
  { name: "manual", description: "Disabled", disableModelInvocation: true },
  { name: "alpha", description: "Duplicate" },
];
const skillCommand = 'description = "Names:"\nsection = "system_prompt.skills"\nexpression = \'ALL_SKILLS.map(s => s.name).join(", ")\'\n';

test("section commands replace request sections, combine in source order, and stay outside bootstrap", async t => {
  const f = await fixture(t);
  await command(f.global, "a.toml", 'description = "Global"\nsection = "system_prompt.skills"\nexpression = \'"<global>"\'');
  await command(f.project, "a.toml", 'description = "Project"\nsection = "system_prompt.skills"\n' + executable('process.stdout.write("<project>")').split("\n").slice(1).join("\n"));
  await memory(f.project, "memory.md", "Memory");
  const h = harness(f.repository);
  await actions(f.global, { "system_prompt.skills": { refer: "Read $link", link: "skills.md" } });
  registerBootstrap(h.pi as never, () => f.repository, h.snapshot, h.transform, h.snapshot.sections);
  await h.run("session_start", {}, { cwd: f.projectRoot, ui: { notify() {} } });
  await h.run("before_agent_start", { systemPromptOptions: { skills, sections: {} } });
  const messages = [
    { role: "system", content: "", sections: { skills: "<skills>Old catalog</skills>", rules: "<rules>Rules</rules>" } },
    { role: "system", content: "", sections: { skills: "<skills>Historical catalog</skills>" } },
    { role: "user", content: "<skills>User text</skills>" },
  ];
  const original = structuredClone(messages);
  const result = await h.run("context_with_system", { messages }, { cwd: f.projectRoot });
  assert.match(result.messages[0].content, /<skills>\nRead skills.md\n<\/skills>/);
  assert.match(result.messages[0].content, /<memory>\nMemory\n<\/memory>$/);
  assert.doesNotMatch(result.messages[0].content, /Global|Project|Old catalog|Historical catalog/);
  assert.equal(await readFile(join(f.global, "skills.md"), "utf8"), "\nGlobal\n&lt;global&gt;\n\nProject\n&lt;project&gt;\n");
  assert.equal(result.messages[2].content, messages[2].content);
  assert.deepEqual(messages, original);
});

test("skill metadata is filtered and frozen, and skill commands run once from saved sources", async t => {
  const f = await fixture(t);
  await command(f.project, "skills.toml", skillCommand);
  const h = harness(f.repository);
  registerBootstrap(h.pi as never, () => f.repository, h.snapshot, h.transform, h.snapshot.sections);
  await h.run("session_start", {}, { cwd: f.projectRoot, ui: { notify() {} } });
  assert.deepEqual(h.snapshot.sections(), {});
  await command(f.project, "skills.toml", skillCommand.replace('Names:', 'Changed:'));
  await h.run("before_agent_start", { systemPromptOptions: { skills, sections: {} } });
  assert.equal(h.snapshot.sections()[JSON.stringify(["system_prompt", "skills"])], "Names:\nalpha, zebra");
  assert.equal(h.snapshot(), "");
  await h.run("before_agent_start", { systemPromptOptions: { skills: [], sections: {} } });
  assert.match(h.snapshot.sections()[JSON.stringify(["system_prompt", "skills"])], /alpha, zebra/);
  const result = await h.run("context_with_system", { messages: [{ role: "system", content: "", sections: { skills: "<skills>Old</skills>" } }] }, { cwd: f.projectRoot });
  assert.equal(result.messages[0].sections.skills, "<skills>\nNames:\nalpha, zebra\n</skills>");
  await h.run("session_shutdown", {});
  assert.deepEqual(h.snapshot.sections(), {});

  await command(f.project, "skills.toml", 'description = "Frozen"\nsection = "system_prompt.skills"\nexpression = \'(() => { ALL_SKILLS[0].name = "bad"; return "bad"; })()\'');
  await h.run("session_start", {}, { cwd: f.projectRoot, ui: { notify() {} } });
  await assert.rejects(h.run("before_agent_start", { systemPromptOptions: { skills, sections: {} } }), /read only|readonly|Cannot assign/i);
  assert.equal(h.snapshot(), "");
  assert.deepEqual(h.snapshot.sections(), {});
});

test("section names are validated for argv and expression commands", async t => {
  const f = await fixture(t);
  for (const value of ['""', '"system_prompt..skills"', '"skills><rules"', '42', '[]', '["skills", 42]']) {
    await command(f.project, "bad.toml", 'description = "Bad"\nsection = ' + value + '\nexpression = \'"text"\'');
    await assert.rejects(f.repository.composeSnapshot({ allTools: [], activeTools: [], allSkills: [] }), /section must/);
  }
});

test("example skill command works with ALL_SKILLS and pi.getSkills", async t => {
  const f = await fixture(t);
  const example = await readFile(new URL("../examples/skills.toml", import.meta.url), "utf8");
  await command(f.project, "skills.toml", example.replace("ALL_SKILLS", "pi.getSkills()"));
  const h = harness(f.repository);
  await h.run("session_start", {}, { cwd: f.projectRoot, ui: { notify() {} } });
  await h.run("before_agent_start", { systemPromptOptions: { skills, sections: {} } });
  assert.match(h.snapshot.sections()[JSON.stringify(["system_prompt", "skills"])], /alpha, zebra/);
  assert.match(h.snapshot.sections()[JSON.stringify(["system_prompt", "skills"])], /skill_search/);
  assert.doesNotMatch(h.snapshot.sections()[JSON.stringify(["system_prompt", "skills"])], /Private description|manual|Duplicate/);
});

test("all execution methods use section paths for nested tags, edges, and literal dotted names", async t => {
  const f = await fixture(t);
  await command(f.global, "nested.toml", 'description = "Global"\nsection = "system_prompt.rules.child"\nexpression = \'"<global>"\'');
  await command(f.project, "nested.toml", 'description = "Project"\nsection = ["system_prompt", "rules", "child"]\n' + executable('process.stdout.write("<project>")').split("\n").slice(1).join("\n"));
  await command(f.project, "edge.toml", 'description = "Opening"\nsection = "system_prompt.preamble"\nexpression = \'"New opening"\'');
  await command(f.project, "literal.toml", 'description = "Literal"\nsection = ["one.two"]\nexpression = \'"New literal"\'');
  await command(f.project, "absent.toml", 'description = "Absent"\nsection = "system_prompt.missing.child"\nexpression = \'"Not inserted"\'');
  await actions(f.global, { "system_prompt.rules.child": { refer: "Read $link", link: "child.md" } });
  const h = harness(f.repository);
  registerBootstrap(h.pi as never, () => f.repository, h.snapshot, messages => messages, h.snapshot.sections);
  await h.run("session_start", {}, { cwd: f.projectRoot, ui: { notify() {} } });
  const messages = [
    { role: "system", content: "", sections: { preamble: "Old opening", rules: "<rules>Before<child>Original</child>After</rules>" } },
    { role: "user", content: "<one.two>Original</one.two><rules><child>User child</child></rules>" },
  ];
  const before = structuredClone(messages);
  const result = await h.run("context_with_system", { messages }, { cwd: f.projectRoot });
  assert.equal(result.messages[0].sections.preamble, "Opening\nNew opening");
  assert.equal(result.messages[0].sections.rules, "<rules>Before<child>\nRead child.md\n</child>After</rules>");
  assert.equal(await readFile(join(f.global, "child.md"), "utf8"), "\nGlobal\n&lt;global&gt;\n\nProject\n&lt;project&gt;\n");
  assert.equal(result.messages[1].content, "<one.two>\nLiteral\nNew literal\n</one.two><rules><child>User child</child></rules>");
  assert.doesNotMatch(JSON.stringify(result), /Not inserted/);
  assert.equal(h.snapshot(), "");
  assert.deepEqual(messages, before);
});

test("the full skills path defers expressions even without a skill metadata alias", async t => {
  const f = await fixture(t);
  await command(f.project, "skills.toml", 'description = "Names"\nsection = ["system_prompt", "skills"]\nexpression = \'"Static skill instructions"\'');
  const h = harness(f.repository);
  registerBootstrap(h.pi as never, () => f.repository, h.snapshot, h.transform, h.snapshot.sections);
  await h.run("session_start", {}, { cwd: f.projectRoot, ui: { notify() {} } });
  assert.deepEqual(h.snapshot.sections(), {});
  await h.run("before_agent_start", { systemPromptOptions: { skills, sections: {} } });
  const result = await h.run("context_with_system", { messages: [{ role: "system", content: "", sections: {} }] }, { cwd: f.projectRoot });
  assert.equal(result.messages[0].sections.skills, "<skills>\nNames\nStatic skill instructions\n</skills>");
});

test("target is rejected for executable commands; section is the only destination field", async t => {
  const f = await fixture(t);
  for (const body of [
    'description = "Bad"\ntarget = "system_prompt.rules"\nexpression = \'"text"\'',
    'description = "Bad"\nsection = "system_prompt.rules"\ntarget = "system_prompt.rules"\n' + executable('process.stdout.write("text")').split("\n").slice(1).join("\n"),
  ]) {
    await command(f.project, "bad.toml", body);
    await assert.rejects(f.repository.composeSnapshot({ allTools: [], activeTools: [], allSkills: [] }), /target is not supported; use section/);
  }
});
