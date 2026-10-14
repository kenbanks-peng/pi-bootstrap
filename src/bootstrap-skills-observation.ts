/** Optional internal diagnostics only. No query, credential, prompt, paths or raw response. */
export interface SkillSearchObservation {
  /** Indexes in skillCatalog's sorted eligible snapshot. Fresh arrays per call. */
  shortlist: number[];
  keywordResults: number[];
  shortlistKind: "keyword" | "semantic";
  decision: "keyword" | "matches" | "no-match" | "fallback";
  reason: "exact" | "empty" | "unavailable" | "bounds" | "timeout" | "provider" | "invalid-response" | "uncertain" | null;
  cache: "disabled" | "miss" | "hit" | "bypass";
}
export type JevObservation =
  | { kind: "attempt" }
  | { kind: "usage"; inputTokens: number | null; outputTokens: number | null };

/** Diagnostics must never change public search behavior, even if a listener fails. */
export function observeSafely<T>(observer: ((value: T) => void) | undefined, value: T): void {
  try { observer?.(value); } catch { /* Optional observer is non-authoritative. */ }
}
