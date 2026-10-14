# Skill-search rollout evaluation: live measurement blocked

## Decision (2026-10-14)

**Keep keyword search as the default. Defer any recommendation to adopt semantic
reranking.** No Jev quality, latency, cache performance, token usage, or cost has
been measured here. The implementation's offline safety tests are not evidence
of semantic improvement. Neither the external Hermes benchmark nor the Jev
cookbook establishes performance on this repository's fixtures.

The worker checked only whether the process environment contained
`TYPESAFE_API_KEY` (without printing a value): **absent**. No explicit model or
paid-call budget authorization was supplied. No provider calls, model discovery,
or paid warmup calls were made. This evaluation remains incomplete/blocked;
merging the offline preparation does not complete the live benchmark.

## Offline measurements

The current production keyword tool was replayed on synthetic v1 fixtures, 10
repetitions at each limit (1, 3, 5). Each split used a fresh process. Registration,
fixture loading, and the separate diagnostic shortlist call are outside measured
tool latency. The source/dependency/environment provenance and exact summaries
are retained in `skill-search-rollout-baseline.json`. Earlier measurements remain
in `skill-search-baseline.json`; neither artifact contains semantic results.

| Split | Unique queries (positive / negative) | Trials per limit | Hit@1 / Hit@3 / Hit@5 | No-match accuracy | Shortlist hit / recall |
| --- | --- | --- | --- | --- | --- |
| tuning | 12 (8 / 4) | 120 | 87.5% / 87.5% / 87.5% | 75% | 87.5% / 87.5% |
| held-out | 14 (10 / 4) | 140 | 70% / 80% / 80% | 75% | 80% / 80% |

Held-out keyword shortlist misses: `h03`, `h04` (20 positive trials per limit);
tuning: `t04` (10 per limit). These diagnostics use the positive-score keyword
shortlist, not the production reranker's zero-score-expanded shortlist. They do
not establish the reranker's recall ceiling. Baseline API calls, input/output
tokens, and API cost are exactly zero (no model/pricing date applies). Cache is
disabled: cold/warm cache-hit latency is **not applicable**, not zero. Held-out
p50/p95 tool latency in milliseconds is recorded for every result limit in the
artifact's `reports[1].metrics[].latencyMs` (and tuning in `reports[0]`). These
small synthetic Linux measurements are descriptive, not production promises. Repetitions are not new
independent queries. Paired semantic regressions remain **unmeasured**.

## Harness preparation

The existing runner now emits schema v2: shortlist miss counts/fixture IDs,
observed cache-state latency/sample counts, and actual API-attempt/token totals
with unknown-trial counts. Missing semantic telemetry remains unknown, never zero.
Do not infer cache hits from fast calls or later repetitions. `miss` and `hit`
groups support cold-request versus warm-hit analysis only when an adapter actually
observes those states; report bypasses separately. A fresh process starts with an
empty session cache, but only its first eligible request is necessarily cold.
The adapter may declare `configuration.shortlistLimit` (1–64), distinct from the
keyword diagnostic bound of 20.

`compare.ts` pairs schema-v2 reports by fixture ID, repetition, and result limit.
It rejects changed fixtures, splits, sample coverage, runtime environment, or
installed dependency versions. Its output lists selection/no-match gains and
regressions with both trial counts and unique fixture IDs, so aggregate gains
cannot conceal regressions. It performs no network requests:

```sh
set -euo pipefail
npm run typecheck
npm test
npx tsx test/skill-search-evaluation/compare.ts /tmp/keyword-held-out.json /tmp/semantic-held-out.json > /tmp/paired-held-out.json
```

Inputs must be complete successful runs from the same environment/dependencies.
The comparison supplements both source reports; retain their accuracy, latency,
cache and usage summaries and full rows. Do not compare the older schema-v1
artifact directly; rerun keyword measurement with the schema-v2 harness.

## Remaining work before a live run

1. Obtain explicit authorization naming the exact supported Jev model/version,
   maximum paid requests and USD budget, and approved price source/date. Supply
   the key securely in the process environment; its presence alone is not budget
   authorization. Never dump environment variables or inspect Pi auth storage.
2. Finish the production evaluation bridge described in
   [skill-search-evaluation.md](skill-search-evaluation.md). It must use only the
   synthetic catalog and real registered tool/session/config path, capturing the
   **actual pre-rerank shortlist**, including cache hits and bypasses. Production
   currently exposes final results only; do not reconstruct a shortlist from
   final matches or copy the scoring algorithm. In bounded catalogs a keyword
   fallback can return skills outside the transmitted semantic shortlist; the
   current harness subset invariant must become outcome-aware before measuring
   that case, without hiding the original retrieval miss.
3. Add evaluation-only observation of cache hits/misses, decisions/fallbacks,
   outbound attempts and provider token/billing usage. The production adapter
   currently discards SDK usage when normalizing probabilities. Do not change
   public tool results or retain raw provider payloads to collect telemetry.
   Include failed/time-out attempts even if billing is unavailable; cost stays
   `null` until established. Implement a hard request ceiling and a preflight
   worst-case cost bound before allowing paid execution, not a retrospective
   budget estimate.
4. Record exact SDK version (currently pinned to `@typesafe-ai/sdk` 0.6.0), exact
   immutable model version (or explicitly document that the provider cannot pin
   one), price date/source, currency, billing units, cache discounts, rounding,
   and estimated versus actual cost. Never invent token counts from query bytes.
5. Calibrate only on `tuning`. Freeze model, thresholds, bounds, deadline and cache
   settings before paired held-out runs. Defaults 0.55 top probability and 0.10
   margin are **not calibrated**. Confidence describes concentration of the
   answer distribution, not the probability of being correct. Do not optimize
   these values or select models using held-out results. No tuning occurred in
   this offline preparation.
6. Retain every invocation including cold requests, cache hits, bypasses,
   uncertainties and failures. Include all paid warmup work (prefer no warmup).
   Compare Hit@k, no-match accuracy, actual shortlist misses, paired regressions,
   end-to-end p50/p95, API attempts, tokens and cost with denominators. Establish
   acceptable regression/latency/cost criteria before looking at held-out data.
   A tiny handcrafted dataset cannot justify a general rollout on its own.

## Operator setup and rollback

Install the extension with its declared dependencies; `@typesafe-ai/sdk` 0.6.0 is
already a runtime dependency, not a Pi chat-provider plugin. In a local checkout,
install repository dependencies before loading the extension. Supply
`TYPESAFE_API_KEY` through a secure environment mechanism to the Pi process;
never place it in TOML, reports, shell history, or logs. Pi login credentials and
its chosen chat model are not used by this feature.

Only an operator's **global Bootstrap** `config.toml` can opt in; a project file
cannot. See the [configuration table and exact example](skill-search-reranking.md)
for all bounds, and replace the model placeholder explicitly. Do not enable this
merely to run the offline benchmark. Reload/start a fresh session after changes.

Outbound content is only the normalized query and bounded candidate IDs, names
and descriptions, plus fixed classification instructions/schema and model/auth
information. Defaults: 32 candidates, 2048 query bytes, 256 name bytes, 512
description bytes, 32768 serialized payload bytes. No skill bodies, local paths,
history or Pi prompts are sent. Query/description text itself can contain private
information: bounds are not content redaction. Overlong names are skipped,
descriptions are UTF-8-truncated, and tail candidates are dropped to fit; relevant
skills can therefore be unreachable.

The default end-to-end deadline is 1000 ms (maximum 10000), including lazy SDK
setup. SDK retries are disabled. Exact names bypass networking. Invalid settings,
missing credentials/model, uncertainty, malformed distributions, unsupported
models, network errors and timeout use deterministic unchanged keyword fallback;
accepted semantic no-match intentionally returns no matches. Cancellation/stale
session work terminates rather than being relabeled as a semantic no-match.
Cache stores only gated successes in session memory, defaults to 128 LRU entries
with 300000 ms absolute TTL, and is invalidated on session/catalog/config/key
changes. It is neither persistent nor a promise of provider prompt-cache savings.

To roll back, set the global nested `enabled = false` (or remove that table), then
reload/start a fresh session. Keyword behavior and explicit `/skill:name` loading
remain available. No default enablement, automatic prompt changes, memory
filtering, documentation injection, or skill execution is part of this rollout.
