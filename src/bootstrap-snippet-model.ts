export interface Snippet {
	/** Filename, e.g. "concise.md" */
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
		if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
	}

	const body = match[2].trim();
	if (!body) return null;

	const parsedOrder = Number.parseInt(meta.order ?? "", 10);
	return {
		id: filename,
		name: meta.name || filename.replace(/\.md$/i, ""),
		description: meta.description ?? "",
		placement: meta.placement === "prepend" ? "prepend" : "append",
		order: Number.isFinite(parsedOrder) ? parsedOrder : 9999,
		body,
	};
}


export const snippetTemplate = "---\nname: New snippet\ndescription: \nplacement: append\norder: 9999\n---\nWrite the instruction here.\n";

export function validateSnippet(content: string): void {
  if (!parseSnippet("snippet.md", content)) throw new Error("Snippet requires Markdown frontmatter and a nonempty body.");
  const meta = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
  for (const line of meta.split(/\r?\n/)) {
    const match = line.match(/^(placement|order)\s*:\s*(.*?)\s*$/i);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (match[1].toLowerCase() === "placement" && !["prepend", "append"].includes(value))
      throw new Error("Snippet placement must be prepend or append.");
    if (match[1].toLowerCase() === "order" && !/^-?\d+$/.test(value))
      throw new Error("Snippet order must be an integer.");
  }
}
