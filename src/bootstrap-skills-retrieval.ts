import type { SkillMetadata } from "./bootstrap-skills.ts";

// Deliberately small, inspectable retrieval vocabulary, not a semantic model.
// Only local metadata is consulted; expansions never enter the outbound query.
const concepts = [
  ["debug", "debugging", "diagnose", "diagnosis", "troubleshoot", "troubleshooting", "fault", "bug", "bugs"],
  ["test", "tests", "testing", "verification", "verify", "assertion", "assertions"],
  ["performance", "profiling", "profile", "latency", "slow", "slowness", "bottleneck", "bottlenecks"],
  ["refactor", "refactoring", "restructure", "restructuring", "simplify", "simplification"],
  ["security", "vulnerability", "vulnerabilities", "exploit", "exploits", "hardening"],
  ["documentation", "docs", "document", "handbook", "manual"],
  ["release", "releasing", "publish", "publishing", "deployment", "deploy", "shipping"],
  ["database", "databases", "sql", "query", "queries", "schema", "schemas"],
  ["translation", "translations", "translate", "localization", "localisation", "i18n"],
  ["research", "investigate", "investigation", "survey", "sources"],
  ["review", "reviewing", "critique", "audit", "auditing"],
  ["merge", "merging", "rebase", "rebasing", "conflict", "conflicts"],
] as const;
const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const intersects = (terms: ReadonlySet<string>, concept: readonly string[]) => concept.some(term => terms.has(term));

/** Enrich only the opted-in shortlist; never replace the saved keyword fallback.
 * Input order is the unchanged lexical score/name order, including zero scores.
 * Alternating streams reserve space for local synonym matches even when lexical
 * matches fill the cap. With no lexical match, start with the enriched stream.
 */
export function retrieveSemanticCandidates(query: string, ranked: readonly { skill: SkillMetadata; rank: number }[]): SkillMetadata[] {
  const terms = words(query);
  // Literal query hits already have the lexical stream. Score only alternate
  // vocabulary here, otherwise repeated literal hits recreate the same ceiling.
  const active = concepts.filter(concept => intersects(terms, concept))
    .map(concept => concept.filter(term => !terms.has(term)));
  if (!active.length) return ranked.map(match => match.skill);
  const enriched = ranked.map((match, order) => {
    const name = words(match.skill.name);
    const description = words(match.skill.description);
    const rank = active.reduce((sum, concept) => sum + (intersects(name, concept) ? 4 : 0) + (intersects(description, concept) ? 1 : 0), 0);
    return { skill: match.skill, rank, order };
  }).filter(match => match.rank > 0).sort((a, b) => b.rank - a.rank || a.order - b.order);
  const lexical = ranked.map(match => match.skill);
  const semantic = enriched.map(match => match.skill);
  const streams = ranked[0]?.rank > 0 ? [lexical, semantic] : [semantic, lexical];
  const result: SkillMetadata[] = [];
  const seen = new Set<string>();
  const positions = [0, 0];
  // Advance past duplicates within each turn so an overlapping head cannot
  // consume the other stream's reserved slot.
  while (positions.some((position, index) => position < streams[index].length)) {
    for (const [index, stream] of streams.entries()) {
      while (positions[index] < stream.length) {
        const skill = stream[positions[index]++];
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        result.push(skill);
        break;
      }
    }
  }
  return result;
}
