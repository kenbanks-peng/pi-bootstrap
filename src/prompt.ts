import type { Lookup, Source, Table } from "./lookup.ts";

export interface TranscriptMessage {
  role: string;
  content?: unknown;
  sections?: Record<string, string | null>;
}
export interface Unidentified { location: string; text: string }
interface Region {
  path: string[];
  tag: string;
  start: number;
  bodyStart: number;
  bodyEnd: number;
  end: number;
}
interface Binding extends Source {
  index: number;
  field: "content" | "sections" | "blocks";
  section?: string;
  block?: number;
  start: number;
  end: number;
}
const safeName = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
const object = (value: unknown): value is Table =>
  !!value && typeof value === "object" && !Array.isArray(value);
const key = (path: string[]) => JSON.stringify(path);

function checkName(name: string): void {
  if (!safeName.test(name) || unsafe.has(name)) throw new Error("Unsafe context tag: " + name);
}

/** Parse nested XML-like tags, including inline tags, without changing source bytes. */
export function taggedRegions(text: string): Region[] {
  const regions: Region[] = [];
  const stack: { path: string[]; tag: string; start: number; bodyStart: number }[] = [];
  let fence: { char: string; size: number } | undefined;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const raw = line[0].replace(/\r?\n$/, "");
    const codeFence = /^\s*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (codeFence) {
      const marker = codeFence[1];
      if (!fence) fence = { char: marker[0], size: marker.length };
      else if (marker[0] === fence.char && marker.length >= fence.size && !codeFence[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    for (const match of raw.matchAll(/<(\/?)([A-Za-z_][A-Za-z0-9_.:-]*)(?=[\s/>])((?:[^<>"']|"[^"]*"|'[^']*')*)>/g)) {
      const tag = match[2];
      checkName(tag);
      const start = line.index! + match.index!;
      if (match[1]) {
        const opened = stack.pop();
        if (!opened || opened.tag !== tag) throw new Error("Unbalanced context tag: " + tag);
        regions.push({ ...opened, bodyEnd: start, end: start + match[0].length });
      } else if (!/\/\s*$/.test(match[3])) {
        stack.push({
          path: [...(stack.at(-1)?.path ?? []), tag], tag, start,
          bodyStart: start + match[0].length,
        });
      }
    }
  }
  if (stack.length) throw new Error("Unclosed context tag: " + stack.at(-1)!.tag);
  return regions.sort((a, b) => a.start - b.start);
}

/** Every table path is a literal tag path. There are no scope aliases. */
function configuration(data: Table): Set<string> {
  const replacements = new Set<string>();
  const visit = (table: Table, path: string[]) => {
    for (const [name, value] of Object.entries(table)) {
      if (name === "replacement" && !object(value) && path.length) {
        if (typeof value !== "string" || !value.trim())
          throw new Error(path.join(".") + ": replacement must be a nonempty string");
        replacements.add(key(path));
      } else {
        checkName(name);
        if (!object(value)) throw new Error([...path, name].join(".") + ": use a table");
        visit(value, [...path, name]);
      }
    }
  };
  visit(data, []);
  return replacements;
}

/** Change tagged bodies in outgoing text only. Do not change tools or stored messages. */
export class Mechanisms {
  private readonly replacements: Set<string>;
  private bindings: Binding[] = [];
  unidentified: Unidentified[] = [];
  constructor(data: Table) { this.replacements = configuration(data); }

  discover(messages: TranscriptMessage[], containerPath: (message: TranscriptMessage) => string[] = () => []): Source[] {
    this.bindings = [];
    this.unidentified = [];
    const scan = (text: string, index: number, field: Binding["field"], section?: string, block?: number) => {
      const location = "messages." + index + "." + field +
        (section === undefined ? "" : "." + section) + (block === undefined ? "" : "." + block);
      const regions = taggedRegions(text);
      const parent = containerPath(messages[index]);
      parent.forEach(checkName);
      const bindings = regions.map(region => ({
        index, field, section, block, path: [...parent, ...region.path],
        original: text.slice(region.bodyStart, region.bodyEnd),
        start: region.bodyStart, end: region.bodyEnd,
      }));
      // Detect active ancestor/descendant replacements before discovery can write config.
      const active = bindings.filter(binding => this.replacements.has(key(binding.path)));
      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const a = active[i], b = active[j];
          if (a.start <= b.start && b.end <= a.end)
            throw new Error("Overlapping replacements: " + a.path.join(".") + " and " + b.path.join(".") + " in " + location);
        }
      }
      this.bindings.push(...bindings);
      // Only text outside outer tags is unidentified; nested bodies are already scoped.
      let at = 0;
      for (const region of regions.filter(region => region.path.length === 1)) {
        const outside = text.slice(at, region.start);
        if (outside.trim()) this.unidentified.push({ location: location + " at offset " + at, text: outside });
        at = region.end;
      }
      const outside = text.slice(at);
      if (outside.trim()) this.unidentified.push({ location: location + " at offset " + at, text: outside });
    };
    messages.forEach((message, index) => {
      if (typeof message.content === "string") scan(message.content, index, "content");
      else if (Array.isArray(message.content)) message.content.forEach((block, at) => {
        if (object(block) && block.type === "text" && typeof block.text === "string")
          scan(block.text, index, "blocks", undefined, at);
      });
      for (const [name, text] of Object.entries(message.sections ?? {}))
        if (typeof text === "string") scan(text, index, "sections", name);
    });
    return [...new Map(this.bindings.map(({ path, original }) => [key(path), { path, original }])).values()];
  }

  applyTranscript<T extends TranscriptMessage>(messages: T[], lookup: Lookup): T[] {
    if (!lookup.valid) return messages;
    const result = [...messages];
    // Non-overlapping writes run backwards so original offsets stay valid.
    for (const binding of [...this.bindings].sort((a, b) => b.start - a.start)) {
      const replacement = lookup.replacement(binding.path);
      if (replacement === undefined) continue;
      const original = result[binding.index];
      const blocks = original.content as Table[];
      const text = binding.field === "sections" ? original.sections![binding.section!]! :
        binding.field === "blocks" ? blocks[binding.block!].text as string : original.content as string;
      const source = text.slice(binding.start, binding.end);
      const leading = source.startsWith("\r\n") ? "\r\n" : source.startsWith("\n") ? "\n" : "";
      const trailing = source.endsWith("\r\n") ? "\r\n" : source.endsWith("\n") ? "\n" : "";
      const changed = text.slice(0, binding.start) + leading + replacement + trailing + text.slice(binding.end);
      if (changed === text) continue;
      if (binding.field === "sections")
        result[binding.index] = { ...original, sections: { ...original.sections, [binding.section!]: changed } };
      else if (binding.field === "blocks") {
        const content = [...blocks];
        content[binding.block!] = { ...content[binding.block!], text: changed };
        result[binding.index] = { ...original, content };
      } else result[binding.index] = { ...original, content: changed };
    }
    return result.every((message, i) => message === messages[i]) ? messages : result;
  }
}
