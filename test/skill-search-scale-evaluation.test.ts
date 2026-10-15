import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillCatalog } from "../src/bootstrap-skills.ts";
import { catalog, queries } from "./skill-search-evaluation/fixtures.ts";
import { scaleFixture, scaleProfiles, syntheticBody } from "./skill-search-evaluation/scale-fixtures.ts";
import { evaluate, keywordAdapter, scoreResult, validateFixtures } from "./skill-search-evaluation/harness.ts";
import { createMockAdapter } from "./skill-search-evaluation/production.ts";
import { compareReports } from "./skill-search-evaluation/comparison.ts";
import { agentFixtureHash, auditAgentTrace, bodyHash, type AgentTrace } from "./skill-search-evaluation/agent-load.ts";

const cli = (file: string, ...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", `test/skill-search-evaluation/${file}.ts`, ...args],
  { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, TYPESAFE_API_KEY: "" } });

for (const size of scaleProfiles) {
  test(`v2 ${size} fixtures preserve baseline and separate splits; adversarial cases are frozen`, () => {
    const fixture = scaleFixture(size);
    const enabled = skillCatalog(fixture.catalog);
    assert.equal(enabled.length, size);
    validateFixtures(fixture.catalog, fixture.queries);
    assert.deepEqual(fixture.queries.slice(0, queries.length), queries);
    assert.equal(skillCatalog(catalog).length, 12);
    assert.equal(fixture.queries.length, 62);
    assert.equal(agentFixtureHash(fixture.catalog, fixture.queries), size === 128
      ? "81af62cee828d233fadbfed783bf7520146b2fffa49a39ebe03cf312a61154f9"
      : "994f36c3f4de0d6ed35c536abdbc18178bdca4e45ecb348b1b1a064869b79280");
    for (const name of ["zzz-archive-recovery", "zzz-greenhouse"]) {
      assert.ok(enabled.findIndex(s => s.name === name) > 64);
      const metadata = enabled.find(s => s.name === name)!;
      const tokens = `${name} ${metadata.description}`.toLowerCase().match(/[\p{L}\p{N}]+/gu)!;
      for (const q of fixture.queries.filter(q => q.acceptable.includes(name))) {
        assert.ok(q.query.toLowerCase().match(/[\p{L}\p{N}]+/gu)!.every(token => !tokens.includes(token)));
      }
    }
    assert.ok(fixture.queries.some(q => q.id === "h10" && q.acceptable.length === 0));
    assert.ok(fixture.queries.filter(q => q.required).length === 4);
    assert.ok(fixture.queries.some(q => q.query.includes("Oracle") && !q.acceptable.length));
    assert.throws(() => validateFixtures(fixture.catalog, [{ ...fixture.queries[0], required: ["testing", "research"] }]), /Invalid/);
  });

  for (const split of ["tuning", "held-out"] as const) {
    test(`offline ${size} ${split} CLI records recall separately from final accuracy without calls`, () => {
      const run = cli("scale", split, String(size));
      assert.equal(run.status, 0, run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.catalogSize, size);
      assert.equal(report.queryCount, split === "tuning" ? 30 : 32);
      assert.equal(report.fixtureVersion, `skill-search-scale-v2-${size}`);
      assert.equal(report.rows.length, report.queryCount * 3);
      assert.equal(report.metrics[0].requiredTrials, 2);
      assert.equal(report.metrics[0].allRequiredAccuracy, 0); // cannot fit two skills at k=1
      for (const metric of report.metrics) {
        assert.equal(metric.usage.apiCalls.knownTotal, 0);
        assert.equal(metric.unknownCostTrials, 0);
        assert.ok(metric.shortlistMissCaseIds.includes(split === "tuning" ? "st01" : "sh01"));
        assert.ok(metric.noMatchTrials > 0);
      }
      assert.ok(!run.stdout.includes("/synthetic-skills/") && !run.stdout.includes("SYNTHETIC-LOAD"));
      assert.ok(Object.keys(report.sourceSha256).includes("test/skill-search-evaluation/scale-fixtures.ts"));
    });
  }
}

test("multi-skill all-required completion is not any-alternative Hit@k", () => {
  const q = scaleFixture(128).queries.find(q => q.required)!;
  const one = { matches: [q.required![0]], shortlist: q.required!, latencyMs: 0, apiCostUsd: 0 };
  assert.equal(scoreResult(q, one, 5).selectionHit, true);
  assert.equal(scoreResult(q, one, 5).allRequiredHit, false);
  assert.equal(scoreResult(q, one, 5).requiredShortlistRecall, 1);
  assert.equal(scoreResult(q, { ...one, matches: q.required! }, 3).allRequiredHit, true);
});

test("scale mock bridge observes real bounded shortlist misses, privacy and exact bypass, not semantic quality", async t => {
  const fixture = scaleFixture(256);
  let calls = 0;
  const adapter = await createMockAdapter(fixture.catalog, { model: "mock", modelVersion: "mock-not-evidence", implementationVersion: "test",
    maxRequests: 200, reranking: { max_candidates: 20 } }, async (_input, init) => {
    calls++;
    const text = String(init!.body);
    assert.ok(!text.includes("synthetic-skills") && !text.includes("SYNTHETIC-LOAD") && !text.includes("filePath"));
    const { state } = JSON.parse(text);
    assert.ok(state.candidates.length <= 20);
    for (const candidate of state.candidates) assert.deepEqual(Object.keys(candidate).sort(), ["description", "id", "name"]);
    return Response.json({ answers: { selection: { type: "choice", probabilities: Object.fromEntries([
      ...state.candidates.map((c: { id: string }) => [c.id, 0]), ["no_match", 1],
    ]) } }, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  t.after(() => adapter.close?.());
  const exact = await adapter.search("zzz-archive-recovery", 1);
  assert.deepEqual(exact.matches, ["zzz-archive-recovery"]);
  assert.equal(calls, 0);
  assert.equal(exact.observation?.reason, "exact");
  const late = await adapter.search("salvage lost replicas", 5);
  assert.equal(late.shortlist.length, 20);
  const lateTargetRetrieved = late.shortlist.includes("zzz-archive-recovery");
  assert.equal(late.observation?.shortlistKind, "semantic");
  const options = { skills: fixture.catalog, cases: fixture.queries, fixtureVersion: fixture.fixtureVersion, split: "held-out" as const, repetitions: 1 };
  const semantic = await evaluate(adapter, options);
  const baseline = await evaluate(keywordAdapter(fixture.catalog, "test"), options);
  const paired = compareReports(baseline, semantic);
  assert.ok(paired.metrics.some(m => m.selectionRegressions.trials > 0));
  assert.equal(paired.metrics[0].allRequiredRegressions.trials, 0);
  assert.equal(paired.metrics[1].allRequiredRegressions.trials, 2);
  for (const row of semantic.rows.filter(row => row.caseId === "sh01")) {
    assert.equal(row.shortlistHit, lateTargetRetrieved);
    assert.equal(row.selectionHit, false); // mock provider abstains regardless of retrieval
  }
  assert.equal(semantic.manifest.configuration.execution, "mock-not-quality-evidence");
  const wrongVersion = structuredClone(semantic);
  wrongVersion.fixtureVersion = "v1";
  assert.throws(() => compareReports(baseline, wrongVersion), /Unpaired/);
});

function traceFixture() {
  const fixture = scaleFixture(128);
  const trace: AgentTrace = { schemaVersion: 1, evidence: "external-agent-trace-unverified", split: "held-out",
    fixtureSha256: agentFixtureHash(fixture.catalog, fixture.queries), cases: fixture.queries.filter(q => q.split === "held-out")
      .map(q => ({ caseId: q.id, events: [{ kind: "search", returned: [] }] })) };
  const index = (name: string) => skillCatalog(fixture.catalog).findIndex(s => s.name === name);
  return { fixture, trace, index };
}

test("agent audit distinguishes correct search from complete SKILL.md read after search", () => {
  const { fixture, trace, index } = traceFixture();
  const sample = trace.cases.find(c => c.caseId === "h01")!;
  const i = index("security-review");
  const read = { kind: "read" as const, index: i, complete: true, bodySha256: bodyHash("security-review") };
  sample.events = [read, { kind: "search", returned: [i] }, { ...read, complete: false }];
  let report = auditAgentTrace(trace, fixture.catalog, fixture.queries, "held-out");
  assert.equal(report.rows.find(r => r.caseId === "h01")!.searchHit, true);
  assert.equal(report.rows.find(r => r.caseId === "h01")!.loadHit, false);
  assert.equal(report.metrics.prematureReads, 1);
  assert.equal(report.metrics.incompleteReads, 1);
  sample.events.push(read);
  report = auditAgentTrace(trace, fixture.catalog, fixture.queries, "held-out");
  assert.equal(report.rows.find(r => r.caseId === "h01")!.loadHit, true);
  assert.equal(report.realAgentBehaviorVerified, false);
  assert.equal(report.metrics.loadGivenSearchHit.accuracy, 1);
  const multi = trace.cases.find(c => c.caseId === "sh09")!;
  multi.events = [{ kind: "search", returned: [index("research"), index("documentation")] },
    { kind: "read", index: index("research"), complete: true, bodySha256: bodyHash("research") }];
  report = auditAgentTrace(trace, fixture.catalog, fixture.queries, "held-out");
  assert.equal(report.rows.find(r => r.caseId === "sh09")!.allRequiredLoaded, false);
  const wrong = trace.cases.find(c => c.caseId === "h08")!;
  wrong.events = [{ kind: "search", returned: [i] }, read];
  report = auditAgentTrace(trace, fixture.catalog, fixture.queries, "held-out");
  assert.equal(report.metrics.wrongLoads, 1);
  assert.equal(report.rows.find(r => r.caseId === "h08")!.noMatchLoadHit, false);
  sample.events = [{ kind: "search", returned: [] }, read];
  report = auditAgentTrace(trace, fixture.catalog, fixture.queries, "held-out");
  assert.equal(report.metrics.unselectedReads, 1);
  assert.equal(report.metrics.wrongLoads, 1); // unselected read does not add a completed selected load
});

test("agent audit rejects raw content, non-synthetic reads, mismatched fixtures and incomplete coverage", () => {
  const { fixture, trace, index } = traceFixture();
  const audit = (input: unknown) => auditAgentTrace(input, fixture.catalog, fixture.queries, "held-out");
  assert.throws(() => audit({ ...trace, prompt: "PRIVATE" }), /fields/);
  assert.throws(() => audit({ ...trace, fixtureSha256: "wrong" }), /Unpaired/);
  assert.throws(() => audit({ ...trace, cases: trace.cases.slice(1) }), /Unpaired/);
  trace.cases[0].events.push({ kind: "read", index: index("security-review"), complete: true, bodySha256: "non-synthetic" });
  assert.throws(() => audit(trace), /synthetic/);
  assert.ok(syntheticBody("research").includes("SYNTHETIC-LOAD"));
});

test("optional agent CLI performs local synthetic reads or bounded offline trace audit only", async t => {
  const mock = cli("agent", "mock", "held-out", "128");
  assert.equal(mock.status, 0, mock.stderr);
  const report = JSON.parse(mock.stdout);
  assert.equal(report.evidence, "mock");
  assert.equal(report.realAgentBehaviorVerified, false);
  assert.ok(report.metrics.loadAfterSearch.trials > 0);
  assert.equal(report.metrics.loadGivenSearchHit.accuracy, 1);
  assert.ok(!mock.stdout.includes("SYNTHETIC-LOAD") && !mock.stdout.includes("SKILL.md"));
  const directory = await mkdtemp(join(tmpdir(), "agent-trace-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "trace.json");
  await writeFile(path, JSON.stringify(traceFixture().trace));
  const audit = cli("agent", "audit", "held-out", "128", path);
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).evidence, "external-agent-trace-unverified");
  await writeFile(path, " ".repeat(1024 * 1024 + 1));
  const oversized = cli("agent", "audit", "held-out", "128", path);
  assert.equal(oversized.status, 1);
  assert.equal(oversized.stdout, "");
});

test("optional live scale profile reuses paired runner and request preflight with mocked transport only", async t => {
  const directory = await mkdtemp(join(tmpdir(), "scale-live-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "authorization.json");
  const options = { model: "mock-model", modelVersion: "mock-not-quality-evidence", authorizePaid: true,
    maxRequests: 96, maxUsd: 1, requestCostCeilingUsd: 0.001, pricingDate: "2026-10-15", pricingSource: "MOCK_ONLY" };
  const script = `
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      const {state} = JSON.parse(init.body);
      return Response.json({answers:{selection:{type:"choice",probabilities:Object.fromEntries([
        ...state.candidates.map(candidate => [candidate.id, 0]), ["no_match", 1]
      ])}},usage:{input_tokens:1,output_tokens:1}});
    };
    process.argv = [process.execPath, "mock-live", "held-out", "1", ${JSON.stringify(path)}, "256"];
    await import("./test/skill-search-evaluation/live.ts");
    process.stderr.write("mock-transport-calls=" + calls);
  `;
  const run = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, TYPESAFE_API_KEY: "MOCK_NOT_A_CREDENTIAL" },
  });
  await writeFile(path, JSON.stringify(options));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.keyword.catalogSize, 256);
  assert.equal(report.semantic.fixtureVersion, "skill-search-scale-v2-256");
  assert.equal(report.semantic.rows.length, 96);
  assert.equal(report.comparison.metrics[0].uniqueQueries, 32);
  assert.ok(report.sourceSha256["test/skill-search-evaluation/scale-fixtures.ts"]);
  assert.equal(report.sourceSha256["src/bootstrap-skills-retrieval.ts"],
    createHash("sha256").update(await readFile("src/bootstrap-skills-retrieval.ts")).digest("hex"));
  assert.ok(!result.stdout.includes("MOCK_NOT_A_CREDENTIAL"));
  await writeFile(path, JSON.stringify({ ...options, maxRequests: 95 }));
  const blocked = run();
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stdout, "");
  assert.ok(blocked.stderr.endsWith("mock-transport-calls=0"));
});

test("scale/live entry points reject invalid profiles, repetitions and missing authorization with no success report", () => {
  for (const args of [["held-out", "256", "0"], ["held-out", "129"], ["held-out", "256", "101"], ["held-out", "256", "1", "adapter.ts"]]) {
    const result = cli("scale", ...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
  const live = cli("live", "held-out", "1", "/no/authorization.json", "256");
  assert.equal(live.status, 1);
  assert.equal(live.stdout, "");
});
