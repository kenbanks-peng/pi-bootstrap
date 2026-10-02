import type { Lookup, Source, Table } from "./lookup.ts";

export interface TranscriptMessage {
  role: string;
  content?: unknown;
  sections?: Record<string, string | null>;
}
export interface Unidentified { location: string; text: string }
interface Region { tag: string; start: number; bodyStart: number; bodyEnd: number; end: number }
interface Binding extends Source {
  index: number;
  field: "content" | "sections";
  section?: string;
  blockIndex?: number;
  start: number;
  end: number;
}
type Mechanism =
  | { kind: "preamble" | "tagged_sections" }
  | { kind: "tagged_message"; role: "user"; tag: string };
const safeName = /^[a-z][a-z0-9_-]*$/;
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
const object = (value: unknown): value is Table =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Pi uses XML-like line tags, not HTML documents. Keep all source bytes and offsets. */
export function taggedRegions(text: string): Region[] {
  const regions: Region[] = [];
  const stack: { tag: string; start: number; bodyStart: number }[] = [];
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
    // Outer sections occupy a full line. Nested fields can open and close inline,
    // as the memory, name, description, run, and output fields do in the baseline.
    const tokens = [...raw.matchAll(/<(\/?)([a-z][a-z0-9_-]*)(?:\s+[^<>]*)?>/g)];
    for (const match of tokens) {
      if (!stack.length && raw.trim() !== match[0]) continue;
      const tag = match[2];
      if (!match[1]) {
        stack.push({ tag, start: line.index! + match.index!, bodyStart: line.index! + match.index! + match[0].length });
      } else {
        const opened = stack.pop();
        if (!opened || opened.tag !== tag) throw new Error("Unbalanced context tag: " + tag);
        if (!stack.length) regions.push({ ...opened, bodyEnd: line.index!, end: line.index! + raw.length });
      }
    }
  }
  if (stack.length) throw new Error("Unclosed context tag: " + stack.at(-1)!.tag);
  return regions;
}

function definitions(data: Table): Mechanism[] {
  if (data.version !== 2) throw new Error("Use version = 2 and the context mechanisms in default.toml; old path mechanisms are not supported");
  if (!object(data.mechanisms)) throw new Error("Define [mechanisms] in config.toml");
  const result: Mechanism[] = [];
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(data.mechanisms)) {
    if (!object(value)) throw new Error("mechanisms." + name + ": use a table");
    const kind = value.kind;
    const fields = kind === "tagged_message" ? ["kind", "role", "tag"] : ["kind"];
    if (Object.keys(value).some(key => !fields.includes(key)))
      throw new Error("mechanisms." + name + ": unsupported parameter");
    if (kind === "tagged_message") {
      if (value.role !== "user" || typeof value.tag !== "string" || !safeName.test(value.tag) || unsafe.has(value.tag))
        throw new Error("mechanisms." + name + ": use role = user and a safe tag name");
      result.push({ kind, role: "user", tag: value.tag });
    } else if (kind === "preamble" || kind === "tagged_sections") result.push({ kind });
    else throw new Error("mechanisms." + name + ": unknown kind");
    const key = kind + ":" + (value.tag ?? "");
    if (seen.has(key)) throw new Error("Duplicate context mechanism: " + key);
    seen.add(key);
  }
  return result;
}

/** Discover and replace existing context text only. No resource or tool metadata is changed. */
export class Mechanisms {
  private readonly definitions: Mechanism[];
  private bindings: Binding[] = [];
  unidentified: Unidentified[] = [];
  constructor(data: Table) { this.definitions = definitions(data); }

  discover(messages: TranscriptMessage[]): Source[] {
    this.bindings = [];
    this.unidentified = [];
    const preamble = this.definitions.some(m => m.kind === "preamble");
    const sections = this.definitions.some(m => m.kind === "tagged_sections");
    const unknown = (location: string, text: string) => {
      if (text.trim()) this.unidentified.push({ location, text });
    };
    const bind = (index: number, field: Binding["field"], section: string | undefined,
      path: string[], text: string, start: number, end: number) => {
      if (!text.slice(start, end).trim()) return;
      this.bindings.push({ index, field, section, path, original: text.slice(start, end), start, end });
    };
    const scanSystem = (text: string, index: number, section?: string) => {
      const field = section === undefined ? "content" : "sections";
      const location = "messages." + index + "." + field + (section === undefined ? "" : "." + section);
      if (section === "preamble") {
        if (preamble) bind(index, field, section, ["system_prompt", "preamble"], text, 0, text.length);
        else unknown(location, text);
        return;
      }
      const regions = taggedRegions(text);
      const prefixEnd = regions[0]?.start ?? text.length;
      const prefix = text.slice(0, prefixEnd);
      if (section === undefined && preamble) {
        const end = prefix.trimEnd().length;
        bind(index, field, section, ["system_prompt", "preamble"], text, 0, end);
      } else unknown(location, prefix);
      let at = prefixEnd;
      for (const region of regions) {
        unknown(location + " at offset " + at, text.slice(at, region.start));
        if (unsafe.has(region.tag)) throw new Error("Unsafe context tag: " + region.tag);
        if (sections) bind(index, field, section, ["system_prompt", "sections", region.tag],
          text, region.bodyStart, region.bodyEnd);
        else unknown(location + " tag " + region.tag, text.slice(region.start, region.end));
        at = region.end;
      }
      unknown(location + " at offset " + at, text.slice(at));
    };
    messages.forEach((message, index) => {
      if (message.role === "system") {
        if (typeof message.content === "string" && message.content) scanSystem(message.content, index);
        else if (message.content) unknown("messages." + index + ".content", JSON.stringify(message.content));
        for (const [name, text] of Object.entries(message.sections ?? {}))
          if (text !== null) scanSystem(text, index, name);
        return;
      }
      if (typeof message.content !== "string") {
        // Prime may arrive as text blocks alongside images. Bind each text block separately below.
        if (Array.isArray(message.content)) message.content.forEach((block, blockIndex) => {
          if (object(block) && block.type === "text" && typeof block.text === "string")
            this.scanMessage(block.text, message.role, index, bind, blockIndex);
        });
      } else this.scanMessage(message.content, message.role, index, bind);
    });
    return [...new Map(this.bindings.map(({ path, original }) => [JSON.stringify(path), { path, original }])).values()];
  }

  private scanMessage(text: string, role: string, index: number,
    bind: (index: number, field: Binding["field"], section: string | undefined, path: string[], text: string, start: number, end: number) => void,
    blockIndex?: number) {
    for (const mechanism of this.definitions) {
      if (mechanism.kind !== "tagged_message" || mechanism.role !== role) continue;
      // Do not parse ordinary messages or quoted tag examples as bootstrap context.
      if (!new RegExp("^\\s*<" + mechanism.tag + "(?:\\s+[^<>]*)?>\\s*(?:\\r?\\n|$)").test(text)) continue;
      const regions = taggedRegions(text);
      if (regions.length !== 1 || regions[0].tag !== mechanism.tag || text.slice(regions[0].end).trim()) continue;
      const region = regions[0];
      if (!text.slice(region.bodyStart, region.bodyEnd).trim()) continue;
      bind(index, "content", undefined, ["bootstrap", mechanism.tag], text, region.bodyStart, region.bodyEnd);
      if (blockIndex !== undefined) this.bindings.at(-1)!.blockIndex = blockIndex;
    }
  }

  applyTranscript<T extends TranscriptMessage>(messages: T[], lookup: Lookup): T[] {
    if (!lookup.valid) return messages;
    const result = [...messages];
    // Offset writes run backwards; source messages and all unrelated objects retain their identity.
    for (const binding of [...this.bindings].sort((a, b) => b.start - a.start)) {
      const replacement = lookup.replacement(binding.path);
      if (replacement === undefined) continue;
      const original = result[binding.index];
      const readText = () => binding.field === "sections" ? original.sections![binding.section!]! :
        binding.blockIndex === undefined ? original.content as string :
          (original.content as { text: string }[])[binding.blockIndex].text;
      const text = readText();
      // Section bodies include the line breaks inside their tags.
      const body = binding.path[0] === "bootstrap" || binding.path[1] === "sections"
        ? (text.slice(binding.start, binding.end).startsWith("\r\n") ? "\r\n" : "\n") + replacement +
          (text.slice(binding.start, binding.end).endsWith("\r\n") ? "\r\n" : "\n")
        : replacement;
      const changed = text.slice(0, binding.start) + body + text.slice(binding.end);
      if (changed === text) continue;
      if (binding.field === "sections") result[binding.index] = { ...original, sections: { ...original.sections, [binding.section!]: changed } };
      else if (binding.blockIndex !== undefined) {
        const content = [...original.content as object[]];
        content[binding.blockIndex] = { ...content[binding.blockIndex], text: changed };
        result[binding.index] = { ...original, content };
      } else result[binding.index] = { ...original, content: changed };
    }
    return result.every((message, i) => message === messages[i]) ? messages : result;
  }
}
