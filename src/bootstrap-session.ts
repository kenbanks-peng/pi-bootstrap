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

export function registerBootstrapSession(
  pi: ExtensionAPI,
  repositoryFor: (cwd: string) => BootstrapRepository = createBootstrapRepository,
): void {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const bootstraps = await repositoryFor(ctx.cwd).compose();
      if (!bootstraps) return;

      pi.sendMessage({
        customType: "bootstrap_session",
        content: bootstraps,
        display: false,
      });
    } catch (error) {
      if (error instanceof CommandSourceError) {
        if (error.exitCode !== undefined) {
          ctx.ui.notify(`${error.sourceName} returned error code ${error.exitCode}.`);
        } else {
          ctx.ui.notify(`${error.sourceName} had an error.`, "error");
        }
        return;
      }
      throw error;
    }
  });

  pi.on("context", (event) => {
    const bootstrapMessages = event.messages.filter(
      (message) => message.role === "custom" && message.customType === "bootstrap_session",
    );
    if (bootstrapMessages.length === 0) return;

    return {
      messages: [
        ...bootstrapMessages,
        ...event.messages.filter(
          (message) => message.role !== "custom" || message.customType !== "bootstrap_session",
        ),
      ],
    };
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
}
