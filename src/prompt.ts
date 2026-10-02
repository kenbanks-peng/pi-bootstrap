import type { BeforeAgentStartEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { Lookup, Source } from "./lookup.ts";

export const sectionNames = ["preamble", "tools", "rules", "docs", "skills", "cwd"] as const;
const sectionPath = (name: string) => ["message3", name];
const toolPath = (name: string, kind: string) => ["message3", "tools", "entries", name, kind];
const skillPath = (name: string) => ["message3", "skills", "entries", name];
export function sectionText(prompt: string, name: string): string | undefined {
  if (name === "preamble") {
    const tags = [...prompt.matchAll(/^<[a-z][a-z0-9_-]*>\n/gm)];
    return prompt.slice(0, tags[0]?.index ?? prompt.length).trimEnd();
  }
  const start = prompt.indexOf("<" + name + ">\n");
  const end = prompt.lastIndexOf("\n</" + name + ">");
  return start < 0 || end < start ? undefined : prompt.slice(start + name.length + 3, end);
}
export function inventory(event: BeforeAgentStartEvent, tools: ToolInfo[]): Source[] {
  const options = event.systemPromptOptions;
  const sources: Source[] = [];
  for (const name of sectionNames) {
    const text = sectionText(event.systemPrompt, name);
    if (text !== undefined) sources.push({ path: sectionPath(name), original: text });
  }
  const snippets = { ...Object.fromEntries(tools.map(t => [t.name, t.description])), ...options.toolSnippets };
  const guidelines = { ...Object.fromEntries(tools.map(t => [t.name, t.promptGuidelines ?? []])), ...options.toolGuidelines };
  for (const [name, text] of Object.entries(snippets))
    sources.push({ path: toolPath(name, "snippet"), original: text });
  for (const [name, rules] of Object.entries(guidelines))
    sources.push({ path: toolPath(name, "guidelines"), original: rules });
  sources.push({ path: ["message3", "rules", "prompt_guidelines"], original: options.promptGuidelines });
  for (const skill of options.skills)
    sources.push({ path: skillPath(skill.name), original: skill.description });
  return sources;
}
export function applyStructured(event: BeforeAgentStartEvent, lookup: Lookup): void {
  if (!lookup.valid) return;
  const options = event.systemPromptOptions;
  for (const name of sectionNames) {
    if (name === "preamble") continue; // customPrompt would disable generated tools/rules/docs.
    const original = sectionText(event.systemPrompt, name);
    if (original === undefined) continue;
    const replacement = lookup.replacement(sectionPath(name));
    if (replacement !== undefined) options.sections[name] = replacement;
  }
  if (!lookup.configured(sectionPath("tools"))) {
    for (const name of Object.keys(options.toolSnippets)) {
      const replacement = lookup.replacement(toolPath(name, "snippet"));
      if (replacement !== undefined) options.toolSnippets[name] = replacement;
    }
  }
  if (!lookup.configured(sectionPath("rules")) && !lookup.configured(sectionPath("tools"))) {
    for (const name of Object.keys(options.toolGuidelines)) {
      const replacement = lookup.replacement<string[]>(toolPath(name, "guidelines"));
      if (replacement !== undefined) options.toolGuidelines[name] = replacement;
    }
  }
  if (!lookup.configured(sectionPath("rules"))) {
    const replacement = lookup.replacement<string[]>(["message3", "rules", "prompt_guidelines"]);
    if (replacement !== undefined) options.promptGuidelines = replacement;
  }
  if (!lookup.configured(sectionPath("skills"))) {
    options.skills = options.skills.map(skill => ({
      ...skill, description: lookup.replacement(skillPath(skill.name)) ?? skill.description,
    }));
  }
}

export interface TranscriptMessage {
  role: string;
  content?: unknown;
  sections?: Record<string, string | null>;
}
/** Touch only editable system text. User/prime messages and tool declarations retain identity. */
export function applyTranscript<T extends TranscriptMessage>(messages: T[], lookup: Lookup): T[] {
  if (!lookup.valid) return messages;
  return messages.map((message, index) => {
    if (message.role !== "system") return message;
    let copy = message;
    if (index === 0 && typeof message.content === "string" && message.content) {
      const replacement = lookup.replacement(["system_prompt"]);
      if (replacement !== undefined) copy = { ...copy, content: replacement };
    }
    if (message.sections?.preamble != null) {
      const replacement = lookup.replacement(sectionPath("preamble"));
      if (replacement !== undefined) copy = { ...copy, sections: { ...message.sections, preamble: replacement } };
    }
    return copy;
  });
}
