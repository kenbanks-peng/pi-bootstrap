import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { registerLazySkills } from "../src/bootstrap-skills.ts";
import type { SkillRerankingRequest } from "../src/bootstrap-skills-reranking.ts";
import type { SkillSearchObservation } from "../src/bootstrap-skills-observation.ts";
import { retrieveSemanticCandidates } from "../src/bootstrap-skills-retrieval.ts";
import { buildRerankingRequest } from "../src/bootstrap-skills-reranking-runtime.ts";
import { defaultRerankingConfig } from "../src/bootstrap-skills-reranking-config.ts";

const skill = (name: string, description: string): Skill => ({ name, description,
  filePath: `/PRIVATE/${name}/SKILL.md`, baseDir: `/PRIVATE/${name}`, disableModelInvocation: false,
  sourceInfo: { source: "user", scope: "user" } as Skill["sourceInfo"] });

test("retrieval preserves unsupported-query order and deterministic overlap/cap behavior", () => {
  const ranked = [
    { skill: skill("a-debugging", "troubleshoot"), rank: 10 },
    { skill: skill("b-literal", "troubleshoot"), rank: 2 },
    { skill: skill("zz-diagnosis", "isolation"), rank: 0 },
  ];
  assert.deepEqual(retrieveSemanticCandidates("unknown-vocabulary", ranked), ranked.map(r => r.skill));
  const retrieved = retrieveSemanticCandidates("troubleshoot", ranked);
  assert.deepEqual(retrieved.map(s => s.name), ["a-debugging", "zz-diagnosis", "b-literal"], "skip overlapping stream heads within a turn");
  assert.deepEqual(retrieveSemanticCandidates("TROUBLESHOOT", ranked), retrieved);
  for (const maxCandidates of [1, 2, 32, 64]) {
    const request = buildRerankingRequest("troubleshoot", retrieved, { ...defaultRerankingConfig, maxCandidates })!;
    assert.equal(request.candidates.length, Math.min(maxCandidates, ranked.length));
    assert.equal(request.candidates[0].name, "a-debugging", "positive lexical head preserved even at cap 1");
    if (maxCandidates > 1) assert.equal(request.candidates[1].name, "zz-diagnosis");
  }
});

for (const size of [100, 220]) {
  for (const [query, description] of [["troubleshoot", "Diagnose faults"], ["slowness", "Performance profiling"], ["localisation", "Translate interfaces"]]) {
    test(`${size} skills: late synonym-only target for ${query}, with and without lexical saturation`, async t => {
      const globalDirectory = await mkdtemp(join(tmpdir(), "skill-retrieval-"));
      t.after(() => rm(globalDirectory, { recursive: true, force: true }));
      const handlers = new Map<string, (...args: any[]) => any>();
      let tool: any;
      let outbound: SkillRerankingRequest | undefined;
      let observation: SkillSearchObservation | undefined;
      let calls = 0;
      let fail = false;
      let payloadBytes = 32768;
      const configure = async (enabled = true) => {
        await writeFile(join(globalDirectory, "config.toml"), `[skill_search.reranking]\nenabled=${enabled}\nmax_payload_bytes=${payloadBytes}\n`);
        await handlers.get("session_start")!({});
      };
      registerLazySkills({ on: (name: string, handler: any) => handlers.set(name, handler), registerTool: (value: any) => { tool = value; } } as never,
        { globalDirectory, credential: () => "mock-only", observe: value => { observation = value; }, adapterFor: () => ({ rerank: async request => {
          calls++;
          outbound = request;
          if (fail) throw new Error("mock failure");
          return { probabilities: [...request.candidates.map(c => ({ id: c.id, probability: c.name === "zz-target" ? 1 : 0 })), { id: null, probability: 0 }] };
        } }) });
      const search = (q = query) => tool.execute("id", { query: q, limit: 1 });
      for (const saturated of [false, true]) {
        const resources = [...Array.from({ length: size }, (_, i) => skill(`a-${String(i).padStart(3, "0")}`, saturated ? query : "unrelated filler")),
          { ...skill("z-disabled", description), disableModelInvocation: true },
          skill("zz-target", description), skill("zz-target", "PRIVATE_DUPLICATE")];
        const start = () => {
          const options = { skills: resources, sections: { skills: "PRIVATE_PROMPT" } };
          handlers.get("before_agent_start")!({ systemPromptOptions: options });
          assert.deepEqual(options.skills, [], "lazy metadata discovery still hides catalog");
        };
        await configure(); start();
        const result = await search();
        assert.equal(result.details.matches[0].name, "zz-target");
        assert.equal(result.details.matches[0].filePath, "/PRIVATE/zz-target/SKILL.md");
        assert.ok(outbound!.candidates.length <= 32);
        assert.ok(outbound!.candidates.findIndex(c => c.name === "zz-target") <= 1, "not merely a larger alphabetical cap");
        assert.ok(Buffer.byteLength(JSON.stringify(outbound)) <= payloadBytes);
        assert.equal(new Set(outbound!.candidates.map(c => c.name)).size, outbound!.candidates.length);
        assert.ok(!outbound!.candidates.some(c => c.name === "z-disabled"));
        assert.equal(outbound!.candidates.find(c => c.name === "zz-target")!.description, description);
        assert.deepEqual(outbound!.candidates.map(c => c.id), outbound!.candidates.map((_, i) => `c${i}`));
        assert.doesNotMatch(JSON.stringify(outbound), /PRIVATE|filePath|baseDir|SKILL\.md/);
        assert.deepEqual(observation!.shortlist, outbound!.candidates.map(c => {
          const sorted = resources.filter(s => !s.disableModelInvocation).filter((s, i, all) => all.findIndex(other => other.name === s.name) === i).sort((a, b) => a.name.localeCompare(b.name));
          return sorted.findIndex(s => s.name === c.name);
        }), "telemetry measures the actual transmitted shortlist");
        const beforeCached = calls;
        await search(); assert.equal(calls, beforeCached);
        assert.equal(observation!.cache, "hit");
        await search("zz-target"); assert.equal(calls, beforeCached, "exact name bypass");

        // A provider failure must return precisely the keyword-only baseline,
        // never the locally expanded synonyms.
        fail = true;
        await configure(); start();
        const fallback = await search();
        await configure(false); start();
        const beforeDisabled = calls;
        const keyword = await search();
        assert.deepEqual(fallback, keyword);
        assert.equal(keyword.details.total, saturated ? size : 0);
        assert.equal(calls, beforeDisabled);
        fail = false;

        // Tail dropping must not invalidate telemetry/IDs under tight bounds.
        payloadBytes = 256;
        await configure(); start();
        await search();
        assert.ok(Buffer.byteLength(JSON.stringify(outbound)) <= 256);
        assert.ok(outbound!.candidates.length < 32);
        assert.equal(observation!.shortlist.length, outbound!.candidates.length);
        payloadBytes = 32768;
      }
    });
  }
}
