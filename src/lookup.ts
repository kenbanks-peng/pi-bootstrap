import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "smol-toml";

export interface Source { path: string[]; original: string }
export type Table = Record<string, unknown>;

function tableAt(root: Table, path: string[]): Table | undefined {
  let value: unknown = root;
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    value = (value as Table)[key];
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Table : undefined;
}
const header = (path: string[]) => "[" + path.map(p => JSON.stringify(p)).join(".") + "]";

/** Insert only new tables. Existing bytes, including comments, are retained. */
export function addFields(text: string, path: string[], body: string, exists: boolean): string {
  if (exists) {
    const marker = "__bootstrap_" + randomUUID().replaceAll("-", "");
    for (const match of text.matchAll(/^[ \t]*\[(?!\[).*?\][ \t]*(?:#.*)?$/gm)) {
      const end = match.index! + match[0].length;
      try {
        const prefix = parse(text.slice(0, end) + "\n" + marker + " = true\n") as Table;
        if (tableAt(prefix, path)?.[marker] === true) {
          const result = text.slice(0, end) + "\n" + body + text.slice(end);
          parse(result);
          return result;
        }
      } catch { /* A header inside a multiline string is not a table. */ }
    }
  }
  const result = text + (text.endsWith("\n") || !text ? "" : "\n") + "\n" + header(path) + "\n" + body;
  parse(result); // Refuse ambiguous inline tables or duplicate keys rather than rewriting them.
  return result;
}

export interface Report { missing: string[]; error?: string }
export class Lookup {
  private data: Table = {};
  report: Report = { missing: [] };
  valid = false;
  constructor(readonly path: string) {}

  /** Read every submission; no watcher and no model calls. */
  async refresh(discover: Source[] | ((data: Table) => Source[]), initialText = ""): Promise<void> {
    this.valid = false;
    this.report = { missing: [] };
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let temp: string | undefined;
    let lockOwned = false;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      lock = await open(this.path + ".lock", "wx", 0o600);
      lockOwned = true;
      let snapshot = "";
      let existed = true;
      try { snapshot = await readFile(this.path, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        existed = false;
      }
      let next = existed ? snapshot : initialText;
      let data = parse(next) as Table;
      const sources = typeof discover === "function" ? discover(data) : discover;
      for (const source of sources) {
        const entry = tableAt(data, source.path);
        if (!entry) {
          next = addFields(next, source.path, "", false);
          data = parse(next) as Table;
        } else {
          if (entry.replacement !== undefined && typeof entry.replacement !== "string")
            throw new Error(source.path.join(".") + ": replacement must be a string");
          if (typeof entry.replacement === "string" && !entry.replacement.trim())
            throw new Error(source.path.join(".") + ": empty replacements are not supported");
        }
      }
      if (next !== snapshot) {
        temp = this.path + "." + randomUUID() + ".tmp";
        const file = await open(temp, "wx", 0o600);
        try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
        let current: string | undefined;
        try { current = await readFile(this.path, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (current !== (existed ? snapshot : undefined)) throw new Error("Lookup changed during discovery; retry on the next submission");
        if (existed) await rename(temp, this.path);
        else {
          // Exclusive creation prevents replacing a file created by an editor.
          const file = await open(this.path, "wx", 0o600);
          try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
          await unlink(temp);
        }
        temp = undefined;
      }
      this.data = data;
      this.valid = true;
      for (const source of sources) {
        const entry = tableAt(data, source.path)!;
        const label = source.path.join(".");
        if (entry.replacement === undefined) this.report.missing.push(label);
      }
    } catch (error) {
      this.data = {};
      this.report.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (temp) await unlink(temp).catch(() => {});
      if (lock) {
        await lock.close();
        if (lockOwned) await unlink(this.path + ".lock").catch(() => {});
      }
    }
  }

  invalidate(error: unknown): void {
    this.valid = false;
    this.data = {};
    this.report.error = error instanceof Error ? error.message : String(error);
  }

  /** Select by stable path only. Source prose is not an identifier. */
  replacement(path: string[]): string | undefined {
    if (!this.valid) return;
    return tableAt(this.data, path)?.replacement as string | undefined;
  }
}
