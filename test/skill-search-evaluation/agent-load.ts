import { createHash } from "node:crypto";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { skillCatalog } from "../../src/bootstrap-skills.ts";
import type { QueryCase } from "./fixtures.ts";
import { syntheticBody } from "./scale-fixtures.ts";

export type AgentEvent = { kind: "search"; returned: number[] } |
  { kind: "read"; index: number; bodySha256: string; complete: boolean };
export interface AgentTrace {
  schemaVersion: 1;
  evidence: "mock" | "external-agent-trace-unverified";
  fixtureSha256: string;
  split: QueryCase["split"];
  cases: { caseId: string; events: AgentEvent[] }[];
}
export const bodyHash = (name: string) => createHash("sha256").update(syntheticBody(name)).digest("hex");
export const agentFixtureHash = (skills: readonly Skill[], cases: readonly QueryCase[]) =>
  createHash("sha256").update(JSON.stringify({ skills, cases })).digest("hex");

function keys(value: unknown, allowed: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key)) || Object.keys(value).length !== allowed.length) {
    throw new Error("Invalid agent trace fields");
  }
}

/** Audit local, sanitized tool observations. No model/SDK invocation or raw transcript ingestion.
 * Hashes bind reads to synthetic bodies, but cannot prove an external collector is truthful.
 */
export function auditAgentTrace(input: unknown, skills: readonly Skill[], cases: readonly QueryCase[], split: QueryCase["split"]) {
  keys(input, ["schemaVersion", "evidence", "fixtureSha256", "split", "cases"]);
  const trace = input as AgentTrace;
  const catalog = skillCatalog(skills);
  const selected = cases.filter(q => q.split === split);
  if (trace.schemaVersion !== 1 || !["mock", "external-agent-trace-unverified"].includes(trace.evidence) ||
    trace.fixtureSha256 !== agentFixtureHash(skills, cases) || trace.split !== split ||
    !Array.isArray(trace.cases) || trace.cases.length !== selected.length || trace.cases.length > 1000) throw new Error("Unpaired agent trace");
  const seen = new Set<string>();
  const rows = trace.cases.map(sample => {
    keys(sample, ["caseId", "events"]);
    const q = selected.find(q => q.id === sample.caseId);
    if (!q || seen.has(q.id) || !Array.isArray(sample.events) || sample.events.length > 32) throw new Error("Invalid agent case coverage");
    seen.add(q.id);
    let lastReturned: number[] | undefined;
    const returned = new Set<string>(), loaded = new Set<string>();
    let reads = 0, prematureReads = 0, incompleteReads = 0, unselectedReads = 0;
    for (const event of sample.events) {
      const validIndex = (i: number) => Number.isSafeInteger(i) && i >= 0 && i < catalog.length;
      if (event.kind === "search") {
        keys(event, ["kind", "returned"]);
        if (!Array.isArray(event.returned) || event.returned.length > 5 || new Set(event.returned).size !== event.returned.length ||
          !event.returned.every(validIndex)) throw new Error("Invalid agent search event");
        lastReturned = event.returned;
        event.returned.forEach(i => returned.add(catalog[i].name));
      } else if (event.kind === "read") {
        keys(event, ["kind", "index", "bodySha256", "complete"]);
        if (!validIndex(event.index) || typeof event.complete !== "boolean" || event.bodySha256 !== bodyHash(catalog[event.index].name)) {
          throw new Error("Agent reads must identify complete synthetic fixture bodies");
        }
        reads++;
        if (!event.complete) incompleteReads++;
        if (!lastReturned) prematureReads++;
        else if (!lastReturned.includes(event.index)) unselectedReads++;
        if (event.complete && lastReturned?.includes(event.index)) loaded.add(catalog[event.index].name);
      } else throw new Error("Invalid agent event kind");
    }
    const positive = q.acceptable.length > 0;
    const searchHit = positive ? q.acceptable.some(n => returned.has(n)) : null;
    const loadHit = positive ? q.acceptable.some(n => loaded.has(n)) : null;
    return {
      caseId: q.id, searchHit, loadHit,
      allRequiredLoaded: q.required ? q.required.every(n => loaded.has(n)) : null,
      noMatchSearchHit: positive ? null : lastReturned !== undefined && returned.size === 0,
      noMatchLoadHit: positive ? null : lastReturned !== undefined && reads === 0,
      wrongLoads: [...loaded].filter(n => !q.acceptable.includes(n)).length,
      reads, prematureReads, incompleteReads, unselectedReads,
    };
  });
  const rate = (values: (boolean | null)[]) => {
    const known = values.filter(value => value !== null);
    return { trials: known.length, accuracy: known.length ? known.filter(Boolean).length / known.length : null };
  };
  return { schemaVersion: 1, evidence: trace.evidence, fixtureSha256: trace.fixtureSha256, split,
    // Mock load success proves harness wiring only, never real agent behavior.
    realAgentBehaviorVerified: false,
    metrics: {
      search: rate(rows.map(r => r.searchHit)), loadAfterSearch: rate(rows.map(r => r.loadHit)),
      loadGivenSearchHit: rate(rows.filter(r => r.searchHit).map(r => r.loadHit)),
      allRequiredLoaded: rate(rows.map(r => r.allRequiredLoaded)),
      noMatchSearch: rate(rows.map(r => r.noMatchSearchHit)), noMatchLoad: rate(rows.map(r => r.noMatchLoadHit)),
      wrongLoads: rows.reduce((sum, r) => sum + r.wrongLoads, 0),
      prematureReads: rows.reduce((sum, r) => sum + r.prematureReads, 0),
      incompleteReads: rows.reduce((sum, r) => sum + r.incompleteReads, 0),
      unselectedReads: rows.reduce((sum, r) => sum + r.unselectedReads, 0),
    }, rows };
}
