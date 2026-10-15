import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJevFitRequest, createJevAdapter, JEV_FIT_ENVELOPE_MAX_BYTES } from "../src/bootstrap-skills-jev.ts";
import { defaultRerankingConfig, parseRerankingConfig } from "../src/bootstrap-skills-reranking-config.ts";
import { decideReranking, SkillRerankingRuntime } from "../src/bootstrap-skills-reranking-runtime.ts";
import { registerLazySkills } from "../src/bootstrap-skills.ts";

const request = { query: "review deployment plan", candidates: [
  { id: "c0", name: "deployment", description: "Execute a production deployment." },
  { id: "c1", name: "plan-review", description: "Explain and review deployment plans." },
  { id: "c2", name: "risk-review", description: "Review deployment risks." },
] };
const config = { ...defaultRerankingConfig, enabled: true, experimentalFit: true };
const options = () => ({ model: "offline-model", signal: new AbortController().signal, experimentalFit: true });
const answer = (fits = [0.1, 0.9, 0.8], probabilities = [0.7, 0.2, 0.01, 0.09]) => ({
  probabilities: probabilities.map((probability, i) => ({ id: i === 3 ? null : `c${i}`, probability })),
  fits: fits.map((probability, i) => ({ id: `c${i}`, probability })),
});
const wireAnswer = (fits: number[] = [0.1, 0.9, 0.8]) => ({ answers: {
  selection: { type: "choice", probabilities: { c0: 0.7, c1: 0.2, c2: 0.01, no_match: 0.09 } },
  ...Object.fromEntries(fits.map((noul, i) => [`fit_c${i}`, { type: "noul", noul }])),
} });

test("fit consent is separate, strict, global-config parsed, and off by default", () => {
  assert.equal(defaultRerankingConfig.experimentalFit, false);
  assert.equal(parseRerankingConfig({ experimental_fit: true }).enabled, false);
  assert.equal(parseRerankingConfig({ enabled: true, experimental_fit: true, min_fit_probability: 0.8 }).minFitProbability, 0.8);
  for (const value of [0, 0.5, 1.01, NaN, "0.8", null]) assert.throws(() => parseRerankingConfig({ min_fit_probability: value }));
  for (const value of [1, "true", null]) assert.throws(() => parseRerankingConfig({ experimental_fit: value }));
});

test("independent fit rejects best-of-bad; separates confident negatives from uncertainty", () => {
  assert.deepEqual(decideReranking(answer([0.1, 0.2, 0.25]), request, config), { kind: "no-match" });
  assert.deepEqual(decideReranking(answer([0.1, 0.2, 0.6]), request, config), { kind: "fallback", reason: "uncertain" });
  // Independent all-low is enough to abstain even when relative Choice is uncertain.
  assert.deepEqual(decideReranking(answer([0.1, 0.1, 0.1], [0.3, 0.3, 0.2, 0.2]), request, config), { kind: "no-match" });
  assert.deepEqual(decideReranking(answer([0.9, 0.9, 0.9], [0.1, 0.1, 0.1, 0.7]), request, config), { kind: "no-match" });
  assert.deepEqual(decideReranking(answer([0.9, 0.9, 0.9], [0.3, 0.3, 0.2, 0.2]), request, config), { kind: "fallback", reason: "uncertain" });
});

test("fit/Choice disagreement uses each candidate's fit, supports multiple results below no_match", () => {
  assert.deepEqual(decideReranking(answer(), request, config), { kind: "matches", ids: ["c1", "c2"] });
  assert.deepEqual(decideReranking(answer([0.9, 0.1, 0.1]), request, config), { kind: "matches", ids: ["c0"] });
  assert.deepEqual(decideReranking(answer([0.6, 0.75, 0.8]), request, config), { kind: "matches", ids: ["c1", "c2"] });
  const ties = answer([0.9, 0.9, 0.9], [0.7, 0.1, 0.1, 0.1]);
  ties.probabilities.reverse(); ties.fits.reverse();
  assert.deepEqual(decideReranking(ties, request, config), { kind: "matches", ids: ["c0", "c1", "c2"] });
  assert.deepEqual(decideReranking(answer(), request, defaultRerankingConfig), { kind: "matches", ids: ["c0", "c1"] });
});

test("complete bounded fit data required even on confident no_match; malformed data fails closed", () => {
  const badFits: unknown[] = [undefined, null, {}, [], answer().fits.slice(1), [...answer().fits, { id: "alien", probability: 1 }],
    [{ id: "c0", probability: 0 }, { id: "c0", probability: 0 }, { id: "c2", probability: 0 }]];
  for (const probability of [NaN, Infinity, -0.1, 1.1, "0.9", null]) badFits.push([{ id: "c0", probability }, ...answer().fits.slice(1)]);
  for (const fits of badFits) {
    for (const probabilities of [answer().probabilities, answer([], [0.1, 0.1, 0.1, 0.7]).probabilities]) {
      assert.deepEqual(decideReranking({ probabilities, fits }, request, config), { kind: "fallback", reason: "invalid-response" });
    }
  }
});

test("fit request references metadata once, preserves untrusted-data boundaries and bounded 64-question envelope", () => {
  const dirty = { ...request, history: "PRIVATE_HISTORY", prompt: "PRIVATE_PROMPT", candidates: request.candidates.map(c => ({ ...c, body: "PRIVATE_BODY", filePath: "PRIVATE_PATH", baseDir: "PRIVATE_DIR" })) };
  const body = buildJevFitRequest(dirty, "offline-model");
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|filePath|baseDir/);
  assert.deepEqual(Object.keys(body.questions), ["selection", "fit_c0", "fit_c1", "fit_c2"]);
  assert.match(body.state.applicability_rubric, /Planning, review, explanation and execution/);
  assert.match(body.state.applicability_rubric, /untrusted data/);
  assert.equal(body.questions.fit_c0.type, "noul");
  for (const candidate of request.candidates) assert.equal(JSON.stringify(body).split(candidate.description).length - 1, 1);
  const large = { query: "q", candidates: Array.from({ length: 64 }, (_, i) => ({ id: `c${i}`, name: `name${i}`, description: "x".repeat(960) })) };
  const wire = buildJevFitRequest(large, "\u0001".repeat(256));
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) <= Buffer.byteLength(JSON.stringify(large)) + JEV_FIT_ENVELOPE_MAX_BYTES);
  assert.throws(() => buildJevFitRequest({ ...large, query: "q".repeat(65536) }, "offline-model"));
});

test("real SDK single fake HTTP request returns independent noul probabilities, not prose/confidence", async () => {
  let calls = 0;
  const adapter = createJevAdapter("offline-key", async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init!.body as string), buildJevFitRequest(request, "offline-model"));
    return Response.json(wireAnswer());
  });
  assert.deepEqual(await adapter.rerank(request, options()), answer());
  assert.equal(calls, 1);
  for (const mutate of [
    (v: any) => { delete v.answers.fit_c1; },
    (v: any) => { v.answers.fit_alien = { type: "noul", noul: 1 }; },
    (v: any) => { v.answers.fit_c0.type = "score"; },
    (v: any) => { v.answers.fit_c0.noul = "0.9"; },
    (v: any) => { v.answers.fit_c0.noul = 1.1; },
  ]) {
    const bad = createJevAdapter("offline-key", async () => { const value = wireAnswer(); mutate(value); return Response.json(value); });
    await assert.rejects(bad.rerank(request, options()));
  }
});

test("fit SDK transport bounds a near-ceiling 64-candidate request and propagates in-flight abort", async () => {
  const large = { query: "q", candidates: Array.from({ length: 64 }, (_, i) => ({ id: `c${i}`, name: `n${i}`, description: "x".repeat(960) })) };
  let attempts = 0;
  const adapter = createJevAdapter("offline-key", async (_url, init) => {
    attempts++;
    assert.ok(Buffer.byteLength(init!.body as string) <= Buffer.byteLength(JSON.stringify(large)) + JEV_FIT_ENVELOPE_MAX_BYTES);
    return Response.json({ answers: {
      selection: { type: "choice", probabilities: Object.fromEntries([...large.candidates.map(c => [c.id, 0]), ["no_match", 1]]) },
      ...Object.fromEntries(large.candidates.map(c => [`fit_${c.id}`, { type: "noul", noul: 0.1 }])),
    } });
  });
  const result = await adapter.rerank(large, options());
  assert.deepEqual(decideReranking(result, large, config), { kind: "no-match" });
  await assert.rejects(adapter.rerank({ ...large, query: "q".repeat(65536) }, options()));
  assert.equal(attempts, 1);
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = new SkillRerankingRuntime().search(request, config, {
    rerank: async (_request, opts) => {
      started();
      return new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true }));
    },
  }, controller.signal);
  await ready;
  controller.abort(new Error("cancel fit"));
  await assert.rejects(pending, /cancel fit/);
});

test("fit mode preserves cache policy, configuration isolation, bounds, cancellation and zero retries", async () => {
  const runtime = new SkillRerankingRuntime();
  let calls = 0;
  const adapter = { rerank: async (_request: unknown, opts: { experimentalFit?: boolean }) => { calls++; assert.equal(opts.experimentalFit, true); return answer(); } };
  await runtime.search(request, config, adapter);
  await runtime.search(request, config, adapter);
  assert.equal(calls, 1);
  await runtime.search(request, { ...config, minFitProbability: 0.95 }, adapter);
  assert.equal(calls, 2);
  let failures = 0;
  const uncertain = { rerank: async () => { failures++; return answer([0.5, 0.5, 0.5]); } };
  const other = new SkillRerankingRuntime();
  await other.search(request, config, uncertain); await other.search(request, config, uncertain);
  assert.equal(failures, 2);
  const low = { rerank: async () => { failures++; return answer([0.1, 0.1, 0.1]); } };
  await other.search(request, config, low); await other.search(request, config, low);
  assert.equal(failures, 3);
  for (const status of [429, 503]) {
    let attempts = 0;
    const failing = createJevAdapter("offline-key", async () => { attempts++; return Response.json({}, { status }); });
    assert.deepEqual(await new SkillRerankingRuntime().search(request, config, failing), { kind: "fallback", reason: "provider" });
    assert.equal(attempts, 1);
  }
  const oversized = createJevAdapter("offline-key", async () => new Response("x".repeat(65537)));
  await assert.rejects(oversized.rerank(request, options()));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.search(request, config, adapter, controller.signal));
  assert.equal(calls, 2);
  const timeout = await new SkillRerankingRuntime().search(request, { ...config, timeoutMs: 5 }, { rerank: () => new Promise(() => {}) });
  assert.deepEqual(timeout, { kind: "fallback", reason: "timeout" });
});

test("registered search passes opt-in through lazy adapter: limits/total/cache, fallback, exact bypass and metadata only", async t => {
  const directory = await mkdtemp(join(tmpdir(), "skill-fit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "config.toml"), "[skill_search.reranking]\nenabled=true\nexperimental_fit=true\n");
  const handlers = new Map<string, (...args: any[]) => any>();
  let tool: any, calls = 0, invalid = false;
  const resources = request.candidates.map(({ name, description }) => ({ name, description,
    filePath: "/PRIVATE_PATH/SKILL.md", baseDir: "/PRIVATE_DIR", sourceInfo: "PRIVATE_SOURCE" }));
  registerLazySkills({ on: (event: string, fn: any) => handlers.set(event, fn), registerTool: (value: any) => { tool = value; } } as never, {
    globalDirectory: directory, credential: () => "offline-key", adapterFor: key => createJevAdapter(key, async (_url, init) => {
      calls++;
      const raw = init!.body as string;
      assert.doesNotMatch(raw, /PRIVATE_|filePath|baseDir|history|sourceInfo/);
      const body = JSON.parse(raw);
      const candidates = body.state.candidates as typeof request.candidates;
      return Response.json({ answers: {
        selection: { type: "choice", probabilities: Object.fromEntries([...candidates.map(c => [c.id, c.name === "deployment" ? 0.7 : c.name === "plan-review" ? 0.2 : 0.01]), ["no_match", 0.09]]) },
        ...Object.fromEntries(candidates.filter(c => !invalid || c.name !== "plan-review").map(c => [`fit_${c.id}`, { type: "noul", noul: c.name === "deployment" ? 0.1 : 0.9 }])),
      } });
    }),
  });
  await handlers.get("session_start")!({});
  const start = () => handlers.get("before_agent_start")!({ systemPromptOptions: { skills: [...resources], sections: { skills: "PRIVATE_PROMPT" } } });
  start();
  for (const limit of [1, 3, 5]) {
    const result = await tool.execute("test", { query: "review deployment plan", limit });
    assert.deepEqual(result.details.matches.map((s: any) => s.name), ["plan-review", "risk-review"].slice(0, limit));
    assert.equal(result.details.total, 2);
    assert.equal(result.details.matches[0].filePath, "/PRIVATE_PATH/SKILL.md");
  }
  assert.equal(calls, 1);
  await tool.execute("test", { query: "plan-review" });
  assert.equal(calls, 1);
  invalid = true;
  await handlers.get("session_start")!({}); start();
  const fallback = await tool.execute("test", { query: "review deployment plan" });
  assert.equal(fallback.details.total, 3, "incomplete fit must use unchanged keyword fallback, not abstain");
  await tool.execute("test", { query: "review deployment plan" });
  assert.equal(calls, 3, "provider/validation failures never cached");
});
