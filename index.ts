import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseReplacements, replaceMessages, replaceTags } from "./src/replace.ts";
import { getBootstrapDirectory } from "./src/bootstrap-paths.ts";
import { registerBootstrapSession } from "./src/bootstrap-session.ts";
import { registerToolGuidance } from "./src/bootstrap-guidance.ts";
import { registerLazySkills, type SkillPromptTransform } from "./src/bootstrap-skills.ts";

export function getConfigPath(): string {
  return join(getBootstrapDirectory(), "config.toml");
}

export default function bootstrap(pi: ExtensionAPI) {
  registerToolGuidance(pi);
  const snapshot = registerBootstrapSession(pi);
  const transformSkills = registerLazySkills(pi);
  registerBootstrap(pi, getConfigPath(), snapshot, transformSkills);
}

export function registerBootstrap(pi: ExtensionAPI, path = getConfigPath(), snapshot: () => string = () => "",
  transformSkills: SkillPromptTransform = messages => messages) {
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
    const messages = replaceMessages(transformSkills(event.messages), replacements, saveReference);
    // Bootstrap has no independent system preamble/postamble. Explicit bootstrap
    // paths still work, but broad prompt-edge rules cannot eat this snapshot.
    const bootstraps = replaceTags(snapshot(), replacements, ["system-prompt"], [], saveReference);
    for (const [target, text] of references) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text, "utf8");
    }
    // Inject after replacements and after replaying prompt sections. Pi renders
    // content before sections, so appending to content alone is not the prompt tail.
    if (bootstraps) {
      const first = messages[0];
      if (!first || first.role !== "system") {
        throw new Error("Bootstrap injection requires a leading system message");
      }
      const { sections: _initialSections, ...initialMetadata } = first;
      const content: string[] = [];
      const sections = new Map<string, string>();
      for (const [index, message] of messages.entries()) {
        if (message.role !== "system") continue;
        const text = typeof message.content === "string"
          ? message.content
          : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
        if (text) content.push(text);
        for (const [name, value] of Object.entries(message.sections ?? {})) {
          if (value === null) sections.delete(name);
          else sections.set(name, value);
        }
        // Keep system/tool delta positions and metadata, but fold their prompt
        // text into the leading message so every adapter gets the same prompt tail.
        const { sections: _sections, ...metadata } = message;
        messages[index] = { ...metadata, content: "" };
      }
      messages[0] = {
        ...initialMetadata,
        content: [...content, ...sections.values(), bootstraps].filter(Boolean).join("\n\n"),
      };
    }
    return { messages };
  });
}
