import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm, open } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "smol-toml";
import bootstrap, { getConfigPath, registerBootstrap } from "../index.ts";
import { Lookup, addFields, type Source } from "../src/lookup.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const source: Source = { path: ["system_prompt", "docs"], original: "Long documentation." };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pi-bootstrap-"));
  return { lookup: new Lookup(join(dir, "config.toml")), cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const entry = (replacement: unknown) => '[system_prompt.docs]\nreplacement = ' + JSON.stringify(replacement) + '\n';

test("discovery retains comments and creates empty stable tables only once", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    await writeFile(lookup.path, "# User comment\n\n");
    await lookup.refresh([source]);
    assert.equal(lookup.valid, true);
    const text = await readFile(lookup.path, "utf8");
    assert.ok(text.startsWith("# User comment\n\n"));
    assert.ok(!text.includes("original"));
    assert.ok(!text.includes("replacement"));
    assert.ok(text.includes('["system_prompt"."docs"]'));
    const mtime = (await stat(lookup.path)).mtimeMs;
    await lookup.refresh([source]);
    assert.equal((await stat(lookup.path)).mtimeMs, mtime);
    assert.deepEqual(lookup.report.missing, ["system_prompt.docs"]);
  } finally { await cleanup(); }
});
test("replacement-only tables remain active when source prose changes", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    const config = "# Keep comment\n" + entry("Short docs.");
    await writeFile(lookup.path, config);
    for (const original of ["First source.", "Different source.", ""]) {
      await lookup.refresh([{ ...source, original }]);
      assert.equal(lookup.valid, true);
      assert.equal(lookup.replacement(source.path), "Short docs.");
      assert.equal(await readFile(lookup.path, "utf8"), config);
    }
    await writeFile(lookup.path, entry("New docs."));
    await lookup.refresh([source]);
    assert.equal(lookup.replacement(source.path), "New docs.");
  } finally { await cleanup(); }
});
test("invalid TOML, wrong types, and empty replacements fail closed", async () => {
  const { lookup, cleanup } = await fixture();
  try {
    for (const text of ["[broken", entry(""), entry([]), entry(["wrong type"]), entry("   "), entry(12)]) {
      await writeFile(lookup.path, text);
      await lookup.refresh([source]);
      assert.equal(lookup.valid, false);
      assert.ok(lookup.report.error);
      assert.equal(lookup.replacement(source.path), undefined);
      assert.equal(await readFile(lookup.path, "utf8"), text);
    }
  } finally { await cleanup(); }
});
test("an existing lock prevents writes and is not removed", async () => {
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
test("fields enter existing tables without changing comments or multiline strings", () => {
  const text = "# Header\n[system_prompt.docs] # My table\n# Notes\n\n[unrelated]\ntext = '''\n[system_prompt.docs]\n'''\n";
  const next = addFields(text, source.path, 'replacement = "Docs"\n', true);
  assert.ok(next.includes('[system_prompt.docs] # My table\nreplacement = "Docs"\n\n# Notes'));
  assert.ok(next.endsWith("[unrelated]\ntext = '''\n[system_prompt.docs]\n'''\n"));
  assert.equal((parse(next) as any).system_prompt.docs.replacement, "Docs");
});
test("the extension creates config in the global Pi extension directory", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = await mkdtemp(join(tmpdir(), "pi-bootstrap-global-"));
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    const config = join(dir, "extensions", "pi-bootstrap", "config.toml");
    assert.equal(getConfigPath(), config);
    const handlers = new Map<string, Function>();
    bootstrap({
      on: (name: string, handler: Function) => handlers.set(name, handler),
      registerCommand: () => {},
    } as unknown as ExtensionAPI);
    await handlers.get("context_with_system")!({ messages: [{ role: "system", content: "Preamble" }] }, { hasUI: false });
    const text = await readFile(config, "utf8");
    const data = parse(text) as any;
    assert.deepEqual(Object.keys(data), []);
    assert.ok(!text.includes("source_hash"));
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(getConfigPath(), join(homedir(), ".pi", "agent", "extensions", "pi-bootstrap", "config.toml"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
test("extension registers only a request-local context hook and report command", () => {
  const events: string[] = [];
  const commands: string[] = [];
  registerBootstrap({ on: (name: string) => { events.push(name); }, registerCommand: (name: string) => { commands.push(name); } } as unknown as ExtensionAPI);
  assert.deepEqual(events, ["context_with_system"]);
  assert.deepEqual(commands, ["bootstrap"]);
});
