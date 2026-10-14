import assert from "node:assert/strict";
import { test } from "node:test";
import { catalog, queries, resultLimits } from "./skill-search-evaluation/fixtures.ts";
import { evaluate, keywordAdapter, scoreResult, validateFixtures, type ReplayAdapter } from "./skill-search-evaluation/harness.ts";

const baseline = () => keywordAdapter(catalog, "test-source");

test("fixtures cover every category in disjoint tuning and held-out splits", () => {
  validateFixtures(catalog, queries);
  for (const split of ["tuning", "held-out"]) {
    assert.deepEqual([...new Set(queries.filter(q => q.split === split).map(q => q.category))].sort(),
      ["ambiguous", "disabled", "duplicate", "exact", "no-match", "paraphrase"].sort());
  }
  assert.throws(() => validateFixtures(catalog, [...queries, queries[0]]), /Duplicate/);
  assert.throws(() => validateFixtures(catalog, [{ ...queries[0], acceptable: ["manual-deploy"] }]), /Invalid/);
});

test("baseline invokes production ranking and excludes disabled/duplicate metadata", async () => {
  const adapter = baseline();
  assert.deepEqual((await adapter.search("CODE-REVIEW", 1)).matches, ["code-review"]);
  assert.deepEqual((await adapter.search("orbital rollout", 5)).matches, []);
  assert.deepEqual((await adapter.search("quasar duplicateignored", 5)).matches, []);
  const result = await adapter.search("review", 1);
  assert.equal(result.matches.length, 1);
  assert.ok(result.shortlist.length > 1);
  assert.equal(result.apiCostUsd, 0);
  assert.ok(result.latencyMs >= 0);
});

test("selection hit, strict abstention, and macro shortlist recall have distinct denominators", () => {
  const q = queries.find(q => q.category === "ambiguous")!;
  const result = { matches: ["testing", "code-review"], shortlist: ["testing", "code-review"], latencyMs: 1, apiCostUsd: 0 };
  assert.deepEqual(scoreResult(q, result, 1), { selectionHit: false, noMatchHit: null, shortlistRecall: 0.5, shortlistHit: true });
  assert.equal(scoreResult(q, result, 3).selectionHit, true);
  const negative = queries.find(q => !q.acceptable.length)!;
  assert.equal(scoreResult(negative, result, 5).noMatchHit, false);
  assert.equal(scoreResult(negative, { ...result, matches: [] }, 5).noMatchHit, true);
});

test("evaluation replay records fixed limits, split, costs, versions and privacy-safe rows", async () => {
  const result = await evaluate(baseline(), { split: "held-out", repetitions: 2 });
  assert.equal(result.rows.length, queries.filter(q => q.split === "held-out").length * resultLimits.length * 2);
  assert.deepEqual(result.metrics.map(m => m.limit), [...resultLimits]);
  assert.equal(result.manifest.modelVersion, null);
  assert.match(result.fixtureSha256, /^[a-f0-9]{64}$/);
  for (const metric of result.metrics) {
    assert.equal(metric.knownApiCostUsd, 0);
    assert.equal(metric.unknownCostTrials, 0);
    assert.ok(metric.latencyMs.p95! >= metric.latencyMs.p50!);
  }
  const text = JSON.stringify(result);
  for (const q of queries) assert.ok(!text.includes(q.query));
  assert.ok(!text.includes("/synthetic-skills/") && !text.includes("primary sources"));
  assert.ok(result.rows.every(r => r.caseId.startsWith("h")));
  assert.deepEqual(result.metrics.map(m => m.selectionAccuracy), [0.7, 0.8, 0.8]);
  assert.ok(result.metrics.every(m => m.noMatchAccuracy === 0.75 && m.shortlistHitRate === 0.8));
});

test("semantic replay uses same cases; retrieval misses remain visible and unknown costs stay unknown", async () => {
  const adapter: ReplayAdapter = {
    manifest: { mode: "semantic", implementationVersion: "fake-v1", modelVersion: "fake-model-v1", sdkVersion: "fake-sdk-v1", configuration: { confidenceThreshold: 0.8 } },
    async search() { return { matches: [], shortlist: [], latencyMs: 10, apiCostUsd: null }; },
  };
  const result = await evaluate(adapter, { split: "tuning", repetitions: 1 });
  for (const metric of result.metrics) {
    assert.equal(metric.selectionAccuracy, 0);
    assert.equal(metric.shortlistRecall, 0);
    assert.equal(metric.shortlistHitRate, 0);
    assert.equal(metric.noMatchAccuracy, 1);
    assert.equal(metric.unknownCostTrials, 12);
  }
});

test("invalid replay output fails rather than silently skewing measurements", async () => {
  await assert.rejects(evaluate(baseline(), { split: "tuning", repetitions: 0 }), /repetitions/);
  await assert.rejects(evaluate({ ...baseline(), manifest: { ...baseline().manifest, mode: "semantic" } },
    { split: "tuning", repetitions: 1 }), /versions/);
  for (const invalid of [
    { matches: ["manual-deploy"], shortlist: ["manual-deploy"], latencyMs: 1, apiCostUsd: 0 },
    { matches: ["testing"], shortlist: [], latencyMs: 1, apiCostUsd: 0 },
    { matches: ["testing", "testing"], shortlist: ["testing"], latencyMs: 1, apiCostUsd: 0 },
    { matches: [], shortlist: [], latencyMs: NaN, apiCostUsd: 0 },
    { matches: [], shortlist: [], latencyMs: 1, apiCostUsd: -1 },
  ]) {
    await assert.rejects(evaluate({ ...baseline(), search: async () => invalid }, { split: "tuning", repetitions: 1 }), /Adapter|adapter/);
  }
});
