import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { evaluate, keywordAdapter } from "./harness.ts";
import { scaleFixture, type ScaleProfile } from "./scale-fixtures.ts";

// Deliberately offline-only. Use live.ts's existing explicit authorization gate
// for a paid paired run; this command never imports arbitrary executable bridges.
try {
  const [split, sizeArg, repeatArg = "1", ...extra] = process.argv.slice(2);
  const size = Number(sizeArg);
  if ((split !== "tuning" && split !== "held-out") || ![128, 256].includes(size) || extra.length) throw new Error("Arguments");
  const fixture = scaleFixture(size as ScaleProfile);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const files = ["src/bootstrap-skills.ts", "test/skill-search-evaluation/harness.ts", "test/skill-search-evaluation/fixtures.ts",
    "test/skill-search-evaluation/scale-fixtures.ts", "test/skill-search-evaluation/scale.ts"];
  const sourceSha256 = Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
  const installed = JSON.parse(execFileSync("npm", ["ls", "--depth=0", "--json"], { encoding: "utf8" }));
  const dependencyVersions = Object.fromEntries(Object.entries(installed.dependencies as Record<string, { version: string }>).map(([name, value]) => [name, value.version]));
  const report = await evaluate(keywordAdapter(fixture.catalog, revision), {
    fixtureVersion: fixture.fixtureVersion, skills: fixture.catalog, cases: fixture.queries, split, repetitions: Number(repeatArg),
  });
  process.stdout.write(JSON.stringify({ ...report, sourceSha256, dependencyVersions, execution: "offline-keyword" }, null, 2) + "\n");
} catch {
  process.stderr.write("Offline scale evaluation failed. Usage: scale.ts tuning|held-out 128|256 [repetitions 1–100].\n");
  process.exitCode = 1;
}
