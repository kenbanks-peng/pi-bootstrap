import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultRerankingConfig } from "../src/bootstrap-skills-reranking-config.ts";
import { SkillRerankingRuntime } from "../src/bootstrap-skills-reranking-runtime.ts";
import { boundedFetch } from "../src/bootstrap-skills-jev.ts";

const config = { ...defaultRerankingConfig, enabled: true, model: "mock-model" };
const request = { query: "topic", candidates: [{ id: "c0", name: "alpha", description: "topic" }] };

test("cancellation/state invalidation before lazy dispatch must not invoke the adapter", async () => {
  for (const boundary of ["cancel", "clear"]) {
    const runtime = new SkillRerankingRuntime();
    const controller = new AbortController();
    let calls = 0;
    const pending = runtime.search(request, config, { rerank: async () => { calls++; return {}; } }, controller.signal);
    const rejected = assert.rejects(pending, boundary === "cancel" ? /cancelled/ : /state changed/);
    if (boundary === "cancel") controller.abort(new Error("cancelled"));
    else runtime.clear();
    await rejected;
    assert.equal(calls, 0, `${boundary} must stop queued provider setup`);
  }
});

test("abort releases an outstanding response body read even if transport ignores the signal", async () => {
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  let cancelled = false;
  const fetcher = boundedFetch(async () => new Response(new ReadableStream({
    pull() { reading(); },
    cancel() { cancelled = true; },
  })));
  const controller = new AbortController();
  const pending = fetcher("https://mock.invalid", { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled/);
  await started;
  controller.abort(new Error("cancelled"));
  // Avoid a hanging regression run on the unfixed implementation.
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([rejected, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("body read did not settle after abort")), 100);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(cancelled, true);
});
