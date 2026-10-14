import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, type Skill } from "@earendil-works/pi-coding-agent";
import { registerLazySkills } from "../src/bootstrap-skills.ts";
import { createJevAdapter } from "../src/bootstrap-skills-jev.ts";
import { catalog, queries } from "./skill-search-evaluation/fixtures.ts";

// Independent acceptance oracle: captured before reranking existed, not a copy
// of score()/decideReranking() and not results from today's keyword implementation.
const baseline = JSON.parse(await readFile(new URL("../docs/skill-search-baseline.json", import.meta.url), "utf8"));
const baselineNames = ["code-review", "database", "debugging", "documentation", "merge-conflicts", "performance", "refactor", "release", "research", "security-review", "testing", "translations"];
const metadata = (name: string) => {
  const { description, filePath, baseDir } = catalog.find(s => s.name === name && !s.disableModelInvocation)!;
  return { name, description, filePath, baseDir };
};
const choice = (probabilities: Record<string, unknown>, confidence = 0.99) => Response.json({
  answers: { selection: { type: "choice", choice: "no_match", confidence, probabilities } },
});

type Wire = { state: { query: string; candidates: { id: string; name: string; description: string }[] }; model: string; questions: any };
async function setup(t: TestContext, fetcher: typeof fetch, settings = "enabled=true\nmodel='mock-model'", resources = catalog) {
  const globalDirectory = await mkdtemp(join(tmpdir(), "reranking-acceptance-"));
  t.after(() => rm(globalDirectory, { recursive: true, force: true }));
  await writeFile(join(globalDirectory, "config.toml"), `[skill_search.reranking]\n${settings}\n`);
  const handlers = new Map<string, (...args: any[]) => any>();
  let tool: any;
  let key: string | undefined = "mock-key-not-a-credential";
  let calls = 0, constructions = 0;
  const diagnostics: string[] = [];
  const transform = registerLazySkills({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (value: any) => { tool = value; },
  } as never, { globalDirectory, credential: () => key, diagnostic: message => diagnostics.push(message),
    adapterFor: credential => {
      constructions++;
      return createJevAdapter(credential, async (...args) => { calls++; return fetcher(...args); });
    },
  });
  const session = async (reason = "reload") => handlers.get("session_start")!({ reason });
  const start = (skills = resources) => {
    const options = { skills, sections: { rules: "PRIVATE_SYSTEM_PROMPT", skills: "PRIVATE_CATALOG" } };
    handlers.get("before_agent_start")!({ systemPromptOptions: options, systemPrompt: "PRIVATE_SYSTEM_PROMPT" });
    return options;
  };
  await session();
  start();
  return { search: (query: string, limit?: number, signal?: AbortSignal) => tool.execute("acceptance", { query, limit }, signal),
    start, session, transform, diagnostics, globalDirectory, tool: () => tool,
    shutdown: () => handlers.get("session_shutdown")!({}),
    key: (value: string | undefined) => { key = value; }, counts: () => ({ calls, constructions }),
  };
}
const wire = (init?: RequestInit): Wire => JSON.parse(init!.body as string);
const certain = (body: Wire, name: string | null) => choice(Object.fromEntries([
  ...body.state.candidates.map(c => [c.id, c.name === name ? 1 : 0]), ["no_match", name === null ? 1 : 0],
]));

test("disabled mode and real SDK failures reproduce every recorded pre-reranking fixture result", async t => {
  for (const enabled of [false, true]) {
    const h = await setup(t, async () => Response.json({ error: "PRIVATE_PROVIDER_ERROR" }, { status: 503 }),
      `enabled=${enabled}\nmodel='mock-model'`);
    for (const report of baseline.reports) {
      for (const row of report.firstTrialOutcomes) {
        const q = queries.find(q => q.id === row.caseId)!;
        const result = await h.search(` ${q.query.toUpperCase()} `, row.limit);
        assert.deepEqual(result.details, {
          matches: row.matches.map((index: number) => metadata(baselineNames[index])), total: row.shortlist.length,
        }, `${enabled ? "SDK failure" : "disabled"}: ${q.id} limit ${row.limit}`);
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_ERROR|mock-key/);
      }
    }
    if (!enabled) {
      assert.deepEqual(h.counts(), { calls: 0, constructions: 0 });
      assert.equal(h.tool().annotations.openWorldHint, false);
    } else {
      const expectedCalls = baseline.reports.flatMap((r: any) => r.firstTrialOutcomes)
        .filter((r: any) => !baselineNames.includes(queries.find(q => q.id === r.caseId)!.query.toLowerCase())).length;
      assert.equal(h.counts().calls, expectedCalls, "no retry; failures never cached; exact names bypass SDK");
    }
  }
});

test("HTTP boundary allowlist, metadata bounds, shortlist beyond limit and lazy explicit Pi command", async t => {
  const path = await mkdtemp(join(tmpdir(), "private-skill-body-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const filePath = join(path, "SKILL.md");
  await writeFile(filePath, "---\nname: manual\ndescription: manual\n---\nPRIVATE_FULL_BODY\n");
  const make = (name: string, description: string): Skill => ({ ...catalog[0], name, description, filePath, baseDir: path });
  const resources = [make("alpha", "topic"), make("beta", "é😀x"), make("oversized", "secret"),
    make("beta", "PRIVATE_DUPLICATE"), { ...make("manual", "PRIVATE_MANUAL"), disableModelInvocation: true }];
  let sent!: Wire;
  const h = await setup(t, async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    sent = wire(init);
    assert.deepEqual(Object.keys(sent).sort(), ["model", "questions", "state"]);
    assert.deepEqual(sent.state, { query: "topic", candidates: [
      { id: "c0", name: "alpha", description: "topic" }, { id: "c1", name: "beta", description: "é😀" },
    ] });
    assert.deepEqual(Object.keys(sent.questions), ["selection"]);
    assert.deepEqual(Object.keys(sent.questions.selection).sort(), ["criteria", "instructions", "type"]);
    assert.deepEqual(sent.questions.selection.criteria, { c0: null, c1: null, no_match: null });
    assert.ok(Buffer.byteLength(JSON.stringify(sent.state)) <= 256);
    assert.doesNotMatch(init!.body as string, /PRIVATE_|SKILL\.md|filePath|baseDir|sourceInfo|private-skill-body/);
    assert.equal(new Headers(init!.headers).get("authorization"), "Bearer mock-key-not-a-credential");
    return certain(sent, "beta");
  }, "enabled=true\nmodel='mock-model'\nmax_name_bytes=5\nmax_description_bytes=6\nmax_payload_bytes=256", resources);
  const before = structuredClone(resources);
  const messages = [{ role: "user", content: "PRIVATE_HISTORY /skill:manual" }, { role: "system", content: "PRIVATE_SYSTEM_PROMPT" }];
  assert.deepEqual(h.transform(messages as never), messages);
  const result = await h.search(" TOPIC ", 1);
  assert.deepEqual(result.details, { matches: [{ name: "beta", description: "é😀x", filePath, baseDir: path }], total: 1 });
  assert.deepEqual(resources, before);
  assert.match(result.content[0].text, /Resolve supporting files against baseDir/);
  // Exercise Pi's actual explicit-command expansion, not merely an unchanged array.
  const expand = (AgentSession.prototype as unknown as { _expandSkillCommand(text: string): string })._expandSkillCommand;
  const expanded = expand.call({ resourceLoader: { getSkills: () => ({ skills: resources }) } }, "/skill:manual user args");
  assert.match(expanded, /PRIVATE_FULL_BODY/);
  assert.match(expanded, /user args$/);
  assert.equal(h.counts().calls, 1, "explicit invocation does not call the reranker");
});

test("SDK confidence/choice cannot override distribution gates; invalid outputs and errors use frozen baseline", async t => {
  const expected = { matches: [metadata("code-review"), metadata("security-review")], total: 4 };
  const responses = [
    (b: Wire) => choice(Object.fromEntries([...b.state.candidates.map(c => [c.id, c.id === "c0" ? 0.5 : 0]), ["no_match", 0.5]])),
    (b: Wire) => choice({ ...Object.fromEntries(b.state.candidates.map(c => [c.id, 0])), no_match: 0, evil: 1 }),
    () => choice({ c0: 1 }),
    () => Response.json({ answers: { selection: { type: "choice", choice: "c0", confidence: 1 } } }),
    () => new Response("malformed JSON"),
    () => new Response("x".repeat(65537)),
    () => Response.json({ error: "private" }, { status: 401 }),
    () => Response.json({ error: "private" }, { status: 429 }),
    () => { throw new Error("private network error"); },
  ];
  for (const respond of responses) {
    const h = await setup(t, async (_url, init) => respond(wire(init)));
    for (let repeat = 0; repeat < 2; repeat++) assert.deepEqual((await h.search("code-review", 2)).details.matches[0], metadata("code-review"));
    assert.equal(h.counts().calls, 0, "exact-name bypass even for malformed providers");
    // This non-exact fixture baseline is recorded in t05.
    const row = baseline.reports[0].firstTrialOutcomes.find((r: any) => r.caseId === "t05" && r.limit === 3);
    const frozen = { matches: row.matches.slice(0, 2).map((i: number) => metadata(baselineNames[i])), total: row.shortlist.length };
    assert.deepEqual(frozen, expected);
    for (let repeat = 0; repeat < 2; repeat++) assert.deepEqual((await h.search("review code", 2)).details, frozen);
    assert.equal(h.counts().calls, 2, "failed/uncertain SDK results must not cache");
  }
  const h = await setup(t, async (_url, init) => certain(wire(init), null));
  assert.deepEqual((await h.search("review code")).details, { matches: [], total: 0 });
  await h.search("review code");
  assert.equal(h.counts().calls, 1, "validated explicit no-match is cached");
});

test("a high distribution probability is not a guarantee of semantic correctness", async t => {
  const intent = queries.find(q => q.id === "h08")!;
  assert.deepEqual(intent.acceptable, []);
  const h = await setup(t, async (_url, init) => certain(wire(init), "code-review"));
  // A confidently wrong provider is accepted by these statistical gates. This
  // deliberately wrong answer is not evidence of accuracy or safe execution.
  assert.deepEqual((await h.search(intent.query)).details.matches, [metadata("code-review")]);
});

test("actual SDK deadlines abort body reads, do not retry/cache, and cancellation terminates the tool", async t => {
  let cancelled = 0, observed!: AbortSignal;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const h = await setup(t, async (_url, init) => {
    observed = init!.signal!;
    return new Response(new ReadableStream({ pull() { started(); }, cancel() { cancelled++; } }));
  }, "enabled=true\nmodel='mock-model'\ntimeout_ms=50");
  const pending = h.search("review code", 1);
  await ready;
  const row = baseline.reports[0].firstTrialOutcomes.find((r: any) => r.caseId === "t05" && r.limit === 1);
  assert.deepEqual((await pending).details, { matches: row.matches.map((i: number) => metadata(baselineNames[i])), total: row.shortlist.length });
  assert.equal(observed.aborted, true);
  assert.equal(cancelled, 1);
  const controller = new AbortController();
  const next = h.search("review code", 1, controller.signal);
  const rejected = assert.rejects(next, /user cancellation/);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("user cancellation"));
  await rejected;
  assert.equal(h.counts().calls, 2, "timed-out result not cached or retried");
});

test("SDK-backed cache uses normalized query, ignores result limit, and invalidates every lifecycle boundary", async t => {
  const h = await setup(t, async (_url, init) => certain(wire(init), "testing"));
  const first = await h.search("write unit", 1);
  assert.deepEqual(first.details.matches, [metadata("testing")]);
  first.details.matches[0].baseDir = "mutated";
  assert.deepEqual((await h.search(" WRITE UNIT ", 20)).details.matches, [metadata("testing")]);
  assert.equal(h.counts().calls, 1);
  for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
    await h.session(reason);
    assert.deepEqual((await h.search("write unit")).details, { matches: [], total: 0 });
    h.start();
    await h.search("write unit");
  }
  assert.equal(h.counts().calls, 6);
  h.key("rotated-mock-key");
  await h.search("write unit");
  assert.equal(h.counts().calls, 7);
  const relocated = catalog.map(s => s.name === "testing" ? { ...s, baseDir: "/relocated", filePath: "/relocated/SKILL.md" } : s);
  h.start(relocated);
  assert.deepEqual((await h.search("write unit")).details.matches, [{ ...metadata("testing"), baseDir: "/relocated", filePath: "/relocated/SKILL.md" }]);
  assert.equal(h.counts().calls, 8);
  await writeFile(join(h.globalDirectory, "config.toml"), "[skill_search.reranking]\nenabled=true\nmodel='changed-model'\n");
  await h.session(); h.start(); await h.search("write unit");
  assert.equal(h.counts().calls, 9);
  h.shutdown();
  assert.deepEqual((await h.search("write unit")).details, { matches: [], total: 0 });
  assert.equal(h.tool().annotations.openWorldHint, false);
});

test("late actual SDK responses cannot restore obsolete paths after catalog invalidation", async t => {
  let respond!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let staleBody!: Wire;
  let oldSignal!: AbortSignal;
  let first = true;
  const h = await setup(t, async (_url, init) => {
    const body = wire(init);
    if (first) {
      first = false;
      staleBody = body;
      oldSignal = init!.signal!;
      started();
      return new Promise<Response>(resolve => { respond = resolve; });
    }
    return certain(body, "testing");
  });
  const pending = h.search("write unit");
  const rejected = assert.rejects(pending, /state changed/);
  await ready;
  const relocated = catalog.map(s => s.name === "testing" ? { ...s, filePath: "/fresh/SKILL.md", baseDir: "/fresh" } : s);
  h.start(relocated);
  await rejected;
  assert.equal(oldSignal.aborted, true);
  respond(certain(staleBody, "code-review")); // The transport ignores abort and completes late.
  await new Promise(resolve => setImmediate(resolve));
  const expected = [{ ...metadata("testing"), filePath: "/fresh/SKILL.md", baseDir: "/fresh" }];
  assert.deepEqual((await h.search("write unit")).details.matches, expected);
  assert.deepEqual((await h.search("write unit")).details.matches, expected);
  assert.equal(h.counts().calls, 2, "only the current snapshot may populate the cache");
});

test("actual SDK receives only bounded escaped metadata and never a truncated oversized query", async t => {
  const resources = [
    { ...catalog[0], name: "alpha", description: 'topic "\\\\\n'.repeat(50) },
    { ...catalog[0], name: "beta", description: "synonym" },
    { ...catalog[0], name: "gamma", description: "synonym" },
  ];
  const h = await setup(t, async (_url, init) => {
    const body = wire(init);
    assert.equal(body.state.query, "topic");
    assert.deepEqual(body.state.candidates.map(c => c.id), ["c0"]);
    assert.equal(body.state.candidates[0].name, "alpha");
    assert.ok(Buffer.byteLength(JSON.stringify(body.state)) <= 256);
    assert.ok(Buffer.byteLength(body.state.candidates[0].description) <= 100);
    return certain(body, "alpha");
  }, "enabled=true\nmodel='mock-model'\nmax_candidates=2\nmax_query_bytes=5\nmax_description_bytes=100\nmax_payload_bytes=256", resources);
  assert.equal((await h.search("topic", 20)).details.matches[0].name, "alpha");
  assert.equal(h.counts().calls, 1);
  await h.search("ééé"); // Six UTF-8 bytes: do not send a truncated query.
  assert.equal(h.counts().calls, 1);
});

test("invalid inputs and all unavailable consent/credential states leave SDK completely lazy", async t => {
  for (const settings of ["enabled=false", "enabled='true'", "enabled=true\nmodel='mock-model'\nunknown='secret'"]) {
    const h = await setup(t, async () => { throw new Error("must never fetch"); }, settings);
    await h.search("review code");
    assert.deepEqual(h.counts(), { calls: 0, constructions: 0 });
    assert.doesNotMatch(h.diagnostics.join(""), /secret/);
  }
  const h = await setup(t, async () => { throw new Error("must never fetch"); });
  for (const query of ["", " ", "---", "?!"]) await assert.rejects(h.search(query), /skill name or task keywords/);
  for (const limit of [0, 21, NaN, Infinity, 1.5]) await assert.rejects(h.search("review code", limit), /integer from 1 to 20/);
  for (const key of [undefined, "", "   "]) {
    h.key(key);
    assert.equal((await h.search("review code")).details.total, 4);
  }
  assert.deepEqual(h.counts(), { calls: 0, constructions: 0 });
});
