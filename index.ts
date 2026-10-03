import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseReplacements, replaceMessages, replaceTags } from "./src/replace.ts";
import { getBootstrapDirectory } from "./src/bootstrap-paths.ts";
import { registerBootstrapSession } from "./src/bootstrap-session.ts";

export function getConfigPath(): string {
  return join(getBootstrapDirectory(), "config.toml");
}

export default function bootstrap(pi: ExtensionAPI) {
  const snapshot = registerBootstrapSession(pi);
  registerBootstrap(pi, getConfigPath(), snapshot);
}

export function registerBootstrap(pi: ExtensionAPI, path = getConfigPath(), snapshot: () => string = () => "") {
  pi.on("context_with_system", async event => {
    let config: string;
    try {
      config = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(dirname(path), { recursive: true });
      try {
        await copyFile(fileURLToPath(new URL("./default.toml", import.meta.url)), path, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      config = await readFile(path, "utf8");
    }
    const references = new Map<string, string>();
    const replacements = parseReplacements(config);
    const saveReference = (link: string, text: string) => {
      const target = link === "~" ? homedir() : link.startsWith("~/")
        ? join(homedir(), link.slice(2)) : resolve(dirname(path), link);
      references.set(target, text);
    };
    const messages = replaceMessages(event.messages, replacements, saveReference);
    // Bootstrap has no independent system preamble/postamble. Explicit bootstrap
    // paths still work, but broad prompt-edge rules cannot eat this snapshot.
    const bootstraps = replaceTags(snapshot(), replacements, ["system-prompt"], [], saveReference);
    for (const [target, text] of references) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
    }
    // Inject last: broad prompt replacements/references must not consume the snapshot.
    // Pi serializes system content + sections as the system-prompt body, not a message.
    if (bootstraps) {
      const first = messages[0];
      if (!first || first.role !== "system") {
        throw new Error("Bootstrap injection requires a leading system message");
      }
      messages[0] = {
        ...first,
        content: typeof first.content === "string"
          ? [first.content, bootstraps].filter(Boolean).join("\n\n")
          : [...first.content, { type: "text", text: bootstraps }],
      };
    }
    return { messages };
  });
}
