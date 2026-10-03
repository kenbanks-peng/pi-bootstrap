import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Read the current tool registry, not the session bootstrap snapshot. */
export function registerToolGuidance(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "getToolGuidance",
    label: "Tool guidance",
    description: "Get prompt guidance metadata for a configured tool by its exact name, including inactive tools. Returns only guidance text, with guidelines separated by newlines. Returns empty text if the tool has no metadata. Does not include the tool description or global prompt rules.",
    exposure: "direct",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({
      name: Type.String({ minLength: 1, description: "Exact registered tool name" }),
    }),
    async execute(_id, { name }) {
      const tool = pi.getAllTools().find(tool => tool.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return {
        content: [{ type: "text", text: (tool.promptGuidelines ?? []).join("\n") }],
        details: {},
      };
    },
  });
}
