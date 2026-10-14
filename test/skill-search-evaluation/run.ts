import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { catalog } from "./fixtures.ts";
import { evaluate, keywordAdapter, type ReplayAdapter } from "./harness.ts";

// Explicit split required: do not accidentally tune against held-out data.
const [split, repeatArg = "10", adapterPath, ...extra] = process.argv.slice(2);
if ((split !== "tuning" && split !== "held-out") || extra.length) {
  throw new Error("Usage: npx tsx test/skill-search-evaluation/run.ts tuning|held-out [repetitions] [semantic-adapter.ts]");
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const sourceHash = createHash("sha256").update(readFileSync(new URL("../../src/bootstrap-skills.ts", import.meta.url))).digest("hex");
const adapter: ReplayAdapter = adapterPath
  ? await (await import(pathToFileURL(resolve(adapterPath)).href)).createAdapter(structuredClone(catalog))
  : keywordAdapter(catalog, `${revision}:bootstrap-skills-sha256:${sourceHash}`);
if (adapterPath && adapter.manifest.mode !== "semantic") throw new Error("External adapter must declare semantic mode");
const installed = JSON.parse(execFileSync("npm", ["ls", "--depth=0", "--json"], { encoding: "utf8" })) as {
  dependencies: Record<string, { version: string }>;
};
const dependencyVersions = Object.fromEntries(Object.entries(installed.dependencies).map(([name, info]) => [name, info.version]));
try {
  const result = await evaluate(adapter, { split, repetitions: Number(repeatArg) });
  await adapter.close?.();
  process.stdout.write(JSON.stringify({ ...result, dependencyVersions }, null, 2) + "\n");
} finally { await adapter.close?.(); }
