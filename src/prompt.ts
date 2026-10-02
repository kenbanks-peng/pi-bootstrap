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
interface Configuration { system: boolean; messageRole?: "user" }
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

function configuration(data: Table): Configuration {
  const fields = (table: Table, allowed: string[], location: string) => {
    for (const key of Object.keys(table))
      if (!allowed.includes(key)) throw new Error(location + key + ": unsupported field");
  };
  const entry = (value: unknown, location: string) => {
    if (!object(value)) throw new Error(location + ": use a table");
    fields(value, ["replacement"], location + ".");
    if (value.replacement !== undefined &&
      (typeof value.replacement !== "string" || !value.replacement.trim()))
      throw new Error(location + ": replacement must be a nonempty string");
  };
  const entries = (table: Table, location: string, reserved: string[] = []) => {
    for (const [tag, value] of Object.entries(table)) {
      if (reserved.includes(tag)) continue;
      if (!safeName.test(tag) || unsafe.has(tag)) throw new Error(location + tag + ": unsafe tag name");
      entry(value, location + tag);
    }
  };
  fields(data, ["system_prompt", "message"], "");
  const system = data.system_prompt;
  if (system !== undefined) {
    if (!object(system)) throw new Error("system_prompt: use a table");
    fields(system, ["kind", "preamble", "sections"], "system_prompt.");
    if (system.kind !== "tagged_sections") throw new Error('system_prompt: use kind = "tagged_sections"');
    if (system.preamble !== undefined) entry(system.preamble, "system_prompt.preamble");
    if (system.sections !== undefined) {
      if (!object(system.sections)) throw new Error("system_prompt.sections: use a table");
      entries(system.sections, "system_prompt.sections.");
    }
  }
  const message = data.message;
  if (message !== undefined) {
    if (!object(message)) throw new Error("message: use a table");
    if (message.kind !== "tagged_messages") throw new Error('message: use kind = "tagged_messages"');
    if (message.role !== "user") throw new Error('message: use role = "user"');
    entries(message, "message.", ["kind", "role"]);
  }
  return { system: system !== undefined, messageRole: message === undefined ? undefined : "user" };
}

/** Discover and replace existing context text only. No resource or tool metadata is changed. */
export class Mechanisms {
  private readonly configuration: Configuration;
  private bindings: Binding[] = [];
  unidentified: Unidentified[] = [];
  constructor(data: Table) { this.configuration = configuration(data); }

  discover(messages: TranscriptMessage[]): Source[] {
    this.bindings = [];
    this.unidentified = [];
    const system = this.configuration.system;
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
        if (system) bind(index, field, section, ["system_prompt", "preamble"], text, 0, text.length);
        else unknown(location, text);
        return;
      }
      if (!system) { unknown(location, text); return; }
      const regions = taggedRegions(text);
      const prefixEnd = regions[0]?.start ?? text.length;
      const prefix = text.slice(0, prefixEnd);
      if (section === undefined) {
        const end = prefix.trimEnd().length;
        bind(index, field, section, ["system_prompt", "preamble"], text, 0, end);
      } else unknown(location, prefix);
      let at = prefixEnd;
      for (const region of regions) {
        unknown(location + " at offset " + at, text.slice(at, region.start));
        if (unsafe.has(region.tag)) throw new Error("Unsafe context tag: " + region.tag);
        bind(index, field, section, ["system_prompt", "sections", region.tag],
          text, region.bodyStart, region.bodyEnd);
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
        // Tagged messages may arrive as text blocks alongside images.
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
    if (this.configuration.messageRole !== role) return;
    // Select only a complete envelope, not ordinary prose or quoted tag examples.
    if (!/^\s*<[a-z][a-z0-9_-]*(?:\s+[^<>]*)?>[^\S\r\n]*(?:\r?\n|$)/.test(text)) return;
    const regions = taggedRegions(text);
    if (regions.length !== 1 || text.slice(regions[0].end).trim()) return;
    const region = regions[0];
    if (unsafe.has(region.tag) || region.tag === "kind" || region.tag === "role")
      throw new Error("Unsafe message tag: " + region.tag);
    if (!text.slice(region.bodyStart, region.bodyEnd).trim()) return;
    bind(index, "content", undefined, ["message", region.tag], text, region.bodyStart, region.bodyEnd);
    if (blockIndex !== undefined) this.bindings.at(-1)!.blockIndex = blockIndex;
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
      const body = binding.path[0] === "message" || binding.path[1] === "sections"
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
