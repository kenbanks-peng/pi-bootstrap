import { parse } from "smol-toml";

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface ReferAction {
  refer: string;
  link: string;
}

type Action = string | ReferAction;
export type SaveReference = (link: string, text: string) => void;

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

function resolvePaths(replacements: ReadonlyMap<string, Action>, paths: string[][]): Map<string, Action> {
  const available = new Set<string>();
  for (const path of paths)
    for (let length = 1; length <= path.length; length++)
      available.add(JSON.stringify(path.slice(0, length)));

  const resolved = new Map<string, Action>();
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

export function replaceTags(text: string, replacements: ReadonlyMap<string, Action>, parent: string[] = [],
  implicitEdges: readonly ("preamble" | "postamble")[] = ["preamble", "postamble"],
  saveReference?: SaveReference): string {
  if (!replacements.size) return text;
  const tokens: { name: string; closing: boolean; selfClosing: boolean; start: number; end: number }[] = [];
  const regions: { start: number; end: number; bodyStart: number; bodyEnd: number; path: string[];
    special?: "preamble" | "postamble" }[] = [];
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
      tokens.push({ name, closing: !!match[1], selfClosing: !match[1] && /\/\s*$/.test(match[3]), start, end });
    }
  }
  // Pair tags first so literal text such as Map<string> adds no ancestry.
  const pending: number[] = [];
  const pairs = new Map<number, number>();
  for (const [index, token] of tokens.entries()) {
    if (token.selfClosing) continue;
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

  // Special references select only the text at the edges of a tag body.
  // Only paired tags and self-closing tags form boundaries; literal type notation does not.
  const boundaries = tokens.filter((token, index) => token.selfClosing || pairs.has(index) || closes.has(index));
  const containers = [...regions];
  if (parent.length)
    containers.push({ start: 0, end: text.length, bodyStart: 0, bodyEnd: text.length, path: [] });
  for (const region of containers) {
    const children = boundaries.filter(token => token.start >= region.bodyStart && token.end <= region.bodyEnd);
    for (const special of region.path.length ? ["preamble", "postamble"] as const : implicitEdges) {
      const start = special === "preamble" ? region.bodyStart : (children.at(-1)?.end ?? region.bodyStart);
      const end = special === "postamble" ? region.bodyEnd : (children[0]?.start ?? region.bodyEnd);
      regions.push({ start, end, bodyStart: start, bodyEnd: end, path: [...region.path, special], special });
    }
  }
  // These suffixes are reserved references, not child tag names.
  const targets = regions.filter(region => region.special || region.path.length < 2 ||
    !["preamble", "postamble"].includes(region.path.at(-1)!));
  targets.sort((a, b) => a.start - b.start ||
    Number(!a.special) - Number(!b.special) || b.end - a.end);

  const direct = resolvePaths(replacements, targets
    .filter(region => !region.special || region.path.length > 1)
    .map(region => region.path));
  const scoped = parent.length
    ? resolvePaths(replacements, targets.map(region => [...parent, ...region.path])) : direct;

  // An outer replacement includes its children. Never scan inserted text.
  let result = "";
  let at = 0;
  for (const edit of targets) {
    if (edit.start < at) continue;
    const reserved = !edit.special && parent.length > 0 &&
      ["preamble", "postamble"].includes(edit.path.at(-1)!);
    const value = (reserved ? undefined : scoped.get(JSON.stringify([...parent, ...edit.path]))) ??
      (edit.special && edit.path.length === 1 ? undefined : direct.get(JSON.stringify(edit.path)));
    if (value === undefined) continue;
    if (value === "") {
      result += text.slice(at, edit.start);
      at = edit.end;
      continue;
    }
    let replacement: string;
    if (typeof value === "string") replacement = value;
    else {
      if (!saveReference) throw new Error("refer action requires a reference writer");
      saveReference(value.link, text.slice(edit.bodyStart, edit.bodyEnd));
      replacement = value.refer.replaceAll("$link", () => value.link);
    }
    // Keep replacement and reference text separate from the retained tags.
    if (!edit.special) {
      const indent = /(?:^|\n)([ \t]*)$/.exec(text.slice(edit.bodyStart, edit.bodyEnd))?.[1] ?? "";
      replacement = `\n${replacement}\n${indent}`;
    }
    result += text.slice(at, edit.bodyStart) + replacement + text.slice(edit.bodyEnd, edit.end);
    at = edit.end;
  }
  return result + text.slice(at);
}

interface Message {
  role: string;
  content?: unknown;
  sections?: Record<string, string | null>;
}

export function replaceMessages<T extends Message>(messages: T[], replacements: ReadonlyMap<string, Action>,
  saveReference?: SaveReference): T[] {
  // Section messages can be patches. Find the final section's last writer,
  // rather than treating every patch or section as a complete system prompt.
  const sections = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (message.role !== "system") continue;
    if (!message.sections) sections.clear();
    else for (const [name, value] of Object.entries(message.sections)) {
      if (value === null) sections.delete(name);
      else sections.set(name, index);
    }
  }
  const lastSection = [...sections].at(-1);
  return messages.map((message, index) => {
    const next = { ...message };
    // Pi stores the system prompt body without its outer container tag.
    const parent = message.role === "system" ? ["system-prompt"] : [];
    const replace = (text: string, edges: readonly ("preamble" | "postamble")[] =
      message.sections ? [] : ["preamble", "postamble"]) => replaceTags(text, replacements, parent, edges, saveReference);
    if (typeof message.content === "string") next.content = replace(message.content);
    else if (Array.isArray(message.content)) {
      const textIndices = message.content.flatMap((item, at) =>
        isTable(item) && item.type === "text" && typeof item.text === "string" ? [at] : []);
      next.content = message.content.map((block, blockIndex) => {
        const edges: ("preamble" | "postamble")[] = [];
        if (!message.sections) {
          if (blockIndex === textIndices[0]) edges.push("preamble");
          if (blockIndex === textIndices.at(-1)) edges.push("postamble");
        }
        return isTable(block) && block.type === "text" && typeof block.text === "string"
          ? { ...block, text: replace(block.text, edges) } : block;
      });
    }
    if (message.sections)
      next.sections = Object.fromEntries(Object.entries(message.sections).map(([name, value]) => {
        const edges: ("preamble" | "postamble")[] = [];
        if (message.role === "system") {
          if (name === "preamble") edges.push("preamble");
          if (lastSection?.[0] === name && lastSection[1] === index) edges.push("postamble");
        }
        return [name, typeof value === "string" ? replace(value, edges) : value];
      }));
    return next;
  });
}
