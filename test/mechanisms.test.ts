import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "smol-toml";
import { Lookup } from "../src/lookup.ts";
import { Mechanisms, taggedRegions, type TranscriptMessage } from "../src/prompt.ts";

async function fixture(text?: string) {
  const dir = await mkdtemp(join(tmpdir(), "pi-context-"));
  const path = join(dir, "config.toml");
  if (text !== undefined) await writeFile(path, text);
  // Test the generic matcher without Pi transport containers. The baseline suite
  // exercises registerBootstrap with real system-prompt/messages ancestry.
  const lookup = new Lookup(path);
  let engine: Mechanisms | undefined;
  return {
    path,
    request: async <T extends TranscriptMessage>(messages: T[]): Promise<T[]> => {
      const candidate: { engine?: Mechanisms } = {};
      await lookup.refresh(data => {
        candidate.engine = new Mechanisms(data);
        return candidate.engine.discover(messages);
      }, await readFile(new URL("../default.toml", import.meta.url), "utf8"));
      engine = candidate.engine;
      return lookup.valid && engine ? engine.applyTranscript(messages, lookup) : messages;
    },
    show: async () => [
      lookup.report.error ? "Error: " + lookup.report.error : "",
      ...lookup.report.missing, ...(engine?.unidentified.map(u => u.text) ?? []),
    ].join("\n"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("configuration and discovery have no fixed scope names or aliases", () => {
  const text = "<one><two>text</two></one><other><two>different</two></other>";
  const engine = new Mechanisms({ one: { two: { replacement: "New" } } });
  assert.deepEqual(engine.discover([{ role: "user", content: text }]).map(s => s.path),
    [["one"], ["one", "two"], ["other"], ["other", "two"]]);
  assert.deepEqual(engine.unidentified, []);
});

test("a path must match the entire ancestry, not a suffix", async () => {
  const f = await fixture('[one.two]\nreplacement = "New"\n');
  try {
    const text = "<one><two>old</two></one><other><two>keep</two></other><two>keep</two>";
    const result = await f.request([{ role: "system", content: text }]);
    assert.equal(result[0].content, text.replace(">old<", ">New<"));
  } finally { await f.cleanup(); }
});

test("arbitrary names and arbitrary nesting depths use the same matching rules", async () => {
  const f = await fixture('[Alpha."beta-tag".gamma.delta]\nreplacement = "New"\n');
  try {
    const text = '<Alpha><beta-tag source="x > y"><gamma><delta>Old</delta></gamma></beta-tag></Alpha>';
    const result = await f.request([{ role: "assistant", content: text }]);
    assert.equal(result[0].content, text.replace("Old", "New"));
  } finally { await f.cleanup(); }
});

test("discovery preserves comments, creates nested tables once, and reloads replacements", async () => {
  const f = await fixture("# Keep this comment\n");
  try {
    const messages = [{ role: "toolResult", content: "<one><two>Old</two></one>" }];
    assert.equal(await f.request(messages), messages);
    const discovered = await readFile(f.path, "utf8");
    assert.ok(discovered.startsWith("# Keep this comment\n"));
    assert.deepEqual({ ...(parse(discovered) as any).one.two }, {});
    const mtime = (await stat(f.path)).mtimeMs;
    assert.equal(await f.request(messages), messages);
    assert.equal((await stat(f.path)).mtimeMs, mtime);
    assert.ok((await f.show()).includes("one.two"));
    for (const value of ["New", "Updated"]) {
      await writeFile(f.path, '[one.two]\nreplacement = "' + value + '"\n');
      assert.equal((await f.request(messages))[0].content, messages[0].content.replace("Old", value));
    }
  } finally { await f.cleanup(); }
});

test("default config contains no fixed scopes or active replacements", async () => {
  const f = await fixture();
  try {
    const messages = [{ role: "system", content: "<new_scope>Keep</new_scope>" }];
    assert.equal(await f.request(messages), messages);
    const template = await readFile(new URL("../default.toml", import.meta.url), "utf8");
    assert.deepEqual(Object.keys(parse(template)), []);
    assert.deepEqual(Object.keys(parse(await readFile(f.path, "utf8"))), ["new_scope"]);
  } finally { await f.cleanup(); }
});

test("text block edits preserve images, unrelated blocks, tool metadata, and input identity", async () => {
  const f = await fixture('[one.two]\nreplacement = "New"\n');
  try {
    const image = { type: "image", data: "abc", mimeType: "image/png" };
    const untouched = { type: "text", text: "Ordinary prose." };
    const content = [image, untouched, { type: "text", text: "<one><two>Old</two></one>" }, null];
    const toolsAdded = [{ name: "read", description: "Read", parameters: {} }];
    const toolsRemoved = ["old"];
    const messages = [{ role: "user", content, toolsAdded, toolsRemoved }];
    const result = await f.request(messages);
    const changed = result[0].content as any[];
    assert.equal(changed[0], image);
    assert.equal(changed[1], untouched);
    assert.equal(changed[2].text, "<one><two>New</two></one>");
    assert.equal(changed[3], null);
    assert.equal(result[0].toolsAdded, toolsAdded);
    assert.equal(result[0].toolsRemoved, toolsRemoved);
    assert.equal((content[2] as any).text, "<one><two>Old</two></one>");
  } finally { await f.cleanup(); }
});

test("structured fields are text containers, not implicit tag path segments", async () => {
  const f = await fixture('[one.two]\nreplacement = "New"\n[preamble]\nreplacement = "Not an alias"\n');
  try {
    const messages: TranscriptMessage[] = [{
      role: "system", content: "", sections: {
        arbitrary: "<one><two>Old</two></one>", preamble: "Raw preamble", removed: null,
      },
    }];
    const result = await f.request(messages);
    assert.equal(result[0].sections!.arbitrary, "<one><two>New</two></one>");
    assert.equal(result[0].sections!.preamble, "Raw preamble");
    assert.equal(result[0].sections!.removed, null);
    assert.equal(messages[0].sections!.arbitrary, "<one><two>Old</two></one>");
  } finally { await f.cleanup(); }
});

test("real Pi sections use their literal tags, with no preamble special case", async () => {
  const host = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { buildSystemPromptSections } = await import(pathToFileURL(join(dirname(host), "core/system-prompt.js")).href);
  const sections = buildSystemPromptSections({ cwd: "/project", selectedTools: [] });
  const f = await fixture('[rules]\nreplacement = "New rules."\n');
  try {
    const result = await f.request([{ role: "system", content: "", sections }]);
    assert.equal(result[0].sections.rules, "<rules>\nNew rules.\n</rules>");
    assert.equal(result[0].sections.preamble, sections.preamble);
  } finally { await f.cleanup(); }
});

test("parent replacements work when no child replacement is active", async () => {
  const f = await fixture('[one]\nreplacement = "Whole body"\n[one.two]\n');
  try {
    const result = await f.request([{ role: "system", content: "<one><two>Old</two></one>" }]);
    assert.equal(result[0].content, "<one>Whole body</one>");
  } finally { await f.cleanup(); }
});

test("active ancestor and descendant replacements fail closed before config writes", async () => {
  const config = '[one]\nreplacement = "Parent"\n[one.two]\nreplacement = "Child"\n[other]\nreplacement = "Other"\n';
  const f = await fixture(config);
  try {
    const messages = [{ role: "system", content: "<one><two>Old</two></one><other>Old</other>" }];
    assert.equal(await f.request(messages), messages);
    assert.equal(await readFile(f.path, "utf8"), config);
    assert.ok((await f.show()).includes("Overlapping replacements: one and one.two"));
  } finally { await f.cleanup(); }
});

test("multiple sibling and repeated replacements keep original offsets and CRLF wrappers", async () => {
  const f = await fixture('[one.two]\nreplacement = "Longer replacement"\n[one.three]\nreplacement = "New"\n');
  try {
    const text = '<one>\r\n<two attr="x">\r\nOld\r\n</two>\r\n<three>Old</three><two>Old</two>\r\n</one>';
    const messages = [{ role: "system", content: text }];
    const result = await f.request(messages);
    assert.equal(result[0].content, text.replaceAll('<two>Old</two>', '<two>Longer replacement</two>')
      .replace('\r\nOld\r\n', '\r\nLonger replacement\r\n').replace('<three>Old</three>', '<three>New</three>'));
    assert.deepEqual(await f.request(result), result);
    assert.equal(messages[0].content, text);
  } finally { await f.cleanup(); }
});

test("empty paired tag bodies can be replaced; self-closing tags have no body", async () => {
  const f = await fixture('[one.two]\nreplacement = "New"\n');
  try {
    const text = "<one><two></two><empty /></one>";
    assert.equal((await f.request([{ role: "user", content: text }]))[0].content,
      "<one><two>New</two><empty /></one>");
  } finally { await f.cleanup(); }
});

test("tag parser ignores fenced examples and tracks inline and multiline nested tags", () => {
  const text = '<one>\n<two>inline</two>\n```xml\n</one>\n<fake>\n```\n~~~xml\n<fake>\n~~~\n</one>';
  assert.deepEqual(taggedRegions(text).map(r => r.path), [["one"], ["one", "two"]]);
  for (const broken of ["<one>Unclosed", "<one></two>", "</one>"])
    assert.throws(() => taggedRegions(broken), /context tag/);
});

test("untagged text has no synthetic scope and is retained and reported", async () => {
  const f = await fixture('[preamble]\nreplacement = "Not applied"\n[one]\nreplacement = "New"\n');
  try {
    const text = "Prefix\n<one>Old</one>\nSuffix";
    assert.equal((await f.request([{ role: "user", content: text }]))[0].content, text.replace("Old", "New"));
    const report = await f.show();
    assert.ok(report.includes("Prefix"));
    assert.ok(report.includes("Suffix"));
    assert.ok(!(parse(await readFile(f.path, "utf8")) as any).system_prompt);
  } finally { await f.cleanup(); }
});

test("former alias names are ordinary literal tags with no precedence rules", async () => {
  const f = await fixture('[tools]\nreplacement = "Top"\n[system_prompt.tools]\nreplacement = "Nested"\n');
  try {
    const text = "<tools>Old</tools><system_prompt><tools>Old</tools></system_prompt>";
    assert.equal((await f.request([{ role: "system", content: text }]))[0].content,
      "<tools>Top</tools><system_prompt><tools>Nested</tools></system_prompt>");
  } finally { await f.cleanup(); }
});

test("a tag named replacement can be represented by a nested table", async () => {
  const f = await fixture('[one.replacement]\nreplacement = "New"\n');
  try {
    const text = "<one><replacement>Old</replacement></one>";
    assert.equal((await f.request([{ role: "system", content: text }]))[0].content,
      "<one><replacement>New</replacement></one>");
  } finally { await f.cleanup(); }
});

test("invalid configuration and malformed tags in any text container stop the entire request", async () => {
  for (const config of ["[broken", '[one]\nreplacement = ""\n', "[one]\nreplacement = 12\n", "one = 12\n"]) {
    const f = await fixture(config);
    try {
      const messages = [{ role: "system", content: "<one>Old</one>" }];
      assert.equal(await f.request(messages), messages);
      assert.equal(await readFile(f.path, "utf8"), config);
      assert.ok((await f.show()).includes("Error:"));
    } finally { await f.cleanup(); }
  }
  for (const malformed of [
    { role: "user", content: "<broken>" },
    { role: "toolResult", content: [{ type: "text", text: "<broken>" }] },
    { role: "system", sections: { arbitrary: "<broken>" } },
  ]) {
    const f = await fixture('[one]\nreplacement = "New"\n');
    try {
      const messages: TranscriptMessage[] = [{ role: "system", content: "<one>Old</one>" }, malformed];
      assert.equal(await f.request(messages), messages);
      assert.ok((await f.show()).includes("Unclosed context tag"));
    } finally { await f.cleanup(); }
  }
});

test("overlap checks are local to each text container, including individual blocks", async () => {
  const f = await fixture('[one]\nreplacement = "Parent"\n[one.two]\nreplacement = "Child"\n');
  try {
    const messages = [
      { role: "system", content: "<one>Old</one>" },
      { role: "user", content: [{ type: "text", text: "<one><two>Old</two></one>" }] },
    ];
    // Both scopes in the second container still overlap and must be rejected.
    assert.equal(await f.request(messages), messages);
    // The same path can occur in separate containers without a false self-conflict.
    await writeFile(f.path, '[one.two]\nreplacement = "Child"\n');
    const independent = [
      { role: "system", content: "<one><two>Old</two></one>" },
      { role: "user", content: [{ type: "text", text: "<one><two>Old</two></one>" },
        { type: "text", text: "<one><two>Old</two></one>" }] },
    ];
    const result = await f.request(independent);
    assert.equal(result[0].content, "<one><two>Child</two></one>");
    const blocks = result[1].content as { type: string; text: string }[];
    assert.ok(blocks.every(block => block.text === "<one><two>Child</two></one>"));
  } finally { await f.cleanup(); }
});

test("quoted TOML segments match periods in tag names literally", async () => {
  const f = await fixture('["one.two".three]\nreplacement = "New"\n');
  try {
    const text = "<one.two><three>Old</three></one.two><one><two><three>Keep</three></two></one>";
    assert.equal((await f.request([{ role: "user", content: text }]))[0].content, text.replace("Old", "New"));
  } finally { await f.cleanup(); }
});

test("invalid table types and unsafe names remain rejected at every depth", () => {
  for (const data of [
    { one: "text" }, { one: [] }, { one: { two: { replacement: [] } } },
    { one: { two: { replacement: "  " } } }, { one: { constructor: {} } },
    { "bad name": {} },
  ]) assert.throws(() => new Mechanisms(data));
  assert.throws(() => new Mechanisms({}).discover([
    { role: "user", content: "<one><constructor>text</constructor></one>" },
  ]), /Unsafe/);
});
