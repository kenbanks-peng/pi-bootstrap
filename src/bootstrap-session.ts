import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runBootstrapCommand } from "./bootstrap-command.js";
import { CommandSourceError } from "./bootstrap-protocol.js";
import { BootstrapRepository } from "./bootstrap-repository.js";
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
): () => string {
  let snapshot = "";
  let generation = 0;
  const clear = () => { snapshot = ""; return ++generation; };
  pi.on("session_shutdown", () => { clear(); });
  pi.on("session_start", async (_event, ctx) => {
    const current = clear();
    try {
      const composed = await repositoryFor(ctx.cwd).compose({
        allTools: pi.getAllTools(),
        activeTools: pi.getActiveTools(),
      });
      if (current === generation) snapshot = composed;
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
  return () => snapshot;
}
