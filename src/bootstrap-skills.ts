import { Type } from "typebox";
import type { ContextWithSystemEvent, ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

export type SkillMetadata = Pick<Skill, "name" | "description" | "filePath" | "baseDir">;
export type SkillPromptTransform = (messages: ContextWithSystemEvent["messages"]) => ContextWithSystemEvent["messages"];

const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
export function skillCatalog(skills: readonly Skill[]): SkillMetadata[] {
  const unique = new Map<string, SkillMetadata>();
  for (const skill of skills) {
    if (skill.disableModelInvocation || unique.has(skill.name)) continue;
    const { name, description, filePath, baseDir } = skill;
    unique.set(name, { name, description, filePath, baseDir });
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function score(skill: SkillMetadata, query: string, terms: string[]): number {
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  const nameWords = tokens(name);
  const descriptionWords = tokens(description);
  let rank = name === query ? 100 : name.includes(query) ? 40 : 0;
  for (const term of terms) {
    rank += nameWords.includes(term) ? 8 : name.includes(term) ? 4 : 0;
    rank += descriptionWords.includes(term) ? 2 : description.includes(term) ? 1 : 0;
  }
  return rank;
}

/** Search discovered metadata; command files own the skill prompt text. */
export function registerLazySkills(pi: ExtensionAPI): SkillPromptTransform {
  let catalog: SkillMetadata[] = [];
  const clear = () => { catalog = []; };
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);

  pi.on("before_agent_start", event => {
    const options = event.systemPromptOptions;
    catalog = skillCatalog(options.skills);
    // Pi supplies fresh resource metadata for each run. Do not alter the resources
    // themselves: explicit /skill:name commands must continue to work.
    options.skills = [];
    options.sections.skills = "";
  });

  pi.registerTool({
    name: "skill_search",
    label: "Skill search",
    description: "Find skills by name or task keywords. Returns names, descriptions, SKILL.md paths, and base directories. Use read to load the selected instructions.",
    promptSnippet: "Find skill descriptions and paths by name or task keywords",
    exposure: "direct",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Skill name or task keywords" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results (default 5)" })),
    }),
    async execute(_id, { query, limit = 5 }) {
      const normalized = query.trim().toLowerCase();
      const terms = [...new Set(tokens(normalized))];
      if (!terms.length) throw new Error("Use a skill name or task keywords.");
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Skill search limit must be an integer from 1 to 20.");
      const ranked = catalog.map(skill => ({ skill, rank: score(skill, normalized, terms) }))
        .filter(match => match.rank > 0)
        .sort((a, b) => b.rank - a.rank || a.skill.name.localeCompare(b.skill.name));
      const matches = ranked.slice(0, limit).map(match => ({ ...match.skill }));
      const text = matches.length
        ? JSON.stringify(matches, null, 2) + "\nRead the selected filePath. Resolve supporting files against baseDir."
        : "No matching skills. Try another skill name or task keywords.";
      return { content: [{ type: "text", text }], details: { matches, total: ranked.length } };
    },
  });

  // Remove full catalogs from earlier request-copy system sections. The
  // configured section command supplies the replacement. Never change history.
  return messages => messages.map(message => {
    if (message.role !== "system" || !message.sections || typeof message.sections.skills !== "string") return message;
    return {
      ...message,
      sections: { ...message.sections, skills: null },
    };
  });
}
