export interface Snippet {
  id: string;
  name: string;
  body: string;
}

export function parseSnippet(filename: string, raw: string): Snippet | null {
  const body = raw.trim();
  if (!body) return null;
  return {
    id: filename,
    name: body.split(/\r?\n/)[0].replace(/^#+\s*/, ""),
    body,
  };
}

export const snippetTemplate = "Write the instruction here.\n";

export function validateSnippet(content: string): void {
  if (!content.trim()) throw new Error("Snippet requires a nonempty body.");
}
