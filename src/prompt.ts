import { isProse, type Lookup, type Prose, type Source, type Table } from "./lookup.ts";

type Path = string[];
type Kind = "value" | "delimited" | "prefix" | "map" | "records";
type Event = "before_agent_start" | "context_with_system";
interface Mechanism {
  name: string;
  kind: Kind;
  event: Event;
  source: Path;
  path: Path;
  target: Path;
  value_type: "string" | "strings";
  blocked_by: Path[];
  start?: string;
  end?: string;
  boundary?: string;
  key_field?: string;
  value_field?: string;
  fallback_source?: Path;
  fallback_key?: string;
  fallback_value?: string;
  fallback_default?: Prose;
}
export interface TranscriptMessage {
  role: string;
  content?: unknown;
  sections?: Record<string, string | null>;
}
export interface Inputs {
  prompt?: string;
  options?: object;
  tools?: object[];
  messages?: TranscriptMessage[];
}
interface Binding extends Source {
  mechanism: string;
  source: Path;
  target: Path;
  blockedBy: Path[];
}
export interface Unidentified { location: string; text: string }
interface Selection { path: Path; value: unknown; key: string; index: string }
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
const object = (value: unknown): value is Table =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" && Object.hasOwn(value, key)
    ? (value as Table)[key] : undefined;

function pathValue(value: unknown, label: string, templates = false): Path {
  if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== "string" || !v || unsafe.has(v)))
    throw new Error(label + ": use a nonempty array of safe path segments");
  if (value.some(v => /[{}]/.test(v) && (!templates || !["{key}", "{index}"].includes(v))))
    throw new Error(label + ": supported placeholders are {key} and {index}");
  return value;
}
const requiredText = (row: Table, key: string, label: string): string => {
  if (typeof row[key] !== "string" || !(row[key] as string).length)
    throw new Error(label + "." + key + ": use nonempty text");
  return row[key] as string;
};

function parseMechanisms(data: Table): Mechanism[] {
  if (data.version !== 1) throw new Error("Set version = 1 and define [mechanisms] in config.toml; see default.toml");
  if (!object(data.mechanisms)) throw new Error("Define named [mechanisms.<name>] tables in config.toml");
  return Object.entries(data.mechanisms).map(([name, row]) => {
    const label = "mechanisms." + name;
    if (!object(row)) throw new Error(label + ": use a table");
    const kind = row.kind as Kind;
    const event = row.event as Event;
    if (!["value", "delimited", "prefix", "map", "records"].includes(kind))
      throw new Error(label + ": unknown kind");
    if (event !== "before_agent_start" && event !== "context_with_system") throw new Error(label + ": invalid event");
    if (row.value_type !== "string" && row.value_type !== "strings") throw new Error(label + ": invalid value_type");
    const fields = ["kind", "event", "source", "path", "target", "value_type", "blocked_by",
      ...(kind === "delimited" ? ["start", "end"] : []),
      ...(kind === "prefix" ? ["boundary"] : []),
      ...(kind === "records" ? ["key_field", "value_field"] : []),
      ...(kind === "map" ? ["fallback_source", "fallback_key", "fallback_value", "fallback_default"] : [])];
    for (const key of Object.keys(row)) if (!fields.includes(key)) throw new Error(label + ": unknown parameter " + key);
    const source = pathValue(row.source, label + ".source");
    const path = pathValue(row.path, label + ".path", true);
    const target = pathValue(row.target, label + ".target", true);
    if (!["prompt", "options", "tools", "messages"].includes(source[0]))
      throw new Error(label + ": unknown source root");
    if (source[0] === "messages" && (source.length < 3 ||
        source[1] !== "*" && !/^\d+$/.test(source[1])))
      throw new Error(label + ": select fields within system messages, not the whole transcript");
    if (event === "before_agent_start" && source[0] === "messages" ||
        event === "context_with_system" && source[0] !== "messages")
      throw new Error(label + ": source does not match event");
    if (target[0] === "options") {
      if (event !== "before_agent_start" || target.length < 2 || target.includes("*"))
        throw new Error(label + ": invalid options target");
    } else if (target[0] === "messages") {
      if (target.length !== 3 && target.length !== 4 ||
          target[2] !== "content" && target[2] !== "sections" ||
          target[2] === "content" && target.length !== 3 ||
          target[2] === "sections" && target.length !== 4 ||
          !["*", "{index}", "{key}"].includes(target[1]) && !/^\d+$/.test(target[1]))
        throw new Error(label + ": target must be system-message content or a named section");
      if (row.value_type !== "string") throw new Error(label + ": message targets require string values");
    } else throw new Error(label + ": target root must be options or messages");
    if (path[0] === "mechanisms" || path[0] === "version" || path.includes("*"))
      throw new Error(label + ": invalid replacement path");
    if (!["map", "records"].includes(kind) && [...path, ...target].some(v => v === "{key}" || v === "{index}") &&
        !source.includes("*"))
      throw new Error(label + ": placeholders need a collection or wildcard source");
    const blocked = row.blocked_by ?? [];
    if (!Array.isArray(blocked)) throw new Error(label + ": blocked_by must be an array of paths");
    const result: Mechanism = { name, kind, event, source, path, target,
      value_type: row.value_type, blocked_by: blocked.map(p => pathValue(p, label + ".blocked_by", true)) };
    if (kind === "delimited") {
      result.start = requiredText(row, "start", label);
      result.end = requiredText(row, "end", label);
    }
    if (kind === "prefix") {
      result.boundary = requiredText(row, "boundary", label);
      new RegExp(result.boundary, "m");
    }
    if (kind === "records") {
      result.key_field = requiredText(row, "key_field", label);
      result.value_field = requiredText(row, "value_field", label);
    }
    if (row.fallback_source !== undefined) {
      result.fallback_source = pathValue(row.fallback_source, label + ".fallback_source");
      if (result.fallback_source[0] === "messages") throw new Error(label + ": fallback messages are not supported");
      result.fallback_key = requiredText(row, "fallback_key", label);
      result.fallback_value = requiredText(row, "fallback_value", label);
      if (row.fallback_default !== undefined) {
        if (!isProse(row.fallback_default)) throw new Error(label + ": invalid fallback_default");
        result.fallback_default = row.fallback_default;
      }
    } else if (["fallback_key", "fallback_value", "fallback_default"].some(k => row[k] !== undefined))
      throw new Error(label + ": fallback parameters need fallback_source");
    return result;
  });
}

function get(root: unknown, path: Path): unknown {
  for (const key of path) root = own(root, key);
  return root;
}
function select(root: Inputs, path: Path): Selection[] {
  const results: Selection[] = [];
  function walk(value: unknown, at: number, actual: Path, key = "", index = "") {
    if (at === path.length) { results.push({ path: actual, value, key, index }); return; }
    const segment = path[at];
    const keys = segment === "*" && value !== null && typeof value === "object"
      ? Object.keys(value) : [segment];
    for (const k of keys) {
      if (unsafe.has(k)) throw new Error("Unsafe source key: " + k);
      const child = own(value, k);
      if (actual.length === 1 && actual[0] === "messages" &&
          (!object(child) || child.role !== "system")) continue;
      if (child === undefined || child === null) continue;
      walk(child, at + 1, [...actual, k], segment === "*" ? k : key,
        segment === "*" && Array.isArray(value) ? k : index);
    }
  }
  walk(root, 0, []);
  return results;
}
function expand(path: Path, key: string, index: string): Path {
  return path.map(segment => {
    const result = segment === "{key}" ? key : segment === "{index}" ? index : segment;
    if (!result || unsafe.has(result)) throw new Error("Invalid expanded path segment");
    return result;
  });
}

/** Only the scanner knows the Pi envelope. It does not assign replacement paths. */
function promptParts(prompt: string): { name: string; start: number; end: number; text: string }[] {
  const parts: ReturnType<typeof promptParts> = [];
  const stack: string[] = [];
  let start = 0;
  let name = "";
  for (const match of prompt.matchAll(/^<(\/)?([a-z][a-z0-9_-]*)(?: [^>]*?)?>[ \t]*\r?$/gm)) {
    if (!match[1]) {
      if (!stack.length) { start = match.index!; name = match[2]; }
      stack.push(match[2]);
    } else if (stack.at(-1) === match[2]) {
      stack.pop();
      if (!stack.length) {
        const end = match.index! + match[0].length;
        parts.push({ name, start, end, text: prompt.slice(start, end) });
      }
    }
  }
  if (stack.length) parts.push({ name, start, end: prompt.length, text: prompt.slice(start) });
  return parts;
}

export class Mechanisms {
  private readonly definitions: Mechanism[];
  private bindings: Binding[] = [];
  private covered: [number, number][] = [];
  unidentified: Unidentified[] = [];

  constructor(data: Table) {
    this.definitions = parseMechanisms(data);
    // Validate configured values even when their source appears only in the transcript.
    const visit = (value: unknown, path: Path) => {
      if (!object(value)) return;
      for (const m of this.definitions) {
        if (m.path.length !== path.length || !m.path.every((key, i) =>
          key === "{key}" || key === "{index}" || key === path[i])) continue;
        const replacement = value.replacement;
        if (replacement !== undefined && (!isProse(replacement) ||
            (m.value_type === "strings") !== Array.isArray(replacement)))
          throw new Error(path.join(".") + ": replacement has the wrong type");
        if (replacement !== undefined && (typeof replacement === "string"
          ? !replacement.trim() : !(replacement as string[]).length || (replacement as string[]).some(v => !v.trim())))
          throw new Error(path.join(".") + ": empty replacements are not supported");
      }
      for (const [key, child] of Object.entries(value)) {
        if (path.length || key !== "mechanisms") visit(child, [...path, key]);
      }
    };
    visit(data, []);
  }

  discover(event: Event, inputs: Inputs): Source[] {
    this.bindings = this.bindings.filter(b => !this.definitions.some(m => m.name === b.mechanism && m.event === event));
    if (event === "before_agent_start") { this.covered = []; this.unidentified = []; }
    else this.unidentified = this.unidentified.filter(u => !u.location.startsWith("messages."));
    const add = (m: Mechanism, value: unknown, key = "", index = "", source: Path = m.source) => {
      if (value === undefined || value === null || value === "") return;
      if (!isProse(value) || (m.value_type === "strings") !== Array.isArray(value))
        throw new Error("mechanisms." + m.name + ": source has the wrong type");
      const path = expand(m.path, key, index);
      const existing = this.bindings.find(b => JSON.stringify(b.path) === JSON.stringify(path));
      if (existing && existing.mechanism !== m.name)
        throw new Error("Multiple mechanisms identify " + path.join("."));
      const target = expand(m.target, key, index);
      if (target[0] === "messages" && target[1] !== "*" && !/^\d+$/.test(target[1]))
        throw new Error(m.name + ": expanded message index must be numeric");
      if (existing && JSON.stringify(existing.target) === JSON.stringify(target)) {
        existing.original = value;
        return;
      }
      this.bindings.push({ mechanism: m.name, source, path, original: value,
        target, blockedBy: m.blocked_by.map(p => expand(p, key, index)) });
    };
    for (const m of this.definitions.filter(m => m.event === event)) {
      for (const found of select(inputs, m.source)) {
        if (m.kind === "value") {
          add(m, found.value, found.key, found.index, found.path);
          if (found.path.length === 1 && found.path[0] === "prompt" && typeof found.value === "string")
            this.covered.push([0, found.value.length]);
        }
        else if (m.kind === "delimited" || m.kind === "prefix") {
          if (typeof found.value !== "string") throw new Error(m.name + ": source must be text");
          let start = 0, end = found.value.length, text: string;
          if (m.kind === "delimited") {
            start = found.value.indexOf(m.start!);
            if (start < 0) continue;
            const body = start + m.start!.length;
            const close = found.value.indexOf(m.end!, body);
            if (close < 0) continue;
            if (found.value.indexOf(m.start!, close + m.end!.length) >= 0)
              throw new Error(m.name + ": delimiter is ambiguous; select a more specific source");
            end = close + m.end!.length;
            text = found.value.slice(body, close);
          } else {
            end = new RegExp(m.boundary!, "m").exec(found.value)?.index ?? end;
            text = found.value.slice(0, end).trimEnd();
          }
          add(m, text, found.key, found.index, found.path);
          if (found.path.length === 1 && found.path[0] === "prompt") this.covered.push([start, end]);
        } else if (m.kind === "map") {
          if (!object(found.value)) throw new Error(m.name + ": source must be a map");
          const values: Table = Object.create(null);
          if (m.fallback_source) {
            const fallback = get(inputs, m.fallback_source);
            if (!Array.isArray(fallback)) throw new Error(m.name + ": fallback_source must be a record array");
            for (const row of fallback) {
              const key = own(row, m.fallback_key!);
              if (typeof key !== "string" || !key || unsafe.has(key)) throw new Error(m.name + ": invalid fallback key");
              if (Object.hasOwn(values, key)) throw new Error(m.name + ": duplicate fallback key " + key);
              values[key] = own(row, m.fallback_value!) ?? m.fallback_default;
            }
          }
          Object.assign(values, found.value);
          for (const [key, value] of Object.entries(values)) add(m, value, key, "", [...found.path, key]);
        } else {
          if (!Array.isArray(found.value)) throw new Error(m.name + ": source must be a record array");
          const keys = new Set<string>();
          found.value.forEach((row, index) => {
            const key = own(row, m.key_field!);
            if (typeof key !== "string" || !key || unsafe.has(key) || keys.has(key))
              throw new Error(m.name + ": invalid or duplicate record key");
            keys.add(key);
            add(m, own(row, m.value_field!), key, String(index), [...found.path, String(index), m.value_field!]);
          });
        }
      }
    }
    if (event === "context_with_system") this.unidentified = this.unidentified.filter(u =>
      !u.location.startsWith("prompt section ") || !this.identifiesSection(u.location.slice("prompt section ".length)));
    this.scan(inputs);
    return [...new Map(this.bindings.map(({ path, original }) =>
      [JSON.stringify(path), { path, original }])).values()];
  }

  private identifiesSection(name: string): boolean {
    return this.bindings.some(b => [b.source, b.target].some(path =>
      path[0] === "options" && path[1] === "sections" && path[2] === name ||
      path[0] === "messages" && path[2] === "sections" && path[3] === name)) ||
      this.definitions.some(m => m.event === "context_with_system" && m.source[0] === "messages" &&
        m.source[2] === "sections" && (
          m.source.length === 3 && m.kind === "map" ||
          m.source.length === 4 && (m.source[3] === name || m.source[3] === "*")));
  }

  private scan(inputs: Inputs) {
    if (inputs.prompt !== undefined) {
      const covered = (start: number, end: number) => {
        let next = start;
        for (const [a, b] of [...this.covered].sort((x, y) => x[0] - y[0])) {
          if (a > next) break;
          next = Math.max(next, b);
        }
        return next >= end;
      };
      const parts = promptParts(inputs.prompt);
      for (const part of parts) {
        const selected = this.identifiesSection(part.name);
        if (!selected && !covered(part.start, part.end)) this.addUnknown("prompt section " + part.name, part.text);
      }
      let at = 0;
      for (const [start, end] of [...this.covered, ...parts.map(p => [p.start, p.end] as [number, number])]
        .sort((a, b) => a[0] - b[0])) {
        if (start > at) this.addUnknown("prompt text at offset " + at, inputs.prompt.slice(at, start));
        at = Math.max(at, end);
      }
      if (at < inputs.prompt.length) this.addUnknown("prompt text at offset " + at, inputs.prompt.slice(at));
    }
    inputs.messages?.forEach((message, index) => {
      if (message.role !== "system") return;
      const identified = (field: string, name?: string) => this.bindings.some(b =>
        [b.source, b.target].some(path =>
          path[0] === "messages" && (path[1] === "*" || path[1] === String(index)) &&
            path[2] === field && (name === undefined || path[3] === name) ||
          field === "sections" && path[0] === "options" && path[1] === "sections" && path[2] === name));
      if (!identified("content") && message.content)
        this.addUnknown("messages." + index + ".content",
          typeof message.content === "string" ? message.content : JSON.stringify(message.content));
      for (const [name, text] of Object.entries(message.sections ?? {})) {
        if (text && !identified("sections", name))
          this.addUnknown("messages." + index + ".sections." + name, text);
      }
    });
  }
  private addUnknown(location: string, text: string) {
    text = text.trim();
    if (text && !this.unidentified.some(u => u.location === location && u.text === text))
      this.unidentified.push({ location, text });
  }

  applyOptions(options: object, lookup: Lookup): void {
    // Validate every target before changing live prompt inputs.
    this.apply({ options: structuredClone(options) }, lookup, "options");
    this.apply({ options }, lookup, "options");
  }
  applyTranscript<T extends TranscriptMessage>(messages: T[], lookup: Lookup): T[] {
    if (!lookup.valid) return messages;
    // Keep original messages and tool declaration objects unchanged.
    const copies = messages.map(message => message.role === "system"
      ? { ...message, ...(message.sections ? { sections: { ...message.sections } } : {}) } : message);
    this.apply({ messages: copies }, lookup, "messages");
    return copies.map((copy, index) => {
      const original = messages[index];
      const sameSections = Object.entries(copy.sections ?? {}).every(([name, text]) =>
        original.sections?.[name] === text);
      return copy.content === original.content && sameSections ? original : copy;
    }) as T[];
  }
  private apply(inputs: Inputs, lookup: Lookup, root: "options" | "messages") {
    if (!lookup.valid) return;
    const writes: { parent: Table; key: string; value: Prose; path: Path }[] = [];
    for (const b of this.bindings) {
      if (b.target[0] !== root || b.blockedBy.some(path => lookup.configured(path))) continue;
      const replacement = lookup.replacement<Prose>(b.path);
      if (replacement === undefined) continue;
      const targets = root === "messages"
        ? select(inputs, b.target.slice(0, 2)).map(s => [...s.path, ...b.target.slice(2)])
        : [b.target];
      for (const target of targets) {
        // Transcript replacements change existing text only; they cannot introduce messages.
        if (root === "messages" && typeof get(inputs, target) !== "string") continue;
        let parent: unknown = inputs;
        for (const key of target.slice(0, -1)) {
          if (own(parent, key) === undefined && object(parent)) parent[key] = Object.create(null);
          parent = own(parent, key);
          if (parent === null || typeof parent !== "object") throw new Error("Invalid target: " + target.join("."));
        }
        const key = target.at(-1)!;
        if (writes.some(w => w.path.slice(0, Math.min(w.path.length, target.length))
          .every((segment, i) => segment === target[i])))
          throw new Error("Conflicting replacement targets: " + target.join("."));
        writes.push({ parent: parent as Table, key, value: replacement, path: target });
      }
    }
    for (const w of writes) w.parent[w.key] = Array.isArray(w.value) ? [...w.value] : w.value;
  }
}
