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
const skillCommand = 'description = "Names:"\nsection = "skills"\nexpression = \'ALL_SKILLS.map(s => s.name).join(", ")\'\n';

test("section commands replace request sections, combine in source order, and stay outside bootstrap", async t => {
  const f = await fixture(t);
  await command(f.global, "a.toml", 'description = "Global"\nsection = "skills"\nexpression = \'"<global>"\'');
  await command(f.project, "a.toml", 'description = "Project"\nsection = "skills"\n' + executable('process.stdout.write("<project>")').split("\n").slice(1).join("\n"));
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
  assert.match(result.messages[0].content, /<bootstrap>\nMemory\n<\/bootstrap>$/);
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
  assert.equal(h.snapshot.sections().skills, "<skills>\nNames:\nalpha, zebra\n</skills>");
  assert.equal(h.snapshot(), "");
  await h.run("before_agent_start", { systemPromptOptions: { skills: [], sections: {} } });
  assert.match(h.snapshot.sections().skills, /alpha, zebra/);
  const result = await h.run("context_with_system", { messages: [{ role: "system", content: "", sections: { skills: "<skills>Old</skills>" } }] }, { cwd: f.projectRoot });
  assert.equal(result.messages[0].sections.skills, h.snapshot.sections().skills);
  await h.run("session_shutdown", {});
  assert.deepEqual(h.snapshot.sections(), {});

  await command(f.project, "skills.toml", 'description = "Frozen"\nsection = "skills"\nexpression = \'(() => { ALL_SKILLS[0].name = "bad"; return "bad"; })()\'');
  await h.run("session_start", {}, { cwd: f.projectRoot, ui: { notify() {} } });
  await assert.rejects(h.run("before_agent_start", { systemPromptOptions: { skills, sections: {} } }), /read only|readonly|Cannot assign/i);
  assert.equal(h.snapshot(), "");
  assert.deepEqual(h.snapshot.sections(), {});
});

test("section names are validated for argv and expression commands", async t => {
  const f = await fixture(t);
  for (const value of ['""', '"Skills"', '"bootstrap"', '"skills><rules"', '42']) {
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
  assert.match(h.snapshot.sections().skills, /alpha, zebra/);
  assert.match(h.snapshot.sections().skills, /skill_search/);
  assert.doesNotMatch(h.snapshot.sections().skills, /Private description|manual|Duplicate/);
});
