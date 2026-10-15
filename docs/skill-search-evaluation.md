# Skill-search evaluation

This is a synthetic, local replay benchmark, not evidence that semantic search is ready for rollout. It changes no production search behavior. Fixtures and the evaluation-only adapter interface are under `test/skill-search-evaluation/`.

## Run

From the repository root, install the repository dependencies, then:

```sh
set -euo pipefail
npm run typecheck
npm test
npx tsx test/skill-search-evaluation/run.ts tuning 10 > /tmp/skill-search-tuning.json
npx tsx test/skill-search-evaluation/run.ts held-out 10 > /tmp/skill-search-held-out.json
```

The first argument must select a split. The default repetition count is 10 (accepted range 1–100). Calls run sequentially in fixture order, at limits **1, 3, 5**, for each repetition. There are no hidden warmup calls. A failed invocation or invalid adapter output aborts the run; never report a partial run as successful.

The keyword adapter invokes the actual tool registered by `registerLazySkills`, with synthetic resource metadata supplied through `before_agent_start`. It does not copy or extract the scoring algorithm. No skill instruction file is read. Catalog construction and registration happen once before measurement, as they do before agent tool calls.

## Scale and optional agent-load suite

The separate [v2 scale/agent-load guide](skill-search-scale-evaluation.md) covers versioned 128/256-skill catalogs, 62 split queries, multi-skill completion metrics, bounded offline commands and synthetic-only load audits. V1 fixtures and baseline artifacts below are retained unchanged. The guide also qualifies the retained historical live reports; they are not v2 or agent-load evidence.

## Fixtures and labels

Version `skill-search-synthetic-v1` contains 12 eligible unique skills and 26 queries. Both splits cover exact names, paraphrases, ambiguous requests, unrelated requests, disabled skills, and duplicate metadata. The catalog includes a disabled duplicate before an enabled copy, an enabled duplicate with different metadata, and a disabled duplicate after an enabled copy. First enabled metadata wins, as in production.

Labels express intended capability, not the baseline's output. `acceptable` lists alternative skills that could satisfy a request; it does not require returning all alternatives. An empty list requires abstention. For example, Klingon translation is outside the synthetic translation skill's documented language pair. This creates lexical false-positive cases as well as requests with no shared words. Some paraphrases deliberately have no useful keyword overlap. Label judgments are handcrafted and small; extend and independently review the dataset before making rollout claims.

`tuning` has 12 cases; `held-out` has 14. Query IDs and normalized query text are distinct across splits. Tune confidence/abstention settings only on `tuning`; freeze configuration and model version before running `held-out`. Do not pick the best model or threshold using held-out results. The keyword baseline has no tuned threshold. A later dataset revision must change `fixtureVersion` and retain prior artifacts.

## Metrics

For each fixed result limit:

- **Selection accuracy (Hit@k):** positive trials with at least one acceptable skill in the first k returned results, divided by all positive trials. An empty result for a positive query is a miss. This is not exact-set accuracy or precision; ambiguous labels are alternatives.
- **No-match accuracy:** negative trials returning zero results, divided by all negative trials. Any result is a false positive. Positive queries are not in this denominator.
- **Shortlist recall:** mean, over positive trials, of `acceptable names in actual pre-rerank shortlist / acceptable names`. The keyword diagnostic shortlist uses production search at limit **20**. This is macro recall of all labeled alternatives.
- **Shortlist hit rate:** positive trials with any acceptable name in the actual shortlist, divided by all positive trials. This bounds a reranker restricted to that shortlist, but not keyword fallback or bypass, which are separate retrieval paths. Always report it beside selection accuracy and shortlist-kind/decision counts: semantic reranking cannot recover its own retrieval miss.
- **Latency:** nearest-rank p50 and p95 in milliseconds over complete search invocations. The baseline measures actual fixed-limit tool execution, including keyword scoring and result serialization. Its separate diagnostic limit-20 call is excluded. Registration, fixture loading, process startup, and summary writing are excluded. This is tool end-to-end latency, not full agent-turn latency. The synthetic catalog is small; timings are descriptive, not a production latency promise.
- **API cost:** sum of actual billed USD for measured invocations. Keyword baseline cost is **zero**. Unknown costs stay `null` in rows and increment `unknownCostTrials`; `knownApiCostUsd` is not a total-cost claim when any trials are unknown. Later semantic runs must count retries, fallback attempts, and any billed cache-warming work. Report pricing assumptions separately if cost must be estimated.

Schema v2 also reports shortlist miss counts and fixture IDs, API-attempt and
input/output token totals with unknown-trial counts, and p50/p95 latency/sample
counts grouped by observed cache state (`disabled`, `miss`, `hit`, `bypass`,
`unknown`). `ReplayResult.telemetry` is optional; absent telemetry is unknown,
not zero. Counts must be nonnegative safe integers or `null`. Adapters must
observe cache state, not infer it from repetition number. Baseline telemetry is
known zero with cache disabled. Empty latency groups are `null`. Model costs
remain separately measured or unknown; token totals are not a billing estimate.
See [rollout status](skill-search-rollout.md) for paired-regression reporting and
the live-run authorization/credential requirements.

All trials are retained, including the first call and cache-affected repetitions. Means give every trial equal weight. `positiveTrials` and `noMatchTrials` expose the denominators. A reranker can abstain with a nonempty shortlist; no-match accuracy measures final results only. The harness rejects ineligible names, duplicate names, oversized results/shortlists and invalid telemetry. The default shortlist bound is 20; a semantic adapter declares its actual bound as `configuration.shortlistLimit` (integer 1–64). Semantic matches must be inside that shortlist. An explicitly observed keyword fallback may leave it only when results exactly reproduce the separately observed keyword ordering at the requested limit. The actual shortlist is never unioned with fallback results. Keyword bypass uses a keyword shortlist bounded at 20. Decision/fallback and shortlist-kind counts distinguish these paths; missing observation stays unknown.

## Replay a semantic implementation

`production.ts` now bridges the real registered semantic tool/session/config path to this harness, with the real SDK and optional internal shortlist/cache/decision/usage observation. The bounded, explicitly authorized paid entry point is `live.ts`; see [the live-run instructions and budget gates](skill-search-rollout.md#runnable-paired-live-path-requires-explicit-authorization). No live calls are enabled by the ordinary keyword runner. Mock transports are used only in tests and are not quality evidence.

For alternative trusted evaluation modules, the existing bridge interface remains:

```ts
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ReplayAdapter } from "./test/skill-search-evaluation/harness.ts";

export async function createAdapter(skills: readonly Skill[]): Promise<ReplayAdapter> {
  // Initialize the real semantic search pipeline with these exact resources.
  // Return manifest and search(query, limit); see ReplayAdapter for the shape.
  throw new Error("Implement with the production adapter; do not simulate rankings");
}
```

Supply its path as the third argument after split and repetition count:

```sh
set -euo pipefail
npx tsx test/skill-search-evaluation/run.ts tuning 10 ./semantic-evaluation-adapter.ts > /tmp/semantic-tuning.json
# After tuning and freezing settings/model:
npx tsx test/skill-search-evaluation/run.ts held-out 10 ./semantic-evaluation-adapter.ts > /tmp/semantic-held-out.json
```

The bridge receives a clone of the same catalog. It must exercise the real retrieval/reranking/cache/fallback pipeline, return the actual bounded shortlist before reranking/abstention, and measure complete invocation latency (not just model latency). If candidate limits differ from 20, put the actual bound in configuration and compare recall explicitly. This evaluation interface is separate from the production SDK/config contract and does not dictate that contract. Optional `close()` releases session-owned resources and must be idempotent. The runner closes before emitting success and again in `finally`. Mocked end-to-end tests cover the production bridge and live/comparison CLIs without using a network; they are not semantic measurements.

The manifest records mode, implementation revision/version, exact immutable model version when supported (otherwise explicitly disclose an unpinned alias), model SDK version, and public configuration. Include confidence threshold, shortlist bound, timeout, cache policy, and fallback settings. Confidence is an answer-distribution statistic, not a correctness guarantee. Use the same split, fixture hash, result limits, environment, and repetition policy in paired comparisons. Declare cold-cache versus cache-affected runs; create a fresh adapter/process for each independent run. A model bridge must not perform unreported paid warmup calls.

## Provenance and privacy

Reports contain a fixture hash/version, implementation version, configuration, runtime environment, installed direct dependency versions, metrics, and rows identified by fixture ID and sorted eligible catalog index. They omit query text, descriptions, paths, skill bodies, conversation history, prompts, credentials, and provider responses. They use only synthetic fixtures, never the local user's skill catalog. Indexes can be decoded against the committed fixture; this is data minimization, not anonymization.

Adapter manifest/version/configuration values are trusted caller input: supply only public settings, not secrets, endpoints, raw prompts, or local paths. Do not log adapter errors that can include sensitive provider payloads in published artifacts. Nothing in this harness authorizes sending history, system prompts, or skill bodies to a service. An external semantic bridge is executable trusted code and must satisfy the production privacy contract independently.

`docs/skill-search-baseline.json` captures measured baseline summaries for both splits. Full per-trial JSON can be regenerated with the commands above; latency will vary. The source SHA-256 in `implementationVersion` identifies the production scoring source even if the enclosing benchmark commit differs. The stored dependency versions describe this sandbox's npm installation (without a generated lockfile); use the repo's lockfile tooling for controlled future runs.

## Initial baseline interpretation

The baseline's lexical no-match mistakes and paraphrase retrieval misses are expected benchmark findings, not test failures. Compare top-1 and shortlist hit rates before attributing gains to reranking. This initial baseline does not recommend adoption or alter thresholds. Historical v1 live comparison was subsequently recorded; see the [provenance-qualified historical evidence](skill-search-scale-evaluation.md#historical-live-evidence-not-v2-evidence), including the no-match regression. New live runs still require explicit authorized credentials/model/budget. See [rollout status](skill-search-rollout.md) for the runner's gates.
