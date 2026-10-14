import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { registerLazySkills, skillCatalog } from "../../src/bootstrap-skills.ts";
import { catalog, fixtureVersion, queries, resultLimits, shortlistLimit, type QueryCase } from "./fixtures.ts";

export interface ReplayTelemetry {
  /** Count actual outbound attempts, including failed/billed attempts. */
  apiCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Observed runtime state, not inferred from repetition number or latency. */
  cache: "disabled" | "miss" | "hit" | "bypass" | "unknown";
}

export interface ReplayResult {
  matches: string[];
  /** Actual candidates before reranking/abstention, never inferred from output. */
  shortlist: string[];
  /** Complete search invocation, including retrieval/network/cache/fallback. */
  latencyMs: number;
  /** Actual billed model API cost; null means unavailable, not zero. */
  apiCostUsd: number | null;
  telemetry?: ReplayTelemetry;
}

/** Evaluation-only interface, not the production semantic adapter contract. */
export interface ReplayAdapter {
  manifest: {
    mode: "keyword" | "semantic";
    implementationVersion: string;
    modelVersion: string | null;
    sdkVersion: string | null;
    /** Public settings only: never credentials, endpoints, prompts or paths. */
    configuration: Record<string, string | number | boolean | null>;
  };
  search(query: string, limit: number): Promise<ReplayResult>;
}

type SearchDetails = { matches: { name: string }[]; total: number };

/** Exercise the real registered tool, not a copied keyword scoring algorithm. */
export function keywordAdapter(skills: readonly Skill[], implementationVersion: string): ReplayAdapter {
  let start: ((event: unknown) => void) | undefined;
  let execute: ((id: string, args: { query: string; limit: number }) => Promise<{ details: SearchDetails }>) | undefined;
  const pi = {
    on(name: string, handler: (event: unknown) => void) {
      if (name === "before_agent_start") start = handler;
    },
    registerTool(tool: { name: string; execute: typeof execute }) {
      if (tool.name === "skill_search") execute = tool.execute;
    },
  };
  registerLazySkills(pi as unknown as ExtensionAPI);
  if (!start || !execute) throw new Error("skill_search registration missing");
  start({ systemPromptOptions: { skills: structuredClone(skills), sections: {} } });
  const search = execute;
  return {
    manifest: {
      mode: "keyword", implementationVersion, modelVersion: null, sdkVersion: null,
      configuration: { shortlistLimit, resultLimits: resultLimits.join(","), scoreThreshold: 0 },
    },
    async search(query, limit) {
      const before = performance.now();
      const result = await search("evaluation", { query, limit });
      const latencyMs = performance.now() - before;
      // Diagnostic search is outside the timed invocation. No keyword cache.
      const candidates = await search("evaluation-shortlist", { query, limit: shortlistLimit });
      return {
        matches: result.details.matches.map(s => s.name),
        shortlist: candidates.details.matches.map(s => s.name),
        latencyMs, apiCostUsd: 0,
        telemetry: { apiCalls: 0, inputTokens: 0, outputTokens: 0, cache: "disabled" },
      };
    },
  };
}

export function validateFixtures(skills: readonly Skill[], cases: readonly QueryCase[]) {
  const available = new Set(skillCatalog(skills).map(s => s.name));
  const ids = new Set<string>();
  const texts = new Set<string>();
  for (const q of cases) {
    if (ids.has(q.id) || texts.has(q.query.trim().toLowerCase())) throw new Error("Duplicate evaluation case");
    if (!q.query.trim() || q.acceptable.some(name => !available.has(name))) throw new Error("Invalid query label");
    ids.add(q.id);
    texts.add(q.query.trim().toLowerCase());
  }
}

export function scoreResult(q: QueryCase, result: ReplayResult, limit: number) {
  return {
    selectionHit: q.acceptable.length ? result.matches.slice(0, limit).some(n => q.acceptable.includes(n)) : null,
    noMatchHit: q.acceptable.length ? null : result.matches.length === 0,
    shortlistRecall: q.acceptable.length
      ? q.acceptable.filter(n => result.shortlist.includes(n)).length / q.acceptable.length : null,
    shortlistHit: q.acceptable.length ? result.shortlist.some(n => q.acceptable.includes(n)) : null,
  };
}

function quantile(values: number[], fraction: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export async function evaluate(adapter: ReplayAdapter, options: {
  split: QueryCase["split"];
  repetitions?: number;
  skills?: readonly Skill[];
  cases?: readonly QueryCase[];
}) {
  const skills = options.skills ?? catalog;
  const cases = options.cases ?? queries;
  const repetitions = options.repetitions ?? 10;
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("Invalid repetitions");
  if (!adapter.manifest.implementationVersion ||
    (adapter.manifest.mode === "semantic" && (!adapter.manifest.modelVersion || !adapter.manifest.sdkVersion))) {
    throw new Error("Adapter must record implementation, model and SDK versions");
  }
  const actualShortlistLimit = adapter.manifest.configuration.shortlistLimit ?? shortlistLimit;
  if (typeof actualShortlistLimit !== "number" || !Number.isInteger(actualShortlistLimit) ||
    actualShortlistLimit < 1 || actualShortlistLimit > 64) throw new Error("Invalid adapter shortlist limit");
  validateFixtures(skills, cases);
  const selected = cases.filter(q => q.split === options.split);
  if (!selected.length) throw new Error("Empty evaluation split");
  const available = new Set(skillCatalog(skills).map(s => s.name));
  const rows: Array<{
    caseId: string; category: QueryCase["category"]; trial: number; limit: number;
    matches: number[]; shortlist: number[]; latencyMs: number; apiCostUsd: number | null;
    telemetry: ReplayTelemetry;
  } & ReturnType<typeof scoreResult>> = [];
  // Sequential fixed order; no unreported warmup API calls. Repetitions expose
  // cache effects. Preserve every trial rather than hiding stochastic failures.
  for (let trial = 0; trial < repetitions; trial++) {
    for (const q of selected) {
      for (const limit of resultLimits) {
        const result = await adapter.search(q.query, limit);
        for (const names of [result.matches, result.shortlist]) {
          if (new Set(names).size !== names.length || names.some(n => !available.has(n))) {
            throw new Error("Adapter returned duplicate or ineligible skill");
          }
        }
        if (result.matches.length > limit || result.shortlist.length > actualShortlistLimit ||
          result.matches.some(n => !result.shortlist.includes(n))) throw new Error("Invalid adapter shortlist/output bounds");
        if (!Number.isFinite(result.latencyMs) || result.latencyMs < 0 ||
          (result.apiCostUsd !== null && (!Number.isFinite(result.apiCostUsd) || result.apiCostUsd < 0))) {
          throw new Error("Invalid adapter telemetry");
        }
        const telemetry = result.telemetry ?? { apiCalls: null, inputTokens: null, outputTokens: null, cache: "unknown" };
        if (!["disabled", "miss", "hit", "bypass", "unknown"].includes(telemetry.cache) ||
          [telemetry.apiCalls, telemetry.inputTokens, telemetry.outputTokens].some(value =>
            value !== null && (!Number.isSafeInteger(value) || value < 0))) {
          throw new Error("Invalid adapter usage/cache telemetry");
        }
        rows.push({
          caseId: q.id, category: q.category, trial, limit,
          // Only fixture IDs and catalog indexes are emitted, not raw strings.
          matches: result.matches.map(n => [...available].indexOf(n)),
          shortlist: result.shortlist.map(n => [...available].indexOf(n)),
          ...scoreResult(q, result, limit), latencyMs: result.latencyMs, apiCostUsd: result.apiCostUsd, telemetry: { ...telemetry },
        });
      }
    }
  }
  const metrics = resultLimits.map(limit => {
    const group = rows.filter(r => r.limit === limit);
    const positive = group.filter(r => r.selectionHit !== null);
    const negative = group.filter(r => r.noMatchHit !== null);
    const rate = (sum: number, count: number) => count ? sum / count : null;
    const knownCosts = group.filter(r => r.apiCostUsd !== null);
    return {
      limit, positiveTrials: positive.length, noMatchTrials: negative.length,
      selectionAccuracy: rate(positive.filter(r => r.selectionHit).length, positive.length),
      noMatchAccuracy: rate(negative.filter(r => r.noMatchHit).length, negative.length),
      shortlistRecall: rate(positive.reduce((sum, r) => sum + r.shortlistRecall!, 0), positive.length),
      shortlistHitRate: rate(positive.filter(r => r.shortlistHit).length, positive.length),
      shortlistMissTrials: positive.filter(r => !r.shortlistHit).length,
      shortlistMissCaseIds: [...new Set(positive.filter(r => !r.shortlistHit).map(r => r.caseId))],
      usage: Object.fromEntries((["apiCalls", "inputTokens", "outputTokens"] as const).map(key => [key, {
        knownTotal: group.reduce((sum, r) => sum + (r.telemetry[key] ?? 0), 0),
        unknownTrials: group.filter(r => r.telemetry[key] === null).length,
      }])),
      cache: Object.fromEntries((["disabled", "miss", "hit", "bypass", "unknown"] as const).map(state => {
        const samples = group.filter(r => r.telemetry.cache === state);
        return [state, { trials: samples.length, latencyMs: {
          p50: quantile(samples.map(r => r.latencyMs), 0.5), p95: quantile(samples.map(r => r.latencyMs), 0.95),
        } }];
      })),
      latencyMs: { p50: quantile(group.map(r => r.latencyMs), 0.5), p95: quantile(group.map(r => r.latencyMs), 0.95) },
      knownApiCostUsd: knownCosts.reduce((sum, r) => sum + r.apiCostUsd!, 0),
      unknownCostTrials: group.length - knownCosts.length,
    };
  });
  return {
    schemaVersion: 2, fixtureVersion,
    fixtureSha256: createHash("sha256").update(JSON.stringify({ skills, cases })).digest("hex"),
    split: options.split, repetitions, shortlistLimit: actualShortlistLimit, resultLimits,
    queryCount: selected.length, catalogSize: available.size, manifest: adapter.manifest,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    metrics, rows,
  };
}
