import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Lookup, type Source } from "./src/lookup.ts";
import { applyStructured, applyTranscript, inventory, sectionNames, sectionText } from "./src/prompt.ts";

export function getConfigPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "extensions", "pi-bootstrap", "config.toml");
}

export default function bootstrap(pi: ExtensionAPI) {
  registerBootstrap(pi);
}

export function registerBootstrap(pi: ExtensionAPI, path = getConfigPath()) {
  const lookup = new Lookup(path);
  let sources: Source[] = [];
  let discoverIdentity = false;
  let notification = "";
  let metrics = "No submission measured.";
  let before: Record<string, number> = {};
  let hookMs = 0;
  const notify = (ctx: ExtensionContext) => {
    const report = lookup.report;
    const key = JSON.stringify(report);
    if (key === notification) return;
    if (!ctx.hasUI) return;
    notification = key;
    if (report.error) ctx.ui.notify("pi-bootstrap: " + report.error + ". Generated text is unchanged.", "warning");
    else if (report.missing.length || report.stale.length)
      ctx.ui.notify("pi-bootstrap: " + report.missing.length + " entries have no replacement; " +
        report.stale.length + " need review. Use /bootstrap.", "info");
  };
  pi.on("before_agent_start", async (event, ctx) => {
    const started = performance.now();
    sources = inventory(event, pi.getAllTools());
    await lookup.refresh(sources);
    before = Object.fromEntries(sectionNames.map(name => [name, Buffer.byteLength(sectionText(event.systemPrompt, name) ?? "")]));
    applyStructured(event, lookup);
    discoverIdentity = true;
    hookMs = performance.now() - started;
    notify(ctx);
  });
  pi.on("context_with_system", async (event, ctx) => {
    const started = performance.now();
    if (discoverIdentity) {
      discoverIdentity = false;
      const leading = event.messages[0];
      // An external application identity is not necessarily present in Pi's transcript.
      if (leading?.role === "system" && typeof leading.content === "string" && leading.content) {
        sources = [...sources, { path: ["system_prompt"], original: leading.content }];
        await lookup.refresh(sources);
        notify(ctx);
      }
    }
    const messages = applyTranscript(event.messages, lookup);
    const after: Record<string, string> = {};
    for (const message of messages) {
      if (message.role !== "system") continue;
      for (const [name, value] of Object.entries(message.sections ?? {})) {
        if (value === null) delete after[name];
        else after[name] = name === "preamble" ? value : sectionText(value, name) ?? value;
      }
    }
    metrics = sectionNames.map(name => name + ": " + (before[name] ?? 0) + " → " +
      Buffer.byteLength(after[name] ?? "") + " bytes").join("\n") +
      "\nSubmission hook: " + hookMs.toFixed(2) + " ms; transcript hook: " + (performance.now() - started).toFixed(2) + " ms.";
    return { messages };
  });
  pi.registerCommand("bootstrap", {
    description: "Show lookup location, review status, and measured prompt sizes",
    handler: async (_args, ctx) => {
      const report = lookup.report;
      const status = [
        lookup.path,
        report.error ? "Error: " + report.error : "",
        "No replacement:\n" + (report.missing.join("\n") || "(none)"),
        "Needs review:\n" + (report.stale.join("\n") || "(none)"),
        metrics,
        "Identity is editable only when present as leading system content.",
      ].filter(Boolean).join("\n\n");
      if (ctx.hasUI) await ctx.ui.select(status, ["Close"]);
    },
  });
}
