// Compact TOML notation for matcher fixtures, not a supported configuration format.
import { parse } from "smol-toml";

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table =>
  value !== null && typeof value === "object" && !Array.isArray(value);

import type { Action } from "../src/replace.ts";

export function parseReplacements(toml: string): Map<string, Action> {
  const replacements = new Map<string, Action>();
  const visit = (table: Table, path: string[]) => {
    const fields = Object.entries(table).filter(([, value]) => !isTable(value));
    if (fields.length) {
      if (path.length && fields.length === 1 && typeof table.replacement === "string")
        replacements.set(JSON.stringify(path), table.replacement);
      else if (path.length && fields.length === 2 && typeof table.refer === "string" &&
        typeof table.link === "string" && table.link.trim())
        replacements.set(JSON.stringify(path), { refer: table.refer, link: table.link });
      else throw new Error(path.join(".") + ": expected replacement, or refer with a non-empty link");
    }
    for (const [name, value] of Object.entries(table))
      if (isTable(value)) visit(value, [...path, name]);
  };
  visit(parse(toml), []);
  return replacements;
}

