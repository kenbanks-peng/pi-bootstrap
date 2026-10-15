# Scale and agent-load evaluation (v2)

This is an **offline synthetic suite**, not a rollout recommendation. No production code, defaults, discovery, or lazy-loading behavior changes. The [original v1 fixtures, baseline artifacts and live runner](skill-search-evaluation.md) remain available. The cookbook is design inspiration, not measured evidence.

## Offline scale suite

```sh
set -euo pipefail
npm run typecheck
npm test
for size in 128 256; do
  for split in tuning held-out; do
    npx tsx test/skill-search-evaluation/scale.ts "$split" "$size" 1 > "/tmp/skills-$size-$split.json"
  done
done
npx tsx --test test/skill-search-scale-evaluation.test.ts
git diff --check
```

`scale-fixtures.ts` freezes versions `skill-search-scale-v2-128` and `skill-search-scale-v2-256`. Counts are **eligible unique skills**, excluding disabled/duplicate entries. Each has 62 queries: 30 tuning, 32 held-out. All original 26 queries are retained, including the historical `h10` disabled-skill regression. The additions cover:

- Zero-token-overlap paraphrases for two `zzz-*` capabilities beyond alphabetical index 64.
- Near-identical TLS client/server certificates, PostgreSQL/MySQL backups, S3/Azure storage, and iOS/Android signing.
- Unsupported Oracle, Google storage, Windows signing, and certificate-related lookalikes requiring abstention.
- Four multi-skill tasks (two per split).
- Exact names and overlapping paraphrases across distinct infrastructure products. A frozen product/action cross-product supplies additional plausible skills; it is templated synthetic data, not 256 independently authored real-world capabilities.

The smaller catalog is a subset of the larger one. Splits share capability classes but not normalized query strings; they are **not** independent catalog generalization tests. Do not tune from held-out labels, choose thresholds/models based on held-out outcomes, or treat repetitions as distinct queries. Any future label/catalog revision needs a new fixture version. Nothing was calibrated here.

The scale CLI imports no executable adapters and performs no network requests, even if credentials exist. It reuses the actual registered keyword tool and existing replay harness at limits 1/3/5. Repetitions are bounded 1–100 (default 1). Reports include version, fixture SHA-256, source hashes, revision, installed dependency versions, environment, and bounded per-trial rows without metadata text or paths.

### Interpretation and initial offline observation

Selection Hit@k still means **any** acceptable skill. For tasks with `required`, `allRequiredAccuracy` instead requires **every** required skill within k, with its own `requiredTrials` denominator. `requiredShortlistRecall` measures required-skill coverage before final selection. Returning one skill on a two-skill task can pass Hit@k but fail task completion. Paired comparison adds all-required gains/regressions without combining them with ordinary selection scores.

Always compare final accuracy with shortlist recall/hit rate, shortlist miss IDs, no-match accuracy, and observed decision/shortlist kind. Tests exercise the real production semantic/SDK path with an injected **mock abstaining transport**, including bounded candidate metadata, exact-name bypass and paired regressions. These tests demonstrate instrumentation and bounds, **not semantic quality**; retrieval improvements can change observed misses without changing labels.

Initial keyword observation on base `2d7af82` (one repetition; both sizes had the same scores):

| Split | Distinct positive / negative | Hit@1 / 3 / 5 | Shortlist recall | No-match | All-required @1 / 3 / 5 |
|---|---|---|---|---|---|
| tuning | 24 / 6 | 83.33 / 87.50 / 87.50% | 87.50% | 50% | 0 / 100 / 100% |
| held-out | 26 / 6 | 80.77 / 84.62 / 84.62% | 84.62% | 50% | 0 / 100 / 100% |

The keyword shortlist bound was 20; all-required denominators were two tasks per split per limit. Calls/tokens/cost were zero. Tuning misses: `t04, st01, st02`; held-out misses: `h03, h04, sh01, sh02`. These are small handcrafted descriptive observations, not a latency or semantic claim. Reproduce with the commands above; each report binds the actual source and fixtures.

## Optional agent-load check

Search success does not establish that an agent read the right instructions. Run the separate, explicitly optional offline check:

```sh
set -euo pipefail
npx tsx test/skill-search-evaluation/agent.ts mock held-out 256 > /tmp/agent-load-mock.json
# Only after an independently authorized run has produced a sanitized local trace:
npx tsx test/skill-search-evaluation/agent.ts audit held-out 256 /tmp/synthetic-agent-trace.json > /tmp/agent-load-audit.json
```

`mock` writes **synthetic-only** SKILL.md bodies into a disposable local directory, invokes real keyword search, then uses a scripted driver to read every returned skill. It hashes bytes actually read and cleans up before emitting success. It is labeled `evidence: "mock"`: useful wiring evidence, never evidence of an autonomous agent choosing to load a skill.

`audit` only reads a local JSON file (maximum 1 MiB), never starts an agent or imports executable adapters. It accepts `evidence: "external-agent-trace-unverified"` only. An external collector must observe successful search/read tool completions in chronological order, hash the **actual complete read response bytes**, and map local synthetic paths to sorted eligible catalog indexes before writing a trace. The collector must use exactly `syntheticBody(name)` from the versioned fixture, not user skill bodies. It must not include prompts, response text, history, credentials, paths, or raw transcripts. This suite provides no paid agent launcher or capture integration; authorizing/capturing a real run is separate work.

Trace shape (supply exactly one sample for **every** case in the selected split):

```ts
{
  schemaVersion: 1,
  evidence: "external-agent-trace-unverified",
  fixtureSha256: agentFixtureHash(fixture.catalog, fixture.queries),
  split: "held-out",
  cases: [{
    caseId: "h01",
    events: [
      { kind: "search", returned: [/* 0–5 sorted eligible catalog indexes */] },
      { kind: "read", index: 123, bodySha256: "/* SHA-256 of synthetic read bytes */", complete: true }
    ]
  } /* remaining cases */]
}
```

There are at most 32 events per case. Unknown fields, wrong versions/hashes/indexes, non-synthetic body hashes, duplicate/missing cases, oversized search results and incomplete files are rejected without a success report. The fixture hash has the same `{skills,cases}` basis as the search harness; catalogs are decoded with production `skillCatalog`.

Metrics separate search hits from complete correct loads **after a search returning that skill**, conditional load accuracy given a search hit, all-required loads, strict no-match search/load behavior, wrong loaded skills, and premature/incomplete/unselected reads. A read before search, a partial read or a read not returned by the most recent search does not satisfy load success. Empty/unsuccessful searches alone do not count as agent-load success on positive cases. No-match load success requires a search and zero reads. Results contain only IDs/counts/booleans/hashes, not body text or local paths.

External traces are supplied observations, not authenticated proof. A collector can lie; hashes only bind claimed bytes to the synthetic fixture. Every report sets `realAgentBehaviorVerified: false` and preserves the evidence class (plus input trace hash for audits). **No real agent run was performed by this change.** Do not mix mock, external trace, and measured real-agent claims.

## Optional live scale search: existing gate only

No paid calls were made for this work. The existing `live.ts` accepts an optional final profile `128` or `256`:

```sh
set -euo pipefail
# Requires separate explicit authorization; NOT part of offline checks.
npx tsx test/skill-search-evaluation/live.ts tuning 1 /path/to/approved-authorization.json 256 > /tmp/live-scale-tuning.json
```

All [existing authorization, credential, request/USD and pricing gates](skill-search-rollout.md#runnable-paired-live-path-requires-explicit-authorization) remain in force. One repetition conservatively requires 90 request slots for tuning or 96 for held-out; repetitions multiply this bound. No hidden warming, model discovery, retries, or new default enablement. This reuses the existing production bridge and paired reporting, not a second benchmark implementation. Without the final profile, v1 behavior remains unchanged. Metadata-only production payloads remain unchanged; agent bodies are **never** passed into this bridge. A separate agent authorization cannot be inferred from search authorization.

## Historical live evidence (not v2 evidence)

The retained `.aven/measurements/jev-1.13.0-{tuning,held-out}.json` reports were inspected locally. Their source hashes match their recorded revision **`f045e005f55d2f21398d21b7d42386597e6b1b21`**, not current base sources: later commits changed the reranking config and contract files. Report SHA-256 values:

- tuning: `e0c8a7e636fc78350c72cb9fa998922b9b0692b82704e1c06d0db4b7642dbecf`
- held-out: `b3986a02740889237fe2614239182160c8dfc10f81ff8f6681bb01268c1ee32f`

Those v1 reports record 24 actual calls (10 tuning, 14 held-out), held-out Hit@1/3/5 of 100%, and a no-match regression from keyword 75% to semantic 50%, identified as `h10`. They are historical small-sample search evidence only, not a v2 scale result, invoice measurement, real-agent loading result, or justification to enable reranking by default. Some older rollout prose predates those measurements; it must not be read as saying semantic search was never measured. Retain keyword default and require new explicit authorization for any further live benchmark.
