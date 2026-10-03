import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBootstrap } from "../index.ts";

test("arbitrary nested tags retain their request containers in all roles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-generic-"));
  const path = join(dir, "config.toml");
  const handlers = new Map<string, Function>();
  registerBootstrap({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: () => {},
  } as unknown as ExtensionAPI, path);
  try {
    await writeFile(path, '[system-prompt.one.two]\nreplacement = "New text."\n[messages.message.one.two]\nreplacement = "New text."\n');
    const text = "<one><two>section text</two></one>";
    const toolsAdded = [{ name: "read", parameters: { type: "object" } }];
    const messages = ["system", "user", "assistant", "toolResult"].map(role => ({ role, content: text, toolsAdded }));
    const result = (await handlers.get("context_with_system")!({ messages }, { hasUI: false })).messages;
    for (const message of result) {
      assert.equal(message.content, "<one><two>New text.</two></one>");
      assert.equal(message.toolsAdded, toolsAdded);
    }
    for (const message of messages) assert.equal(message.content, text);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
