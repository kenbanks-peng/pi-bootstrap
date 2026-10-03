import assert from "node:assert/strict";
import { test } from "node:test";
import { replaceTags, replaceMessages } from "../src/replace.ts";

import { parseReplacements } from "./replacement-fixture.ts";

const replace = (text: string, config: string) => replaceTags(text, parseReplacements(config));

test("preamble and postamble replace text at tag body edges", () => {
  const text = "<abc>\nthis is some preamble.\n<def>hi</def>\nhere is some postamble\n</abc>";
  assert.equal(replace(text,
    '[abc.preamble]\nreplacement = "Before"\n[abc.postamble]\nreplacement = "After"'),
    "<abc>Before<def>hi</def>After</abc>");
});

test("special references support nested paths, repeats, and underscore fallback", () => {
  const text = "<outer-tag><abc>Before<def>Old</def>After</abc><abc>B<def>D</def>A</abc></outer-tag>";
  assert.equal(replace(text,
    '[outer_tag.abc.preamble]\nreplacement = ""\n[outer_tag.abc.def]\nreplacement = "New"\n[outer_tag.abc.postamble]\nreplacement = "End"'),
    "<outer-tag><abc><def>\nNew\n</def>End</abc><abc><def>\nNew\n</def>End</abc></outer-tag>");
});

test("edge boundaries include self-closing tags and exclude fenced and unmatched tags", () => {
  assert.equal(replace('<abc id="a">Before<empty/>After</abc>',
    '[abc.preamble]\nreplacement = "P"\n[abc.postamble]\nreplacement = "Q"'),
    '<abc id="a">P<empty/>Q</abc>');
  const text = "<abc>Map<string>\n~~~\n<example>literal</example>\n~~~\n<def>hi</def>After</abc>";
  assert.equal(replace(text, '[abc.preamble]\nreplacement = "P"'), "<abc>P<def>hi</def>After</abc>");
  assert.equal(replace("<abc>P<def><inner>I</inner></def>Middle<last>L</last>Q</abc>",
    '[abc.postamble]\nreplacement = "End"'),
    "<abc>P<def><inner>I</inner></def>Middle<last>L</last>End</abc>");
});

test("special references include empty edges and leaf bodies without rescanning inserted text", () => {
  assert.equal(replace("<abc><def>hi</def></abc>",
    '[abc.preamble]\nreplacement = "<def>P</def>"\n[abc.postamble]\nreplacement = "Q"\n[abc.def]\nreplacement = "New"'),
    "<abc><def>P</def><def>\nNew\n</def>Q</abc>");
  for (const suffix of ["preamble", "postamble"])
    assert.equal(replace("<abc>Body</abc>", '[abc.' + suffix + ']\nreplacement = "New"'),
      "<abc>New</abc>");
  assert.equal(replace("<abc>P<def>hi</def>Q</abc>",
    '[abc.preamble]\nreplacement = "P2"\n[abc.postamble]\nreplacement = "Q2"\n[abc]\nreplacement = "Whole"'),
    "<abc>\nWhole\n</abc>");
});

test("special suffixes do not select literal child tags with the same name", () => {
  assert.equal(replace("<abc>Before<preamble>Literal</preamble>After</abc>",
    '[abc.preamble]\nreplacement = "New"'),
    "<abc>New<preamble>Literal</preamble>After</abc>");
  const result = replaceMessages([{ role: "system", content: "Before<preamble>Literal</preamble>After" }],
    parseReplacements('[system_prompt.preamble]\nreplacement = "New"'));
  assert.equal(result[0].content, "New<preamble>Literal</preamble>After");
});

test("a structured system prompt has one preamble, not one per section", () => {
  const messages = [{ role: "system", content: "", sections: {
    preamble: "Original opening",
    tools: "<tools>Old guidance</tools>",
    rules: "<rules>Rules</rules>",
    docs: "<docs>Docs</docs>",
  } }];
  const result = replaceMessages(messages, parseReplacements(
    '[system_prompt.preamble]\nreplacement = "PREAMBLE REPLACEMENT TEXT"'));
  assert.deepEqual(result[0].sections, {
    preamble: "PREAMBLE REPLACEMENT TEXT",
    tools: "<tools>Old guidance</tools>",
    rules: "<rules>Rules</rules>",
    docs: "<docs>Docs</docs>",
  });
  assert.equal(result[0].content, "");
});

test("system section updates do not create more preambles or postambles", () => {
  const messages: { role: string; content: string; sections: Record<string, string | null> }[] = [
    { role: "system", content: "", sections: {
      preamble: "Opening", tools: "<tools>T</tools>", rules: "<rules>R</rules>",
    } },
    { role: "system", content: "", sections: { tools: "<tools>Updated</tools>" } },
    { role: "system", content: "", sections: { rules: null } },
  ];
  const before = structuredClone(messages);
  const result = replaceMessages(messages, parseReplacements(
    '[system_prompt.preamble]\nreplacement = "PREAMBLE REPLACEMENT TEXT"\n[system_prompt.postamble]\nreplacement = "POSTAMBLE REPLACEMENT TEXT"'));
  assert.deepEqual(result[0].sections, {
    preamble: "PREAMBLE REPLACEMENT TEXT", tools: "<tools>T</tools>", rules: "<rules>R</rules>",
  });
  assert.deepEqual(result[1].sections, { tools: "<tools>Updated</tools>POSTAMBLE REPLACEMENT TEXT" });
  assert.deepEqual(result[2].sections, { rules: null });
  assert.ok(result.every(message => message.content === ""));
  assert.deepEqual(messages, before);
});

test("system text blocks receive edge replacements only in the first and last text blocks", () => {
  const result = replaceMessages([{ role: "system", content: [
    { type: "text", text: "Before<tools>T</tools>" },
    { type: "image", data: "unchanged" },
    { type: "text", text: "<rules>R</rules>" },
    { type: "text", text: "<docs>D</docs>After" },
  ] }], parseReplacements(
    '[system_prompt.preamble]\nreplacement = "P"\n[system_prompt.postamble]\nreplacement = "Q"'));
  assert.deepEqual(result[0].content, [
    { type: "text", text: "P<tools>T</tools>" },
    { type: "image", data: "unchanged" },
    { type: "text", text: "<rules>R</rules>" },
    { type: "text", text: "<docs>D</docs>Q" },
  ]);
});

test("nested edge references still work inside structured system sections", () => {
  const result = replaceMessages([{ role: "system", sections: {
    preamble: "Opening", tools: "<tools>Before<child>C</child>After</tools>",
  } }], parseReplacements(
    '[system_prompt.tools.preamble]\nreplacement = "P"\n[system_prompt.tools.postamble]\nreplacement = "Q"'));
  assert.deepEqual(result[0].sections, {
    preamble: "Opening", tools: "<tools>P<child>C</child>Q</tools>",
  });
});

test("system prompt edge references work without an outer tag", () => {
  const messages = [
    { role: "system", content: "Before<tools>Old</tools>After" },
    { role: "user", content: "Before<tools>Old</tools>After" },
  ];
  const result = replaceMessages(messages, parseReplacements(
    '[system_prompt.preamble]\nreplacement = "P"\n[system_prompt.postamble]\nreplacement = "Q"\n[system_prompt.tools]\nreplacement = "New"'));
  assert.equal(result[0].content, "P<tools>\nNew\n</tools>Q");
  assert.equal(result[1].content, messages[1].content);
});

test("[one] replaces only the body of a root tag", () => {
  assert.equal(replace('Before <one id="a">Old</one> after', '[one]\nreplacement = "New"'),
    'Before <one id="a">\nNew\n</one> after');
});

test("[one.two] matches exact ancestry at any depth", () => {
  const text = "<two>A</two><one><two>B</two></one><other><one><two>C</two></one></other>";
  assert.equal(replace(text, '[one.two]\nreplacement = "New"'),
    "<two>A</two><one><two>\nNew\n</two></one><other><one><two>C</two></one></other>");
  assert.equal(replace(text, '[other.one.two]\nreplacement = "Deep"'),
    "<two>A</two><one><two>B</two></one><other><one><two>\nDeep\n</two></one></other>");
});

test("underscores use exact tags first and hyphen tags only when exact tags are absent", () => {
  const config = '[abc_def]\nreplacement = "New"';
  assert.equal(replace("<abc_def>Old</abc_def>", config), "<abc_def>\nNew\n</abc_def>");
  assert.equal(replace("<abc-def>Old</abc-def>", config), "<abc-def>\nNew\n</abc-def>");
  assert.equal(replace("<abc-def>Hyphen</abc-def><abc_def>\nExact\n</abc_def>", config),
    "<abc-def>Hyphen</abc-def><abc_def>\nNew\n</abc_def>");
  assert.equal(replace("<abc_def>\nExact\n</abc_def><abc-def>Hyphen</abc-def>", config),
    "<abc_def>\nNew\n</abc_def><abc-def>Hyphen</abc-def>");
  assert.equal(replace("<abc-def>Old</abc-def>", '[abc_def]\nreplacement = ""'),
    "");
});

test("fallback applies to each nested segment and is limited to its parent", () => {
  const config = '[abc_def.ghi_jkl]\nreplacement = "New"';
  for (const outer of ["abc_def", "abc-def"])
    for (const inner of ["ghi_jkl", "ghi-jkl"]) {
      const text = "<" + outer + "><" + inner + ">Old</" + inner + "></" + outer + ">";
      assert.equal(replace(text, config), text.replace("Old", "\nNew\n"));
    }
  assert.equal(replace("<other><ghi_jkl>Other</ghi_jkl></other><abc-def><ghi-jkl>Old</ghi-jkl></abc-def>", config),
    "<other><ghi_jkl>Other</ghi_jkl></other><abc-def><ghi-jkl>\nNew\n</ghi-jkl></abc-def>");
  assert.equal(replace("<abc_def><ghi-jkl>Old</ghi-jkl></abc_def><abc-def><ghi_jkl>Other</ghi_jkl></abc-def>", config),
    "<abc_def><ghi-jkl>\nNew\n</ghi-jkl></abc_def><abc-def><ghi_jkl>Other</ghi_jkl></abc-def>");
  // An exact parent exists, so do not use the fallback parent to find a child.
  const text = "<abc_def>\nExact\n</abc_def><abc-def><ghi-jkl>Old</ghi-jkl></abc-def>";
  assert.equal(replace(text, config), text);
});

test("literal hyphen configuration takes precedence over an underscore fallback", () => {
  for (const config of [
    '[abc_def]\nreplacement = "Fallback"\n[abc-def]\nreplacement = "Exact"',
    '[abc-def]\nreplacement = "Exact"\n[abc_def]\nreplacement = "Fallback"',
  ]) assert.equal(replace("<abc-def>Old</abc-def>", config), "<abc-def>\nExact\n</abc-def>");
  assert.equal(replace("<abc_def>Old</abc_def>", '[abc-def]\nreplacement = "New"'),
    "<abc_def>Old</abc_def>");
});

test("generic fallback works for the system-prompt tag without a special alias", () => {
  assert.equal(replace("<system-prompt><tools>Old</tools></system-prompt>",
    '[system_prompt.tools]\nreplacement = "New"'),
    "<system-prompt><tools>\nNew\n</tools></system-prompt>");
});

test("untagged text, unmatched tags, and case differences stay unchanged", () => {
  const text = "Plain text <One>Old</One><other>Old</other>";
  assert.equal(replace(text, '[one]\nreplacement = "New"'), text);
  assert.equal(replace("<one>Old</one>", "[one]"), "<one>Old</one>");
  assert.equal(replace("<unclosed>", ""), "<unclosed>");
});

test("repeated and same-name nested tags use their own paths", () => {
  assert.equal(replace("<one>A</one><one>B</one>", '[one]\nreplacement = "New"'),
    "<one>\nNew\n</one><one>\nNew\n</one>");
  assert.equal(replace("<one><one>A</one></one>", '[one.one]\nreplacement = "New"'),
    "<one><one>\nNew\n</one></one>");
});

test("replacement text is exact, may be empty, and is not scanned again", () => {
  assert.equal(replace("<one>\nOld\n</one>", '[one]\nreplacement = ""'), "");
  assert.equal(replace("<one>Old</one>", '[one]\nreplacement = "  New  "'), "<one>\n  New  \n</one>");
  assert.equal(replace("<one>Old</one>", '[one]\nreplacement = "<one>New</one> $&"'),
    "<one>\n<one>New</one> $&\n</one>");
  assert.equal(replace("<one>Old</one>", '[one]\nreplacement = """\nNew\ncontent\n"""'),
    "<one>\nNew\ncontent\n\n</one>");
});

test("parent replacements take precedence over child replacements", () => {
  assert.equal(replace("<one><two>Old</two></one><one><two>Again</two></one>",
    '[one.two]\nreplacement = "Child"\n[one]\nreplacement = "Parent"'),
    "<one>\nParent\n</one><one>\nParent\n</one>");
});

test("attributes and self-closing tags do not change ancestry", () => {
  assert.equal(replace('<one attr=">"><empty/><two data=\'x\'>Old</two></one>',
    '[one.two]\nreplacement = "New"'),
    '<one attr=">"><empty/><two data=\'x\'>\nNew\n</two></one>');
  assert.equal(replace("<one/><one>Old</one>", '[one]\nreplacement = "New"'),
    "<one/><one>\nNew\n</one>");
});

test("Markdown fences keep tag examples literal", () => {
  for (const fence of ["~~~", "```"]) {
    const text = fence + "\n<one>Example</one>\n<unclosed>\n" + fence + "\n<one>Old</one>";
    assert.equal(replace(text, '[one]\nreplacement = "New"'),
      fence + "\n<one>Example</one>\n<unclosed>\n" + fence + "\n<one>\nNew\n</one>");
  }
});

test("literal type notation does not stop replacements or change ancestry", () => {
  const config = '[one.two]\nreplacement = "New"';
  for (const text of [
    "Map<string> <one><two>Old</two></one>",
    "<one>Map<string> <two>Old</two></one>",
    "<one><two>Old Map<string></two></one>",
  ]) assert.equal(replace(text, config), text.replace(/<two>.*?<\/two>/, "<two>\nNew\n</two>"));
});

test("unmatched tags stay unchanged", () => {
  for (const text of ["<one>Old", "<one></two>", "</one>"])
    assert.equal(replace(text, '[one]\nreplacement = "New"'), text);
});

test("tag names have no special meaning and quoted path segments stay literal", () => {
  assert.equal(replace("<tools>Old</tools>", '[tools]\nreplacement = "New"'), "<tools>\nNew\n</tools>");
  assert.equal(replace("<replacement>Old</replacement>", '[replacement]\nreplacement = "New"'),
    "<replacement>\nNew\n</replacement>");
  assert.equal(replace("<one.two>Old</one.two>", '["one.two"]\nreplacement = "New"'),
    "<one.two>\nNew\n</one.two>");
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
  assert.deepEqual(result[0].sections, { arbitrary: "<one>\nNew\n</one>", empty: null });
  assert.equal(result[0].toolsAdded, toolsAdded);
  assert.equal(result[1].content, "<one>\nNew\n</one>");
  assert.deepEqual(result[2].content, [{ type: "text", text: "<one>\nNew\n</one>" }, toolCall]);
  assert.deepEqual(result[3].content, [image, { type: "text", text: "<one>\nNew\n</one>" }]);
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
    tools: "<tools>\nNew guidance\n</tools>",
    custom: "<one><two>\nNew nested text\n</two></one>",
  });
  assert.equal(result[0].toolsAdded, toolsAdded);
  assert.equal(result[1].content, "<tools>\nNew guidance\n</tools>");
  assert.deepEqual(result[2].content, [{ type: "text", text: "<one><two>\nNew nested text\n</two></one>" }]);
  assert.equal(result[3].content, messages[3].content);
  assert.deepEqual(messages, original);
});

test("refer captures exact original bodies and follows replacement precedence", () => {
  const saved: [string, string][] = [];
  const config = parseReplacements(
    '[system_prompt.docs]\nrefer = "Read $link and $link"\nlink = "~/docs/$&.md"\n' +
    '[system_prompt.docs.child]\nrefer = "Child"\nlink = "child.md"');
  const messages = [{ role: "system", sections: { docs: '<docs id="a">\n<child>Original</child>\n</docs>' } }];
  const before = structuredClone(messages);
  const result = replaceMessages(messages, config, (link, text) => saved.push([link, text]));
  assert.equal(result[0].sections.docs, '<docs id="a">\nRead ~/docs/$&.md and ~/docs/$&.md\n</docs>');
  assert.deepEqual(saved, [["~/docs/$&.md", "\n<child>Original</child>\n"]]);
  assert.deepEqual(messages, before);
  assert.throws(() => replaceMessages(messages, config), /reference writer/);
  assert.equal(replaceTags("<other>Text</other>", config), "<other>Text</other>");
});

test("refer supports repeated matches, body edges, and fenced examples", () => {
  const saved: string[] = [];
  const config = parseReplacements('[abc.preamble]\nrefer = "Read $link"\nlink = "start.md"');
  assert.equal(replaceTags("<abc>Before<child>C</child>After</abc><abc>Again</abc>", config,
    [], undefined, (_link, text) => saved.push(text)),
    "<abc>Read start.md<child>C</child>After</abc><abc>Read start.md</abc>");
  assert.deepEqual(saved, ["Before", "Again"]);
  saved.length = 0;
  const fenced = "\`\`\`\n<abc>Example</abc>\n\`\`\`";
  assert.equal(replaceTags(fenced, config, [], undefined, (_link, text) => saved.push(text)), fenced);
  assert.deepEqual(saved, []);
});
