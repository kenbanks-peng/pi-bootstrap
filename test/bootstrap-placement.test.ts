import assert from "node:assert/strict";
import { test } from "node:test";
import { registerBootstrap } from "../index.ts";
import { fixture } from "./session-fixture.ts";

test("bootstrap follows current sections and later system text while tool deltas stay in place", async t => {
  const f = await fixture(t);
  let handler: any;
  registerBootstrap({ on: (_name: string, fn: any) => { handler = fn; } } as never, () => f.repository,
    () => '<commands>\n  <command>First command\none</command>\n  <command>Second command\ntwo</command>\n</commands>');
  const toolsAdded = [{ name: "read" }];
  const toolsRemoved = [{ name: "bash" }];
  const messages = [
    { role: "system", content: [{ type: "text", text: "Base" }], sections: { rules: "Old rules", cwd: "Workspace", obsolete: "Remove" }, toolsAdded, timestamp: 0 },
    { role: "user", content: "Question", timestamp: 1 },
    { role: "system", content: "Later instructions", sections: { rules: "Current rules", obsolete: null, skills: "New skills" }, toolsRemoved, timestamp: 2 },
  ];
  const before = structuredClone(messages);
  const result = await handler({ messages }, { cwd: f.projectRoot });
  assert.equal(result.messages[0].content,
    'Base\n\nLater instructions\n\nCurrent rules\n\nWorkspace\n\nNew skills\n\n<commands>\n  <command>First command\none</command>\n  <command>Second command\ntwo</command>\n</commands>');
  assert.equal(result.messages[0].sections, undefined);
  assert.equal(result.messages[0].toolsAdded, toolsAdded);
  assert.deepEqual(result.messages[1], messages[1]);
  assert.equal(result.messages[2].toolsRemoved, toolsRemoved);
  assert.equal(result.messages[2].content, "");
  assert.equal(result.messages[2].sections, undefined);
  assert.equal(result.messages[2].timestamp, 2);
  assert.deepEqual(messages, before);
  assert.deepEqual(await handler({ messages }, { cwd: f.projectRoot }), result);
});

test("an empty bootstrap does not fold system sections or patches", async t => {
  const f = await fixture(t);
  let handler: any;
  registerBootstrap({ on: (_name: string, fn: any) => { handler = fn; } } as never, () => f.repository, () => "");
  const messages = [
    { role: "system", content: "Base", sections: { rules: "Rules" } },
    { role: "user", content: "Question" },
    { role: "system", content: "", sections: { rules: "New rules" } },
  ];
  assert.deepEqual((await handler({ messages }, { cwd: f.projectRoot })).messages, messages);
});
