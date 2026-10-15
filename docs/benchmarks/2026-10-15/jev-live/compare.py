"""Compare Jev on 2026-10-14 and Jev on 2026-10-15; no API calls."""
import hashlib
import json
from pathlib import Path

out = Path(__file__).resolve().parent
root = out.parents[3]
comparisons = []
for split in ["tuning", "held-out"]:
    jev_2026_10_14_path = out / f"jev-2026-10-14-{split}.json"
    jev_2026_10_15_path = out / f"jev-2026-10-15-{split}.json"
    jev_2026_10_14, jev_2026_10_15 = [json.loads(p.read_text()) for p in [jev_2026_10_14_path, jev_2026_10_15_path]]
    old, new = jev_2026_10_14["semantic"], jev_2026_10_15["semantic"]
    for key in ["fixtureSha256", "fixtureVersion", "split", "repetitions", "resultLimits", "catalogSize", "queryCount"]:
        assert old[key] == new[key], key
    assert old["manifest"]["modelVersion"] == new["manifest"]["modelVersion"]
    for key in ["model", "maxRequests", "authorizedMaxUsd", "requestCostCeilingUsd", "timeoutMs",
                "cacheMaxEntries", "cacheTtlMs", "maxCandidates", "maxQueryBytes", "maxNameBytes",
                "maxDescriptionBytes", "maxPayloadBytes", "minProbability", "minMargin"]:
        assert old["manifest"]["configuration"][key] == new["manifest"]["configuration"][key], key
    oldrows = {(r["caseId"], r["trial"], r["limit"]): r for r in old["rows"]}
    newrows = {(r["caseId"], r["trial"], r["limit"]): r for r in new["rows"]}
    assert oldrows.keys() == newrows.keys()
    metrics = []
    for before, after in zip(old["metrics"], new["metrics"]):
        limit = after["limit"]
        changes = {}
        for field in ["selectionHit", "noMatchHit"]:
            changes[field] = {
                name: sorted({key[0] for key, row in oldrows.items()
                              if key[2] == limit and row[field] is a and newrows[key][field] is b})
                for name, a, b in [("gains", False, True), ("regressions", True, False)]
            }
        fields = ["selectionAccuracy", "noMatchAccuracy", "shortlistRecall"]
        metrics.append({
            "limit": limit, "jev_2026_10_14": {k: before[k] for k in fields},
            "jev_2026_10_15": {k: after[k] for k in fields},
            "deltaPercentagePoints": {k: (after[k] - before[k]) * 100 for k in fields},
            "caseChanges": changes,
            "jev_2026_10_14LatencyMs": before["latencyMs"], "jev_2026_10_15LatencyMs": after["latencyMs"],
            "jev_2026_10_14Usage": before["usage"], "jev_2026_10_15Usage": after["usage"],
            "jev_2026_10_15FallbackReasons": after["fallbackReasons"],
        })
    comparisons.append({
        "split": split,
        "jev_2026_10_14Report": str(jev_2026_10_14_path.relative_to(root)),
        "jev_2026_10_15Report": str(jev_2026_10_15_path.relative_to(root)),
        "jev_2026_10_14Sha256": hashlib.sha256(jev_2026_10_14_path.read_bytes()).hexdigest(),
        "jev_2026_10_15Sha256": hashlib.sha256(jev_2026_10_15_path.read_bytes()).hexdigest(),
        "jev_2026_10_14Revision": old["manifest"]["implementationVersion"],
        "jev_2026_10_15Revision": new["manifest"]["implementationVersion"],
        "jev_2026_10_14Configuration": old["manifest"]["configuration"],
        "jev_2026_10_15Configuration": new["manifest"]["configuration"],
        "metrics": metrics,
    })
result = {
    "scope": "Live Jev 1.13.0, v1 12-skill fixtures; same prior budgets/settings; one repetition per split.",
    "caveats": [
        "Historical comparison across separate runs, not controlled attribution to service vs client changes.",
        "Experimental independent fit remains disabled, matching prior Choice-only settings.",
        "Billed USD is unknown; approved historical pricing assumptions are not verified jev_2026_10_15 billing.",
        "Sequential limits share cache; limit-3/5 latency is not an independent cold latency sample.",
    ],
    "comparisons": comparisons,
}
(out / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
for c in comparisons:
    calls = sum(m["jev_2026_10_15Usage"]["apiCalls"]["knownTotal"] for m in c["metrics"])
    print(c["split"], "actual requests", calls)
    for m in c["metrics"]:
        print(m["limit"], m["deltaPercentagePoints"], m["caseChanges"])
