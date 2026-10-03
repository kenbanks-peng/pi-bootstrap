import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseReplacements, replaceMessages } from "./src/replace.ts";

export function getConfigPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    "extensions", "pi-bootstrap", "config.toml");
}

export default function bootstrap(pi: ExtensionAPI) {
  registerBootstrap(pi);
}

export function registerBootstrap(pi: ExtensionAPI, path = getConfigPath()) {
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
    const messages = replaceMessages(event.messages, parseReplacements(config), (link, text) => {
      const target = link === "~" ? homedir() : link.startsWith("~/")
        ? join(homedir(), link.slice(2)) : resolve(dirname(path), link);
      references.set(target, text);
    });
    for (const [target, text] of references) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
    }
    return { messages };
  });
}
