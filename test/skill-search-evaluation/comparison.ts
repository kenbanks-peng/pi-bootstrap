import type { evaluate } from "./harness.ts";

type Report = Awaited<ReturnType<typeof evaluate>>;

/** Pair every trial; never hide a baseline success behind an aggregate gain. */
export function compareReports(baseline: Report, semantic: Report) {
  if (baseline.schemaVersion !== 2 || semantic.schemaVersion !== 2 ||
    baseline.manifest.mode !== "keyword" || semantic.manifest.mode !== "semantic") {
    throw new Error("Expected schema-v2 keyword and semantic reports");
  }
  for (const field of ["fixtureVersion", "fixtureSha256", "split", "repetitions", "queryCount", "catalogSize", "resultLimits", "environment"] as const) {
    if (JSON.stringify(baseline[field]) !== JSON.stringify(semantic[field])) {
      throw new Error(`Unpaired report field: ${field}`);
    }
  }
  for (const report of [baseline, semantic]) {
    if (!Number.isSafeInteger(report.queryCount) || report.queryCount < 1 ||
      !Number.isSafeInteger(report.repetitions) || report.repetitions < 1 ||
      JSON.stringify(report.resultLimits) !== "[1,3,5]" ||
      report.rows.length !== report.queryCount * report.repetitions * report.resultLimits.length ||
      new Set(report.rows.map(row => row.caseId)).size !== report.queryCount ||
      report.rows.some(row => !Number.isInteger(row.trial) || row.trial < 0 || row.trial >= report.repetitions ||
        !report.resultLimits.includes(row.limit as 1 | 3 | 5))) throw new Error("Missing or invalid trial coverage");
  }
  const key = (row: Report["rows"][number]) => JSON.stringify([row.caseId, row.trial, row.limit]);
  const baseRows = new Map(baseline.rows.map(row => [key(row), row]));
  const semanticRows = new Map(semantic.rows.map(row => [key(row), row]));
  if (!baseRows.size || baseRows.size !== baseline.rows.length || semanticRows.size !== semantic.rows.length ||
    baseRows.size !== semanticRows.size || [...baseRows.keys()].some(id => !semanticRows.has(id))) {
    throw new Error("Missing or duplicate paired trials");
  }
  for (const [id, row] of baseRows) {
    const other = semanticRows.get(id)!;
    if (row.category !== other.category ||
      (row.selectionHit === null) !== (other.selectionHit === null) ||
      (row.noMatchHit === null) !== (other.noMatchHit === null) ||
      (row.allRequiredHit === undefined) !== (other.allRequiredHit === undefined)) throw new Error("Unpaired labels");
    for (const sample of [row, other]) {
      if (sample.allRequiredHit !== undefined && typeof sample.allRequiredHit !== "boolean") throw new Error("Invalid task score");
      if (!((typeof sample.selectionHit === "boolean" && sample.noMatchHit === null) ||
        (sample.selectionHit === null && typeof sample.noMatchHit === "boolean"))) throw new Error("Invalid trial scores");
    }
  }
  return {
    schemaVersion: 1, fixtureSha256: baseline.fixtureSha256, split: baseline.split,
    baseline: baseline.manifest, semantic: semantic.manifest,
    // These are paired descriptive counts, not independent repeated-query samples
    // or statistical evidence of generalization to a real user catalog.
    metrics: baseline.resultLimits.map(limit => {
      const paired = [...baseRows.values()].filter(row => row.limit === limit).map(row => ({
        baseline: row, semantic: semanticRows.get(key(row))!,
      }));
      const changes = (field: "selectionHit" | "noMatchHit" | "allRequiredHit", from: boolean, to: boolean) => {
        const changed = paired.filter(pair => pair.baseline[field] === from && pair.semantic[field] === to);
        return { trials: changed.length, caseIds: [...new Set(changed.map(pair => pair.baseline.caseId))] };
      };
      return {
        limit, pairedTrials: paired.length, uniqueQueries: new Set(paired.map(pair => pair.baseline.caseId)).size,
        selectionRegressions: changes("selectionHit", true, false), selectionGains: changes("selectionHit", false, true),
        noMatchRegressions: changes("noMatchHit", true, false), noMatchGains: changes("noMatchHit", false, true),
        allRequiredRegressions: changes("allRequiredHit", true, false), allRequiredGains: changes("allRequiredHit", false, true),
      };
    }),
  };
}
