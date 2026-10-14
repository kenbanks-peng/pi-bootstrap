import type { SkillMetadata } from "./bootstrap-skills.ts";
import type { SkillRerankingAdapter, SkillRerankingConfig, SkillRerankingDecision, SkillRerankingRequest } from "./bootstrap-skills-reranking.ts";

const bytes = (value: string) => Buffer.byteLength(value, "utf8");
function truncate(value: string, max: number): string {
  let result = "", size = 0;
  for (const point of value) {
    size += bytes(point);
    if (size > max) break;
    result += point;
  }
  return result;
}
export function buildRerankingRequest(query: string, shortlist: readonly SkillMetadata[], config: SkillRerankingConfig): SkillRerankingRequest | undefined {
  if (bytes(query) > config.maxQueryBytes) return;
  const candidates = shortlist.slice(0, config.maxCandidates)
    .filter(skill => bytes(skill.name) <= config.maxNameBytes)
    .map((skill, index) => ({ id: `c${index}`, name: skill.name, description: truncate(skill.description, config.maxDescriptionBytes) }));
  const request = { query, candidates };
  while (candidates.length && bytes(JSON.stringify(request)) > config.maxPayloadBytes) candidates.pop();
  return candidates.length ? request : undefined;
}

/** Confidence is only a distribution statistic, never an authorization decision. */
export function decideReranking(value: unknown, request: SkillRerankingRequest, config: SkillRerankingConfig): SkillRerankingDecision {
  const invalid = (): SkillRerankingDecision => ({ kind: "fallback", reason: "invalid-response" });
  if (!value || typeof value !== "object") return invalid();
  const entries = (value as { probabilities?: unknown }).probabilities;
  if (!Array.isArray(entries) || entries.length !== request.candidates.length + 1) return invalid();
  const expected = new Set<string | null>([...request.candidates.map(candidate => candidate.id), null]);
  const probabilities: { id: string | null; probability: number; order: number }[] = [];
  let sum = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !expected.delete(entry.id) || typeof entry.probability !== "number" ||
      !Number.isFinite(entry.probability) || entry.probability < 0 || entry.probability > 1) return invalid();
    sum += entry.probability;
    probabilities.push({ id: entry.id, probability: entry.probability, order: entry.id === null ? -1 : request.candidates.findIndex(candidate => candidate.id === entry.id) });
  }
  if (expected.size || Math.abs(sum - 1) > 0.000001) return invalid();
  for (const entry of probabilities) entry.probability /= sum;
  probabilities.sort((a, b) => b.probability - a.probability || a.order - b.order);
  if (probabilities[0].probability < config.minProbability || probabilities[0].probability - probabilities[1].probability < config.minMargin) return { kind: "fallback", reason: "uncertain" };
  if (probabilities[0].id === null) return { kind: "no-match" };
  return { kind: "matches", ids: probabilities.filter(entry => entry.id !== null && entry.probability >= config.minProbability).map(entry => entry.id!) };
}

type Success = Exclude<SkillRerankingDecision, { kind: "fallback" }>;
/** Session-owned LRU, deadlines and invalidation. No raw response or paths in entries. */
export class SkillRerankingRuntime {
  private cache = new Map<string, { decision: Success; expires: number }>();
  private pending = new Set<AbortController>();
  private generation = 0;
  private fingerprint = "";
  private credential: string | undefined;
  constructor(private readonly now: () => number = () => performance.now()) {}
  get version(): number { return this.generation; }

  clear(): void {
    this.generation++;
    this.cache.clear();
    this.fingerprint = "";
    this.credential = undefined;
    for (const controller of this.pending) controller.abort(new Error("Skill search state changed."));
    this.pending.clear();
  }
  snapshot(catalog: readonly SkillMetadata[], config: SkillRerankingConfig, credential: string | undefined): void {
    const fingerprint = JSON.stringify([catalog, config]);
    if (this.fingerprint !== fingerprint || this.credential !== credential) {
      this.clear();
      this.fingerprint = fingerprint;
      this.credential = credential;
    }
  }

  async search(request: SkillRerankingRequest, config: SkillRerankingConfig, adapter: SkillRerankingAdapter, signal?: AbortSignal): Promise<SkillRerankingDecision> {
    signal?.throwIfAborted();
    const key = JSON.stringify([1, config, request]);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      if (cached.expires > this.now()) {
        this.cache.set(key, cached);
        return cached.decision;
      }
    }
    const started = this.now();
    const generation = this.generation;
    const controller = new AbortController();
    this.pending.add(controller);
    let timeout = false;
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timeout = true; controller.abort(new Error("Reranking deadline exceeded.")); }, config.timeoutMs);
    try {
      const value = await Promise.race([Promise.resolve().then(() => adapter.rerank(request, { model: config.model!, signal: controller.signal })), aborted]);
      if (generation !== this.generation) throw new Error("Skill search state changed.");
      signal?.throwIfAborted();
      if (this.now() - started >= config.timeoutMs) return { kind: "fallback", reason: "timeout" };
      const decision = decideReranking(value, request, config);
      if (this.now() - started >= config.timeoutMs) return { kind: "fallback", reason: "timeout" };
      if (decision.kind !== "fallback" && config.cacheMaxEntries && config.cacheTtlMs) {
        this.cache.set(key, { decision, expires: this.now() + config.cacheTtlMs });
        while (this.cache.size > config.cacheMaxEntries) this.cache.delete(this.cache.keys().next().value!);
      }
      return decision;
    } catch {
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new Error("Skill search state changed.");
      return { kind: "fallback", reason: timeout ? "timeout" : "provider" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
      this.pending.delete(controller);
    }
  }
}
