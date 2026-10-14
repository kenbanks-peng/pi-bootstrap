# Skill-search reranking acceptance verification

Contract: [skill-search-reranking.md](skill-search-reranking.md). This is an
offline compatibility/privacy verification, **not an adoption benchmark**.
No provider service, live credential, or chat model is needed.

## Independent evidence

`test/bootstrap-skills-reranking-acceptance.test.ts` drives the registered tool
through the actual `@typesafe-ai/sdk` with injected HTTP responses. Its keyword
oracle is the committed **pre-reranking** `skill-search-baseline.json`, not a copy
of the current scoring algorithm. Both disabled searches and SDK-error fallbacks
replay every first-trial tuning/held-out outcome at limits 1, 3, and 5; ordering,
metadata, paths and unsliced totals must equal that independent baseline.

| Contract area | Evidence |
| --- | --- |
| Default/local behavior and consent | Baseline replay asserts zero disabled SDK constructions/requests; unavailable consent, invalid config, absent/blank credentials and invalid inputs are exercised separately. Existing config unit tests cover all numeric bounds, missing files, global-only consent and sanitized diagnostics. |
| Query/candidate privacy bounds | Actual HTTP state and enclosing SDK field allowlists are asserted. UTF-8 description/name/query bounds, escaped JSON payload size, tail dropping, contiguous IDs, duplicate/excluded skills and candidates beyond result limit are tested. Existing request-builder tests additionally exercise byte-boundary truncation and no-fit bypass. |
| Exact/empty bypass and compatibility | Frozen baseline includes exact names, Unicode, duplicates and excluded skills. Session changes clear the catalog without network calls. Returned metadata is reconstructed locally and is mutation-isolated. |
| Explicit invocation and lazy loading | The installed Pi `AgentSession` explicit skill-command expansion is exercised against a temporary instruction file, including a disabled skill and arguments. The test calls that internal method with a minimal resource-loader receiver; it does not create a chat session or make a model call. Outbound HTTP assertions exclude its body/path. |
| Validation and decisions | SDK tests distinguish explicit no-match from incomplete/foreign IDs, malformed/oversized responses, low/ambiguous probabilities, missing probabilities despite high SDK confidence, and auth/rate-limit/network failures. Existing distribution unit tests cover duplicates, types, finite/range/sum checks, near-one normalization, ties, margin, qualifying totals and limits. |
| Confidence limitations | A deliberately wrong probability-1 selection for a labeled no-match query is accepted: distribution gates cannot guarantee correctness. SDK `choice`/`confidence` labels do not override the probability distribution. |
| Deadline, retry and cancellation | Real SDK stalled-body tests verify abort, body cancellation, baseline fallback, no retries and no timeout caching. Lifetime regressions verify cancellation/invalidation before lazy dispatch and cleanup when a transport ignores abort. Existing concurrency tests verify independent signals and rejection/discarding of stale work. |
| Cache | SDK tests verify normalized-query hits across result limits, fresh reconstructed results, credential/path/model invalidation, startup/new/resume/fork/reload and shutdown. Existing clock-controlled runtime tests verify miss/hit, absolute expiry, LRU eviction, metadata/settings keys, zero-cache settings, and successful no-match-only caching. |
| Prompt scope | Extended `bootstrap-skills.test.ts` verifies disabled searches do not read credentials or construct adapters, add no prompt hooks/commands, and do not change transformation results/history. All existing prompt/bootstrap transformation tests remain part of the project check. `index.ts` is unchanged. |

## Repairs uncovered by independent verification

1. The lazy adapter microtask could run after tool cancellation or state
   invalidation. Check its owned signal before constructing/invoking the adapter.
2. The bounded HTTP reader relied entirely on the transport to honor abort after
   headers. Cancel its reader on abort, check the signal around reads, and remove
   the listener on completion. An ignored transport signal must not leave a
   response body read running indefinitely after the tool deadline.

Both were reproduced by failing lifetime regressions before repairing production
code. Repairs do not change ranking, public results, configuration or prompt logic.

## Reproduction

```bash
set -euo pipefail
node --import tsx --test test/bootstrap-skills-reranking-{acceptance,lifetime}.test.ts
npm test
npm run typecheck
git diff --check
```

Remaining work: repository/model-specific selection accuracy, no-match accuracy,
latency and billed cost evaluation before recommending opt-in adoption. Mocked
responses cannot establish service availability, probability calibration or real
model quality; they verify the implementation contract only.
