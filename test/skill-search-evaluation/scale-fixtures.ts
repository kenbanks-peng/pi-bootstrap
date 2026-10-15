import type { Skill } from "@earendil-works/pi-coding-agent";
import { skillCatalog } from "../../src/bootstrap-skills.ts";
import { catalog as originalCatalog, queries as originalQueries, type QueryCase } from "./fixtures.ts";

export const scaleProfiles = [128, 256] as const;
export type ScaleProfile = typeof scaleProfiles[number];
export const scaleVersion = "skill-search-scale-v2";

function skill(name: string, description: string): Skill {
  return { name, description, filePath: `/synthetic-skills/${name}/SKILL.md`, baseDir: `/synthetic-skills/${name}`,
    disableModelInvocation: false, sourceInfo: { source: "user", scope: "user" } as Skill["sourceInfo"] };
}

// Hand-labeled confusables and late-alphabetical zero-overlap capabilities.
const capabilities = [
  skill("tls-client", "Configure TLS client certificates for outbound service connections. Not server certificates."),
  skill("tls-server", "Configure TLS server certificates for inbound service connections. Not client certificates."),
  skill("postgres-backup", "Back up and restore PostgreSQL databases. Not MySQL or Oracle databases."),
  skill("mysql-backup", "Back up and restore MySQL databases. Not PostgreSQL or Oracle databases."),
  skill("s3-storage", "Configure Amazon S3 bucket object storage. Not Azure blob storage or Google cloud storage."),
  skill("azure-storage", "Configure Azure blob object storage. Not Amazon S3 or Google cloud storage."),
  skill("ios-signing", "Sign iOS applications with Apple provisioning profiles. Not Android applications."),
  skill("android-signing", "Sign Android applications with keystore certificates. Not iOS applications."),
  skill("zzz-archive-recovery", "Restore redundant archives after storage faults."),
  skill("zzz-greenhouse", "Cultivate seedlings within climate controlled glass enclosures."),
];

// Cross product supplies distinct, plausible metadata rather than numbered copies
// of a single description. Ordering/version are frozen; no runtime random data.
const domains = ["kubernetes", "redis", "kafka", "nginx", "terraform", "docker", "prometheus", "grafana",
  "elasticsearch", "rabbitmq", "sqlite", "mongodb", "cassandra", "clickhouse", "snowflake", "bigquery",
  "flink", "spark", "airflow", "dbt", "vault", "consul", "nomad", "envoy", "istio", "linkerd",
  "argocd", "flux", "helm", "ansible", "pulumi", "packer"];
const actions = [
  ["installation", "Install and configure a new instance"],
  ["upgrades", "Upgrade versions and verify compatibility"],
  ["monitoring", "Set up metrics dashboards and alert rules"],
  ["backup", "Back up state and restore after failures"],
  ["security", "Audit permissions credentials and encryption"],
  ["performance", "Profile throughput latency and resource usage"],
  ["networking", "Diagnose network connectivity and routing"],
  ["migration", "Migrate workloads between environments"],
] as const;

export function scaleFixture(size: ScaleProfile) {
  if (!scaleProfiles.includes(size)) throw new Error("Scale profile must be 128 or 256");
  const catalog = structuredClone(originalCatalog);
  catalog.push(...structuredClone(capabilities));
  for (const domain of domains) for (const [action, description] of actions) {
    if (skillCatalog(catalog).length < size) catalog.push(skill(`${domain}-${action}`, `${description} for ${domain}.`));
  }
  // Late targets stay beyond any 20/64-candidate alphabetical prefix.
  catalog.sort((a, b) => a.name.localeCompare(b.name));
  const queries: QueryCase[] = structuredClone(originalQueries);
  const add = (q: Omit<QueryCase, "id">, id: string) => queries.push({ ...q, id });
  for (const [split, prefix] of [["tuning", "st"], ["held-out", "sh"]] as const) {
    const tuning = split === "tuning";
    const cases: Omit<QueryCase, "id">[] = [
      { split, category: "paraphrase", query: tuning ? "resurrect vanished snapshots" : "salvage lost replicas", acceptable: ["zzz-archive-recovery"] },
      { split, category: "paraphrase", query: tuning ? "grow tomatoes indoors" : "raise vegetables under transparent roofs", acceptable: ["zzz-greenhouse"] },
      { split, category: "paraphrase", query: tuning ? "TLS client certificates outbound" : "configure inbound TLS server certificates", acceptable: [tuning ? "tls-client" : "tls-server"] },
      { split, category: "paraphrase", query: tuning ? "PostgreSQL restore backup" : "MySQL restore backup", acceptable: [tuning ? "postgres-backup" : "mysql-backup"] },
      { split, category: "paraphrase", query: tuning ? "Amazon S3 bucket configuration" : "Azure blob configuration", acceptable: [tuning ? "s3-storage" : "azure-storage"] },
      { split, category: "paraphrase", query: tuning ? "Apple provisioning profiles" : "Android keystore certificates", acceptable: [tuning ? "ios-signing" : "android-signing"] },
      { split, category: "no-match", query: tuning ? "restore Oracle database backup" : "configure Google cloud storage buckets", acceptable: [] },
      { split, category: "no-match", query: tuning ? "sign Windows applications with certificates" : "configure TLS certificates for a sourdough oven", acceptable: [] },
      { split, category: "ambiguous", query: tuning ? "review code and write integration tests" : "research primary sources and write documentation",
        acceptable: tuning ? ["code-review", "testing"] : ["research", "documentation"],
        required: tuning ? ["code-review", "testing"] : ["research", "documentation"] },
      { split, category: "ambiguous", query: tuning ? "restore PostgreSQL and MySQL backups" : "configure Amazon S3 and Azure blob storage",
        acceptable: tuning ? ["postgres-backup", "mysql-backup"] : ["s3-storage", "azure-storage"],
        required: tuning ? ["postgres-backup", "mysql-backup"] : ["s3-storage", "azure-storage"] },
    ];
    cases.forEach((q, index) => add(q, `${prefix}${String(index + 1).padStart(2, "0")}`));
    // Different products across splits; all present even in the smaller catalog.
    const products = tuning ? ["kubernetes", "kafka", "terraform", "prometheus"] : ["redis", "nginx", "docker", "grafana"];
    for (const [i, product] of products.entries()) {
      add({ split, category: "exact", query: `${product}-upgrades`, acceptable: [`${product}-upgrades`] }, `${prefix}e${i}`);
      add({ split, category: "paraphrase", query: `${product} metrics dashboards alert rules`, acceptable: [`${product}-monitoring`] }, `${prefix}p${i}`);
    }
  }
  return { catalog, queries, fixtureVersion: `${scaleVersion}-${size}` };
}

/** Bodies are local synthetic canaries, never part of search/provider payloads. */
export function syntheticBody(name: string) {
  return `# Synthetic skill ${name}\n\nEvaluation-only instructions. Record local canary SYNTHETIC-LOAD-${name}.\n`;
}
