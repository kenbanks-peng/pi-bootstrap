import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BootstrapRepository, BootstrapScope } from "./bootstrap-repository.js";
import { parseSnippet, type Snippet } from "./bootstrap-snippet-model.js";

export interface ScopedSnippet extends Snippet { scope: BootstrapScope }

export async function loadSnippets(repository: BootstrapRepository): Promise<ScopedSnippet[]> {
  const result: ScopedSnippet[] = [];
  for (const scope of ["global", "project"] as const) {
    const snippets: ScopedSnippet[] = [];
    for (const source of (await repository.list(scope)).filter(source => source.type === "snippet")) {
      try {
        const snippet = parseSnippet(source.id + ".md", await repository.read(scope, source));
        if (snippet) snippets.push({ ...snippet, id: scope + ":" + source.id, scope });
      } catch { /* Skip files removed or made unreadable during scanning. */ }
    }
    snippets.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    result.push(...snippets);
  }
  return result;
}

export async function installSnippetDefaults(repository: BootstrapRepository): Promise<void> {
  const directory = join(repository.directories.globalDirectory, "snippets");
  try { if ((await readdir(directory)).length > 0) return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bundled = fileURLToPath(new URL("../snippets/", import.meta.url));
  await mkdir(directory, { recursive: true });
  for (const file of await readdir(bundled)) {
    if (!file.endsWith(".md")) continue;
    try {
      await writeFile(join(directory, file), await readFile(join(bundled, file)), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
