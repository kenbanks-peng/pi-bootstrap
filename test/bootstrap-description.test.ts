import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, command } from "./session-fixture.ts";

test("commands show an escaped description line and output without execution details", async t => {
  const f = await fixture(t);
  await command(f.project, "example.toml", 'description = "Available <tools>&"\nexpression = \'"read\\nbash"\'\n');
  assert.equal(await f.repository.compose({ allTools: [], activeTools: [] }),
    '<bootstrap>\n<command>\nAvailable &lt;tools&gt;&amp;\nread\nbash\n</command>\n</bootstrap>');
});

test("command descriptions must be non-empty single-line strings", async t => {
  const f = await fixture(t);
  for (const description of ["", 'description = ""\n', 'description = "   "\n', "description = 42\n", 'description = "first\\nsecond"\n', 'description = "first\\rsecond"\n']) {
    await command(f.project, "example.toml", `${description}expression = '"ok"'\n`);
    await assert.rejects(f.repository.compose({ allTools: [], activeTools: [] }), /description must be a non-empty single-line string/);
  }
});
