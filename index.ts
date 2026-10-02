import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Lookup } from "./src/lookup.ts";
import { Mechanisms } from "./src/prompt.ts";

export function getConfigPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "extensions", "pi-bootstrap", "config.toml");
}
export default function bootstrap(pi: ExtensionAPI) { registerBootstrap(pi); }

const safeText = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,
  char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));

export function registerBootstrap(pi: ExtensionAPI, path = getConfigPath()) {
  const lookup = new Lookup(path);
  let mechanisms: Mechanisms | undefined;
  let definitionSnapshot = "";
  let notification = "";
  let metrics = "No submission measured.";
  let hookMs = 0;
  let beforeBytes = 0;
  const notify = (ctx: ExtensionContext) => {
    const unknown = mechanisms?.unidentified ?? [];
    const key = JSON.stringify({ ...lookup.report, unknown });
    if (!ctx.hasUI) return;
    ctx.ui.setStatus?.("pi-bootstrap", unknown.length
      ? "⚠ pi-bootstrap: " + unknown.length + " unidentified sections — /bootstrap" : undefined);
    if (key === notification) return;
    notification = key;
    if (lookup.report.error) ctx.ui.notify("pi-bootstrap: " + lookup.report.error + ". No new replacements applied.", "warning");
    else if (unknown.length) ctx.ui.notify(
      "pi-bootstrap: Unidentified startup content:\n" +
      unknown.map(u => safeText(u.location) + "\n" + safeText(u.text).slice(0, 200)).join("\n\n") +
      "\nUnchanged. Add a mechanism in " + path + ". Use /bootstrap for full text.", "warning");
    else if (lookup.report.missing.length)
      ctx.ui.notify("pi-bootstrap: " + lookup.report.missing.length + " entries have no replacement. Use /bootstrap.", "info");
  };
  pi.on("before_agent_start", async (event, ctx) => {
    const started = performance.now();
    mechanisms = undefined;
    beforeBytes = Buffer.byteLength(event.systemPrompt);
    try {
      const defaults = await readFile(new URL("./default.toml", import.meta.url), "utf8");
      const candidate: { engine?: Mechanisms } = {};
      await lookup.refresh(data => {
        candidate.engine = new Mechanisms(data);
        definitionSnapshot = JSON.stringify(data.mechanisms);
        return candidate.engine.discover("before_agent_start", {
          prompt: event.systemPrompt, options: event.systemPromptOptions, tools: pi.getAllTools(),
        });
      }, defaults);
      mechanisms = candidate.engine;
      if (lookup.valid) mechanisms?.applyOptions(event.systemPromptOptions, lookup);
    } catch (error) { lookup.invalidate(error); }
    hookMs = performance.now() - started;
    notify(ctx);
  });
  pi.on("context_with_system", async (event, ctx) => {
    const started = performance.now();
    let messages = event.messages;
    if (lookup.valid && mechanisms) {
      try {
        // Reuse this submission's bindings. New transcript-only content can now be identified.
        await lookup.refresh(data => {
          if (JSON.stringify(data.mechanisms) !== definitionSnapshot)
            throw new Error("Mechanisms changed during submission; submit again to use them");
          return mechanisms!.discover("context_with_system", { messages: event.messages });
        });
        if (lookup.valid) messages = mechanisms.applyTranscript(event.messages, lookup);
      } catch (error) { lookup.invalidate(error); }
    }
    const afterBytes = messages.reduce((total, message) => message.role !== "system" ? total :
      total + (typeof message.content === "string" ? Buffer.byteLength(message.content) : 0) +
      Object.values(message.sections ?? {}).reduce((sum, value) => sum + Buffer.byteLength(value ?? ""), 0), 0);
    metrics = "Startup prompt: " + beforeBytes + " bytes; outgoing system text: " + afterBytes + " bytes.\n" +
      "Submission hook: " + hookMs.toFixed(2) + " ms; transcript hook: " + (performance.now() - started).toFixed(2) + " ms.";
    notify(ctx);
    return { messages };
  });
  pi.registerCommand("bootstrap", {
    description: "Show TOML mechanisms, unidentified content, replacement status, and prompt sizes",
    handler: async (_args, ctx) => {
      const unknown = mechanisms?.unidentified ?? [];
      const status = [
        path,
        lookup.report.error ? "Error: " + lookup.report.error : "",
        "UNIDENTIFIED — unchanged; add mechanisms to config.toml:\n" +
          (unknown.map(u => safeText(u.location) + "\n" + safeText(u.text)).join("\n\n") || "(none)"),
        "No replacement:\n" + (lookup.report.missing.join("\n") || "(none)"),
        metrics,
      ].filter(Boolean).join("\n\n");
      if (ctx.hasUI) await ctx.ui.select(status, ["Close"]);
    },
  });
}
