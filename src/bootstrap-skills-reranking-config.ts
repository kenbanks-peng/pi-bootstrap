import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { SkillRerankingConfig } from "./bootstrap-skills-reranking.ts";

export const defaultRerankingConfig: SkillRerankingConfig = Object.freeze({
  enabled: false, experimentalFit: false, minFitProbability: 0.75, model: "jev-latest", timeoutMs: 1000, cacheMaxEntries: 128, cacheTtlMs: 300000,
  maxCandidates: 32, maxQueryBytes: 2048, maxNameBytes: 256, maxDescriptionBytes: 512,
  maxPayloadBytes: 32768, minProbability: 0.55, minMargin: 0.10,
});
const fields = {
  timeout_ms: ["timeoutMs", 1, 10000], cache_max_entries: ["cacheMaxEntries", 0, 1024],
  cache_ttl_ms: ["cacheTtlMs", 0, 3600000], max_candidates: ["maxCandidates", 1, 64],
  max_query_bytes: ["maxQueryBytes", 1, 8192], max_name_bytes: ["maxNameBytes", 1, 256],
  max_description_bytes: ["maxDescriptionBytes", 0, 2048], max_payload_bytes: ["maxPayloadBytes", 256, 65536],
  min_probability: ["minProbability", 0, 1], min_margin: ["minMargin", 0, 1],
} as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Strict validation, never coercion. Invalid settings disable consent as a whole. */
export function parseRerankingConfig(value: unknown): SkillRerankingConfig {
  if (value === undefined) return defaultRerankingConfig;
  if (!object(value)) throw new Error("Invalid skill-search reranking configuration.");
  const config = { ...defaultRerankingConfig };
  for (const [key, entry] of Object.entries(value)) {
    if (key === "enabled" || key === "experimental_fit") {
      if (typeof entry !== "boolean") throw new Error("Invalid skill-search reranking configuration.");
      config[key === "enabled" ? "enabled" : "experimentalFit"] = entry;
    } else if (key === "min_fit_probability") {
      if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0.5 || entry > 1) throw new Error("Invalid skill-search reranking configuration.");
      config.minFitProbability = entry;
    } else if (key === "model") {
      if (typeof entry !== "string" || !entry.trim() || Buffer.byteLength(entry, "utf8") > 256) throw new Error("Invalid skill-search reranking configuration.");
      config.model = entry;
    } else if (Object.hasOwn(fields, key)) {
      const [target, min, max] = fields[key as keyof typeof fields];
      if (typeof entry !== "number" || !Number.isFinite(entry) || entry < min || entry > max ||
        (!key.startsWith("min_") && !Number.isInteger(entry))) throw new Error("Invalid skill-search reranking configuration.");
      config[target] = entry;
    } else throw new Error("Invalid skill-search reranking configuration.");
  }
  return config;
}

/** Only the resolved global Bootstrap directory can grant transmission consent. */
export async function loadRerankingConfig(globalDirectory: string, diagnostic: (message: string) => void = () => {}): Promise<SkillRerankingConfig> {
  try {
    const root = parse(await readFile(join(globalDirectory, "config.toml"), "utf8"));
    const search = root.skill_search;
    if (search === undefined) return defaultRerankingConfig;
    if (!object(search)) throw new Error();
    return parseRerankingConfig(search.reranking);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostic("Skill-search reranking disabled: invalid or unreadable global configuration.");
    return defaultRerankingConfig;
  }
}
