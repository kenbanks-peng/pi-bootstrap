import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "smol-toml";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBootstrap } from "../index.ts";
import { type Table } from "../src/lookup.ts";
import { Mechanisms, taggedRegions, type TranscriptMessage } from "../src/prompt.ts";

const defaultTemplate = await readFile(new URL("../default.toml", import.meta.url), "utf8");
const defaults = "[system_prompt]\n\n[tools]\n";
const config = () => parse(defaultTemplate) as Table;
const replacement = (tag: string, text: unknown) =>
  "\n[system_prompt." + tag + "]\nreplacement = " + JSON.stringify(text) + "\n";
const tags = ["preamble", "tools", "rules", "docs", "skills", "cwd", "prime"];
const prime = '<prime>\n<memory>Keep instructions.</memory>\n<command>\n<run>pwd</run>\n</command>\n</prime>';
const prompt = [
  "<preamble>\nYou are a coding assistant.\n</preamble>",
  "<tools>\nTool guidance.\n</tools>",
  "<rules>\nRules.\n</rules>",
  "<docs>\nDocumentation.\n</docs>",
  "<skills>\n<available_skills>\n<skill>\n<name>test</name>\n</skill>\n</available_skills>\n</skills>",
  "<cwd>\n/project\n</cwd>",
  prime,
].join("\n\n");

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

test("default config matches the new section layout exactly", () => {
  const data = config() as any;
  assert.deepEqual(Object.keys(data), ["system_prompt", "tools"]);
  assert.deepEqual(Object.keys(data.system_prompt), tags);
  assert.deepEqual(Object.keys(data.tools), []);
  for (const tag of tags)
    assert.deepEqual({ ...data.system_prompt[tag] }, tag === "tools" ? { replacement: "TOOLS REPLACEMENT TEXT" } : {});
});

test("tagged discovery includes preamble and prime but not nested fields or messages", () => {
  const engine = new Mechanisms(config());
  const sources = engine.discover([
    { role: "system", content: prompt },
    { role: "user", content: prime },
    { role: "assistant", content: "<rules>\nUnclosed example" },
  ]);
  assert.deepEqual(sources.map(s => s.path.join(".")), tags.map(tag => "system_prompt." + tag));
  assert.deepEqual(engine.unidentified, []);
  assert.ok(sources.find(s => s.path.at(-1) === "skills")!.original.includes("<available_skills>"));
  assert.ok(sources.find(s => s.path.at(-1) === "prime")!.original.includes("<memory>"));
});

test("default replacement changes only system tools text and keeps tool declarations", async () => {
  const f = await fixture();
  try {
    const tools = [{ name: "read", parameters: {} }];
    const messages = [{ role: "system", content: prompt, toolsAdded: tools }, { role: "user", content: prime }];
    const result = await f.request(messages);
    assert.equal(result[0].content, prompt.replace("Tool guidance.", "TOOLS REPLACEMENT TEXT"));
    assert.equal(result[0].toolsAdded, tools);
    assert.equal(result[1], messages[1]);
    assert.equal(messages[0].content, prompt);
    assert.equal(await readFile(f.path, "utf8"), defaultTemplate);
    assert.ok((await f.show()).includes("Context hook:"));
  } finally { await f.cleanup(); }
});

test("all tagged sections use direct keys and retain wrappers and source bytes", async () => {
  const f = await fixture(defaults + tags.map(tag => replacement(tag, "New " + tag)).join(""));
  try {
    const text = prompt.replace("<prime>", '<prime version="1">').replaceAll("\n", "\r\n");
    const messages = [{ role: "system", content: text }];
    const snapshot = structuredClone(messages);
    const result = await f.request(messages);
    const regions = taggedRegions(result[0].content);
    for (const region of regions)
      assert.equal(result[0].content.slice(region.bodyStart, region.bodyEnd), "\r\nNew " + region.tag + "\r\n");
    assert.ok(result[0].content.includes('<prime version="1">'));
    assert.deepEqual(messages, snapshot);
    assert.deepEqual(await f.request(result), result);
  } finally { await f.cleanup(); }
});

test("structured tagged sections and deltas use the same direct keys", async () => {
  const f = await fixture(defaults + replacement("preamble", "New preamble") + replacement("prime", "New prime"));
  try {
    const messages: TranscriptMessage[] = [
      { role: "system", content: "", sections: { preamble: "<preamble>\nOld\n</preamble>", prime, docs: null } },
      { role: "system", content: "", sections: { prime, preamble: null } },
    ];
    const result = await f.request(messages);
    assert.equal(result[0].sections!.preamble, "<preamble>\nNew preamble\n</preamble>");
    assert.equal(result[0].sections!.prime, "<prime>\nNew prime\n</prime>");
    assert.equal(result[1].sections!.prime, "<prime>\nNew prime\n</prime>");
    assert.equal(result[0].sections!.docs, null);
    assert.equal(result[1].sections!.preamble, null);
    assert.equal(messages[0].sections!.prime, prime);
  } finally { await f.cleanup(); }
});

test("real Pi structured sections and raw preamble still work", async () => {
  const host = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { buildSystemPromptSections } = await import(pathToFileURL(join(dirname(host), "core/system-prompt.js")).href);
  const sections = buildSystemPromptSections({ cwd: "/project", selectedTools: [] });
  const f = await fixture(defaults + replacement("preamble", "Short preamble.") + replacement("rules", "Short rules."));
  try {
    const result = await f.request([{ role: "system", content: "", sections }]);
    assert.equal(result[0].sections.preamble, "Short preamble.");
    assert.equal(result[0].sections.rules, "<rules>\nShort rules.\n</rules>");
    assert.ok(sections.preamble.startsWith("You are"));
    const flat = await f.request([{ role: "system", content: "Old preamble\n\n<rules>\nOld\n</rules>" }]);
    assert.equal(flat[0].content, "Short preamble.\n\n<rules>\nShort rules.\n</rules>");
  } finally { await f.cleanup(); }
});

test("new tags are discovered once and config reloads on every request", async () => {
  const f = await fixture(defaults);
  try {
    const text = '<project_context>\n<project_instructions path="/repo/AGENTS.md">\nInstructions\n</project_instructions>\n</project_context>\n\n<addendum>\nExtra\n</addendum>';
    const messages = [{ role: "system", content: text }];
    assert.equal(await f.request(messages), messages);
    const discovered = await readFile(f.path, "utf8");
    const data = parse(discovered) as any;
    assert.deepEqual(Object.keys(data.system_prompt), ["project_context", "addendum"]);
    await f.request(messages);
    assert.equal(await readFile(f.path, "utf8"), discovered);
    assert.equal(f.notifications.length, 1);
    await writeFile(f.path, defaults + replacement("addendum", "New"));
    assert.equal((await f.request(messages))[0].content, text.replace("Extra", "New"));
    await writeFile(f.path, defaults);
    assert.equal(await f.request(messages), messages);
  } finally { await f.cleanup(); }
});

test("conversation messages and their text and image blocks are never scanned or changed", async () => {
  const f = await fixture(defaults + replacement("prime", "New prime"));
  try {
    const image = { type: "image", data: "abc", mimeType: "image/png" };
    const messages = [
      { role: "system", content: prime },
      { role: "user", content: prime },
      { role: "user", content: '<prime_session version="1">\nOld\n</prime_session>' },
      { role: "assistant", content: prime },
      { role: "toolResult", content: "<constructor>\nBroken" },
      { role: "user", content: "<prime>\nUnclosed" },
      { role: "user", content: [image, { type: "text", text: prime }] },
    ];
    const result = await f.request(messages);
    assert.equal(result[0].content, "<prime>\nNew prime\n</prime>");
    for (let i = 1; i < messages.length; i++) assert.equal(result[i], messages[i]);
    assert.equal((parse(await readFile(f.path, "utf8")) as any).message, undefined);
  } finally { await f.cleanup(); }
});

test("tag parser respects nesting, attributes, code fences, and closing-tag errors", () => {
  const text = '<skills>\n<available_skills>\n<skill>\n<name>x</name>\n</skill>\n</available_skills>\n```xml\n</skills>\n<fake>\n```\n</skills>';
  assert.deepEqual(taggedRegions(text).map(r => r.tag), ["skills"]);
  for (const broken of ["<rules>\nText", "<rules>\n</docs>", "</rules>"])
    assert.throws(() => taggedRegions(broken), /context tag/);
});

test("invalid and old configuration is rejected without changes or writes", async () => {
  for (const text of [
    "[broken",
    'version = 1\n[mechanisms]\n',
    "[system_prompt.sections.docs]\n",
    "[message.prime_session]\n",
    defaults + replacement("unobserved", ""),
    defaults + replacement("unobserved", 12),
    "[tools]\nreplacement = \"Unsupported\"\n",
  ]) {
    const f = await fixture(text);
    try {
      const messages = [{ role: "system", content: prompt }];
      assert.equal(await f.request(messages), messages);
      assert.equal(await readFile(f.path, "utf8"), text);
      assert.ok((await f.show()).includes("Error:"));
    } finally { await f.cleanup(); }
  }
});

test("malformed system context stops all replacements", async () => {
  const f = await fixture(defaults + replacement("preamble", "New"));
  try {
    const messages = [{ role: "system", content: "Old\n<rules>\nBroken" }];
    assert.equal(await f.request(messages), messages);
    assert.ok((await f.show()).includes("Unclosed context tag"));
  } finally { await f.cleanup(); }
});

test("absent system scope leaves text unchanged and reports it", async () => {
  const f = await fixture("[tools]\n");
  try {
    const messages = [{ role: "system", content: prompt }];
    assert.equal(await f.request(messages), messages);
    assert.ok((await f.show()).includes("UNIDENTIFIED"));
    assert.equal((parse(await readFile(f.path, "utf8")) as any).system_prompt, undefined);
  } finally { await f.cleanup(); }
});

test("wrong types, unsupported fields, and unsafe names are rejected", () => {
  for (const data of [
    { system_prompt: "text" },
    { system_prompt: { preamble: "text" } },
    { system_prompt: { preamble: { kind: "preamble" } } },
    { system_prompt: { constructor: {} } },
    { system_prompt: { "bad.tag": {} } },
    { tools: [] },
    { message: {} },
  ]) assert.throws(() => new Mechanisms(data));
  assert.throws(() => new Mechanisms(config()).discover([
    { role: "system", content: "<constructor>\ntext\n</constructor>" },
  ]), /Unsafe/);
});

test("unwrapped structured text is retained and reported", () => {
  const engine = new Mechanisms(config());
  assert.deepEqual(engine.discover([{ role: "system", sections: { custom: "Opaque text" } }]), []);
  assert.ok(engine.unidentified.some(u => u.text === "Opaque text"));
});
