import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBootstrap } from "../index.ts";
import { parseReplacements, replaceTags, replaceMessages } from "../src/replace.ts";

const replace = (text: string, config: string) => replaceTags(text, parseReplacements(config));

test("[one] replaces only the body of a root tag", () => {
  assert.equal(replace('Before <one id="a">Old</one> after', '[one]\nreplacement = "New"'),
    'Before <one id="a">New</one> after');
});

test("[one.two] matches exact ancestry at any depth", () => {
  const text = "<two>A</two><one><two>B</two></one><other><one><two>C</two></one></other>";
  assert.equal(replace(text, '[one.two]\nreplacement = "New"'),
    "<two>A</two><one><two>New</two></one><other><one><two>C</two></one></other>");
  assert.equal(replace(text, '[other.one.two]\nreplacement = "Deep"'),
    "<two>A</two><one><two>B</two></one><other><one><two>Deep</two></one></other>");
});

test("underscores use exact tags first and hyphen tags only when exact tags are absent", () => {
  const config = '[abc_def]\nreplacement = "New"';
  assert.equal(replace("<abc_def>Old</abc_def>", config), "<abc_def>New</abc_def>");
  assert.equal(replace("<abc-def>Old</abc-def>", config), "<abc-def>New</abc-def>");
  assert.equal(replace("<abc-def>Hyphen</abc-def><abc_def>Exact</abc_def>", config),
    "<abc-def>Hyphen</abc-def><abc_def>New</abc_def>");
  assert.equal(replace("<abc_def>Exact</abc_def><abc-def>Hyphen</abc-def>", config),
    "<abc_def>New</abc_def><abc-def>Hyphen</abc-def>");
  assert.equal(replace("<abc-def>Old</abc-def>", '[abc_def]\nreplacement = ""'),
    "<abc-def></abc-def>");
});

test("fallback applies to each nested segment and is limited to its parent", () => {
  const config = '[abc_def.ghi_jkl]\nreplacement = "New"';
  for (const outer of ["abc_def", "abc-def"])
    for (const inner of ["ghi_jkl", "ghi-jkl"]) {
      const text = "<" + outer + "><" + inner + ">Old</" + inner + "></" + outer + ">";
      assert.equal(replace(text, config), text.replace("Old", "New"));
    }
  assert.equal(replace("<other><ghi_jkl>Other</ghi_jkl></other><abc-def><ghi-jkl>Old</ghi-jkl></abc-def>", config),
    "<other><ghi_jkl>Other</ghi_jkl></other><abc-def><ghi-jkl>New</ghi-jkl></abc-def>");
  assert.equal(replace("<abc_def><ghi-jkl>Old</ghi-jkl></abc_def><abc-def><ghi_jkl>Other</ghi_jkl></abc-def>", config),
    "<abc_def><ghi-jkl>New</ghi-jkl></abc_def><abc-def><ghi_jkl>Other</ghi_jkl></abc-def>");
  // An exact parent exists, so do not use the fallback parent to find a child.
  const text = "<abc_def>Exact</abc_def><abc-def><ghi-jkl>Old</ghi-jkl></abc-def>";
  assert.equal(replace(text, config), text);
});

test("literal hyphen configuration takes precedence over an underscore fallback", () => {
  for (const config of [
    '[abc_def]\nreplacement = "Fallback"\n[abc-def]\nreplacement = "Exact"',
    '[abc-def]\nreplacement = "Exact"\n[abc_def]\nreplacement = "Fallback"',
  ]) assert.equal(replace("<abc-def>Old</abc-def>", config), "<abc-def>Exact</abc-def>");
  assert.equal(replace("<abc_def>Old</abc_def>", '[abc-def]\nreplacement = "New"'),
    "<abc_def>Old</abc_def>");
});

test("generic fallback works for the system-prompt tag without a special alias", () => {
  assert.equal(replace("<system-prompt><tools>Old</tools></system-prompt>",
    '[system_prompt.tools]\nreplacement = "New"'),
    "<system-prompt><tools>New</tools></system-prompt>");
});

test("untagged text, unmatched tags, and case differences stay unchanged", () => {
  const text = "Plain text <One>Old</One><other>Old</other>";
  assert.equal(replace(text, '[one]\nreplacement = "New"'), text);
  assert.equal(replace("<one>Old</one>", "[one]"), "<one>Old</one>");
  assert.equal(replace("<unclosed>", ""), "<unclosed>");
});

test("repeated and same-name nested tags use their own paths", () => {
  assert.equal(replace("<one>A</one><one>B</one>", '[one]\nreplacement = "New"'),
    "<one>New</one><one>New</one>");
  assert.equal(replace("<one><one>A</one></one>", '[one.one]\nreplacement = "New"'),
    "<one><one>New</one></one>");
});

test("replacement text is exact, may be empty, and is not scanned again", () => {
  assert.equal(replace("<one>\nOld\n</one>", '[one]\nreplacement = ""'), "<one></one>");
  assert.equal(replace("<one>Old</one>", '[one]\nreplacement = "  New  "'), "<one>  New  </one>");
  assert.equal(replace("<one>Old</one>", '[one]\nreplacement = "<one>New</one> $&"'),
    "<one><one>New</one> $&</one>");
  assert.equal(replace("<one>Old</one>", '[one]\nreplacement = """\nNew\ncontent\n"""'),
    "<one>New\ncontent\n</one>");
});

test("parent replacements take precedence over child replacements", () => {
  assert.equal(replace("<one><two>Old</two></one><one><two>Again</two></one>",
    '[one.two]\nreplacement = "Child"\n[one]\nreplacement = "Parent"'),
    "<one>Parent</one><one>Parent</one>");
});

test("attributes and self-closing tags do not change ancestry", () => {
  assert.equal(replace('<one attr=">"><empty/><two data=\'x\'>Old</two></one>',
    '[one.two]\nreplacement = "New"'),
    '<one attr=">"><empty/><two data=\'x\'>New</two></one>');
  assert.equal(replace("<one/><one>Old</one>", '[one]\nreplacement = "New"'),
    "<one/><one>New</one>");
});

test("Markdown fences keep tag examples literal", () => {
  for (const fence of ["~~~", "```"]) {
    const text = fence + "\n<one>Example</one>\n<unclosed>\n" + fence + "\n<one>Old</one>";
    assert.equal(replace(text, '[one]\nreplacement = "New"'),
      fence + "\n<one>Example</one>\n<unclosed>\n" + fence + "\n<one>New</one>");
  }
});

test("literal type notation does not stop replacements or change ancestry", () => {
  const config = '[one.two]\nreplacement = "New"';
  for (const text of [
    "Map<string> <one><two>Old</two></one>",
    "<one>Map<string> <two>Old</two></one>",
    "<one><two>Old Map<string></two></one>",
  ]) assert.equal(replace(text, config), text.replace(/<two>.*?<\/two>/, "<two>New</two>"));
});

test("invalid configuration is rejected and unmatched tags stay unchanged", () => {
  for (const config of ["[broken", '[one]\nreplacement = 3', '[one]\nreplacement = []',
    'replacement = "Root"', '[one]\nunknown = "Value"'])
    assert.throws(() => parseReplacements(config));
  for (const text of ["<one>Old", "<one></two>", "</one>"])
    assert.equal(replace(text, '[one]\nreplacement = "New"'), text);
});

test("tag names have no special meaning and quoted path segments stay literal", () => {
  assert.equal(replace("<tools>Old</tools>", '[tools]\nreplacement = "New"'), "<tools>New</tools>");
  assert.equal(replace("<replacement>Old</replacement>", '[replacement]\nreplacement = "New"'),
    "<replacement>New</replacement>");
  assert.equal(replace("<one.two>Old</one.two>", '["one.two"]\nreplacement = "New"'),
    "<one.two>New</one.two>");
  assert.equal(replace("<one><two>Old</two></one>", '["one.two"]\nreplacement = "New"'),
    "<one><two>Old</two></one>");
});

test("all message roles use literal paths without changing stored messages or non-text data", () => {
  const image = { type: "image", data: "unchanged" };
  const toolCall = { type: "toolCall", name: "read", arguments: { text: "<one>Old</one>" } };
  const toolsAdded = [{ name: "read", description: "<one>Old</one>" }];
  const messages = [
    { role: "system", sections: { arbitrary: "<one>Old</one>", empty: null }, toolsAdded },
    { role: "user", content: "<one>Old</one>" },
    { role: "assistant", content: [{ type: "text", text: "<one>Old</one>" }, toolCall] },
    { role: "toolResult", content: [image, { type: "text", text: "<one>Old</one>" }] },
  ];
  const before = structuredClone(messages);
  const result = replaceMessages(messages, parseReplacements('[one]\nreplacement = "New"'));
  assert.deepEqual(messages, before);
  assert.deepEqual(result[0].sections, { arbitrary: "<one>New</one>", empty: null });
  assert.equal(result[0].toolsAdded, toolsAdded);
  assert.equal(result[1].content, "<one>New</one>");
  assert.deepEqual(result[2].content, [{ type: "text", text: "<one>New</one>" }, toolCall]);
  assert.deepEqual(result[3].content, [image, { type: "text", text: "<one>New</one>" }]);
});

test("system_prompt paths select system text without changing tools or conversation text", () => {
  const toolsAdded = [{ name: "read", description: "Real tool" }];
  const messages = [
    { role: "system", content: "", sections: {
      tools: "<tools>Old guidance</tools>",
      custom: "<one><two>Old nested text</two></one>",
    }, toolsAdded },
    { role: "system", content: "<tools>Updated guidance</tools>" },
    { role: "system", content: [{ type: "text", text: "<one><two>Block</two></one>" }] },
    { role: "user", content: "<tools>User text</tools><one><two>User nested text</two></one>" },
  ];
  const original = structuredClone(messages);
  const result = replaceMessages(messages, parseReplacements(
    '[system_prompt.tools]\nreplacement = "New guidance"\n[system_prompt.one.two]\nreplacement = "New nested text"'));
  assert.deepEqual(result[0].sections, {
    tools: "<tools>New guidance</tools>",
    custom: "<one><two>New nested text</two></one>",
  });
  assert.equal(result[0].toolsAdded, toolsAdded);
  assert.equal(result[1].content, "<tools>New guidance</tools>");
  assert.deepEqual(result[2].content, [{ type: "text", text: "<one><two>New nested text</two></one>" }]);
  assert.equal(result[3].content, messages[3].content);
  assert.deepEqual(messages, original);
});

test("the hook creates a default config, preserves edits, and registers no UI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bootstrap-"));
  const path = join(dir, "config.toml");
  const handlers = new Map<string, (event: any) => Promise<any>>();
  // No command or UI methods: registration and requests must not need them.
  registerBootstrap({
    on: (name: string, handler: (event: any) => Promise<any>) => handlers.set(name, handler),
  } as unknown as ExtensionAPI, path);
  const run = handlers.get("context_with_system")!;
  const event = { messages: [{ role: "system", content: "Plain text <one>Old</one>" }] };
  try {
    assert.deepEqual([...handlers.keys()], ["context_with_system"]);
    const defaults = await readFile(new URL("../default.toml", import.meta.url), "utf8");
    assert.deepEqual((await run(event)).messages, event.messages);
    assert.equal(await readFile(path, "utf8"), defaults);
    const toolsAdded = [{ name: "read", description: "Real tool" }];
    const system = { role: "system", content: "", sections: { tools: "<tools>Old guidance</tools>" }, toolsAdded };
    const replaced = (await run({ messages: [system] })).messages[0];
    assert.equal(replaced.sections.tools, "<tools>TOOLS REPLACEMENT TEXT</tools>");
    assert.equal(replaced.toolsAdded, toolsAdded);
    assert.equal(system.sections.tools, "<tools>Old guidance</tools>");
    assert.deepEqual(await readdir(dir), ["config.toml"]);
    for (const value of ["First", "Second", ""]) {
      const config = '[one]\nreplacement = "' + value + '"';
      await writeFile(path, config);
      const result = await run(event);
      assert.equal(result.messages[0].content, "Plain text <one>" + value + "</one>");
      assert.equal(event.messages[0].content, "Plain text <one>Old</one>");
      assert.equal(await readFile(path, "utf8"), config);
      assert.deepEqual(await readdir(dir), ["config.toml"]);
    }
    await writeFile(path, "[invalid");
    await assert.rejects(run(event));
    await rm(path);
    assert.deepEqual((await run(event)).messages, event.messages);
    assert.equal(await readFile(path, "utf8"), defaults);
    await rm(dir, { recursive: true });
    // Missing parent directories are created too.
    await run(event);
    assert.equal(await readFile(path, "utf8"), defaults);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
