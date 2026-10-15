# Live Jev rerun — 2026-10-15 UTC

**Actual online service calls**, not the earlier offline keyword rerun.
User authorized rerunning with the 2026-10-14 budget/settings. Both splits completed successfully.

- Model/version: **jev-1.13.0**, SDK **0.6.0**.
- Client revision: `448709fae6af4c97e53bae1b41c3878455f94321`.
- Same v1 catalog (12 eligible skills), fixture hashes, limits 1/3/5 and one repetition per split as the 2026-10-14 live reports.
- 2026-10-14 thresholds, candidate/byte bounds, timeout and cache settings preserved; no tuning between splits.
- Conservative ceiling: **36 tuning + 42 held-out = 78 requests**, at **$0.001/request**, totaling **$0.078** within the 2026-10-14 **$0.10** authorization.
- **25 actual requests** (11 tuning, 14 held-out), versus 24 on 2026-10-14. No automatic retries or hidden warmups.
- The experimental independent-fit mode remains **disabled**, matching the 2026-10-14 Choice-only configuration. Current local retrieval and inclusion/ranking code is exercised; this is not an independent-fit evaluation.

## Results: Jev disabled, Jev on 2026-10-14, Jev on 2026-10-15

### Tuning

| Measure | Jev disabled | Jev on 2026-10-14 | Jev on 2026-10-15 |
|---|---:|---:|---:|
| Suitable skill ranked first (Hit@1) | 87.5% | 100% | 100% |
| Suitable skill in top 3 (Hit@3) | 87.5% | 100% | 100% |
| Suitable skill in top 5 (Hit@5) | 87.5% | 100% | 100% |
| Correctly returned nothing — limit 1 | 75% | 50% | **25%** |
| Correctly returned nothing — limit 3 | 75% | 50% | 50% |
| Correctly returned nothing — limit 5 | 75% | 50% | 50% |

### Held-out

| Measure | Jev disabled | Jev on 2026-10-14 | Jev on 2026-10-15 |
|---|---:|---:|---:|
| Suitable skill ranked first (Hit@1) | 70% | 100% | 100% |
| Suitable skill in top 3 (Hit@3) | 80% | 100% | 100% |
| Suitable skill in top 5 (Hit@5) | 80% | 100% | 100% |
| Correctly returned nothing — limit 1 | 75% | 50% | 50% |
| Correctly returned nothing — limit 3 | 75% | 50% | 50% |
| Correctly returned nothing — limit 5 | 75% | 50% | 50% |

**Higher is better throughout.** Jev disabled means keyword-only search; its quality scores match in both runs. Jev on 2026-10-14 and Jev on 2026-10-15 are actual online service runs. Hit@k counts requests with at least one suitable skill among the first k results; it does not prove the agent chose that skill. Correctly returning nothing measures rejection of requests with no suitable skill. Tuning queries are available for adjustment; held-out queries are reserved for evaluation. Neither set was used to adjust settings during this rerun.

Positive denominators are eight tuning and ten held-out cases per limit; no-match denominators are four per split per limit. This small dataset already had ceiling-level positive accuracy, so it cannot demonstrate an accuracy gain beyond 100%.

**No positive-selection gains or regressions.** The only changed success/failure label versus the Jev on 2026-10-14 run is tuning case `t08` at limit 1: correct abstention on 2026-10-14, incorrect match on 2026-10-15. That invocation observed an `invalid-response` fallback; limits 3/5 subsequently abstained correctly. Held-out no-match accuracy remains 50%; the regression versus keyword on `h10` persists. Held-out `h11` fell back as `uncertain` at each limit. No provider or timeout fallbacks were observed.

The paired **current keyword versus Jev on 2026-10-15** comparison is embedded in each raw report. Keyword scores remain tuning 87.5/87.5/87.5%, held-out 70/80/80%, and no-match accuracy 75%. Thus Jev still improves positive selection but worsens abstention on these fixtures.

## Latency, usage and cost

Jev on 2026-10-15 Hit@1 invocation latency (p50 / p95):
- Tuning: **85.04 / 163.98 ms**.
- Held-out: **83.91 / 179.56 ms**.

Limits run sequentially with shared session cache. Many limit-3/5 calls are warm; they must not be presented as cold service latency. Full observed cache groups, dated latency and usage are retained in JSON.

**Billed USD is unknown**, because the SDK exposes tokens, not billed cost. Authorization uses exactly the prior operator-approved pricing assumptions/date, not newly verified provider pricing. Actual outbound token usage totals **21,659 input** and **3,100 output** tokens. At the retained $0.042/M input, output-free assumption, arithmetic estimated cost is **$0.000910**, not an invoice measurement. The conservative allowance for 25 attempted requests is $0.025; neither this nor the token estimate is measured billing.

## Artifacts

- `jev-2026-10-14-{tuning,held-out}.json`: Jev on 2026-10-14 live runs, preserved byte-for-byte in their original JSON report format.
- `jev-2026-10-15-{tuning,held-out}.json`: Jev on 2026-10-15 live runs in the same JSON report format.
- Every report includes **Jev disabled** under `keyword`, **Jev enabled** under `semantic`, plus trial rows, provenance and within-run comparisons.
- `authorization-{tuning,held-out}.json`: exact approved public settings; **no credentials**.
- `comparison.json`: Jev on 2026-10-14 versus Jev on 2026-10-15 results, case-level changes, latency/usage, report hashes and configuration.
- `compare.py`: regenerate the historical comparison locally with no API calls:

```sh
python3 docs/benchmarks/2026-10-15/jev-live/compare.py
```

Historical inputs were moved from `.aven/measurements/` into this directory with consistent `jev-YYYY-MM-DD-*` naming; their bytes and SHA-256 hashes are unchanged. New reports record client source hashes; separate historical runs cannot isolate remote service changes from client implementation changes or model variability. This run makes no rollout or real-agent skill-loading claim.
