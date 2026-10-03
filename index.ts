import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { replaceMessages, replaceTags } from "./src/replace.ts";
import { createBootstrapRepository, registerBootstrapSession } from "./src/bootstrap-session.ts";
import { registerToolGuidance } from "./src/bootstrap-guidance.ts";
import { registerLazySkills, type SkillPromptTransform } from "./src/bootstrap-skills.ts";

export default function bootstrap(pi: ExtensionAPI) {
  registerToolGuidance(pi);
  const snapshot = registerBootstrapSession(pi);
  const transformSkills = registerLazySkills(pi);
  registerBootstrap(pi, createBootstrapRepository, snapshot, transformSkills, snapshot.sections);
}

export function registerBootstrap(pi: ExtensionAPI, repositoryFor = createBootstrapRepository, snapshot: () => string = () => "",
  transformSkills: SkillPromptTransform = messages => messages,
  snapshotSections: () => Record<string, string> = () => ({})) {
  pi.on("context_with_system", async (event, ctx) => {
    const replacements = await repositoryFor(ctx.cwd).loadActions();
    const references = new Map<string, string>();
    const saveReference = (target: string, text: string) => { references.set(target, text); };
    const sections = snapshotSections();
    if (Object.keys(sections).length && event.messages[0]?.role !== "system") {
      throw new Error("Section injection requires a leading system message");
    }
    const patches: Record<string, string> = {};
    const generated = new Map<string, string>();
    for (const [key, body] of Object.entries(sections)) {
      const path = JSON.parse(key) as string[];
      const name = path[1];
      if (path.length === 2 && path[0].replaceAll("_", "-") === "system-prompt" &&
        !["preamble", "postamble", "memory", "commands"].includes(name)) {
        patches[name] = `<${name}>\n${body}\n</${name}>`;
      } else generated.set(key, body);
    }
    const prepared = replaceMessages(transformSkills(event.messages).map((message, index) => {
      if (message.role !== "system" || !Object.keys(patches).length) return message;
      const current = Object.fromEntries(Object.entries(patches)
        .filter(([name]) => index === 0 || name in (message.sections ?? {})));
      return { ...message, sections: { ...message.sections, ...current } };
    }), generated);

    const messages = replaceMessages(prepared, replacements, saveReference);
    // Bootstrap has no independent system preamble/postamble. Explicit memory/commands
    // paths still work, but broad prompt-edge rules cannot eat this snapshot.
    const generatedBootstrap = replaceTags(snapshot(), generated, ["system-prompt"], []);
    const bootstraps = replaceTags(generatedBootstrap, replacements, ["system-prompt"], [], saveReference);
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
