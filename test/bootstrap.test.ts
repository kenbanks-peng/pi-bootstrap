import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import bootstrap, { getConfigPath, registerBootstrap } from "../index.ts";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Lookup, addFields, type Source } from "../src/lookup.ts";
import { applyStructured, applyTranscript, inventory } from "../src/prompt.ts";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const source: Source = { path: ["message3", "docs"], original: "Long documentation." };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-bootstrap-"));
  const lookup = new Lookup(join(dir, "bootstrap.toml"));
  return { lookup, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
function entry(s: Source, replacement?: string | string[]) {
  return "[" + s.path.map(p => JSON.stringify(p)).join(".") + "]\noriginal = " +
    JSON.stringify(s.original) + "\n" + (replacement === undefined ? "" : "replacement = " + JSON.stringify(replacement) + "\n");
}
function event(): BeforeAgentStartEvent {
  return {
    type: "before_agent_start", prompt: "Hello",
    systemPrompt: "Default preamble\n\n<tools>\nTools\n</tools>\n\n<rules>\nRules\n</rules>\n\n<docs>\nDocs\n</docs>\n\n<skills>\nSkills\n</skills>\n\n<cwd>\n/project\n</cwd>",
    systemPromptOptions: {
      selectedTools: ["read"], toolSnippets: { read: "Read files." },
      toolGuidelines: { read: ["Use read."] }, promptGuidelines: ["Be brief."],
      sections: {}, appendSystemPrompt: "", cwd: "/project", contextFiles: [],
      skills: [{ name: "archify", description: "Draw systems.", filePath: "/skills/archify/SKILL.md", baseDir: "/skills/archify", sourceInfo: { path: "/skills/archify/SKILL.md", source: "local", scope: "user", origin: "top-level" }, disableModelInvocation: false }],
    },
  };
}
test("discovery is comment preserving and creates empty stable tables", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    await writeFile(lookup.path, "# User comment\n\n");
    await lookup.refresh([source]);
    assert.equal(lookup.valid, true);
    assert.equal(lookup.replacement(source.path), undefined);
    const text = await readFile(lookup.path, "utf8");
    assert.ok(text.startsWith("# User comment\n\n"));
    assert.ok(!text.includes("original"));
    assert.ok(!text.includes("replacement"));
    assert.ok(text.includes("[\"message3\".\"docs\"]"));
    const mtime = (await stat(lookup.path)).mtimeMs;
    await lookup.refresh([source]);
    assert.equal((await stat(lookup.path)).mtimeMs, mtime);
    assert.deepEqual(lookup.report.missing, ["message3.docs"]);
  } finally { await cleanup(); }
});
test("TOML edits reload and source changes keep path-based replacements active", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    const original = "# Keep this\n" + entry(source, "Short docs.");
    await writeFile(lookup.path, original);
    await lookup.refresh([source]);
    assert.equal(lookup.replacement(source.path), "Short docs.");
    const changed = { ...source, original: "New upstream docs." };
    await lookup.refresh([changed]);
    assert.equal(lookup.replacement(changed.path), "Short docs.");
    assert.deepEqual(lookup.report.missing, []);
    assert.equal(await readFile(lookup.path, "utf8"), original);
    await writeFile(lookup.path, entry(changed, "Updated replacement."));
    await lookup.refresh([changed]);
    assert.equal(lookup.replacement(changed.path), "Updated replacement.");
  } finally { await cleanup(); }
});
test("a replacement-only table needs no generated source text or hash", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    const config = '# User setting\n[message3.docs]\nreplacement = "Short docs."\n';
    await writeFile(lookup.path, config);
    for (const original of ["First source.", "Different source.", ""]) {
      await lookup.refresh([{ ...source, original }]);
      assert.equal(lookup.valid, true);
      assert.equal(lookup.replacement(source.path), "Short docs.");
      assert.deepEqual(lookup.report.missing, []);
      assert.equal(await readFile(lookup.path, "utf8"), config);
    }
  } finally { await cleanup(); }
});
test("granular and transcript replacements survive changed source prose", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    const e = event();
    const granular = inventory(e, []).filter(s => s.path.includes("entries") || s.path.includes("prompt_guidelines"));
    const identity: Source = { path: ["system_prompt"], original: "Old identity" };
    const preamble: Source = { path: ["message3", "preamble"], original: "Old preamble" };
    await writeFile(lookup.path, [...granular, identity, preamble]
      .map(s => entry(s, Array.isArray(s.original) ? ["Short rule."] : "Short prose.")).join("\n"));
    e.systemPromptOptions.toolSnippets.read = "Changed tool description.";
    e.systemPromptOptions.toolGuidelines.read = ["Changed tool rule."];
    e.systemPromptOptions.promptGuidelines = ["Changed prompt rule."];
    e.systemPromptOptions.skills[0].description = "Changed skill description.";
    await lookup.refresh([...inventory(e, []), { ...identity, original: "Changed identity" }]);
    applyStructured(e, lookup);
    assert.equal(e.systemPromptOptions.toolSnippets.read, "Short prose.");
    assert.deepEqual(e.systemPromptOptions.toolGuidelines.read, ["Short rule."]);
    assert.deepEqual(e.systemPromptOptions.promptGuidelines, ["Short rule."]);
    assert.equal(e.systemPromptOptions.skills[0].description, "Short prose.");
    const result = applyTranscript([
      { role: "system", content: "Changed identity" },
      { role: "system", sections: { preamble: "Changed preamble" } },
    ], lookup);
    assert.equal(result[0].content, "Short prose.");
    assert.equal(result[1].sections?.preamble, "Short prose.");
  } finally { await cleanup(); }
});
test("invalid TOML, wrong types, and empty replacements fail closed", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    for (const text of ["[broken", entry(source, ""), entry(source, []), entry(source, ["wrong type"]), entry(source, "   ")]) {
      await writeFile(lookup.path, text);
      await lookup.refresh([source]);
      assert.equal(lookup.valid, false);
      assert.ok(lookup.report.error);
      assert.equal(lookup.replacement(source.path), undefined);
      assert.equal(await readFile(lookup.path, "utf8"), text);
    }
  } finally { await cleanup(); }
});
test("an editor or another Pi session holding the lock prevents writes", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    await writeFile(lookup.path, "# Pending edit\n");
    const lock = await open(lookup.path + ".lock", "wx");
    try {
      await lookup.refresh([source]);
      assert.equal(lookup.valid, false);
      assert.equal(await readFile(lookup.path, "utf8"), "# Pending edit\n");
      await stat(lookup.path + ".lock");
    } finally { await lock.close(); }
  } finally { await cleanup(); }
});
test("new fields can enter existing tables without changing comments or multiline strings", () => {
  const text = "# Header\n[message3.docs] # My table\n# Keep notes\n\n[unrelated]\ntext = '''\n[message3.docs]\n'''\n";
  const next = addFields(text, source.path, "replacement = \"Docs\"\n", true);
  assert.ok(next.includes("[message3.docs] # My table\nreplacement = \"Docs\"\n\n# Keep notes"));
  assert.ok(next.endsWith("[unrelated]\ntext = '''\n[message3.docs]\n'''\n"));
  assert.equal((parse(next) as any).message3.docs.replacement, "Docs");
});
test("quoted tool names, arrays, Unicode, and source text round-trip", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    const sources: Source[] = [
      { path: ["message3", "tools", "entries", "mcp.server/read", "snippet"], original: "文\n\"\\\t" },
      { path: ["message3", "tools", "entries", "mcp.server/read", "guidelines"], original: ["One", "Two"] },
    ];
    await lookup.refresh(sources);
    assert.equal(lookup.valid, true);
    const data = parse(await readFile(lookup.path, "utf8")) as any;
    assert.ok(data.message3.tools.entries["mcp.server/read"].guidelines);
  } finally { await cleanup(); }
});
test("granular changes preserve tool selection, context files, and skill locations", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    const e = event();
    const sources = inventory(e, []);
    const configured = sources.filter(s => s.path.includes("entries"));
    await writeFile(lookup.path, configured.map(s => entry(s, Array.isArray(s.original) ? ["Read."] : "Short.")).join("\n"));
    await lookup.refresh(sources);
    const tools = [...e.systemPromptOptions.selectedTools];
    const files = e.systemPromptOptions.contextFiles;
    const skill = e.systemPromptOptions.skills[0];
    applyStructured(e, lookup);
    assert.equal(e.systemPromptOptions.toolSnippets.read, "Short.");
    assert.deepEqual(e.systemPromptOptions.toolGuidelines.read, ["Read."]);
    assert.equal(e.systemPromptOptions.skills[0].description, "Short.");
    assert.equal(e.systemPromptOptions.skills[0].filePath, skill.filePath);
    assert.deepEqual(e.systemPromptOptions.selectedTools, tools);
    assert.equal(e.systemPromptOptions.contextFiles, files);
  } finally { await cleanup(); }
});
test("whole-section replacement takes precedence regardless of source text", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    for (const original of ["Tools", "Old tools"]) {
      const e = event();
      await writeFile(lookup.path, entry({ path: ["message3", "tools"], original }, "Whole tools") +
        "\n" + entry({ path: ["message3", "tools", "entries", "read", "snippet"], original: "Read files." }, "Granular"));
      await lookup.refresh(inventory(e, []));
      applyStructured(e, lookup);
      assert.equal(e.systemPromptOptions.toolSnippets.read, "Read files.");
      assert.equal(e.systemPromptOptions.sections.tools, "Whole tools");
    }
  } finally { await cleanup(); }
});
test("installation/removal and description changes need no fixed tool or skill list", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    const e = event();
    await lookup.refresh(inventory(e, []));
    const old = await readFile(lookup.path, "utf8");
    e.systemPromptOptions.toolSnippets.extra = "New tool.";
    e.systemPromptOptions.skills = [];
    await lookup.refresh(inventory(e, []));
    assert.ok((await readFile(lookup.path, "utf8")).startsWith(old));
    assert.ok(lookup.report.missing.includes("message3.tools.entries.extra.snippet"));
    assert.ok(!lookup.report.missing.includes("message3.skills.entries.archify"));
    e.systemPromptOptions.toolSnippets.read = "Updated read.";
    await lookup.refresh(inventory(e, []));
    assert.ok(lookup.report.missing.includes("message3.tools.entries.read.snippet"));
    delete e.systemPromptOptions.toolSnippets.extra;
    await lookup.refresh(inventory(e, []));
    assert.ok(!lookup.report.missing.includes("message3.tools.entries.extra.snippet"));
  } finally { await cleanup(); }
});
test("transcript fallback changes only identity and preamble, not prime, tools, or user content", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    const identity: Source = { path: ["system_prompt"], original: "Identity" };
    const preamble: Source = { path: ["message3", "preamble"], original: "Default preamble" };
    await writeFile(lookup.path, entry(identity, "New identity") + "\n" + entry(preamble, "New preamble"));
    await lookup.refresh([identity, preamble]);
    const tools = [{ name: "read" }];
    const messages = [
      { role: "system", content: "Identity", toolsAdded: tools },
      { role: "user", content: "<prime_session>unchanged</prime_session>" },
      { role: "system", content: "", toolsAdded: tools },
      { role: "system", content: "", sections: { preamble: "Default preamble", docs: "<docs>\nDocs\n</docs>" } },
      { role: "user", content: "Identity Default preamble" },
    ];
    const result = applyTranscript(messages, lookup);
    assert.equal(result[0].content, "New identity");
    assert.equal(result[0].toolsAdded, tools);
    assert.equal(result[1], messages[1]);
    assert.equal(result[2], messages[2]);
    assert.equal(result[3].sections?.preamble, "New preamble");
    assert.equal(result[3].sections?.docs, messages[3].sections?.docs);
    assert.equal(result[4], messages[4]);
    assert.equal(messages[0].content, "Identity");
  } finally { await cleanup(); }
});
test("invalid lookup leaves both structured inputs and transcript unchanged", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    await writeFile(lookup.path, "bad = [");
    await lookup.refresh([source]);
    const e = event();
    const snapshot = structuredClone(e);
    applyStructured(e, lookup);
    assert.deepEqual(e, snapshot);
    const messages = [{ role: "system", content: "Text" }];
    assert.equal(applyTranscript(messages, lookup), messages);
  } finally { await cleanup(); }
});
test("real Pi prompt builder and hooks preserve prime/tools and measure repeated submissions", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    const host = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { buildSystemPrompt, buildSystemPromptSections } = await import(pathToFileURL(join(dirname(host), "core/system-prompt.js")).href);
    const handlers = new Map<string, Function>();
    let command: any;
    const notifications: string[] = [];
    registerBootstrap({
      on: (name: string, handler: Function) => handlers.set(name, handler),
      registerCommand: (_name: string, value: any) => { command = value; },
      getAllTools: () => [],
    } as unknown as ExtensionAPI, lookup.path);
    const ctx = { hasUI: true, ui: { notify: (text: string) => notifications.push(text), select: async (text: string) => text } };
    const makeEvent = () => {
      const e = event();
      Object.defineProperty(e, "systemPrompt", { get: () => buildSystemPrompt(e.systemPromptOptions) });
      return e;
    };
    const first = makeEvent();
    await handlers.get("before_agent_start")!(first, ctx);
    const prime = { role: "user", content: "<prime_session>Do not change.</prime_session>" };
    const tools = { role: "system", content: "", toolsAdded: [{ name: "read", description: "Read files.", parameters: {} }] };
    const baseline = [{ role: "system", content: "", sections: buildSystemPromptSections(first.systemPromptOptions) }, prime, tools];
    const unchanged = await handlers.get("context_with_system")!({ messages: baseline }, ctx);
    assert.deepEqual(unchanged.messages, baseline);
    await handlers.get("before_agent_start")!(makeEvent(), ctx);
    assert.equal(notifications.length, 1);
    const config = await readFile(lookup.path, "utf8");
    const enabled = config.replace("[\"message3\".\"preamble\"]", "[message3.preamble]\nreplacement = \"Short preamble.\"");
    await writeFile(lookup.path, enabled);
    const next = makeEvent();
    await handlers.get("before_agent_start")!(next, ctx);
    assert.deepEqual(next.systemPromptOptions.selectedTools, ["read"]);
    const outgoing = [{ role: "system", content: "", sections: buildSystemPromptSections(next.systemPromptOptions) }, prime, tools];
    const result = await handlers.get("context_with_system")!({ messages: outgoing }, ctx);
    assert.equal(result.messages[0].sections.preamble, "Short preamble.");
    assert.equal(result.messages[1], prime);
    assert.equal(result.messages[2], tools);
    let report = "";
    ctx.ui.select = async (text: string) => { report = text; return text; };
    await command.handler("", ctx);
    assert.ok(report.includes("bytes"));
    assert.ok(report.includes("Submission hook:"));
  } finally { await cleanup(); }
});
test("the extension creates config.toml in the global Pi extension directory", async () => {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(join(tmpdir(), "pi-bootstrap-global-"));
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    const config = join(dir, "extensions", "pi-bootstrap", "config.toml");
    assert.equal(getConfigPath(), config);
    const handlers = new Map<string, Function>();
    bootstrap({
      on: (name: string, handler: Function) => handlers.set(name, handler),
      registerCommand: () => {},
      getAllTools: () => [],
    } as unknown as ExtensionAPI);
    await handlers.get("before_agent_start")!(event(), { hasUI: false, ui: { notify: () => {} } });
    assert.ok(!(await readFile(config, "utf8")).includes("original"));
    assert.ok(!(await readFile(config, "utf8")).includes("source_hash"));
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(getConfigPath(), join(homedir(), ".pi", "agent", "extensions", "pi-bootstrap", "config.toml"));
  } finally {
    if (envDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = envDir;
    await rm(dir, { recursive: true, force: true });
  }
});
test("extension registers only the two required hooks and a UI command", () => {
  const events: string[] = [];
  const commands: string[] = [];
  bootstrap({ on: (name: string) => { events.push(name); }, registerCommand: (name: string) => { commands.push(name); } } as unknown as ExtensionAPI);
  assert.deepEqual(events, ["before_agent_start", "context_with_system"]);
  assert.deepEqual(commands, ["bootstrap"]);
});
