import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "smol-toml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBootstrap } from "../index.ts";
import { Lookup, type Table } from "../src/lookup.ts";
import { Mechanisms, taggedRegions, type TranscriptMessage } from "../src/prompt.ts";

const defaults = await readFile(new URL("../default.toml", import.meta.url), "utf8");
const config = () => parse(defaults) as Table;
const replacement = (path: string[], text: unknown) =>
  "\n[" + path.map(p => JSON.stringify(p)).join(".") + "]\nreplacement = " + JSON.stringify(text) + "\n";
async function fixture(text?: string) {
  const dir = await mkdtemp(join(tmpdir(), "pi-context-"));
  const path = join(dir, "config.toml");
  if (text !== undefined) await writeFile(path, text);
  const handlers = new Map<string, Function>();
  let command: any;
  const notifications: string[] = [];
  const ctx = { hasUI: true, ui: {
    notify: (text: string) => notifications.push(text),
    setStatus: () => {},
    select: async (text: string) => text,
  } };
  registerBootstrap({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (_name: string, value: any) => { command = value; },
  } as unknown as ExtensionAPI, path);
  return {
    path, notifications,
    request: async <T extends TranscriptMessage>(messages: T[]): Promise<T[]> =>
      (await handlers.get("context_with_system")!({ messages }, ctx)).messages,
    show: async () => {
      let report = "";
      ctx.ui.select = async (text: string) => { report = text; return text; };
      await command.handler("", ctx);
      return report;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
const baseline = await readFile(new URL("../docs/pi-baseline.md", import.meta.url), "utf8");
const prompt = /<system-prompt>\n\n([\s\S]*?)\n\n<\/system-prompt>/.exec(baseline)![1];
const prime = /<prime_session version="1">[\s\S]*?<\/prime_session>/.exec(baseline)![0];

test("default config has three context mechanisms with no numbered-message dependency", () => {
  const data = config();
  assert.equal(data.version, 2);
  assert.equal(Object.keys(data.mechanisms as object).length, 3);
  assert.ok(!defaults.includes("message3"));
  assert.ok(!defaults.includes("fallback_source"));
});
test("baseline discovery follows top-level tags and finds prime by envelope", () => {
  const engine = new Mechanisms(config());
  const sources = engine.discover([
    { role: "system", content: prompt },
    { role: "user", content: "hi" },
    { role: "user", content: prime },
    { role: "user", content: 'context-mode active.\n<session_state source="compaction">\n<session_mode>implement</session_mode>\n</session_state>' },
  ]);
  assert.deepEqual(sources.map(s => s.path.join(".")), [
    "system_prompt.preamble", "system_prompt.sections.tools", "system_prompt.sections.rules",
    "system_prompt.sections.docs", "system_prompt.sections.skills", "system_prompt.sections.cwd",
    "bootstrap.prime_session",
  ]);
  assert.deepEqual(engine.unidentified, []);
  assert.ok(sources.find(s => s.path.at(-1) === "skills")!.original.includes("<available_skills>"));
  assert.ok(sources.find(s => s.path.at(-1) === "prime_session")!.original.includes("<memory>"));
});
test("baseline replacements keep tag wrappers, tools, ordinary messages, and originals", async () => {
  const f = await fixture(defaults +
    replacement(["system_prompt", "preamble"], "Short identity.") +
    replacement(["system_prompt", "sections", "docs"], "Short docs.") +
    replacement(["bootstrap", "prime_session"], "Short preferences."));
  try {
    const tools = [{ name: "codemode", description: "Actual tool declaration", parameters: {} }];
    const messages = [
      { role: "system", content: prompt, toolsAdded: tools },
      { role: "user", content: prime },
      { role: "user", content: "hi" },
      { role: "user", content: "context-mode active." },
    ];
    const snapshot = structuredClone(messages);
    const result = await f.request(messages);
    assert.ok((result[0].content as string).startsWith("Short identity.\n\n<tools>"));
    assert.ok((result[0].content as string).includes("<docs>\nShort docs.\n</docs>"));
    assert.equal(result[1].content, '<prime_session version="1">\nShort preferences.\n</prime_session>');
    assert.equal(result[0].toolsAdded, tools);
    assert.equal(result[2], messages[2]);
    assert.equal(result[3], messages[3]);
    assert.deepEqual(messages, snapshot);
    const report = await f.show();
    assert.ok(report.includes("bytes"));
    assert.ok(report.includes("Context hook:"));
  } finally { await f.cleanup(); }
});
test("real Pi structured sections and deltas use the same keys as flat tagged text", async () => {
  const host = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { buildSystemPromptSections } = await import(pathToFileURL(join(dirname(host), "core/system-prompt.js")).href);
  const sections = buildSystemPromptSections({ cwd: "/project", selectedTools: [] });
  const f = await fixture(defaults +
    replacement(["system_prompt", "preamble"], "Short preamble.") +
    replacement(["system_prompt", "sections", "rules"], "Short rules."));
  try {
    const messages = [
      { role: "system", content: "", sections },
      { role: "system", content: "", sections: { rules: "<rules>\nUpdated rules.\n</rules>", docs: null } },
    ];
    const result = await f.request(messages);
    assert.equal(result[0].sections!.preamble, "Short preamble.");
    assert.equal(result[0].sections!.rules, "<rules>\nShort rules.\n</rules>");
    assert.equal(result[1].sections!.rules, "<rules>\nShort rules.\n</rules>");
    assert.equal(result[1].sections!.docs, null);
    assert.equal(sections.preamble.startsWith("You are"), true);
  } finally { await f.cleanup(); }
});
test("new system tags are discovered automatically, including project context and addenda", async () => {
  const f = await fixture();
  try {
    const text = 'Preamble\r\n\r\n<project_context>\r\n<project_instructions path="/repo/AGENTS.md">\r\nInstructions\r\n</project_instructions>\r\n</project_context>\r\n\r\n<addendum>\r\nExtra\r\n</addendum>';
    const messages = [{ role: "system", content: text }];
    assert.equal(await f.request(messages), messages);
    const data = parse(await readFile(f.path, "utf8")) as any;
    assert.ok(data.system_prompt.sections.project_context);
    assert.ok(data.system_prompt.sections.addendum);
    assert.ok(!data.system_prompt.sections.project_instructions);
    assert.ok((await f.show()).includes("(none)"));
    await writeFile(f.path, defaults + replacement(["system_prompt", "sections", "addendum"], "New"));
    const result = await f.request(messages);
    assert.ok(result[0].content.includes("<addendum>\r\nNew\r\n</addendum>"));
    assert.ok(result[0].content.includes('<project_instructions path="/repo/AGENTS.md">'));
  } finally { await f.cleanup(); }
});
test("tag parser respects nesting, attributes, code fences, and closing-tag errors", () => {
  const text = '<skills>\n<available_skills>\n<skill>\n<name>x</name>\n</skill>\n</available_skills>\n```xml\n</skills>\n<fake>\n```\n</skills>';
  const regions = taggedRegions(text);
  assert.deepEqual(regions.map(r => r.tag), ["skills"]);
  assert.equal(text.slice(regions[0].start, regions[0].end), text);
  for (const broken of ["<rules>\nText", "<rules>\n</docs>", "</rules>"])
    assert.throws(() => taggedRegions(broken), /context tag/);
});
test("ordinary tag examples, other roles, and additional text are never selected as prime", async () => {
  const f = await fixture(defaults + replacement(["bootstrap", "prime_session"], "New"));
  try {
    const messages = [
      { role: "system", content: "" },
      { role: "user", content: "Example:\n" + prime },
      { role: "assistant", content: prime },
      { role: "user", content: prime + "\nThis is my task." },
      { role: "user", content: "<prime_session>inline</prime_session>" },
      { role: "user", content: "```xml\n" + prime + "\n```" },
    ];
    assert.equal(await f.request(messages), messages);
  } finally { await f.cleanup(); }
});
test("prime text blocks can be rewritten without changing image blocks", async () => {
  const f = await fixture(defaults + replacement(["bootstrap", "prime_session"], "New"));
  try {
    const image = { type: "image", data: "abc", mimeType: "image/png" };
    const text = { type: "text", text: prime };
    const messages = [{ role: "system", content: "" }, { role: "user", content: [image, text] }];
    const result = await f.request(messages);
    const content = result[1].content as typeof messages[1]["content"];
    assert.equal(content![0], image);
    assert.equal((content![1] as typeof text).text, '<prime_session version="1">\nNew\n</prime_session>');
    assert.equal(text.text, prime);
  } finally { await f.cleanup(); }
});
test("config reloads each request and repeated processing does not add duplicate tables or wrappers", async () => {
  const f = await fixture();
  try {
    const messages = [{ role: "system", content: "Preamble\n\n<docs>\nOld docs\n</docs>" }];
    assert.equal(await f.request(messages), messages);
    const discovered = await readFile(f.path, "utf8");
    await f.request(messages);
    assert.equal(await readFile(f.path, "utf8"), discovered);
    assert.equal(f.notifications.length, 1);
    await writeFile(f.path, defaults + replacement(["system_prompt", "sections", "docs"], "New docs"));
    const result = await f.request(messages);
    assert.ok(result[0].content.includes("<docs>\nNew docs\n</docs>"));
    assert.deepEqual(await f.request(result), result);
    await writeFile(f.path, defaults);
    assert.equal(await f.request(messages), messages);
  } finally { await f.cleanup(); }
});
test("invalid configuration or malformed context leaves the full request unchanged", async () => {
  for (const configText of ["[broken", 'version = 1\n[mechanisms]\n', defaults + replacement(["system_prompt", "preamble"], ["Wrong type"])]) {
    const f = await fixture(configText);
    try {
      const messages = [{ role: "system", content: "Preamble" }];
      assert.equal(await f.request(messages), messages);
      assert.ok((await f.show()).includes("Error:"));
    } finally { await f.cleanup(); }
  }
  const f = await fixture(defaults + replacement(["system_prompt", "preamble"], "New"));
  try {
    const messages = [{ role: "system", content: "Preamble\n<rules>\nBroken" }];
    assert.equal(await f.request(messages), messages);
    assert.ok((await f.show()).includes("Unclosed context tag"));
  } finally { await f.cleanup(); }
});
test("disabled mechanisms leave context unchanged and report unselected system text", async () => {
  const f = await fixture('version = 2\n[mechanisms]\n');
  try {
    const messages = [{ role: "system", content: "Preamble\n<rules>\nRules\n</rules>\nTrailing text" }];
    assert.equal(await f.request(messages), messages);
    assert.ok((await f.show()).includes("Trailing text"));
    const data = parse(await readFile(f.path, "utf8")) as any;
    assert.equal(data.system_prompt, undefined);
  } finally { await f.cleanup(); }
});
test("mechanisms reject obsolete parameters, duplicate selectors, and unsafe tags", () => {
  const invalid = [
    { version: 1, mechanisms: {} },
    { version: 2, mechanisms: { x: { kind: "map" } } },
    { version: 2, mechanisms: { x: { kind: "preamble", source: ["prompt"] } } },
    { version: 2, mechanisms: { x: { kind: "preamble" }, y: { kind: "preamble" } } },
    { version: 2, mechanisms: { x: { kind: "tagged_message", role: "assistant", tag: "prime_session" } } },
    { version: 2, mechanisms: { x: { kind: "tagged_message", role: "user", tag: "constructor" } } },
  ];
  for (const data of invalid) assert.throws(() => new Mechanisms(data));
  assert.throws(() => new Mechanisms(config()).discover([{ role: "system", content: "<constructor>\ntext\n</constructor>" }]), /Unsafe/);
});
test("unwrapped structured text is reported and retained, not treated as an identity", () => {
  const engine = new Mechanisms(config());
  assert.deepEqual(engine.discover([{ role: "system", sections: { custom: "Opaque text" } }]), []);
  assert.ok(engine.unidentified.some(u => u.text === "Opaque text"));
});
