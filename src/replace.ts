import { parse } from "smol-toml";

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseReplacements(toml: string): Map<string, string> {
  const replacements = new Map<string, string>();
  const visit = (table: Table, path: string[]) => {
    for (const [name, value] of Object.entries(table)) {
      if (isTable(value)) visit(value, [...path, name]);
      else if (name === "replacement" && path.length && typeof value === "string")
        replacements.set(JSON.stringify(path), value);
      else throw new Error([...path, name].join(".") + ": expected a replacement string or table");
    }
  };
  visit(parse(toml), []);
  return replacements;
}

function resolvePaths(replacements: Map<string, string>, paths: string[][]): Map<string, string> {
  const available = new Set<string>();
  for (const path of paths)
    for (let length = 1; length <= path.length; length++)
      available.add(JSON.stringify(path.slice(0, length)));

  const resolved = new Map<string, string>();
  const priorities = new Map<string, number>();
  for (const [key, value] of replacements) {
    const path: string[] = [];
    let fallbacks = 0;
    const names = JSON.parse(key) as string[];
    for (const name of names) {
      if (available.has(JSON.stringify([...path, name]))) path.push(name);
      else {
        const fallback = name.replaceAll("_", "-");
        if (!available.has(JSON.stringify([...path, fallback]))) break;
        path.push(fallback);
        fallbacks++;
      }
    }
    if (path.length !== names.length) continue;
    const target = JSON.stringify(path);
    if (fallbacks < (priorities.get(target) ?? Infinity)) {
      resolved.set(target, value);
      priorities.set(target, fallbacks);
    }
  }
  return resolved;
}

export function replaceTags(text: string, replacements: Map<string, string>, parent: string[] = []): string {
  if (!replacements.size) return text;
  const tokens: { name: string; closing: boolean; start: number; end: number }[] = [];
  const regions: { start: number; end: number; bodyStart: number; bodyEnd: number; path: string[] }[] = [];
  let fence: { char: string; size: number } | undefined;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const raw = line[0].replace(/\r?\n$/, "");
    const codeFence = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (codeFence) {
      const marker = codeFence[1];
      if (!fence) fence = { char: marker[0], size: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.size && !codeFence[2].trim())
        fence = undefined;
      continue;
    }
    if (fence) continue;
    for (const match of raw.matchAll(/<(\/?)([A-Za-z_][A-Za-z0-9_.:-]*)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>/g)) {
      const start = line.index! + match.index!;
      const end = start + match[0].length;
      const name = match[2];
      if (match[1] || !/\/\s*$/.test(match[3]))
        tokens.push({ name, closing: !!match[1], start, end });
    }
  }
  // Pair tags first so literal text such as Map<string> adds no ancestry.
  const pending: number[] = [];
  const pairs = new Map<number, number>();
  for (const [index, token] of tokens.entries()) {
    if (!token.closing) pending.push(index);
    else {
      const at = pending.findLastIndex(open => tokens[open].name === token.name);
      if (at < 0) continue;
      pairs.set(pending[at], index);
      pending.splice(at);
    }
  }
  const stack: string[] = [];
  const closes = new Set(pairs.values());
  for (const [index, token] of tokens.entries()) {
    const close = pairs.get(index);
    if (close !== undefined) {
      stack.push(token.name);
      regions.push({ start: token.start, end: tokens[close].end,
        bodyStart: token.end, bodyEnd: tokens[close].start, path: [...stack] });
    } else if (closes.has(index)) stack.pop();
  }

  const direct = resolvePaths(replacements, regions.map(region => region.path));
  const scoped = parent.length
    ? resolvePaths(replacements, regions.map(region => [...parent, ...region.path])) : direct;

  // An outer replacement includes its children. Never scan inserted text.
  let result = "";
  let at = 0;
  for (const edit of regions) {
    if (edit.start < at) continue;
    const value = scoped.get(JSON.stringify([...parent, ...edit.path])) ??
      direct.get(JSON.stringify(edit.path));
    if (value === undefined) continue;
    result += text.slice(at, edit.bodyStart) + value + text.slice(edit.bodyEnd, edit.end);
    at = edit.end;
  }
  return result + text.slice(at);
}

interface Message {
  role: string;
  content?: unknown;
  sections?: Record<string, string | null>;
}

export function replaceMessages<T extends Message>(messages: T[], replacements: Map<string, string>): T[] {
  return messages.map(message => {
    const next = { ...message };
    // Pi stores the system prompt body without its outer container tag.
    const parent = message.role === "system" ? ["system-prompt"] : [];
    const replace = (text: string) => replaceTags(text, replacements, parent);
    if (typeof message.content === "string") next.content = replace(message.content);
    else if (Array.isArray(message.content))
      next.content = message.content.map(block =>
        isTable(block) && block.type === "text" && typeof block.text === "string"
          ? { ...block, text: replace(block.text) } : block);
    if (message.sections)
      next.sections = Object.fromEntries(Object.entries(message.sections).map(([name, value]) =>
        [name, typeof value === "string" ? replace(value) : value]));
    return next;
  });
}
