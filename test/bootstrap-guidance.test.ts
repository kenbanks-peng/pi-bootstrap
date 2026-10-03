import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import bootstrap from "../index.ts";

function fixture(initial: ToolInfo[]) {
  let tools = initial;
  let registered: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  bootstrap({
    on() {},
    registerCommand() {},
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) {
      if (tool.name === "getToolGuidance") registered = tool;
    },
    getAllTools: () => tools,
  } as unknown as ExtensionAPI);
  assert.ok(registered, "extension must register getToolGuidance");
  return {
    tool: registered,
    setTools: (next: ToolInfo[]) => { tools = next; },
    execute: (name: string) => registered!.execute("test", { name }, undefined, undefined, {} as never),
  };
}

test("getToolGuidance returns metadata for a configured inactive tool", async () => {
  const f = fixture([{ name: "read", promptGuidelines: ["Use read to examine files."] } as ToolInfo]);
  const result = await f.execute("read");
  assert.deepEqual(result.content, [{ type: "text", text: "Use read to examine files." }]);
  assert.equal(result.structuredContent, undefined);
  assert.equal(f.tool.annotations?.readOnlyHint, true);
  assert.equal(f.tool.outputSchema, undefined);
});

test("getToolGuidance returns empty text when metadata is absent", async () => {
  const f = fixture([{ name: "plain", description: "Description is not guidance." } as ToolInfo]);
  assert.deepEqual((await f.execute("plain")).content, [{ type: "text", text: "" }]);
});

test("getToolGuidance rejects unknown names and requires exact names", async () => {
  const f = fixture([{ name: "read" } as ToolInfo]);
  for (const name of ["missing", "READ", " read", ""]) {
    await assert.rejects(f.execute(name), /Unknown tool/);
  }
});

test("getToolGuidance uses current metadata and joins guidelines with newlines", async () => {
  const f = fixture([{ name: "read", promptGuidelines: ["Original"] } as ToolInfo]);
  assert.deepEqual((await f.execute("read")).content, [{ type: "text", text: "Original" }]);
  f.setTools([{ name: "read", promptGuidelines: ["Updated", "Second guideline"] } as ToolInfo]);
  assert.deepEqual((await f.execute("read")).content, [{ type: "text", text: "Updated\nSecond guideline" }]);
});
