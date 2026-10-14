import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { catalog, queries, resultLimits } from "./fixtures.ts";
import { evaluate, keywordAdapter } from "./harness.ts";
import { createLiveAdapter, type LiveOptions } from "./production.ts";
import { compareReports } from "./comparison.ts";

// No implicit model, credential discovery, warmups, calibration or paid retries.
// Catch at this boundary: SDK/transport exceptions must never print raw payloads.
try {
  const [split, repeatArg, authorizationPath, ...extra] = process.argv.slice(2);
  const repetitions = Number(repeatArg);
  if ((split !== "tuning" && split !== "held-out") || !authorizationPath || extra.length ||
    !Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new Error("Invalid arguments");
  }
  const options: LiveOptions = JSON.parse(readFileSync(authorizationPath, "utf8"));
  const trials = queries.filter(query => query.split === split).length * resultLimits.length * repetitions;
  // Conservatively allow one paid call per invocation, including failed calls.
  // No warming or hidden diagnostic model calls are made.
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < trials) throw new Error("Insufficient request ceiling");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const sourceFiles = ["src/bootstrap-skills.ts", "src/bootstrap-skills-jev.ts", "src/bootstrap-skills-reranking-runtime.ts",
    "src/bootstrap-skills-reranking-config.ts", "src/bootstrap-skills-reranking.ts", "src/bootstrap-skills-observation.ts",
    "test/skill-search-evaluation/harness.ts", "test/skill-search-evaluation/production.ts", "test/skill-search-evaluation/live.ts",
    "test/skill-search-evaluation/comparison.ts", "test/skill-search-evaluation/fixtures.ts"];
  const sourceSha256 = Object.fromEntries(sourceFiles.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
  const installed = JSON.parse(execFileSync("npm", ["ls", "--depth=0", "--json"], { encoding: "utf8" }));
  const dependencyVersions = Object.fromEntries(Object.entries(installed.dependencies as Record<string, { version: string }>).map(([key, value]) => [key, value.version]));
  if (dependencyVersions["@typesafe-ai/sdk"] !== "0.6.0") throw new Error("SDK version mismatch");
  const semantic = await createLiveAdapter(structuredClone(catalog), { ...options, implementationVersion: revision });
  try {
    const keywordReport = await evaluate(keywordAdapter(catalog, revision), { split, repetitions });
    const semanticReport = await evaluate(semantic, { split, repetitions });
    const report = {
      measuredAt: new Date().toISOString(), sourceSha256, dependencyVersions,
      keyword: keywordReport, semantic: semanticReport, comparison: compareReports(keywordReport, semanticReport),
    };
    await semantic.close?.();
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } finally { await semantic.close?.(); }
} catch {
  // Incomplete runs intentionally produce no JSON success report. Any already
  // incurred charges still need reconciliation via provider billing records.
  process.stderr.write("Live evaluation blocked or failed; no complete report. Check explicit split/repetitions (1–100), model/version, TYPESAFE_API_KEY, authorized request/USD ceilings and pricing assumptions. No provider error payload is logged.\n");
  process.exitCode = 1;
}
