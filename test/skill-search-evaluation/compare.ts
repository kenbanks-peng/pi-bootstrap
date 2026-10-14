import { readFileSync } from "node:fs";
import { compareReports } from "./comparison.ts";

const [baselinePath, semanticPath, ...extra] = process.argv.slice(2);
if (!baselinePath || !semanticPath || extra.length) {
  throw new Error("Usage: npx tsx test/skill-search-evaluation/compare.ts baseline.json semantic.json");
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const semantic = JSON.parse(readFileSync(semanticPath, "utf8"));
if (!baseline.dependencyVersions || !semantic.dependencyVersions ||
  JSON.stringify(baseline.dependencyVersions) !== JSON.stringify(semantic.dependencyVersions)) {
  throw new Error("Unpaired installed dependency versions");
}
process.stdout.write(JSON.stringify(compareReports(baseline, semantic), null, 2) + "\n");
