import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { stringify } from "smol-toml";
import { registerLazySkills, skillCatalog } from "../../src/bootstrap-skills.ts";
import { parseRerankingConfig } from "../../src/bootstrap-skills-reranking-config.ts";
import { createJevAdapter } from "../../src/bootstrap-skills-jev.ts";
import type { SkillSearchObservation } from "../../src/bootstrap-skills-observation.ts";
import type { ReplayAdapter } from "./harness.ts";

export interface ProductionOptions {
  model: string;
  /** Immutable version if available; explicitly disclose unpinned aliases. */
  modelVersion: string;
  implementationVersion: string;
  /** TOML snake_case settings; enabled/model are fixed by the explicit arguments. */
  reranking?: Record<string, unknown>;
  maxRequests: number;
}
export interface LiveOptions extends ProductionOptions {
  authorizePaid: boolean;
  maxUsd: number;
  /** Operator-approved conservative upper bound, NOT measured cost. */
  requestCostCeilingUsd: number;
  pricingDate: string;
  pricingSource: string;
}

function validate(options: ProductionOptions) {
  if (!options.modelVersion.trim() || !options.implementationVersion.trim() ||
    !Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 100000) {
    throw new Error("Explicit model/version, revision and bounded request limit required");
  }
  return parseRerankingConfig({ ...options.reranking, enabled: true, model: options.model });
}

/** Explicit paid-call gate. Merely having a key does not grant authorization. */
export async function createLiveAdapter(skills: readonly Skill[], options: LiveOptions): Promise<ReplayAdapter> {
  validate(options);
  if (options.authorizePaid !== true || !Number.isFinite(options.maxUsd) || options.maxUsd <= 0 ||
    !Number.isFinite(options.requestCostCeilingUsd) || options.requestCostCeilingUsd <= 0 ||
    options.maxRequests * options.requestCostCeilingUsd > options.maxUsd ||
    !/^\d{4}-\d{2}-\d{2}$/.test(options.pricingDate) || !options.pricingSource?.trim()) {
    throw new Error("Paid evaluation requires explicit authorization and approved request/USD bounds with pricing date/source");
  }
  const credential = process.env.TYPESAFE_API_KEY?.trim();
  if (!credential) throw new Error("Live measurement blocked: TYPESAFE_API_KEY absent");
  return productionAdapter(skills, options, credential, globalThis.fetch, {
    execution: "live", authorizedMaxUsd: options.maxUsd, requestCostCeilingUsd: options.requestCostCeilingUsd,
    pricingDate: options.pricingDate, pricingSource: options.pricingSource,
  });
}

/** Tests only: exercises the real SDK with an injected HTTP transport, never quality evidence. */
export function createMockAdapter(skills: readonly Skill[], options: ProductionOptions, fetcher: typeof fetch): Promise<ReplayAdapter> {
  validate(options);
  return productionAdapter(skills, options, "mock-key-not-a-credential", fetcher, { execution: "mock-not-quality-evidence" });
}

async function productionAdapter(skills: readonly Skill[], options: ProductionOptions, credential: string,
  transport: typeof fetch, publicSettings: Record<string, string | number | boolean | null>): Promise<ReplayAdapter> {
  const config = validate(options);
  const settings = { ...options.reranking, enabled: true, model: options.model };
  const directory = await mkdtemp(join(tmpdir(), "skill-search-evaluation-"));
  const handlers = new Map<string, (event: any) => unknown>();
  let execute!: (id: string, args: { query: string; limit: number }) => Promise<{ details: { matches: { name: string }[] } }>;
  type Measurement = { calls: number; usages: number; input: number | null; output: number | null; closed: boolean; observation?: SkillSearchObservation };
  let active: Measurement | undefined;
  let totalCalls = 0, exhausted = false, closed = false;
  const eligible = skillCatalog(skills);
  try {
    await writeFile(join(directory, "config.toml"), stringify({ skill_search: { reranking: settings } }));
    registerLazySkills({
      on(name: string, handler: (event: any) => unknown) { handlers.set(name, handler); },
      registerTool(tool: { name: string; execute: typeof execute }) { if (tool.name === "skill_search") execute = tool.execute; },
    } as unknown as ExtensionAPI, {
      globalDirectory: directory, credential: () => credential, diagnostic: () => {},
      observe(value) { if (active && !active.closed) active.observation = structuredClone(value); },
      adapterFor(key) {
        const measurement = active;
        if (!measurement) throw new Error("Evaluation invocation missing");
        return createJevAdapter(key, async (...args) => {
          if (totalCalls >= options.maxRequests || measurement.closed) {
            exhausted = true;
            throw new Error("Evaluation request ceiling reached");
          }
          totalCalls++;
          measurement.calls++;
          return transport(...args);
        }, event => {
          if (event.kind !== "usage" || measurement.closed) return;
          measurement.usages++;
          measurement.input = measurement.input === null || event.inputTokens === null ? null : measurement.input + event.inputTokens;
          measurement.output = measurement.output === null || event.outputTokens === null ? null : measurement.output + event.outputTokens;
        });
      },
    });
    await handlers.get("session_start")!({ reason: "new" });
    handlers.get("before_agent_start")!({ systemPromptOptions: { skills: structuredClone(skills), sections: {} } });
    if (!execute) throw new Error("Evaluation registration missing");
  } catch {
    handlers.get("session_shutdown")?.({});
    await rm(directory, { recursive: true, force: true });
    throw new Error("Evaluation initialization failed");
  }
  return {
    manifest: {
      mode: "semantic", implementationVersion: options.implementationVersion,
      modelVersion: options.modelVersion, sdkVersion: "0.6.0",
      configuration: { ...config, model: options.model, shortlistLimit: config.maxCandidates,
        maxRequests: options.maxRequests, costBasis: "unknown; SDK 0.6.0 exposes tokens, not billed USD", ...publicSettings },
    },
    async search(query, limit) {
      if (closed || active) throw new Error("Evaluation bridge requires sequential open-session calls");
      const measurement: Measurement = { calls: 0, usages: 0, input: 0, output: 0, closed: false };
      active = measurement;
      try {
        const started = performance.now();
        const result = await execute("evaluation", { query, limit });
        const latencyMs = performance.now() - started;
        if (exhausted) throw new Error("Evaluation request ceiling exceeded; discard incomplete report");
        const observed = measurement.observation;
        if (!observed) throw new Error("Evaluation observation missing");
        const names = (indexes: number[]) => indexes.map(index => {
          if (!eligible[index]) throw new Error("Evaluation snapshot index invalid");
          return eligible[index].name;
        });
        return {
          matches: result.details.matches.map(skill => skill.name), shortlist: names(observed.shortlist),
          latencyMs, apiCostUsd: measurement.calls ? null : 0,
          telemetry: {
            apiCalls: measurement.calls,
            inputTokens: measurement.usages === measurement.calls ? measurement.input : null,
            outputTokens: measurement.usages === measurement.calls ? measurement.output : null,
            cache: observed.cache,
          },
          observation: { decision: observed.decision, reason: observed.reason, shortlistKind: observed.shortlistKind,
            keywordResults: names(observed.keywordResults) },
        };
      } finally {
        measurement.closed = true;
        active = undefined;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try { handlers.get("session_shutdown")?.({}); }
      finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}
