import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runBootstrapCommand } from "./bootstrap-command.js";
import { evaluateExpression, type BootstrapExpressionContext } from "./bootstrap-expression.js";
import { COMMAND_TIMEOUT_MS, COMMAND_OUTPUT_LIMIT_BYTES, CommandSourceError, type BootstrapSessionEntry } from "./bootstrap-protocol.js";
import { BootstrapRepository, formatSnapshot } from "./bootstrap-repository.js";
import { skillCatalog } from "./bootstrap-skills.js";
import { getBootstrapDirectory } from "./bootstrap-paths.js";

export function createBootstrapRepository(cwd: string, home = homedir(), agentDirectory = process.env.PI_CODING_AGENT_DIR): BootstrapRepository {
  return new BootstrapRepository({
    globalDirectory: getBootstrapDirectory(home, agentDirectory),
    projectDirectory: join(cwd, ".agents", "bootstrap"),
  });
}

/** A runtime-local snapshot, never a persisted conversation message. */
export function registerBootstrapSession(
  pi: ExtensionAPI,
  repositoryFor: (cwd: string) => BootstrapRepository = createBootstrapRepository,
): (() => string) & { sections: () => Record<string, string> } {
  let snapshot = "";
  let sections: Record<string, string> = {};
  let pending: BootstrapSessionEntry[] = [];
  let expressionContext: BootstrapExpressionContext = { allTools: [], activeTools: [] };
  let generation = 0;
  const clear = () => { snapshot = ""; sections = {}; pending = []; return ++generation; };
  pi.on("session_shutdown", () => { clear(); });
  pi.on("session_start", async (_event, ctx) => {
    const current = clear();
    try {
      expressionContext = JSON.parse(JSON.stringify({ allTools: pi.getAllTools(), activeTools: pi.getActiveTools() }));
      const composed = await repositoryFor(ctx.cwd).composeSnapshot(expressionContext);
      if (current === generation) {
        snapshot = composed.bootstrap;
        sections = composed.sections;
        pending = composed.entries.some(entry => "deferred" in entry && entry.deferred) ? composed.entries : [];
      }
    } catch (error) {
      if (current !== generation) return;
      if (error instanceof CommandSourceError) {
        if (error.exitCode !== undefined) {
          ctx.ui.notify(`${error.sourceName} returned error code ${error.exitCode}.`);
        } else {
          ctx.ui.notify(`${error.sourceName} had an error: ${error.message}`, "error");
        }
        return;
      }
      throw error;
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!pending.length) return;
    const current = generation;
    const entries = pending;
    pending = [];
    const data = { ...expressionContext, allSkills: skillCatalog(event.systemPromptOptions.skills) };
    try {
      const resolved: BootstrapSessionEntry[] = [];
      for (const entry of entries) {
        if (entry.type === "command" && "expression" in entry && entry.deferred) {
          const { deferred: _, sourceName = "skill expression", ...source } = entry;
          try {
            resolved.push({ ...source, output: await evaluateExpression(entry.expression, data, sourceName, COMMAND_TIMEOUT_MS, COMMAND_OUTPUT_LIMIT_BYTES) });
          } catch (error) {
            throw new CommandSourceError(sourceName, error instanceof Error ? error.message : String(error));
          }
        } else resolved.push(entry);
      }
      if (current === generation) {
        const composed = formatSnapshot(resolved);
        snapshot = composed.bootstrap;
        sections = composed.sections;
      }
    } catch (error) {
      if (current === generation) { snapshot = ""; sections = {}; }
      if (current !== generation) return;
      if (error instanceof CommandSourceError) ctx.ui?.notify(`${error.sourceName} had an error: ${error.message}`, "error");
      throw error;
    }
  });

  pi.registerCommand("bootstrap", {
    description: "Manage Bootstrap memories and commands; injection requires a matching protocol.toml rule",
    handler: async (args, ctx) => {
      await runBootstrapCommand(args, repositoryFor(ctx.cwd), {
        hasUI: ctx.hasUI,
        editor: ctx.ui.editor.bind(ctx.ui),
        notify: ctx.ui.notify.bind(ctx.ui),
      });
    },
  });
  return Object.assign(() => snapshot, { sections: () => ({ ...sections }) });
}
