import { Type } from "typebox";
import { getBootstrapDirectory } from "./bootstrap-paths.ts";
import { defaultRerankingConfig, loadRerankingConfig } from "./bootstrap-skills-reranking-config.ts";
import { createJevAdapter } from "./bootstrap-skills-jev.ts";
import { buildRerankingRequest, SkillRerankingRuntime } from "./bootstrap-skills-reranking-runtime.ts";
import type { SkillRerankingAdapter } from "./bootstrap-skills-reranking.ts";
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
export function registerLazySkills(pi: ExtensionAPI, dependencies: {
  globalDirectory?: string;
  adapterFor?: (credential: string) => SkillRerankingAdapter;
  credential?: () => string | undefined;
  diagnostic?: (message: string) => void;
} = {}): SkillPromptTransform {
  let catalog: SkillMetadata[] = [];
  let config = defaultRerankingConfig;
  let credential: string | undefined;
  let epoch = 0;
  const runtime = new SkillRerankingRuntime();
  const clear = () => { epoch++; catalog = []; config = defaultRerankingConfig; credential = undefined; runtime.clear(); };
  pi.on("session_start", async () => {
    clear();
    const current = epoch;
    const loaded = await loadRerankingConfig(dependencies.globalDirectory ?? getBootstrapDirectory(), dependencies.diagnostic ?? (message => console.warn(message)));
    if (current !== epoch) return;
    config = loaded;
    tool.annotations.openWorldHint = config.enabled && !!config.model;
    pi.registerTool(tool);
  });
  pi.on("session_shutdown", () => { clear(); tool.annotations.openWorldHint = false; });

  pi.on("before_agent_start", event => {
    const options = event.systemPromptOptions;
    catalog = skillCatalog(options.skills);
    runtime.snapshot(catalog, config, credential);
    // Pi supplies fresh resource metadata for each run. Do not alter the resources
    // themselves: explicit /skill:name commands must continue to work.
    options.skills = [];
    options.sections.skills = "";
  });

  const tool = {
    name: "skill_search",
    label: "Skill search",
    description: "Find skills by name or task keywords. Returns names, descriptions, SKILL.md paths, and base directories. Use read to load the selected instructions.",
    promptSnippet: "Find skill descriptions and paths by name or task keywords",
    exposure: "direct" as const,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Skill name or task keywords" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results (default 5)" })),
    }),
    async execute(_id: string, { query, limit = 5 }: { query: string; limit?: number }, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const normalized = query.trim().toLowerCase();
      const terms = [...new Set(tokens(normalized))];
      if (!terms.length) throw new Error("Use a skill name or task keywords.");
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Skill search limit must be an integer from 1 to 20.");
      const snapshot = catalog;
      const allRanked = snapshot.map(skill => ({ skill, rank: score(skill, normalized, terms) }))
        .sort((a, b) => b.rank - a.rank || a.skill.name.localeCompare(b.skill.name));
      const ranked = allRanked.filter(match => match.rank > 0);
      let selected = ranked.map(match => match.skill);
      credential = config.enabled && config.model ? (dependencies.credential ?? (() => process.env.TYPESAFE_API_KEY))()?.trim() || undefined : undefined;
      runtime.snapshot(snapshot, config, credential);
      if (config.enabled && config.model && credential && snapshot.length && !snapshot.some(skill => skill.name.toLowerCase() === normalized)) {
        const request = buildRerankingRequest(normalized, allRanked.map(match => match.skill), config);
        if (request) {
          const requestCredential = credential;
          const version = runtime.version;
          // The adapter receives only fresh bounded metadata, never local paths or prompt state.
          const decision = await runtime.search(request, config, {
            rerank: (payload, options) => (dependencies.adapterFor ?? createJevAdapter)(requestCredential).rerank(payload, options),
          }, signal);
          signal?.throwIfAborted();
          if (version !== runtime.version) throw new Error("Skill search state changed.");
          if (decision.kind === "no-match") selected = [];
          else if (decision.kind === "matches") {
            const localByName = new Map(snapshot.map(skill => [skill.name, skill]));
            const localById = new Map(request.candidates.map(candidate => [candidate.id, localByName.get(candidate.name)!]));
            selected = decision.ids.map(id => localById.get(id)!);
          }
        }
      }
      const matches = selected.slice(0, limit).map(skill => ({ ...skill }));
      const text = matches.length
        ? JSON.stringify(matches, null, 2) + "\nRead the selected filePath. Resolve supporting files against baseDir."
        : "No matching skills. Try another skill name or task keywords.";
      return { content: [{ type: "text" as const, text }], details: { matches, total: selected.length } };
    },
  };
  pi.registerTool(tool);

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
