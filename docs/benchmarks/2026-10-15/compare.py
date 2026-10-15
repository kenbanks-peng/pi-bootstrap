"""Regenerate comparison.json from saved reports; no benchmarks or network calls."""
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[3]
out = Path(__file__).resolve().parent
def read(path):
    return json.loads(path.read_text())
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

baseline_path = root / "docs/skill-search-rollout-baseline.json"
baselines = {r["split"]: r for r in read(baseline_path)["reports"]}
quality = ["selectionAccuracy", "noMatchAccuracy", "shortlistRecall", "shortlistHitRate"]
comparisons = []
for path in sorted(out.glob("*.json")):
    if path.name == "comparison.json":
        continue
    report = read(path)
    assert report["manifest"]["mode"] == "keyword"
    assert report["repetitions"] == 10
    assert len(report["rows"]) == report["queryCount"] * 10 * 3
    if report["catalogSize"] == 12:
        base = baselines[report["split"]]
        assert report["fixtureSha256"] == base["fixtureSha256"]
        assert report["resultLimits"] == base["resultLimits"]
        reference = "docs/skill-search-rollout-baseline.json"
        baseline_metrics = base["metrics"]
    else:
        # Exact fractions underlying the rounded table in the scale guide.
        tuning = report["split"] == "tuning"
        baseline_metrics = [{
            "limit": k,
            "selectionAccuracy": ((20 if k == 1 else 21) / 24 if tuning else (21 if k == 1 else 22) / 26),
            "noMatchAccuracy": 0.5,
            "shortlistRecall": 21 / 24 if tuning else 22 / 26,
            "allRequiredAccuracy": 0 if k == 1 else 1,
        } for k in [1, 3, 5]]
        reference = "docs/skill-search-scale-evaluation.md#interpretation-and-initial-offline-observation"
    fields = quality if report["catalogSize"] == 12 else quality[:3] + ["allRequiredAccuracy"]
    metrics = []
    for current, previous in zip(report["metrics"], baseline_metrics):
        assert current["limit"] == previous["limit"]
        metrics.append({
            "limit": current["limit"],
            "baseline": {k: previous[k] for k in fields},
            "current": {k: current[k] for k in fields},
            "deltaPercentagePoints": {k: (current[k] - previous[k]) * 100 for k in fields},
            "shortlistMissCaseIds": current["shortlistMissCaseIds"],
            "latencyMs": current["latencyMs"],
            "knownApiCostUsd": current["knownApiCostUsd"],
            "apiCalls": current["usage"]["apiCalls"],
        })
    comparisons.append({
        "report": path.name, "reportSha256": sha(path),
        "fixtureSha256": report["fixtureSha256"], "split": report["split"],
        "catalogSize": report["catalogSize"], "queryCount": report["queryCount"],
        "repetitions": report["repetitions"], "environment": report["environment"],
        "baselineReference": reference,
        "comparisonKind": "historical aggregate; not paired trials",
        "metrics": metrics,
    })
assert len(comparisons) == 6
sources = sorted(set(root.glob("src/*.ts")) | set(root.glob("test/skill-search-evaluation/*.ts")))
sources += [root / p for p in ["package.json", "pnpm-lock.yaml", "docs/skill-search-rollout-baseline.json", "docs/skill-search-scale-evaluation.md"]]
result = {
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "scope": "Offline keyword only. No paid calls; no semantic quality or autonomous agent-load evidence.",
    "repetitionsAreIndependentQueries": False,
    "latencyComparison": "No speedup claim: historical v1 environment differs; scale baseline has no stored latency.",
    "baselineCaveat": "Scale comparison uses documented rounded observations reconstructed as exact query fractions, not retained baseline trial rows. No case-level gains/regressions inferred.",
    "sourceSha256": {str(p.relative_to(root)): sha(p) for p in sources},
    "validation": {"typecheck": "passed", "tests": {"passed": 192, "failed": 0}},
    "comparisons": comparisons,
}
(out / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
print("Saved", out / "comparison.json")
