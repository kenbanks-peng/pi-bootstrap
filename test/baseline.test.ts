import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBootstrap } from "../index.ts";

const baseline = await readFile(new URL("../docs/pi-baseline.md", import.meta.url), "utf8");
const start = baseline.indexOf("<system-prompt>") + "<system-prompt>".length;
const end = baseline.indexOf("</system-prompt>", start);
const systemText = baseline.slice(start, end);
assert.ok(start > 0 && end > start);
const docsStart = systemText.indexOf("<docs>") + "<docs>".length;
const docsEnd = systemText.indexOf("</docs>", docsStart);
const expected = systemText.slice(0, docsStart) + "\nShort docs.\n" + systemText.slice(docsEnd);

async function fixture(config: string) {
  const dir = await mkdtemp(join(tmpdir(), "pi-baseline-"));
  const path = join(dir, "config.toml");
  await writeFile(path, config);
  const handlers = new Map<string, Function>();
  const warnings: string[] = [];
  registerBootstrap({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: () => {},
  } as unknown as ExtensionAPI, path);
  return {
    path, warnings,
    request: async (messages: any[]) => (await handlers.get("context_with_system")!(
      { messages }, { hasUI: true, ui: { notify: (text: string) => warnings.push(text) } },
    )).messages,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("baseline system-prompt.docs scope replaces docs without losing the container", async () => {
  const f = await fixture('[system-prompt.docs]\nreplacement = "Short docs."\n');
  try {
    const toolsAdded = [{ name: "codemode", description: "Declaration", parameters: { type: "object" } }];
    const messages = [
      { role: "system", content: systemText, toolsAdded },
      { role: "user", content: "<docs>User docs stay unchanged.</docs>" },
    ];
    const result = await f.request(messages);
    assert.equal(result[0].content, expected);
    assert.equal(result[0].toolsAdded, toolsAdded);
    assert.equal(result[1], messages[1]);
    assert.equal(messages[0].content, systemText);
    const config = parse(await readFile(f.path, "utf8")) as any;
    assert.ok(config["system-prompt"].skills.available_skills.skill);
    assert.ok(config["system-prompt"].tools);
    assert.ok(config.messages.message.docs);
    assert.equal(config.docs, undefined);
  } finally { await f.cleanup(); }
});

test("baseline system guidance and peer tool declarations are different scopes", async () => {
  const f = await fixture('[system-prompt.tools]\nreplacement = "Guidance only."\n');
  try {
    const toolsAdded = [{ name: "codemode", description: "Declaration", parameters: {} }];
    const result = await f.request([{ role: "system", content: systemText, toolsAdded }]);
    assert.ok(result[0].content.includes("<tools>\nGuidance only.\n</tools>"));
    assert.equal(result[0].toolsAdded, toolsAdded);
    // Prose cannot replace structured provider declarations. It must not affect guidance.
    await writeFile(f.path, '[tools]\nreplacement = "Not guidance."\n');
    const messages = [{ role: "system", content: systemText, toolsAdded }];
    assert.equal(await f.request(messages), messages);
    assert.ok(f.warnings.some(w => w.includes("structured") && w.includes("tools")));
  } finally { await f.cleanup(); }
});

test("Pi section storage fields do not remove the system-prompt ancestry", async () => {
  const f = await fixture('[system-prompt.docs]\nreplacement = "Short docs."\n');
  try {
    const sections = {
      preamble: "Raw opening text.",
      docs: "<docs>\nLong docs.\n</docs>",
      arbitrary: "<one><two>Keep.</two></one>",
      removed: null,
    };
    const result = await f.request([{ role: "system", content: "", sections }]);
    assert.equal(result[0].sections.docs, "<docs>\nShort docs.\n</docs>");
    assert.equal(result[0].sections.preamble, sections.preamble);
    assert.equal(result[0].sections.arbitrary, sections.arbitrary);
    assert.equal(result[0].sections.removed, null);
    assert.equal(sections.docs, "<docs>\nLong docs.\n</docs>");
  } finally { await f.cleanup(); }
});

test("baseline nested skill descriptions use the same generic path rule", async () => {
  const f = await fixture('[system-prompt.skills.available_skills.skill.description]\nreplacement = "Short skill."\n');
  try {
    const result = await f.request([{ role: "system", content: systemText }]);
    const count = [...systemText.matchAll(/<description>/g)].length;
    assert.ok(count > 1);
    assert.equal([...result[0].content.matchAll(/<description>\s*Short skill\.\s*<\/description>/g)].length, count);
    assert.equal(result[0].content.includes("<name>agents</name>"), true);
    assert.equal(result[0].content.includes("<docs>"), true);
  } finally { await f.cleanup(); }
});

test("Pi adapter rejects overlapping scopes before writes and preserves unrelated sections", async () => {
  const config = '[system-prompt.one]\nreplacement = "Parent"\n[system-prompt.one.two]\nreplacement = "Child"\n';
  const f = await fixture(config);
  try {
    const messages = [{ role: "system", content: "", sections: {
      custom: "<one><two>Old</two></one>", other: "<elsewhere>Keep</elsewhere>",
    } }];
    assert.equal(await f.request(messages), messages);
    assert.equal(await readFile(f.path, "utf8"), config);
    assert.ok(f.warnings.some(w => w.includes("Overlapping replacements")));
  } finally { await f.cleanup(); }
});

test("transport containers reject prose replacements instead of applying them to every fragment", async () => {
  for (const scope of ["system-prompt", "messages", "messages.message"]) {
    const config = "[" + scope + ']\nreplacement = "Not a fragment"\n';
    const f = await fixture(config);
    try {
      const messages = [{ role: "system", sections: { a: "<a>Keep</a>", b: "<b>Keep</b>" } }];
      assert.equal(await f.request(messages), messages);
      assert.equal(await readFile(f.path, "utf8"), config);
      assert.ok(f.warnings.some(w => w.includes("transport container")));
    } finally { await f.cleanup(); }
  }
});

test("baseline messages.message ancestry is independent from system-prompt", async () => {
  const f = await fixture('[messages.message.session_state.session_mode]\nreplacement = "review"\n');
  try {
    const text = '<session_state source="compaction"><session_mode>implement</session_mode></session_state>';
    const messages = [
      { role: "system", content: text },
      ...["user", "assistant", "toolResult"].map(role => ({ role, content: [{ type: "text", text }] })),
    ];
    const result = await f.request(messages);
    assert.equal(result[0], messages[0]);
    for (const message of result.slice(1)) assert.equal(message.content[0].text, text.replace("implement", "review"));
  } finally { await f.cleanup(); }
});
