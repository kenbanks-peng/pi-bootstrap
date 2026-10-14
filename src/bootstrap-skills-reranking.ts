/**
 * Contract only: no configuration loading, SDK imports, or network activity.
 * See docs/skill-search-reranking.md for bounds and runtime validation rules.
 */
export interface SkillRerankingConfig {
  readonly enabled: boolean;
  /** Explicit Jev model ID; no implicit model selection. */
  readonly model?: string;
  readonly timeoutMs: number;
  readonly cacheMaxEntries: number;
  readonly cacheTtlMs: number;
  readonly maxCandidates: number;
  readonly maxQueryBytes: number;
  readonly maxNameBytes: number;
  readonly maxDescriptionBytes: number;
  readonly maxPayloadBytes: number;
  readonly minProbability: number;
  readonly minMargin: number;
}

/** Outbound allowlist. IDs are request-local, never paths or skill names. */
export interface SkillRerankingCandidate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** Construct fresh objects: do not spread SkillMetadata into this payload. */
export interface SkillRerankingRequest {
  readonly query: string;
  readonly candidates: readonly SkillRerankingCandidate[];
}

export interface SkillRerankingProbability {
  /** null is the explicit no-match alternative; all other IDs must be submitted. */
  readonly id: string | null;
  readonly probability: number;
}

/** Validated complete distribution, not a correctness guarantee. */
export interface SkillRerankingDistribution {
  readonly probabilities: readonly SkillRerankingProbability[];
}

/** The caller owns timeout, validation, gating, caching, and keyword fallback. */
export interface SkillRerankingAdapter {
  rerank(
    request: SkillRerankingRequest,
    options: { readonly model: string; readonly signal: AbortSignal },
  ): Promise<unknown>;
}

/** Internal decision only; keep the public skill_search result shape unchanged. */
export type SkillRerankingDecision =
  | { readonly kind: "matches"; readonly ids: readonly string[] }
  | { readonly kind: "no-match" }
  | { readonly kind: "fallback"; readonly reason: "unavailable" | "bounds" | "timeout" | "provider" | "invalid-response" | "uncertain" };
