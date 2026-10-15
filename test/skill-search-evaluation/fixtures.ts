import type { Skill } from "@earendil-works/pi-coding-agent";

export type Category = "exact" | "paraphrase" | "ambiguous" | "no-match" | "disabled" | "duplicate";
export interface QueryCase {
  id: string;
  split: "tuning" | "held-out";
  category: Category;
  query: string;
  /** Any one of these skills satisfies the request. Empty means abstain. */
  acceptable: string[];
  /** Optional multi-skill task: every listed skill must be returned/loaded. */
  required?: string[];
}

function skill(name: string, description: string, suffix = name, disabled = false): Skill {
  return {
    name, description, filePath: `/synthetic-skills/${suffix}/SKILL.md`,
    baseDir: `/synthetic-skills/${suffix}`, disableModelInvocation: disabled,
    sourceInfo: { source: "user", scope: "user" } as Skill["sourceInfo"],
  };
}

/** Synthetic metadata only. Order is intentional: first enabled duplicate wins. */
export const catalog: Skill[] = [
  skill("code-review", "Review a branch or pull request for coding standards and specification compliance."),
  skill("debugging", "Diagnose bugs, investigate failures, and locate the cause of errors."),
  skill("testing", "Write unit and integration tests using test-driven development."),
  skill("refactor", "Restructure code and remove duplication without changing observable behavior."),
  skill("research", "Investigate technical questions using primary sources and document findings."),
  skill("documentation", "manual docs disabledfirst", "disabled-docs", true),
  skill("documentation", "Write guides and API reference documentation."),
  skill("security-review", "Review code for vulnerabilities, unsafe input, and authentication risks."),
  skill("performance", "Measure latency and optimize slow code and memory usage."),
  skill("release", "Prepare version updates, changelogs, and package publication."),
  skill("merge-conflicts", "Resolve conflicting changes during git merge and rebase."),
  skill("database", "Design SQL schemas and migrations for relational databases."),
  skill("translations", "Translate text between Français and 日本語."),
  skill("manual-deploy", "manual-deploy orbital rollout", "manual-deploy", true),
  skill("code-review", "quasar duplicateignored guidance", "duplicate-code-review"),
  skill("release", "hiddenrelease disabledduplicate", "disabled-release", true),
];

export const fixtureVersion = "skill-search-synthetic-v1";
export const resultLimits = [1, 3, 5] as const;
export const shortlistLimit = 20;

// Labels describe user intent, not current keyword output. Keep held-out cases
// out of threshold selection; queries do not repeat between splits.
export const queries: QueryCase[] = [
  { id: "t01", split: "tuning", category: "exact", query: "code-review", acceptable: ["code-review"] },
  { id: "t02", split: "tuning", category: "exact", query: "testing", acceptable: ["testing"] },
  { id: "t03", split: "tuning", category: "paraphrase", query: "find the cause of errors", acceptable: ["debugging"] },
  { id: "t04", split: "tuning", category: "paraphrase", query: "tidy implementation while preserving outputs", acceptable: ["refactor"] },
  { id: "t05", split: "tuning", category: "ambiguous", query: "review code", acceptable: ["code-review", "security-review"] },
  { id: "t06", split: "tuning", category: "ambiguous", query: "investigate", acceptable: ["debugging", "research"] },
  { id: "t07", split: "tuning", category: "no-match", query: "sourdough bread recipe", acceptable: [] },
  { id: "t08", split: "tuning", category: "no-match", query: "review my sourdough recipe", acceptable: [] },
  { id: "t09", split: "tuning", category: "disabled", query: "manual-deploy", acceptable: [] },
  { id: "t10", split: "tuning", category: "duplicate", query: "quasar duplicateignored", acceptable: [] },
  { id: "t11", split: "tuning", category: "duplicate", query: "branch specification compliance", acceptable: ["code-review"] },
  { id: "t12", split: "tuning", category: "paraphrase", query: "publish a new package version", acceptable: ["release"] },
  { id: "h01", split: "held-out", category: "exact", query: "SECURITY-REVIEW", acceptable: ["security-review"] },
  { id: "h02", split: "held-out", category: "exact", query: "merge-conflicts", acceptable: ["merge-conflicts"] },
  { id: "h03", split: "held-out", category: "paraphrase", query: "make this routine faster", acceptable: ["performance"] },
  { id: "h04", split: "held-out", category: "paraphrase", query: "explain how to use this library", acceptable: ["documentation"] },
  { id: "h05", split: "held-out", category: "paraphrase", query: "test-driven development", acceptable: ["testing"] },
  { id: "h06", split: "held-out", category: "ambiguous", query: "write documentation from primary sources", acceptable: ["research", "documentation"] },
  { id: "h07", split: "held-out", category: "ambiguous", query: "review unsafe code", acceptable: ["code-review", "security-review"] },
  { id: "h08", split: "held-out", category: "no-match", query: "weather forecast tomorrow", acceptable: [] },
  { id: "h09", split: "held-out", category: "no-match", query: "translate a sourdough recipe into Klingon", acceptable: [] },
  { id: "h10", split: "held-out", category: "disabled", query: "orbital rollout", acceptable: [] },
  { id: "h11", split: "held-out", category: "duplicate", query: "hiddenrelease disabledduplicate", acceptable: [] },
  { id: "h12", split: "held-out", category: "duplicate", query: "guides API reference", acceptable: ["documentation"] },
  { id: "h13", split: "held-out", category: "exact", query: "Français 日本語", acceptable: ["translations"] },
  { id: "h14", split: "held-out", category: "paraphrase", query: "research authentication risks", acceptable: ["security-review"] },
];
