export interface Snippet {
  id: string;
  name: string;
  description: string;
  placement: "prepend" | "append";
  order: number;
  body: string;
}

export function parseSnippet(filename: string, raw: string): Snippet | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      const value = kv[2].trim();
      try {
        meta[kv[1].toLowerCase()] = value.startsWith('"') ? JSON.parse(value) : value.replace(/^'|'$/g, "");
      } catch {
        meta[kv[1].toLowerCase()] = value.replace(/^["']|["']$/g, "");
      }
    }
  }

  const body = match[2].trim();
  if (!body) return null;
  const order = Number.parseInt(meta.order ?? "", 10);
  return {
    id: filename,
    name: meta.name || filename.replace(/\.md$/i, ""),
    description: meta.description ?? "",
    placement: meta.placement === "prepend" ? "prepend" : "append",
    order: Number.isFinite(order) ? order : 9999,
    body,
  };
}

export const snippetTemplate = "---\nname: New snippet\ndescription: \nplacement: append\norder: 9999\n---\nWrite the instruction here.\n";

export function serializeSnippet(snippet: Omit<Snippet, "id">): string {
  return [
    "---",
    `name: ${JSON.stringify(snippet.name)}`,
    ...(snippet.description ? [`description: ${JSON.stringify(snippet.description)}`] : []),
    `placement: ${snippet.placement}`,
    `order: ${snippet.order}`,
    "---",
    snippet.body,
  ].join("\n");
}

export function validateSnippet(content: string): void {
  if (!parseSnippet("snippet.md", content)) {
    throw new Error("Snippet requires frontmatter and a nonempty body.");
  }
}
