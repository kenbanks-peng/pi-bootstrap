import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillCatalog } from "../../src/bootstrap-skills.ts";
import { keywordAdapter } from "./harness.ts";
import { scaleFixture, syntheticBody, type ScaleProfile } from "./scale-fixtures.ts";
import { agentFixtureHash, auditAgentTrace, type AgentTrace } from "./agent-load.ts";

// Offline only: mock local reads, or audit an explicitly supplied sanitized trace.
// Never launches an agent, loads executable adapters, or authorizes paid calls.
try {
  const [mode, split, sizeArg, tracePath, ...extra] = process.argv.slice(2);
  if (!["mock", "audit"].includes(mode) || (split !== "tuning" && split !== "held-out") ||
    !["128", "256"].includes(sizeArg) || extra.length || (mode === "mock" ? tracePath !== undefined : !tracePath)) throw new Error("Arguments");
  const fixture = scaleFixture(Number(sizeArg) as ScaleProfile);
  let trace: unknown;
  let sourceTraceSha256: string | null = null;
  if (mode === "audit") {
    // Read at most 1 MiB (+ one sentinel byte), even if the caller supplies a huge file.
    const { open } = await import("node:fs/promises");
    const file = await open(tracePath!, "r");
    try {
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) throw new Error("Trace exceeds bound");
      const bytes = buffer.subarray(0, bytesRead);
      sourceTraceSha256 = createHash("sha256").update(bytes).digest("hex");
      trace = JSON.parse(bytes.toString("utf8"));
    } finally { await file.close(); }
    if ((trace as AgentTrace).evidence !== "external-agent-trace-unverified") throw new Error("External evidence must be disclosed");
  } else {
    const directory = await mkdtemp(join(tmpdir(), "skill-agent-load-"));
    try {
      const catalog = skillCatalog(fixture.catalog);
      // Synthetic bodies are written only for this explicit agent-load check.
      await Promise.all(catalog.map((s, i) => writeFile(join(directory, `${i}-SKILL.md`), syntheticBody(s.name))));
      const adapter = keywordAdapter(fixture.catalog, "mock-agent-wiring-not-quality-evidence");
      const mock: AgentTrace = { schemaVersion: 1, evidence: "mock", split,
        fixtureSha256: agentFixtureHash(fixture.catalog, fixture.queries), cases: [] };
      for (const q of fixture.queries.filter(q => q.split === split)) {
        const result = await adapter.search(q.query, 5);
        const returned = result.matches.map(n => catalog.findIndex(s => s.name === n));
        const events: AgentTrace["cases"][number]["events"] = [{ kind: "search", returned }];
        // A scripted driver loads every search match. This is not a real agent.
        for (const index of returned) {
          const bytes = await readFile(join(directory, `${index}-SKILL.md`));
          events.push({ kind: "read", index, complete: true, bodySha256: createHash("sha256").update(bytes).digest("hex") });
        }
        mock.cases.push({ caseId: q.id, events });
      }
      trace = mock;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const report = auditAgentTrace(trace, fixture.catalog, fixture.queries, split);
  process.stdout.write(JSON.stringify({ ...report, sourceTraceSha256, fixtureVersion: fixture.fixtureVersion }, null, 2) + "\n");
} catch {
  process.stderr.write("Agent-load audit blocked or failed; no complete report. Usage: agent.ts mock|audit tuning|held-out 128|256 [sanitized-trace.json for audit only].\n");
  process.exitCode = 1;
}
