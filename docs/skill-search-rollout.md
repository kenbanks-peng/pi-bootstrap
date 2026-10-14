# Skill-search rollout evaluation: live measurement blocked

## Decision (2026-10-14)

**Keep keyword search as the default. Do not adopt semantic reranking on the
current evidence.** The offline harness, production bridge and mocked integration
checks are ready; actual Jev selection accuracy, no-match accuracy, regressions,
latency, cache behavior, tokens and cost remain **unmeasured**. Offline safety
checks and mock distributions establish plumbing, not semantic quality. Neither
the external Hermes benchmark nor the Jev cookbook establishes performance on
this repository's fixtures.

The worker checked only availability of process `TYPESAFE_API_KEY`, without
printing a value: **absent**. No explicit live model or paid-call budget was
supplied. No provider discovery, paid calls, or live warmups were made. This task
remains active pending the live-only inputs/measurement; completion of offline
preparation is not a claim that the live comparison ran.

## Offline keyword measurements

The current production keyword tool is replayed on synthetic v1 fixtures, 10
repetitions at each limit (1, 3, 5), with a fresh process per split. Registration,
fixture loading and the diagnostic shortlist call are outside measured tool
latency; optional observation overhead is included. Exact provenance, environment,
dependencies, sample counts and p50/p95 milliseconds are retained in
`skill-search-rollout-baseline.json`. Earlier measurements are retained in
`skill-search-baseline.json`. Neither artifact contains semantic measurements.

| Split | Unique queries (positive / negative) | Trials per limit | Hit@1 / Hit@3 / Hit@5 | No-match accuracy | Keyword shortlist hit / recall |
| --- | --- | --- | --- | --- | --- |
| tuning | 12 (8 / 4) | 120 | 87.5% / 87.5% / 87.5% | 75% | 87.5% / 87.5% |
| held-out | 14 (10 / 4) | 140 | 70% / 80% / 80% | 75% | 80% / 80% |

Held-out keyword shortlist misses are `h03`, `h04` (20 positive trials per limit);
tuning miss is `t04` (10 per limit). These use the positive-score keyword shortlist,
not semantic zero-score expansion. Baseline API calls, input/output tokens and
API cost are exactly zero; no model/pricing date applies. Cache is disabled:
cold-miss/warm-hit latency is **not applicable**, not zero. Repetitions are not
independent queries. Synthetic timings are descriptive, not production promises.
Paired semantic gains/regressions remain **unmeasured**.

## Runnable paired live path (requires explicit authorization)

Install repository dependencies first. The runtime dependency is pinned to
`@typesafe-ai/sdk` **0.6.0**, not a Pi chat-provider plugin. Supply `TYPESAFE_API_KEY`
securely to the process; never put it in TOML, reports, shell history, or logs.
Pi login credentials and the selected chat model are not consulted.

Prepare a local **public-settings-only** authorization JSON file. Do not commit a
credential. This deliberately non-authorizing example must be filled in and
explicitly approved before execution:

```json
{
  "authorizePaid": false,
  "model": "<explicit-supported-Jev-model-id>",
  "modelVersion": "<immutable-version-or-explicit-unpinned-alias-disclosure>",
  "maxRequests": 360,
  "maxUsd": 1,
  "requestCostCeilingUsd": 0.001,
  "pricingDate": "2026-10-14",
  "pricingSource": "<approved-current-price-source-and-assumptions>",
  "reranking": {
    "max_candidates": 32,
    "timeout_ms": 1000,
    "cache_max_entries": 128,
    "cache_ttl_ms": 300000,
    "min_probability": 0.55,
    "min_margin": 0.10
  }
}
```

Numbers above are illustrative authorization values, **not provider prices** or
cost estimates. Obtain approval for the exact model, request ceiling and USD
budget. The bridge rejects absent/blank credentials, missing model/version,
missing literal `authorizePaid: true`, nonpositive/invalid limits, missing price
date/source, or `maxRequests * requestCostCeilingUsd > maxUsd`. The per-request
ceiling is an **operator-approved conservative assumption**, not measured billing
or a provider-enforced USD cap. Check the provider's billing terms, currency,
rounding, cache discounts and worst-case charges before approving it; use a
provider-side spending cap if a hard invoice ceiling is required.

The runner requires enough authorized requests for the conservative worst case
of one call per invocation (tuning: 36 × repetitions; held-out: 42 × repetitions),
although exact-name bypasses and gated cache hits reduce actual calls. Request
ceilings are integers 1–100000; repetitions are integers 1–100. A transport guard
stops before any call beyond the ceiling and aborts the run rather than reporting
a budget-refusal fallback as a valid trial. SDK retries are disabled. No unreported
model calls or warmups occur.

Run tuning first, then freeze settings/model before a separate held-out run with
its own approved budget. The commands below are **paid when authorized**:

```sh
set -euo pipefail
npm run typecheck
npm test
npx tsx test/skill-search-evaluation/live.ts tuning 10 /path/to/approved-tuning.json > /tmp/paired-tuning.json
# Only after calibration and freezing all settings, with held-out authorization:
npx tsx test/skill-search-evaluation/live.ts held-out 10 /path/to/approved-held-out.json > /tmp/paired-held-out.json
```

Each run creates a fresh session on the synthetic catalog, runs the actual
registered keyword tool and actual registered opted-in semantic tool sequentially,
and emits both complete reports plus paired comparison, source SHA-256 hashes,
revision and installed direct dependencies. A temporary global Bootstrap config
exercises the normal config/session/resource path; the operator's real config and
skill catalog are never read. Cache persists across queries/limits/repetitions
within the semantic session and is destroyed at shutdown. No full agent turn is
measured. The runner emits JSON only after successful evaluation, pairing and
cleanup; a failure emits a sanitized message and exits nonzero. Discard incomplete
output. A failed paid run can still incur charges; reconcile provider billing
separately. Redirecting output to a temporary file and renaming only after command
success avoids publishing an empty/failed artifact.

The SDK returns token usage but **no billed USD field**. Billed cost is `null` for
any invocation with outbound attempts, even when tokens are known; calls without
an outbound attempt cost zero. Price assumptions do not become measured cost.
Missing/invalid usage and failed/time-out requests retain unknown token counts,
not zero or estimates from bytes. Late responses after timeout do not mutate
reports or contaminate later calls. If a model cannot be immutably pinned,
disclose the moving alias in `modelVersion`; this runner cannot discover or verify
an immutable server version. Do not claim reproducibility stronger than the
provider supports.

## What is observed and validated

Optional internal observation reports only eligible-catalog indexes, bounded
keyword-result indexes, shortlist kind, decision/reason enums and cache state.
The actual request shortlist is observed **before reranking**, including on cache
hits. No query, candidate text, paths, key, response body or provider error is in
this observation. SDK observation contains only transport-attempt events and
validated numeric token counts. Observers cannot alter public tool results; a
throwing observer is ignored. The bridge measures actual transport calls and
isolates each invocation, including timeout/late-response handling. There is no
production logging or extra outbound data.

Schema-v2 replay rows retain actual shortlist membership and explicit observed
`keyword`, `matches`, `no-match` or `fallback` decisions/reasons. Keyword fallback
may return a skill outside the bounded semantic shortlist; it is accepted only
when final matches exactly reproduce the separately observed keyword ordering at
the requested limit. The original semantic shortlist is **not** unioned with
fallback results, so retrieval misses remain visible. Successful semantic matches
must stay inside the actual shortlist; an accepted semantic no-match must be
empty. Keyword bypass uses a keyword diagnostic shortlist (up to 20), distinct
from the configured semantic shortlist bound (1–64). Reports expose shortlist-kind
sample counts. For mixed fallback/bypass runs, overall shortlist hit rate is not
an upper bound on final Hit@k: fallback is a separate retrieval path.

Reports include selection/no-match denominators, shortlist miss trials/fixture
IDs, decision/fallback counts, complete invocation p50/p95, observed cache-state
latency/sample counts, actual API attempts and token totals with unknown-trial
counts. `miss`/`hit` come from the runtime, not repetition number or speed.
Bypasses/cache-disabled calls are separate. Only the first eligible uncached
request in a new process is necessarily cold; expiry/eviction/failures affect
later calls. No synthetic model rankings are published as measurements.

The paired comparison reports selection/no-match gains and regressions with
trial counts and unique fixture IDs; it rejects fixture/split/coverage/runtime
mismatches and duplicate/incomplete trials. For separate complete schema-v2
reports, use the offline CLI (requires matching installed dependency metadata):

```sh
set -euo pipefail
npx tsx test/skill-search-evaluation/compare.ts /tmp/keyword-held-out.json /tmp/semantic-held-out.json > /tmp/paired-regressions.json
```

The bundled live output includes this comparison already. Preserve both source
reports with the comparison, not just aggregate gains. Offline tests inject mock
HTTP distributions through the real SDK/tool; these validate the bridge, bounds,
cache, fallback, usage, runner and comparison, **not semantic quality**.

## Calibration and adoption gates

Tune only on `tuning`. Freeze model/version, thresholds, bounds, deadline, cache
policy, environment, sample/repetition policy and acceptance criteria before
held-out measurement. Default top-probability 0.55/margin 0.10 are **not calibrated**;
no tuning occurred in this work. Confidence is concentration of an answer
distribution, not probability of being correct. Do not choose the best model or
threshold using held-out results. Establish acceptable regressions, p95 latency
and cost before seeing held-out results. Small handcrafted fixtures require
independent expansion/review before a general rollout recommendation.

The only remaining blocker is obtaining approved live inputs (credential, exact
model/version and request/USD/pricing authorization) and running/reporting those
measurements. Until then, evidence supports keeping the existing default only;
there is no recommendation to enable semantic search.

## Operator configuration and rollback

Only an operator's **global Bootstrap** `config.toml` can opt in; a project file
cannot. See the [configuration contract](skill-search-reranking.md) for the exact
example and all accepted values. Reload/start a fresh session after changes. The
benchmark runner uses its own temporary config and does not enable production.

Outbound data is only the normalized query and bounded candidate IDs, names and
descriptions, plus fixed classification instructions/schema and model/auth
information. Defaults: 32 candidates, 2048 query bytes, 256 name bytes, 512
description bytes and 32768 serialized payload bytes. No skill bodies, local
paths, history or Pi prompts are sent. Metadata itself can contain sensitive
text: byte bounds are not redaction. Overlong names are skipped, descriptions
UTF-8-truncated and tail candidates dropped to fit; relevant skills may be lost.

The default end-to-end deadline is 1000 ms (maximum 10000), including lazy SDK
setup. Exact names bypass networking. Invalid settings, missing credentials/model,
uncertainty, malformed distributions, unsupported models, network errors and
timeout use unchanged deterministic keyword fallback; accepted semantic no-match
intentionally returns no results. Cancellation/stale work terminates rather than
being relabeled a semantic no-match. Cache retains only gated successes in session
memory: default 128 LRU entries with 300000 ms absolute TTL, invalidated on
session/catalog/config/key changes. It is not persistent or provider prompt-cache
savings.

Rollback: set global nested `enabled = false` (or remove the table), then reload
or start a fresh session. Keyword search and explicit `/skill:name` stay available.
No default enablement, automatic prompt changes, memory filtering, documentation
injection or skill execution is part of this rollout.
