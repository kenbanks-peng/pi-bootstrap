import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import type { ExtensionAPI, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { registerBootstrap } from "../index.ts";
import { Lookup, type Table } from "../src/lookup.ts";
import { Mechanisms } from "../src/prompt.ts";

const defaults = await readFile(new URL("../default.toml", import.meta.url), "utf8");
const config = () => parse(defaults) as Table;
const simple = (patch: Table = {}) => ({
  kind: "value", event: "before_agent_start", source: ["options", "newText"],
  path: ["custom", "newText"], target: ["options", "newText"], value_type: "string", ...patch,
});
async function fixture(text?: string) {
  const dir = await mkdtemp(join(tmpdir(), "pi-mechanisms-"));
  const path = join(dir, "config.toml");
  if (text !== undefined) await writeFile(path, text);
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  let command: any;
  const notifications: { text: string; level: string }[] = [];
  const statuses: (string | undefined)[] = [];
  let report = "";
  const ctx = { hasUI: true, ui: {
    notify: (text: string, level: string) => notifications.push({ text, level }),
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    select: async (text: string) => { report = text; },
  } };
  registerBootstrap({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (_name: string, value: any) => { command = value; },
    getAllTools: () => [],
  } as unknown as ExtensionAPI, path);
  const options = () => ({
    selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [],
    sections: {}, appendSystemPrompt: "", cwd: "/project", contextFiles: [], skills: [],
  });
  return {
    path, notifications, statuses, ctx,
    submit: (prompt: string, extra = {}) => {
      const event = { type: "before_agent_start", prompt: "Hello", systemPrompt: prompt, systemPromptOptions: { ...options(), ...extra } } as BeforeAgentStartEvent;
      return handlers.get("before_agent_start")!(event, ctx).then(() => event);
    },
    transcript: (messages: object[]) => handlers.get("context_with_system")!({ messages }, ctx),
    show: async () => { await command.handler("", ctx); return report; },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("default TOML names all shipped selectors, targets, and precedence", async () => {
  const f = await fixture();
  try {
    await f.submit("Preamble\n\n<rules>\nRules\n</rules>");
    const data = parse(await readFile(f.path, "utf8")) as any;
    assert.equal(data.version, 1);
    assert.deepEqual(data.mechanisms.rules_section.source, ["prompt"]);
    assert.equal(data.mechanisms.rules_section.start, "<rules>\n");
    assert.deepEqual(data.mechanisms.rules_section.target, ["options", "sections", "rules"]);
    assert.equal(Object.keys(data.mechanisms).length, 11);
    assert.ok(data.message3.rules);
    assert.deepEqual(f.statuses, [undefined]);
  } finally { await f.cleanup(); }
});

test("unknown tagged section is highlighted, preserved, and not added as a replacement", async () => {
  const f = await fixture();
  try {
    const prompt = "Preamble\n\n<rules>\nRules\n</rules>\n\n<policy>\nNew safety text.\n</policy>";
    const event = await f.submit(prompt);
    assert.deepEqual(event.systemPromptOptions.sections, {});
    assert.ok(f.notifications.some(n => n.level === "warning" && n.text.includes("policy") && n.text.includes("New safety text.")));
    assert.ok(f.statuses.at(-1)?.includes("unidentified"));
    const data = parse(await readFile(f.path, "utf8")) as any;
    assert.equal(data.message3.policy, undefined);
    const report = await f.show();
    assert.ok(report.includes("<policy>\nNew safety text.\n</policy>"));
    assert.ok(report.includes(f.path));
    const messages = [{ role: "system", content: "", sections: { policy: "<policy>\nNew safety text.\n</policy>" } }];
    const result = await f.transcript(messages);
    assert.equal(result.messages[0], messages[0]);
    assert.ok((await f.show()).includes("messages.0.sections.policy"));
  } finally { await f.cleanup(); }
});

test("adding a mechanism in TOML identifies a new section and applies its replacement on next submission", async () => {
  const f = await fixture();
  try {
    const prompt = "Preamble\n\n<policy>\nNew safety text.\n</policy>";
    await f.submit(prompt);
    const current = await readFile(f.path, "utf8");
    const mechanism = `
[mechanisms.policy]
kind = "delimited"
event = "before_agent_start"
source = ["prompt"]
start = "<policy>\\n"
end = "\\n</policy>"
path = ["startup", "policy"]
target = ["options", "sections", "policy"]
value_type = "string"

[startup.policy]
replacement = "Short policy."
`;
    await writeFile(f.path, current + mechanism);
    const next = await f.submit(prompt);
    assert.equal(next.systemPromptOptions.sections.policy, "Short policy.");
    assert.equal(f.statuses.at(-1), undefined);
    assert.ok((await f.show()).includes("UNIDENTIFIED — unchanged; add mechanisms to config.toml:\n(none)"));
    const result = await f.transcript([{ role: "system", sections: { policy: "<policy>\nShort policy.\n</policy>", preamble: "Preamble" } }]);
    assert.equal(result.messages[0].sections.policy, "<policy>\nShort policy.\n</policy>");
    assert.equal(f.statuses.at(-1), undefined);
  } finally { await f.cleanup(); }
});

test("changing or removing a selector has effect without code changes or hidden fallback", () => {
  const data = config() as any;
  delete data.mechanisms.rules_section;
  const engine = new Mechanisms(data);
  const sources = engine.discover("before_agent_start", { prompt: "Preamble\n\n<rules>\nRules\n</rules>", options: { toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], skills: [] }, tools: [] });
  assert.ok(!sources.some(s => s.path.join(".") === "message3.rules"));
  assert.ok(engine.unidentified.some(u => u.location === "prompt section rules"));

  const custom = new Mechanisms({ version: 1, mechanisms: { renamed: simple({
    kind: "delimited", source: ["prompt"], start: "BEGIN\n", end: "\nEND",
    path: ["arbitrary", "snippet"], target: ["options", "newText"],
  }) } });
  assert.deepEqual(custom.discover("before_agent_start", { prompt: "BEGIN\nCaptured\nEND" }),
    [{ path: ["arbitrary", "snippet"], original: "Captured" }]);
  assert.deepEqual(custom.unidentified, []);
});

test("maps and record fields are selected by user parameters, not tool or skill names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-custom-map-"));
  try {
    const options: { snippets: Record<string, string>; items: { id: string; text: string }[] } = { snippets: { "new.tool/name": "Long snippet" }, items: [{ id: "record", text: "Long record" }] };
    const data = { version: 1, mechanisms: {
      snippets: simple({ kind: "map", source: ["options", "snippets"], path: ["custom", "{key}"], target: ["options", "snippets", "{key}"] }),
      records: simple({ kind: "records", source: ["options", "items"], key_field: "id", value_field: "text",
        path: ["records", "{key}"], target: ["options", "items", "{index}", "text"] }),
    } };
    const engine = new Mechanisms(data);
    const sources = engine.discover("before_agent_start", { options });
    assert.deepEqual(sources.map(s => s.path), [["custom", "new.tool/name"], ["records", "record"]]);
    const lookup = new Lookup(join(dir, "config.toml"));
    await writeFile(lookup.path, '[custom."new.tool/name"]\nreplacement = "Short snippet"\n[records.record]\nreplacement = "Short record"\n');
    await lookup.refresh(sources);
    engine.applyOptions(options, lookup);
    assert.deepEqual(options, { snippets: { "new.tool/name": "Short snippet" }, items: [{ id: "record", text: "Short record" }] });
    Object.assign(options.snippets, { next: "New snippet" });
    assert.ok(engine.discover("before_agent_start", { options }).some(s => s.path.at(-1) === "next"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("fallback metadata and map overrides are controlled by TOML", () => {
  const engine = new Mechanisms(config());
  const sources = engine.discover("before_agent_start", {
    options: { toolSnippets: { read: "Override" }, toolGuidelines: {}, promptGuidelines: [], skills: [] },
    tools: [{ name: "read", description: "Original", promptGuidelines: ["Guide"] }, { name: "new.tool", description: "New" }],
  });
  assert.equal(sources.find(s => s.path.includes("read") && s.path.at(-1) === "snippet")?.original, "Override");
  assert.deepEqual(sources.find(s => s.path.includes("new.tool") && s.path.at(-1) === "guidelines")?.original, []);
});

test("wildcard value selectors identify new transcript sections without fixed message indexes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-transcript-map-"));
  try {
    const engine = new Mechanisms({ version: 1, mechanisms: { dynamic: simple({
      event: "context_with_system", source: ["messages", "*", "sections", "policy"],
      path: ["policies", "{index}"], target: ["messages", "{index}", "sections", "policy"],
    }) } });
    const messages = [
      { role: "user", sections: { policy: "User policy" } },
      { role: "system", sections: { policy: "System policy" } },
    ];
    const sources = engine.discover("context_with_system", { messages });
    assert.deepEqual(sources, [{ path: ["policies", "1"], original: "System policy" }]);
    const lookup = new Lookup(join(dir, "config.toml"));
    await writeFile(lookup.path, '[policies."1"]\nreplacement = "Short policy"\n');
    await lookup.refresh(sources);
    const result = engine.applyTranscript(messages, lookup);
    assert.equal(result[0], messages[0]);
    assert.equal(result[1].sections.policy, "Short policy");
    assert.equal(messages[1].sections.policy, "System policy");
    assert.deepEqual(engine.unidentified, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unknown system content and untagged prompt remainder are reported", () => {
  const engine = new Mechanisms({ version: 1, mechanisms: { prefix: simple({
    kind: "prefix", source: ["prompt"], boundary: "STOP",
  }) } });
  engine.discover("before_agent_start", { prompt: "Known opening\nSTOP\nNew text" });
  assert.ok(engine.unidentified.some(u => u.text.includes("New text")));
  engine.discover("context_with_system", { messages: [
    { role: "user", content: "Prime unchanged" },
    { role: "system", content: "Unidentified system text" },
  ] });
  assert.ok(engine.unidentified.some(u => u.location === "messages.1.content"));
  assert.ok(!engine.unidentified.some(u => u.text.includes("Prime")));
});

test("nested tags are reported as one unknown outer section, not individual skills", () => {
  const engine = new Mechanisms({ version: 1, mechanisms: {} });
  engine.discover("before_agent_start", { prompt: "<new>\n<inner>\nText\n</inner>\n</new>" });
  assert.deepEqual(engine.unidentified, [{ location: "prompt section new", text: "<new>\n<inner>\nText\n</inner>\n</new>" }]);
});

test("invalid mechanisms fail before any file discovery or input change", async () => {
  const invalid = defaults.replace('kind = "prefix"', 'kind = "unknown"');
  const f = await fixture(invalid);
  try {
    const e = await f.submit("Preamble\n<rules>\nRules\n</rules>");
    assert.deepEqual(e.systemPromptOptions.sections, {});
    assert.equal(await readFile(f.path, "utf8"), invalid);
    assert.ok(f.notifications[0].text.includes("unknown kind"));
    assert.equal(f.notifications[0].level, "warning");
  } finally { await f.cleanup(); }
});

test("missing mechanism configuration is rejected instead of silently using fixed defaults", async () => {
  const text = '[message3.rules]\nreplacement = "Legacy text"\n';
  const f = await fixture(text);
  try {
    const e = await f.submit("<rules>\nRules\n</rules>");
    assert.deepEqual(e.systemPromptOptions.sections, {});
    assert.equal(await readFile(f.path, "utf8"), text);
    assert.ok(f.notifications[0].text.includes("define [mechanisms]"));
  } finally { await f.cleanup(); }
});

test("bad mechanism parameters, unsafe paths, duplicate sources, and wrong value types fail closed", () => {
  for (const patch of [
    { kind: "not-a-kind" }, { phase: "bad" }, { value_type: "bad" }, { source: ["bad"] },
    { target: ["messages", "*", "toolsAdded"] }, { target: ["options", "__proto__", "x"] },
    { typo: "x" }, { kind: "prefix", boundary: "[" }, { path: ["mechanisms", "bad"] },
  ]) assert.throws(() => new Mechanisms({ version: 1, mechanisms: { bad: simple(patch) } }));
  assert.throws(() => new Mechanisms({ version: 1, mechanisms: { bad: simple() }, custom: { newText: { replacement: [] } } }), /wrong type/);
  assert.throws(() => new Mechanisms({ version: 1, mechanisms: { one: simple(), two: simple() } })
    .discover("before_agent_start", { options: { newText: "Text" } }), /Multiple mechanisms/);
  assert.throws(() => new Mechanisms({ version: 1, mechanisms: { one: simple() } })
    .discover("before_agent_start", { options: { newText: ["Text"] } }), /wrong type/);
});

test("configured transcript replacements are validated before structured replacements", async () => {
  const f = await fixture(defaults + '\n[message3.rules]\nreplacement = "Short rules"\n[system_prompt]\nreplacement = []\n');
  try {
    const e = await f.submit("Preamble\n<rules>\nRules\n</rules>");
    assert.deepEqual(e.systemPromptOptions.sections, {});
    assert.ok(f.notifications[0].text.includes("wrong type"));
  } finally { await f.cleanup(); }
});

test("a configured transcript section selector does not produce a false unknown prompt warning", async () => {
  const f = await fixture(defaults + `
[mechanisms.policy]
kind = "value"
event = "context_with_system"
source = ["messages", "*", "sections", "policy"]
path = ["policy"]
target = ["messages", "*", "sections", "policy"]
value_type = "string"

[policy]
replacement = "Short policy"
`);
  try {
    await f.submit("Opening\n<policy>\nPolicy\n</policy>");
    assert.ok(!f.notifications.some(n => n.level === "warning"));
    const result = await f.transcript([
      { role: "system", sections: { preamble: "Opening", policy: "<policy>\nPolicy\n</policy>" } },
      { role: "system", sections: { policy: "<policy>\nUpdated policy\n</policy>" } },
    ]);
    assert.equal(result.messages[0].sections.policy, "Short policy");
    assert.equal(result.messages[1].sections.policy, "Short policy");
    assert.equal(f.statuses.at(-1), undefined);
    assert.ok((await f.show()).includes("UNIDENTIFIED — unchanged; add mechanisms to config.toml:\n(none)"));
  } finally { await f.cleanup(); }
});

test("repeated transcript scans refresh unknown entries instead of accumulating them", () => {
  const engine = new Mechanisms({ version: 1, mechanisms: {} });
  const inputs = { messages: [{ role: "system", content: "  Unknown  " }] };
  engine.discover("context_with_system", inputs);
  engine.discover("context_with_system", inputs);
  assert.equal(engine.unidentified.length, 1);
  engine.discover("context_with_system", { messages: [] });
  assert.equal(engine.unidentified.length, 0);
});

test("a new map of section fields identifies its prompt blocks through TOML selectors", () => {
  const engine = new Mechanisms({ version: 1, mechanisms: { sections: simple({
    kind: "map", source: ["options", "sections"], path: ["custom", "{key}"],
    target: ["options", "sections", "{key}"],
  }) } });
  engine.discover("before_agent_start", { prompt: "<new>\nNew text\n</new>", options: { sections: { new: "New text" } } });
  assert.deepEqual(engine.unidentified, []);
  engine.discover("context_with_system", { messages: [{ role: "system", sections: { new: "<new>\nNew text\n</new>" } }] });
  assert.deepEqual(engine.unidentified, []);
});

test("precedence is defined in TOML and can be removed without a code change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-precedence-"));
  try {
    const lookup = new Lookup(join(dir, "config.toml"));
    await writeFile(lookup.path, '[whole]\nreplacement = "Whole text"\n[part]\nreplacement = "Part text"\n');
    for (const blocked of [true, false]) {
      const options = { whole: "Original whole", part: "Original part" };
      const engine = new Mechanisms({ version: 1, mechanisms: {
        whole: simple({ source: ["options", "whole"], path: ["whole"], target: ["options", "whole"] }),
        part: simple({ source: ["options", "part"], path: ["part"], target: ["options", "part"],
          blocked_by: blocked ? [["whole"]] : [] }),
      } });
      await lookup.refresh(engine.discover("before_agent_start", { options }));
      engine.applyOptions(options, lookup);
      assert.equal(options.whole, "Whole text");
      assert.equal(options.part, blocked ? "Original part" : "Part text");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("conflicting active targets fail before changing live options", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-conflict-"));
  try {
    const options = { first: "First", second: "Second" };
    const engine = new Mechanisms({ version: 1, mechanisms: {
      one: simple({ source: ["options", "first"], path: ["first"], target: ["options", "first"] }),
      two: simple({ source: ["options", "second"], path: ["second"], target: ["options", "first"] }),
    } });
    const lookup = new Lookup(join(dir, "config.toml"));
    await writeFile(lookup.path, '[first]\nreplacement = "One"\n[second]\nreplacement = "Two"\n');
    await lookup.refresh(engine.discover("before_agent_start", { options }));
    assert.throws(() => engine.applyOptions(options, lookup), /Conflicting/);
    assert.deepEqual(options, { first: "First", second: "Second" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("UI reports escape terminal controls in unidentified text", async () => {
  const f = await fixture();
  try {
    await f.submit("Opening\n<new>\nEscape \u001b[31m text\n</new>");
    const warning = f.notifications.find(n => n.level === "warning")!.text;
    assert.ok(warning.includes("\\u001b"));
    assert.ok(!warning.includes("\u001b"));
    assert.ok((await f.show()).includes("\\u001b"));
  } finally { await f.cleanup(); }
});

test("no UI and duplicate warning reports do not block submissions", async () => {
  const f = await fixture();
  try {
    const prompt = "Preamble\n<new>\nUnknown\n</new>";
    await f.submit(prompt);
    await f.submit(prompt);
    assert.equal(f.notifications.length, 1);
    f.ctx.hasUI = false;
    await f.submit(prompt + "changed");
    assert.equal(f.notifications.length, 1);
  } finally { await f.cleanup(); }
});
