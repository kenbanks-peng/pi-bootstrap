import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockAdapter, createLiveAdapter, type ProductionOptions } from "./skill-search-evaluation/production.ts";
import { evaluate, keywordAdapter } from "./skill-search-evaluation/harness.ts";
import { compareReports } from "./skill-search-evaluation/comparison.ts";
import { catalog, queries } from "./skill-search-evaluation/fixtures.ts";
import { createJevAdapter } from "../src/bootstrap-skills-jev.ts";
import { registerLazySkills } from "../src/bootstrap-skills.ts";

const options: ProductionOptions = { model: "mock-model", modelVersion: "mock-v1-not-live", implementationVersion: "mock-test", maxRequests: 1000 };
const certain = (init?: RequestInit, select: string | null = null, usage: unknown = { input_tokens: 5, output_tokens: 2 }) => {
  const { state } = JSON.parse(init!.body as string);
  return Response.json({ answers: { selection: { type: "choice", probabilities: Object.fromEntries([
    ...state.candidates.map((c: { id: string; name: string }) => [c.id, c.name === select ? 1 : 0]), ["no_match", select === null ? 1 : 0],
  ]) } }, usage });
};
async function mock(t: TestContext, fetcher: typeof fetch, reranking?: Record<string, unknown>, maxRequests = 1000) {
  const adapter = await createMockAdapter(catalog, { ...options, reranking, maxRequests }, fetcher);
  t.after(() => adapter.close?.());
  return adapter;
}

test("production bridge replays registered semantic tool and SDK, cache/bypass, usage and paired regressions", async t => {
  let calls = 0;
  const adapter = await mock(t, async (_input, init) => {
    calls++;
    assert.ok(!String(init!.body).includes("/synthetic-skills/"));
    return certain(init);
  });
  const report = await evaluate(adapter, { split: "held-out", repetitions: 2 });
  const comparison = compareReports(await evaluate(keywordAdapter(catalog, "mock-test"), { split: "held-out", repetitions: 2 }), report);
  assert.equal(report.rows.length, 84);
  assert.ok(calls > 0 && calls < 14);
  assert.equal(report.rows.reduce((sum, row) => sum + row.telemetry.apiCalls!, 0), calls);
  const misses = report.rows.filter(row => row.telemetry.cache === "miss");
  const hits = report.rows.filter(row => row.telemetry.cache === "hit");
  assert.equal(misses.length, calls);
  assert.ok(hits.length > misses.length);
  assert.ok(misses.every(row => row.telemetry.inputTokens === 5 && row.telemetry.outputTokens === 2 && row.apiCostUsd === null));
  assert.ok(hits.every(row => row.telemetry.apiCalls === 0 && row.telemetry.inputTokens === 0 && row.apiCostUsd === 0));
  assert.ok(report.rows.some(row => row.observation?.reason === "exact" && row.telemetry.cache === "bypass"));
  assert.ok(report.rows.filter(row => row.observation?.shortlistKind === "semantic").every(row => row.shortlist.length === 12));
  assert.ok(comparison.metrics.some(metric => metric.selectionRegressions.trials > 0));
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("mock-key") && !serialized.includes("synthetic-skills") && !serialized.includes("probabilities"));
  for (const query of queries) assert.ok(!serialized.includes(query.query));
});

test("semantic shortlist is actual bounded input; provider fallback may leave it without hiding retrieval misses", async t => {
  const adapter = await mock(t, async () => Response.json({ error: "PRIVATE_ERROR" }, { status: 503 }), { max_candidates: 1 });
  const result = await adapter.search("review", 5);
  assert.equal(result.shortlist.length, 1);
  assert.ok(result.matches.length > 1);
  assert.equal(result.observation?.decision, "fallback");
  assert.equal(result.observation?.reason, "provider");
  assert.equal(result.telemetry?.apiCalls, 1);
  assert.equal(result.telemetry?.inputTokens, null);
  assert.equal(result.apiCostUsd, null);
  assert.deepEqual(result.matches, (await keywordAdapter(catalog, "mock-test").search("review", 5)).matches);
  const report = await evaluate(adapter, { split: "tuning", repetitions: 1 });
  assert.ok(report.rows.some(row => row.observation?.decision === "fallback" && row.matches.some(index => !row.shortlist.includes(index))));
  assert.ok(report.metrics.some(metric => metric.shortlistMissTrials > 0));
  assert.ok(report.metrics.some(metric => metric.fallbackReasons.provider > 0));
  await assert.rejects(evaluate({ ...adapter, async search(query, limit) {
    const value = await adapter.search(query, limit);
    return { ...value, matches: ["translations"], observation: value.observation };
  } }, { split: "tuning", repetitions: 1 }), /Fallback must reproduce/);
});

test("gated match/no-match, uncertainty, invalid answer, bounds, disabled cache and unknown usage are observed", async t => {
  const select = await mock(t, async (_input, init) => certain(init, "testing", { input_tokens: -1, output_tokens: 1.5 }), { cache_max_entries: 0 });
  const match = await select.search("prevent broken changes", 1);
  assert.deepEqual(match.matches, ["testing"]);
  assert.equal(match.observation?.decision, "matches");
  assert.equal(match.telemetry?.cache, "disabled");
  assert.equal(match.telemetry?.inputTokens, null);
  assert.equal(match.telemetry?.outputTokens, null);
  const uncertain = await mock(t, async (_input, init) => {
    const { state } = JSON.parse(init!.body as string);
    return Response.json({ answers: { selection: { type: "choice", probabilities: Object.fromEntries([
      ...state.candidates.map((c: { id: string }) => [c.id, 1 / (state.candidates.length + 1)]), ["no_match", 1 / (state.candidates.length + 1)],
    ]) } }, usage: { input_tokens: 3, output_tokens: 4 } });
  });
  const uncertainResult = await uncertain.search("review", 5);
  assert.equal(uncertainResult.observation?.reason, "uncertain");
  assert.equal(uncertainResult.telemetry?.inputTokens, 3);
  const invalid = await mock(t, async () => Response.json({ answers: { selection: { type: "choice", probabilities: { no_match: 1 } } } }));
  const invalidResult = await invalid.search("review", 5);
  assert.equal(invalidResult.observation?.reason, "invalid-response");
  assert.equal(invalidResult.telemetry?.outputTokens, null);
  const bounds = await mock(t, async () => { throw new Error("must not call"); }, { max_query_bytes: 1 });
  const bounded = await bounds.search("review", 5);
  assert.deepEqual(bounded.shortlist, []);
  assert.equal(bounded.observation?.reason, "bounds");
  assert.equal(bounded.telemetry?.apiCalls, 0);
  assert.equal(bounded.apiCostUsd, 0);
  await evaluate(bounds, { split: "held-out", repetitions: 1 });
});

test("deadline reports actual attempts and unknown usage, late SDK responses do not contaminate later calls", async t => {
  let finish!: () => void;
  let calls = 0;
  const adapter = await mock(t, async (_input, init) => {
    if (++calls === 1) return new Promise<Response>(resolve => { finish = () => resolve(certain(init)); });
    return certain(init);
  }, { timeout_ms: 100 });
  const timed = await adapter.search("review", 5);
  assert.equal(timed.observation?.reason, "timeout");
  assert.equal(timed.telemetry?.apiCalls, 1);
  assert.equal(timed.telemetry?.inputTokens, null);
  finish();
  const next = await adapter.search("prevent broken changes", 1);
  assert.equal(next.telemetry?.apiCalls, 1);
  assert.equal(next.telemetry?.inputTokens, 5);
});

test("request ceiling stops before outbound transport, fails run rather than reporting budget fallback", async t => {
  let calls = 0;
  const adapter = await mock(t, async (_input, init) => { calls++; return certain(init); }, { cache_max_entries: 0 }, 1);
  await adapter.search("review", 1);
  await assert.rejects(adapter.search("review", 1), /request ceiling/);
  assert.equal(calls, 1);
  await adapter.close?.();
  await assert.rejects(adapter.search("review", 1), /open-session/);
});

test("SDK observation contains only sanitized numeric telemetry and failing listeners cannot affect decisions", async () => {
  const events: unknown[] = [];
  const adapter = createJevAdapter("PRIVATE_KEY", async (_input, init) => certain(init), event => { events.push(event); throw new Error("observer failure"); });
  const result = await adapter.rerank({ query: "PRIVATE_QUERY", candidates: [{ id: "c0", name: "testing", description: "PRIVATE_DESCRIPTION" }] }, { model: "mock", signal: new AbortController().signal });
  assert.deepEqual(events, [{ kind: "attempt" }, { kind: "usage", inputTokens: 5, outputTokens: 2 }]);
  assert.deepEqual(result, { probabilities: [{ id: "c0", probability: 0 }, { id: null, probability: 1 }] });
});

test("mocked paired comparison CLI is runnable and rejects dependency drift", async t => {
  const adapter = await mock(t, async (_input, init) => certain(init));
  const keyword = await evaluate(keywordAdapter(catalog, "mock-test"), { split: "tuning", repetitions: 1 });
  const semantic = await evaluate(adapter, { split: "tuning", repetitions: 1 });
  const directory = await mkdtemp(join(tmpdir(), "mock-comparison-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const basePath = join(directory, "keyword.json"), semanticPath = join(directory, "semantic.json");
  await writeFile(basePath, JSON.stringify({ ...keyword, dependencyVersions: { mock: "1" } }));
  await writeFile(semanticPath, JSON.stringify({ ...semantic, dependencyVersions: { mock: "1" } }));
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "test/skill-search-evaluation/compare.ts", basePath, semanticPath], { encoding: "utf8" });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), compareReports(keyword, semantic));
  await writeFile(semanticPath, JSON.stringify({ ...semantic, dependencyVersions: { mock: "2" } }));
  const drift = run();
  assert.equal(drift.status, 1);
  assert.equal(drift.stdout, "");
});

test("live runner completes a fully mocked paired run without network and emits provenance/unknown billing", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mock-live-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "mock-authorization.json");
  await writeFile(path, JSON.stringify({ ...options, maxRequests: 36, authorizePaid: true, maxUsd: 1,
    requestCostCeilingUsd: 0.01, pricingDate: "2026-10-14", pricingSource: "MOCK_TEST_ONLY_NOT_A_PRICE" }));
  const script = `
    globalThis.fetch = async (_input, init) => {
      const {state} = JSON.parse(init.body);
      return Response.json({answers:{selection:{type:"choice",probabilities:Object.fromEntries([
        ...state.candidates.map(candidate => [candidate.id, 0]), ["no_match", 1]
      ])}},usage:{input_tokens:5,output_tokens:2}});
    };
    process.argv = [process.execPath, "mock-live-runner", "tuning", "1", ${JSON.stringify(path)}];
    await import("./test/skill-search-evaluation/live.ts");
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "MOCK_KEY_NOT_A_CREDENTIAL" },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.keyword.rows.length, 36);
  assert.equal(report.semantic.rows.length, 36);
  assert.equal(report.semantic.manifest.modelVersion, "mock-v1-not-live");
  assert.equal(report.dependencyVersions["@typesafe-ai/sdk"], "0.6.0");
  assert.match(report.sourceSha256["src/bootstrap-skills.ts"], /^[a-f0-9]{64}$/);
  assert.ok(report.semantic.metrics.some((metric: any) => metric.unknownCostTrials > 0));
  assert.equal(report.comparison.metrics.length, 3);
  assert.ok(!result.stdout.includes("MOCK_KEY_NOT_A_CREDENTIAL"));
});

test("throwing tool observers cannot alter public results or add private instrumentation to them", async () => {
  const handlers = new Map<string, (event: any) => unknown>();
  let tool: any;
  let observed: unknown;
  registerLazySkills({ on: (name: string, handler: any) => handlers.set(name, handler), registerTool: (value: any) => { tool = value; } } as never,
    { observe(value) { observed = value; throw new Error("observer failure"); } });
  handlers.get("before_agent_start")!({ systemPromptOptions: { skills: structuredClone(catalog), sections: {} } });
  const result = await tool.execute("PRIVATE_ID", { query: "review", limit: 1 });
  assert.deepEqual(Object.keys(result).sort(), ["content", "details"]);
  assert.deepEqual(Object.keys(result.details).sort(), ["matches", "total"]);
  assert.deepEqual(result.details.matches.map((skill: { name: string }) => skill.name), ["code-review"]);
  const text = JSON.stringify(observed);
  for (const forbidden of ["PRIVATE_ID", "review", "synthetic-skills", "filePath", "baseDir", "probabilities"]) assert.ok(!text.includes(forbidden));
});

test("live gate and CLI fail closed without key/authorization; no success JSON or secret diagnostics", async t => {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; });
  const authorized = { ...options, authorizePaid: true, maxUsd: 10, requestCostCeilingUsd: 0.01, pricingDate: "2026-10-14", pricingSource: "test-only-assumption" };
  await assert.rejects(createLiveAdapter(catalog, authorized), /TYPESAFE_API_KEY absent/);
  await assert.rejects(createLiveAdapter(catalog, { ...authorized, authorizePaid: false }), /authorization/);
  await assert.rejects(createLiveAdapter(catalog, { ...authorized, maxUsd: 0.001 }), /authorization/);
  await assert.rejects(createLiveAdapter(catalog, { ...authorized, model: "" }), /Invalid/);
  await assert.rejects(createLiveAdapter(catalog, { ...authorized, maxRequests: 0 }), /bounded request limit/);
  await assert.rejects(createLiveAdapter(catalog, { ...authorized, pricingDate: "" }), /authorization/);
  process.env.TYPESAFE_API_KEY = "   ";
  await assert.rejects(createLiveAdapter(catalog, authorized), /TYPESAFE_API_KEY absent/);
  delete process.env.TYPESAFE_API_KEY;
  const directory = await mkdtemp(join(tmpdir(), "live-gate-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "authorization.json");
  await writeFile(path, JSON.stringify(authorized));
  const result = spawnSync(process.execPath, ["--import", "tsx", "test/skill-search-evaluation/live.ts", "tuning", "1", path], { encoding: "utf8", env: process.env });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Live evaluation blocked or failed/);
});
