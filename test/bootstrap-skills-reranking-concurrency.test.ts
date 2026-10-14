import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultRerankingConfig } from "../src/bootstrap-skills-reranking-config.ts";
import { SkillRerankingRuntime } from "../src/bootstrap-skills-reranking-runtime.ts";
import { createJevAdapter } from "../src/bootstrap-skills-jev.ts";
import type { SkillRerankingRequest } from "../src/bootstrap-skills-reranking.ts";

const config = { ...defaultRerankingConfig, enabled: true, model: "test-model", timeoutMs: 50 };
const request: SkillRerankingRequest = { query: "topic", candidates: [{ id: "c0", name: "alpha", description: "topic" }] };
const chosen = { probabilities: [{ id: "c0", probability: 0.9 }, { id: null, probability: 0.1 }] };

test("parallel searches have independent signals and one cancellation cannot cancel its sibling", async () => {
  const runtime = new SkillRerankingRuntime();
  const signals: AbortSignal[] = [];
  const resolvers: ((value: unknown) => void)[] = [];
  const adapter = { rerank: async (_request: SkillRerankingRequest, { signal }: { signal: AbortSignal }) => {
    signals.push(signal);
    return new Promise(resolve => resolvers.push(resolve));
  } };
  const controller = new AbortController();
  const first = runtime.search(request, config, adapter, controller.signal);
  const rejected = assert.rejects(first, /cancel/);
  const second = runtime.search({ ...request, query: "synonym" }, config, adapter);
  await Promise.resolve();
  assert.notEqual(signals[0], signals[1]);
  controller.abort(new Error("cancel"));
  await rejected;
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  resolvers[1](chosen);
  assert.deepEqual(await second, { kind: "matches", ids: ["c0"] });
  resolvers[0](chosen); // late completion must not populate the cancelled query's cache
  let calls = 0;
  await runtime.search(request, config, { rerank: async () => { calls++; return chosen; } });
  assert.equal(calls, 1);
});

test("actual SDK network/auth/unsupported model/malformed and partial responses all fall back", async () => {
  for (const failure of ["network", "auth", "model", "malformed", "partial"]) {
    let calls = 0;
    const adapter = createJevAdapter("private-key", async () => {
      calls++;
      if (failure === "network") throw new Error("Network unreachable");
      if (failure === "auth") return Response.json({ error: "bad key" }, { status: 401 });
      if (failure === "model") return Response.json({ error: "unsupported model" }, { status: 422 });
      if (failure === "malformed") return new Response("invalid JSON");
      return Response.json({ answers: { selection: { type: "choice", probabilities: { c0: 1 } } } });
    });
    const runtime = new SkillRerankingRuntime();
    const result = await runtime.search(request, { ...config, timeoutMs: 1000 }, adapter);
    assert.deepEqual(result, { kind: "fallback", reason: failure === "partial" ? "invalid-response" : "provider" });
    assert.equal(calls, 1);
  }
});
