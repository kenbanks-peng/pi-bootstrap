# Skill-search benchmark rerun — 2026-10-15 UTC

**Follow-up:** the separately authorized [actual live Jev rerun and historical comparison](jev-live/README.md) is now complete. The results below remain the offline keyword-only snapshot.

Measured revision: `448709fae6af4c97e53bae1b41c3878455f94321` (clean working tree before measurement).
All six runs used **10 repetitions**, limits **1/3/5**, sequentially, with no hidden warmup.
There were **4,500 measured search invocations** across 150 split/catalog query instances; repetitions are not independent queries. Diagnostic shortlist calls are additional, local-only work.

## Results

Percentages; Hit columns are final selection accuracy, not precision.

| Catalog | Split | Distinct positive / negative | Hit@1 / 3 / 5 | Shortlist recall | Correct no-match | All-required @1 / 3 / 5 |
|---|---|---|---|---|---|---|
| v1, 12 | tuning | 8 / 4 | 87.50 / 87.50 / 87.50 | 87.50 | 75 | n/a |
| v1, 12 | held-out | 10 / 4 | 70.00 / 80.00 / 80.00 | 80.00 | 75 | n/a |
| v2, 128 | tuning | 24 / 6 | 83.33 / 87.50 / 87.50 | 87.50 | 50 | 0 / 100 / 100 |
| v2, 128 | held-out | 26 / 6 | 80.77 / 84.62 / 84.62 | 84.62 | 50 | 0 / 100 / 100 |
| v2, 256 | tuning | 24 / 6 | 83.33 / 87.50 / 87.50 | 87.50 | 50 | 0 / 100 / 100 |
| v2, 256 | held-out | 26 / 6 | 80.77 / 84.62 / 84.62 | 84.62 | 50 | 0 / 100 / 100 |

**Every compared quality metric changed by 0 percentage points.** API calls, tokens and cost were zero, with no unknown usage/cost trials. Scale all-required denominators are two distinct tasks per split, repeated ten times.

Historical references:
- v1: [stored rollout baseline](../../skill-search-rollout-baseline.json), same fixture hash and result limits; the original [v1 baseline](../../skill-search-baseline.json) records the same quality scores.
- v2: [initial keyword observations](../../skill-search-scale-evaluation.md#interpretation-and-initial-offline-observation) on base `2d7af82`, one repetition. The comparison reconstructs exact query fractions from that rounded table. No historical scale trial file was available, so this is an **aggregate comparison**, not a paired case-level regression analysis.

Remaining shortlist misses:
- v1 tuning: `t04`; held-out: `h03, h04`.
- Both scale sizes, tuning: `t04, st01, st02`; held-out: `h03, h04, sh01, sh02`.

Complete per-limit p50/p95 latency and miss IDs are in [comparison.json](comparison.json). Current held-out Hit@1 search latency (p50 / p95, milliseconds): **0.0135 / 0.0228** for 12 skills, **0.1158 / 0.1625** for 128, **0.2404 / 0.4743** for 256. These include tool execution, not agent-turn latency. Historical v1 measurements used a different environment, and the historical scale table has no latency data; **no speedup/regression claim** is made.

## Scope and interpretation

This rerun exercises the registered production **keyword** search path only. Recent enhancements include opt-in local semantic shortlist retrieval, Choice ranking/inclusion changes, and independent candidate fit. The unchanged keyword results **do not establish that those enhancements improve or regress semantic selection**.

The 192 passing tests include mocked production semantic transport tests, but mocks demonstrate contracts/plumbing, not model quality. No live semantic calls, autonomous agent runs, threshold tuning or held-out model selection occurred. Historical paid semantic reports are not a comparable current semantic run. A new live comparison remains pending explicit provider/model, pricing and request/USD budget authorization through the existing gated runner.

## Stored artifacts and reproduction

- `v1-{tuning,held-out}.json`: full current v1 reports.
- `scale-{128,256}-{tuning,held-out}.json`: full current scale reports.
- `comparison.json`: historical metrics, current metrics, percentage-point deltas, current latency, source/report hashes, revision and validation summary.
- `compare.py`: regenerate comparison from saved reports; makes no network calls.
- `tests.log`, `typecheck.log`: validation output (**192/192 tests passed**, typecheck passed).

From repository root, with installed dependencies:

```sh
set -euo pipefail
out=docs/benchmarks/2026-10-15
npm run typecheck > "$out/typecheck.log" 2>&1
npm test > "$out/tests.log" 2>&1
for split in tuning held-out; do
  npx tsx test/skill-search-evaluation/run.ts "$split" 10 > "$out/v1-$split.json"
done
for size in 128 256; do
  for split in tuning held-out; do
    npx tsx test/skill-search-evaluation/scale.ts "$split" "$size" 10 > "$out/scale-$size-$split.json"
  done
done
python3 "$out/compare.py"
git diff --check
```

Each report records installed direct dependency versions and environment. Supplementary source hashes in the comparison cover all production TypeScript modules and evaluation sources, including the local retrieval source that the offline entry points do not hash themselves. Existing historical artifacts remain unchanged. Use a fresh dated directory for future measurements rather than overwriting this snapshot; the validation summary in `compare.py` describes this specific run.
