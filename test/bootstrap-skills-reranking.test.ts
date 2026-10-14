import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { registerLazySkills, type SkillMetadata } from "../src/bootstrap-skills.ts";
import { defaultRerankingConfig, parseRerankingConfig, loadRerankingConfig } from "../src/bootstrap-skills-reranking-config.ts";
import { buildRerankingRequest, decideReranking, SkillRerankingRuntime } from "../src/bootstrap-skills-reranking-runtime.ts";
import { createJevAdapter, boundedFetch } from "../src/bootstrap-skills-jev.ts";
import type { SkillRerankingAdapter, SkillRerankingRequest } from "../src/bootstrap-skills-reranking.ts";

const config = { ...defaultRerankingConfig, enabled: true, model: "explicit-test-model" };
const skill = (name: string, description = "topic"): Skill => ({ name, description, filePath: `/private/${name}/SKILL.md`, baseDir: `/private/${name}`, disableModelInvocation: false, sourceInfo: { source: "user", scope: "user" } as Skill["sourceInfo"] });
const request: SkillRerankingRequest = { query: "topic", candidates: [{ id: "c0", name: "alpha", description: "topic" }, { id: "c1", name: "beta", description: "topic" }] };
const distribution = (...values: number[]) => ({ probabilities: values.map((probability, index) => ({ id: index === values.length - 1 ? null : `c${index}`, probability })) });
const chosen = distribution(0.8, 0.1, 0.1);
async function harness(t: TestContext, adapter: SkillRerankingAdapter, toml = "enabled = true\nmodel = 'explicit-test-model'", key: string | undefined = "secret") {
  const global = await mkdtemp(join(tmpdir(), "skill-rerank-"));
  t.after(() => rm(global, { recursive: true, force: true }));
  await writeFile(join(global, "config.toml"), `[skill_search.reranking]\n${toml}\n`);
  const handlers = new Map<string, (...args: any[]) => any>();
  let tool: any;
  let setups = 0;
  let reads = 0;
  const diagnostics: string[] = [];
  registerLazySkills({ on: (name: string, handler: any) => handlers.set(name, handler), registerTool: (value: any) => { tool = value; } } as never,
    { globalDirectory: global, adapterFor: () => { setups++; return adapter; }, credential: () => { reads++; return key; }, diagnostic: message => diagnostics.push(message) });
  const start = (skills: Skill[]) => handlers.get("before_agent_start")!({ systemPromptOptions: { skills, sections: {} } });
  const session = () => handlers.get("session_start")!({ reason: "reload" });
  assert.equal(setups, 0);
  assert.equal(reads, 0);
  await session();
  return { global, start, session, shutdown: () => handlers.get("session_shutdown")!({}), search: (query = "topic", limit?: number, signal?: AbortSignal) => tool.execute("id", { query, limit }, signal),
    setups: () => setups, reads: () => reads, tool: () => tool, key: (value: string | undefined) => { key = value; }, diagnostics };
}

test("config defaults, all bounds, unknown keys, no coercion and sanitized errors", async t => {
  assert.deepEqual(parseRerankingConfig(undefined), defaultRerankingConfig);
  assert.deepEqual(parseRerankingConfig({}), defaultRerankingConfig);
  const bounds = { timeout_ms: [1, 10000], cache_max_entries: [0, 1024], cache_ttl_ms: [0, 3600000], max_candidates: [1, 64], max_query_bytes: [1, 8192], max_name_bytes: [1, 256], max_description_bytes: [0, 2048], max_payload_bytes: [256, 65536], min_probability: [0, 1], min_margin: [0, 1] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    for (const value of [min, max]) assert.doesNotThrow(() => parseRerankingConfig({ [key]: value }));
    for (const value of [min - 1, max + 1, NaN, Infinity, "1"]) assert.throws(() => parseRerankingConfig({ [key]: value }));
    if (!key.startsWith("min_")) assert.throws(() => parseRerankingConfig({ [key]: min + 0.5 }));
  }
  for (const value of [{ enabled: "true" }, { model: " " }, { model: "é".repeat(129) }, { secret: "credential" }, [], null]) assert.throws(() => parseRerankingConfig(value));
  const h = await harness(t, { rerank: async () => chosen }, "enabled = true\nunknown = 'secret'");
  assert.equal(h.diagnostics.length, 1);
  assert.doesNotMatch(h.diagnostics[0], /secret/);
  h.start([skill("alpha")]);
  await h.search();
  assert.equal(h.setups(), 0);
});

test("global-only consent ignores project config and root enabled", async t => {
  const h = await harness(t, { rerank: async () => chosen }, "enabled = false");
  await mkdir(join(h.global, "project"));
  await writeFile(join(h.global, "project", "config.toml"), "[skill_search.reranking]\nenabled=true\nmodel='model'\n");
  await writeFile(join(h.global, "config.toml"), "enabled=true\n");
  await h.session();
  h.start([skill("alpha")]);
  assert.equal((await h.search()).details.total, 1);
  assert.equal(h.reads(), 0);
  assert.equal(h.setups(), 0);
  await rm(join(h.global, "config.toml"));
  assert.equal((await loadRerankingConfig(h.global)).enabled, false);
});

test("disabled, missing model, missing/blank credentials, exact-name and empty catalog never create SDK", async t => {
  for (const [toml, key] of [["enabled=false", "key"], ["enabled=true", "key"], ["enabled=true\nmodel='model'", undefined], ["enabled=true\nmodel='model'", "  "]] as const) {
    const h = await harness(t, { rerank: async () => chosen }, toml, key);
    h.key(key);
    h.start([skill("alpha")]);
    await h.search();
    assert.equal(h.setups(), 0);
  }
  const h = await harness(t, { rerank: async () => chosen });
  assert.equal(h.tool().annotations.openWorldHint, true);
  h.start([skill("alpha"), skill("alpha-extra", "alpha")]);
  assert.equal((await h.search(" ALPHA ", 1)).details.total, 2);
  h.start([]);
  assert.equal((await h.search()).details.total, 0);
  assert.equal(h.setups(), 0);
});

test("bounded UTF-8 descriptions and escaped JSON, untruncated query, skipped names and contiguous IDs", () => {
  const skills: SkillMetadata[] = [skill("toolong"), skill("a", "é😀x"), skill("b", '"\\\n'.repeat(200))];
  const bounded = { ...config, maxNameBytes: 1, maxDescriptionBytes: 6, maxPayloadBytes: 256 };
  const payload = buildRerankingRequest("topic", skills, bounded)!;
  assert.deepEqual(payload.candidates.map(c => c.id), ["c0", "c1"]);
  assert.equal(payload.candidates[0].description, "é😀");
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 256);
  assert.deepEqual(Object.keys(payload.candidates[0]), ["id", "name", "description"]);
  assert.equal(buildRerankingRequest("éé", skills, { ...bounded, maxQueryBytes: 3 }), undefined);
  const dropped = buildRerankingRequest("q", [skill("a", '"'.repeat(200)), skill("b")], { ...config, maxPayloadBytes: 256 });
  assert.equal(dropped, undefined);
  const tail = buildRerankingRequest("q", [skill("a"), skill("b", '"'.repeat(200))], { ...config, maxPayloadBytes: 256 })!;
  assert.deepEqual(tail.candidates.map(c => c.id), ["c0"]);
  assert.ok(Buffer.byteLength(JSON.stringify(tail)) <= 256);
});

test("semantic shortlist includes zero-score synonyms, excludes disabled/duplicates, reconstructs only local paths", async t => {
  let outbound: SkillRerankingRequest | undefined;
  const h = await harness(t, { rerank: async payload => { outbound = payload; return distribution(0.1, 0.8, 0.1); } });
  const resources = [skill("alpha"), skill("beta", "synonym"), { ...skill("manual"), disableModelInvocation: true }, skill("beta", "duplicate")];
  h.start(resources);
  const result = await h.search("TOPIC", 1);
  assert.deepEqual(outbound, requestWithBeta());
  assert.deepEqual(result.details, { matches: [{ name: "beta", description: "synonym", filePath: "/private/beta/SKILL.md", baseDir: "/private/beta" }], total: 1 });
  assert.match(result.content[0].text, /Read the selected filePath/);
  result.details.matches[0].filePath = "mutated";
  assert.equal((await h.search()).details.matches[0].filePath, "/private/beta/SKILL.md");
  assert.equal(h.setups(), 1);
  function requestWithBeta() { return { query: "topic", candidates: [{ id: "c0", name: "alpha", description: "topic" }, { id: "c1", name: "beta", description: "synonym" }] }; }
});

test("distribution completeness, IDs, probability ranges, sum and near-one normalization", () => {
  assert.deepEqual(decideReranking(chosen, request, config), { kind: "matches", ids: ["c0"] });
  for (const value of [null, {}, { probabilities: [] }, distribution(0.8, 0.2), distribution(0.8, 0.1, 0.2), distribution(NaN, 0.1, 0.1), distribution(Infinity, 0, 0), distribution(-0.1, 0.9, 0.2), distribution(1.1, 0, -0.1), { probabilities: [{ id: "evil", probability: 0.8 }, { id: "c1", probability: 0.1 }, { id: null, probability: 0.1 }] }, { probabilities: [{ id: "c0", probability: 0.8 }, { id: "c0", probability: 0.1 }, { id: null, probability: 0.1 }] }, { probabilities: [{ id: "c0", probability: "0.8" }, { id: "c1", probability: 0.1 }, { id: null, probability: 0.1 }] }]) {
    assert.deepEqual(decideReranking(value, request, config), { kind: "fallback", reason: "invalid-response" });
  }
  assert.deepEqual(decideReranking(distribution(0.8, 0.1, 0.1000005), request, config), { kind: "matches", ids: ["c0"] });
});

test("ties use shortlist order and conservative no-match, thresholds and margin gate top only", () => {
  const relaxed = { ...config, minProbability: 0.3, minMargin: 0 };
  assert.deepEqual(decideReranking(distribution(0.5, 0.5, 0), request, relaxed), { kind: "matches", ids: ["c0", "c1"] });
  assert.deepEqual(decideReranking(distribution(0.5, 0, 0.5), request, relaxed), { kind: "no-match" });
  assert.deepEqual(decideReranking(distribution(0.6, 0.4, 0), request, { ...relaxed, minMargin: 0.1 }), { kind: "matches", ids: ["c0", "c1"] });
  assert.equal(decideReranking(distribution(0.4, 0.3, 0.3), request, config).kind, "fallback");
  assert.equal(decideReranking(distribution(0.6, 0, 0.4), request, { ...config, minMargin: 0.3 }).kind, "fallback");
});

test("explicit no-match differs from uncertain, malformed and provider failures; keyword baseline remains exact", async t => {
  for (const [answer, expected] of [[distribution(0.1, 0.1, 0.8), 0], [distribution(0.4, 0.3, 0.3), 2], [{ probabilities: [] }, 2], [new Error("secret API failure"), 2]] as const) {
    const h = await harness(t, { rerank: async () => { if (answer instanceof Error) throw answer; return answer; } });
    h.start([skill("beta"), skill("alpha")]);
    const result = await h.search("topic", 1);
    assert.equal(result.details.total, expected);
    if (expected) assert.equal(result.details.matches[0].name, "alpha");
    else assert.match(result.content[0].text, /No matching skills/);
    assert.doesNotMatch(JSON.stringify(result), /secret|probabilities|confidence/);
  }
});

test("synonyms independent of result limit and limits/total preserved after semantic selection", async t => {
  const h = await harness(t, { rerank: async () => distribution(0.6, 0.4, 0) }, "enabled=true\nmodel='model'\nmin_probability=0.3");
  h.start([skill("alpha"), skill("beta")]);
  const result = await h.search("no-overlap", 1);
  assert.equal(result.details.total, 2);
  assert.equal(result.details.matches.length, 1);
  assert.equal(h.setups(), 1);
});

test("bounds bypass returns baseline without adapter setup", async t => {
  const h = await harness(t, { rerank: async () => chosen }, "enabled=true\nmodel='model'\nmax_query_bytes=1\nmax_name_bytes=1");
  h.start([skill("alpha")]);
  assert.equal((await h.search()).details.total, 1);
  await h.search("q");
  assert.equal(h.setups(), 0);
});

test("deadline returns baseline for uncooperative adapter and cancellation terminates tool", async t => {
  let received: AbortSignal | undefined;
  const h = await harness(t, { rerank: async (_payload, options) => { received = options.signal; return new Promise(() => {}); } }, "enabled=true\nmodel='model'\ntimeout_ms=10");
  h.start([skill("alpha")]);
  assert.equal((await h.search()).details.total, 1);
  assert.equal(received?.aborted, true);
  const controller = new AbortController();
  const pending = h.search("topic", undefined, controller.signal);
  controller.abort(new Error("cancelled by caller"));
  await assert.rejects(pending, /cancelled by caller/);
  assert.equal(received?.aborted, true);
});

test("catalog/config/session/shutdown changes abort and discard stale work", async t => {
  for (const boundary of ["catalog", "session", "shutdown"]) {
    let resolve!: (answer: unknown) => void;
    let signal!: AbortSignal;
    const h = await harness(t, { rerank: async (_payload, options) => { signal = options.signal; return new Promise(r => { resolve = r; }); } });
    h.start([skill("alpha")]);
    const pending = h.search();
    const rejected = assert.rejects(pending, /state changed/);
    await Promise.resolve();
    if (boundary === "catalog") h.start([skill("new")]);
    else if (boundary === "session") await h.session();
    else h.shutdown();
    await rejected;
    assert.equal(signal.aborted, true);
    resolve(distribution(0.9, 0.1));
  }
});

test("cache absolute expiry and LRU capacity, successful no-match only; failures not cached", async () => {
  let now = 0, calls = 0;
  const runtime = new SkillRerankingRuntime(() => now);
  const settings = { ...config, cacheTtlMs: 10, cacheMaxEntries: 2 };
  const adapter = { rerank: async () => { calls++; return chosen; } };
  const search = (query: string) => runtime.search({ ...request, query }, settings, adapter);
  await search("a"); now = 5; await search("a"); assert.equal(calls, 1);
  now = 10; await search("a"); assert.equal(calls, 2);
  await search("b"); await search("a"); await search("c"); await search("b"); assert.equal(calls, 5);
  for (const answer of [distribution(0.4, 0.3, 0.3), {}, new Error("failure")]) {
    runtime.clear();
    let count = 0;
    const failing = { rerank: async () => { count++; if (answer instanceof Error) throw answer; return answer; } };
    await runtime.search(request, settings, failing); await runtime.search(request, settings, failing);
    assert.equal(count, 2);
  }
  runtime.clear();
  let count = 0;
  const empty = { rerank: async () => { count++; return distribution(0.1, 0.1, 0.8); } };
  await runtime.search(request, settings, empty); await runtime.search(request, settings, empty);
  assert.equal(count, 1);
});

test("cache invalidates paths, metadata, credentials and reloaded settings; entries never expose keys", async t => {
  const h = await harness(t, { rerank: async () => distribution(0.9, 0.1) });
  h.start([skill("alpha")]); await h.search(); await h.search(); assert.equal(h.setups(), 1);
  h.start([{ ...skill("alpha"), filePath: "/new/SKILL.md" }]);
  assert.equal((await h.search()).details.matches[0].filePath, "/new/SKILL.md"); assert.equal(h.setups(), 2);
  h.key("other-secret"); await h.search(); assert.equal(h.setups(), 3);
  h.start([skill("alpha", "changed")]); await h.search(); assert.equal(h.setups(), 4);
  await writeFile(join(h.global, "config.toml"), "[skill_search.reranking]\nenabled=false\n");
  await h.session(); h.start([skill("alpha")]); await h.search(); assert.equal(h.setups(), 4);
  assert.equal(h.tool().annotations.openWorldHint, false);
});

test("cache settings/query/model/metadata affect keys and zero disables cache", async () => {
  const runtime = new SkillRerankingRuntime();
  let calls = 0;
  const adapter = { rerank: async () => { calls++; return chosen; } };
  await runtime.search(request, config, adapter); await runtime.search(request, config, adapter);
  await runtime.search(request, { ...config, model: "other" }, adapter);
  await runtime.search(request, { ...config, minMargin: 0.2 }, adapter);
  await runtime.search({ ...request, query: "different" }, config, adapter);
  await runtime.search({ ...request, candidates: request.candidates.map(c => ({ ...c, description: "changed" })) }, config, adapter);
  assert.equal(calls, 5);
  for (const settings of [{ ...config, cacheMaxEntries: 0 }, { ...config, cacheTtlMs: 0 }]) {
    await runtime.search(request, settings, adapter); await runtime.search(request, settings, adapter);
  }
  assert.equal(calls, 9);
});

test("actual SDK choice probabilities, fixed endpoint, no logs/retries or implicit model, allowlisted outbound state", async t => {
  const previous = { ...process.env };
  process.env.TYPESAFE_BASE_URL = "https://unexpected.example";
  process.env.TYPESAFE_DEFAULT_MODEL = "implicit-model";
  process.env.TYPESAFE_LOG_LEVEL = "debug";
  t.after(() => {
    for (const key of ["TYPESAFE_BASE_URL", "TYPESAFE_DEFAULT_MODEL", "TYPESAFE_LOG_LEVEL"]) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  });
  let calls = 0;
  const adapter = createJevAdapter("private-key", async (input, init) => {
    calls++;
    assert.equal(input, "https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(init!.body as string);
    assert.deepEqual(body.state, request);
    assert.equal(body.model, config.model);
    assert.deepEqual(body.questions.selection.criteria, { c0: null, c1: null, no_match: null });
    assert.doesNotMatch(JSON.stringify(body), /private-key|filePath|baseDir|SKILL.md/);
    return Response.json({ model: config.model, answers: { selection: { type: "choice", choice: "c0", confidence: 0.99, probabilities: { c0: 0.8, c1: 0.1, no_match: 0.1 } } }, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  assert.deepEqual(await adapter.rerank(request, { model: config.model!, signal: new AbortController().signal }), chosen);
  assert.equal(calls, 1);
  const failing = createJevAdapter("private-key", async () => { calls++; return Response.json({ error: "rate limited" }, { status: 429 }); });
  await assert.rejects(failing.rerank(request, { model: config.model!, signal: new AbortController().signal }));
  assert.equal(calls, 2);
});

test("HTTP response bound applied before SDK parse, streaming body cancelled on overflow", async () => {
  let cancelled = false;
  const fetcher = boundedFetch(async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(40000)); }, cancel() { cancelled = true; } })));
  await assert.rejects(fetcher("https://example.test"), /Oversized/);
  assert.equal(cancelled, true);
  const adapter = createJevAdapter("key", async () => new Response("x".repeat(65537)));
  await assert.rejects(adapter.rerank(request, { model: config.model!, signal: new AbortController().signal }));
});
