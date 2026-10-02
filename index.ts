import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Lookup } from "./src/lookup.ts";
import { Mechanisms, type TranscriptMessage } from "./src/prompt.ts";

export function getConfigPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "extensions", "pi-bootstrap", "config.toml");
}
export default function bootstrap(pi: ExtensionAPI) { registerBootstrap(pi); }

const safeText = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,
  char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
const textBytes = (messages: TranscriptMessage[]) => messages.reduce((total, message) => {
  const content = typeof message.content === "string" ? message.content :
    Array.isArray(message.content) ? message.content.map(block => block.type === "text" ? block.text : "").join("") : "";
  return total + Buffer.byteLength(content) +
    Object.values(message.sections ?? {}).reduce((sum, value) => sum + Buffer.byteLength(value ?? ""), 0);
}, 0);

export function registerBootstrap(pi: ExtensionAPI, path = getConfigPath()) {
  const lookup = new Lookup(path);
  let mechanisms: Mechanisms | undefined;
  let notification = "";
  let metrics = "No request measured.";
  const notify = (ctx: ExtensionContext) => {
    const unknown = mechanisms?.unidentified ?? [];
    const key = JSON.stringify({ ...lookup.report, unknown });
    if (!ctx.hasUI) return;
    ctx.ui.setStatus?.("pi-bootstrap", lookup.report.error || unknown.length
      ? "⚠ pi-bootstrap — /bootstrap" : undefined);
    if (key === notification) return;
    notification = key;
    if (lookup.report.error) ctx.ui.notify("pi-bootstrap: " + lookup.report.error + ". No replacements applied.", "warning");
    else if (unknown.length) ctx.ui.notify(
      "pi-bootstrap: Unidentified system context remains unchanged. Use /bootstrap.", "warning");
    else if (lookup.report.missing.length)
      ctx.ui.notify("pi-bootstrap: " + lookup.report.missing.length + " entries have no replacement. Use /bootstrap.", "info");
  };
  pi.on("context_with_system", async (event, ctx) => {
    const started = performance.now();
    const beforeBytes = textBytes(event.messages);
    let messages = event.messages;
    mechanisms = undefined;
    try {
      const defaults = await readFile(new URL("./default.toml", import.meta.url), "utf8");
      const candidate: { engine?: Mechanisms } = {};
      await lookup.refresh(data => {
        candidate.engine = new Mechanisms(data);
        return candidate.engine.discover(event.messages);
      }, defaults);
      mechanisms = candidate.engine;
      if (lookup.valid && mechanisms) messages = mechanisms.applyTranscript(event.messages, lookup);
    } catch (error) { lookup.invalidate(error); }
    metrics = "Request context text: " + beforeBytes + " → " + textBytes(messages) + " bytes.\n" +
      "Context hook: " + (performance.now() - started).toFixed(2) + " ms.";
    notify(ctx);
    return { messages };
  });
  pi.registerCommand("bootstrap", {
    description: "Show bootstrap context discovery, replacement status, and text sizes",
    handler: async (_args, ctx) => {
      const unknown = mechanisms?.unidentified ?? [];
      const status = [
        path,
        lookup.report.error ? "Error: " + lookup.report.error : "",
        "UNIDENTIFIED — unchanged:\n" +
          (unknown.map(u => safeText(u.location) + "\n" + safeText(u.text)).join("\n\n") || "(none)"),
        "No replacement:\n" + (lookup.report.missing.join("\n") || "(none)"),
        metrics,
      ].filter(Boolean).join("\n\n");
      if (ctx.hasUI) await ctx.ui.select(status, ["Close"]);
    },
  });
}
