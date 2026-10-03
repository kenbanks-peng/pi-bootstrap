import assert from "node:assert/strict";
import { test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { registerLazySkills } from "../src/bootstrap-skills.ts";
import { registerBootstrap } from "../index.ts";
import { fixture, actions } from "./session-fixture.ts";

function skill(name: string, description = name + " guidance", disabled = false): Skill {
  return {
    name, description, disableModelInvocation: disabled,
    filePath: "/skills/" + name + "/SKILL.md",
    baseDir: "/skills/" + name,
    sourceInfo: { source: "user", scope: "user" } as Skill["sourceInfo"],
  };
}

function harness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  };
  const transform = registerLazySkills(pi as never);
  const start = (skills: Skill[]) => {
    const event = { systemPromptOptions: { skills, sections: { policy: "Keep policy" } } };
    handlers.get("before_agent_start")!(event);
    return event.systemPromptOptions;
  };
  const search = (query: string, limit?: number) => tools.get("skill_search").execute("search", { query, limit });
  return { pi, handlers, tools, transform, start, search };
}

test("registration is direct, read-only, and does not read skill files", async () => {
  const h = harness();
  const tool = h.tools.get("skill_search");
  assert.equal(tool.exposure, "direct");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.parameters.properties.limit.maximum, 20);
  assert.equal(tool.parameters.properties.limit.minimum, 1);
  assert.match(tool.description, /read/);
  assert.deepEqual((await h.search("uninitialized")).details, { matches: [], total: 0 });
});

test("prompt text is command-owned; resource metadata stays unchanged", () => {
  const h = harness();
  const skills = [skill("zebra", "Private zebra description"), skill("alpha", "Private alpha description"), skill("manual", "Manual only", true)];
  const before = structuredClone(skills);
  const options = h.start(skills);
  assert.deepEqual(options.skills, []);
  const prompt = (options.sections as Record<string, string>).skills;
  assert.equal(prompt, "");
  assert.doesNotMatch(prompt, /Private|\/skills\/|manual/);
  assert.equal(options.sections.policy, "Keep policy");
  assert.deepEqual(skills, before); // Pi can still resolve explicit /skill:name commands.
});

test("search returns only registered metadata and ranks exact names before description matches", async () => {
  const h = harness();
  h.start([
    skill("aaa", "Testing and code review instructions"),
    skill("code-review", "Review a branch"),
    skill("code-review-extra", "More review"),
    skill("manual", "code-review", true),
    skill("code-review", "Duplicate ignored"),
  ]);
  const result = await h.search("CODE-REVIEW", 2);
  assert.deepEqual(result.details.matches.map((s: Skill) => s.name), ["code-review", "code-review-extra"]);
  assert.equal(result.details.total, 3);
  assert.deepEqual(result.details.matches[0], {
    name: "code-review", description: "Review a branch",
    filePath: "/skills/code-review/SKILL.md", baseDir: "/skills/code-review",
  });
  assert.match(result.content[0].text, /Read the selected filePath/);
  assert.doesNotMatch(result.content[0].text, /Duplicate ignored|Manual only/);
  const keywords = await h.search("testing");
  assert.deepEqual(keywords.details.matches.map((s: Skill) => s.name), ["aaa"]);
  assert.deepEqual((await h.search("../unregistered/SKILL.md")).details.matches, []);
});

test("default limit, deterministic ties, unique query terms, and empty results", async () => {
  const h = harness();
  h.start(Array.from({ length: 8 }, (_, index) => skill("skill-" + (8 - index), "Shared topic")));
  const result = await h.search("shared");
  assert.equal(result.details.total, 8);
  assert.deepEqual(result.details.matches.map((s: Skill) => s.name), ["skill-1", "skill-2", "skill-3", "skill-4", "skill-5"]);
  assert.deepEqual((await h.search("shared shared")).details, result.details);
  const missing = await h.search("unmatched");
  assert.equal(missing.details.total, 0);
  assert.match(missing.content[0].text, /No matching skills/);
  h.start([]);
  assert.equal((await h.search("shared")).details.total, 0);
});

test("search validates limits and non-word queries, and supports Unicode keywords", async () => {
  const h = harness();
  h.start([skill("translations", "Français 日本語")]);
  for (const query of ["", " ", "---", "?!"]) await assert.rejects(h.search(query), /skill name or task keywords/);
  for (const limit of [0, 21, 1.5, NaN]) await assert.rejects(h.search("translations", limit), /integer from 1 to 20/);
  assert.equal((await h.search("FRANÇAIS")).details.matches[0].name, "translations");
  assert.equal((await h.search("日本語")).details.matches[0].name, "translations");
});

test("each run replaces the catalog and tool results cannot mutate it", async () => {
  const h = harness();
  const resources = [skill("first", "Original")];
  h.start(resources);
  resources[0].description = "Changed externally";
  const result = await h.search("first");
  assert.equal(result.details.matches[0].description, "Original");
  result.details.matches[0].description = "Changed result";
  assert.equal((await h.search("first")).details.matches[0].description, "Original");
  h.start([skill("second")]);
  assert.deepEqual((await h.search("first")).details.matches, []);
  assert.equal((await h.search("second")).details.matches[0].name, "second");
  h.start([]);
  assert.deepEqual((await h.search("second")).details.matches, []);
});

test("session changes and shutdown clear runtime state", async () => {
  const h = harness();
  for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
    h.start([skill("previous")]);
    h.handlers.get("session_start")!({ reason });
    assert.deepEqual((await h.search("previous")).details.matches, []);
    const transformed = h.transform([{ role: "system", content: "", sections: { skills: "Old catalog" } }] as never);
    assert.equal(transformed[0].role === "system" && transformed[0].sections?.skills, null);
    h.start([skill(reason)]);
    assert.equal((await h.search(reason)).details.matches[0].name, reason);
  }
  h.handlers.get("session_shutdown")!({});
  assert.deepEqual((await h.search("fork")).details.matches, []);
});

test("request transform removes historical full catalogs without changing messages or tool metadata", () => {
  const h = harness();
  h.start([skill("alpha"), skill("a<&>")]);
  const messages = [
    { role: "system", content: "", sections: { skills: "<skills>Full description and location</skills>", rules: "Rules" }, toolsAdded: [{ name: "read" }] },
    { role: "system", content: "", sections: { skills: "<skills>Another full catalog</skills>" }, toolsRemoved: ["old"] },
    { role: "system", content: "", sections: { skills: null } },
    { role: "user", content: "<skills>User text stays</skills>" },
  ];
  const before = structuredClone(messages);
  const result = h.transform(messages as never);
  assert.deepEqual(messages, before);
  const first = result[0];
  assert.ok(first.role === "system");
  assert.equal(first.sections!.skills, null);
  assert.equal(first.sections!.skills, null);
  assert.equal(first.sections!.rules, "Rules");
  assert.equal(first.toolsAdded, messages[0].toolsAdded);
  assert.equal(result[2], messages[2]);
  assert.equal(result[3], messages[3]);
  assert.deepEqual(h.transform(result), result);
});

test("lazy skill sections compose with request replacements and bootstrap, including empty snapshots", async t => {
  const f = await fixture(t);
  await actions(f.global, { "system_prompt.rules": "New rules" });
  for (const snapshot of ["", '<bootstrap>Memory</bootstrap>']) {
    const h = harness();
    const options = h.start([skill("alpha", "Long description")]);
    registerBootstrap(h.pi as never, () => f.repository, () => snapshot, h.transform, () => ({ [JSON.stringify(["system_prompt", "skills"])]: "Available skill names: alpha" }));
    const messages = [
      { role: "system", content: "", sections: { rules: "<rules>Old rules</rules>", skills: "<skills>Long description /skills/alpha/SKILL.md</skills>" }, toolsAdded: [{ name: "read" }] },
      { role: "system", content: "", sections: { skills: "<skills>\n" + (options.sections as Record<string, string>).skills + "\n</skills>" } },
      { role: "user", content: "Request" },
    ];
    const before = structuredClone(messages);
    const result = await h.handlers.get("context_with_system")!({ messages }, { cwd: f.projectRoot });
    const text = JSON.stringify(result.messages);
    assert.match(text, /Available skill names: alpha/);
    assert.match(text, /New rules/);
    assert.doesNotMatch(text, /Long description|\/skills\/alpha/);
    assert.deepEqual(messages, before);
    assert.deepEqual(result.messages[0].toolsAdded, messages[0].toolsAdded);
    if (snapshot) assert.match(result.messages[0].content, /<\/bootstrap>$/);
    assert.equal(result.messages.at(-1).content, "Request");
  }
});
