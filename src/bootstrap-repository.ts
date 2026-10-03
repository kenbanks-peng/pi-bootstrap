import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Action } from "./replace.js";
import { installDefaultProtocol, loadProtocol, resolveProtocolActions, resolveProtocolMemories } from "./bootstrap-protocol.js";
import type { BootstrapExpressionContext, BootstrapSessionEntry } from "./bootstrap-protocol.js";

export interface BootstrapSnapshot {
  bootstrap: string;
  sections: Record<string, string>;
  entries: BootstrapSessionEntry[];
}

export type BootstrapScope = "global" | "project";
export type BootstrapSourceType = "memory" | "command";

export interface BootstrapRepositoryDirectories {
  globalDirectory: string;
  projectDirectory: string;
}

export interface BootstrapSource {
  id: string;
  type: BootstrapSourceType;
}

export class BootstrapRepository {
  constructor(readonly directories: BootstrapRepositoryDirectories) {}

  async create(scope: BootstrapScope, type: BootstrapSourceType, content: string): Promise<string> {
    const directory = this.sourceDirectoryFor(scope, type);
    await mkdir(directory, { recursive: true });

    for (;;) {
      const id = `${type}-${randomUUID().slice(0, 8)}`;
      try {
        await writeFile(this.pathFor(scope, id, type), content, { encoding: "utf8", flag: "wx" });
        return id;
      } catch (error) {
        if (!isFileSystemError(error, "EEXIST")) {
          throw error;
        }
      }
    }
  }

  async read(scope: BootstrapScope, source: BootstrapSource): Promise<string> {
    try {
      return await readFile(this.pathFor(scope, source.id, source.type), "utf8");
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        throw new Error(`${scopeLabel(scope)} ${source.type} Bootstrap "${source.id}" does not exist.`);
      }
      throw error;
    }
  }

  async edit(scope: BootstrapScope, source: BootstrapSource, content: string): Promise<void> {
    await this.read(scope, source);
    await writeFile(this.pathFor(scope, source.id, source.type), content, "utf8");
  }

  async delete(scope: BootstrapScope, source: BootstrapSource): Promise<void> {
    try {
      await unlink(this.pathFor(scope, source.id, source.type));
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        throw new Error(`${scopeLabel(scope)} ${source.type} Bootstrap "${source.id}" does not exist.`);
      }
      throw error;
    }
  }

  async list(scope: BootstrapScope): Promise<BootstrapSource[]> {
    const sources = await Promise.all((["memory", "command"] as const).map(async (type) => {
      try {
        const entries = await readdir(this.sourceDirectoryFor(scope, type), { withFileTypes: true });
        const suffix = type === "memory" ? ".md" : ".toml";
        return entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
          .map((entry) => ({ id: entry.name.slice(0, -suffix.length), type }))
          .filter((source) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(source.id));
      } catch (error) {
        if (isFileSystemError(error, "ENOENT")) return [];
        throw error;
      }
    }));
    return sources.flat().sort((left, right) => left.id.localeCompare(right.id) || left.type.localeCompare(right.type));
  }

  /** Request actions refresh independently of the session snapshot. Project targets win. */
  async loadActions(): Promise<Map<string, Action>> {
    const { globalProtocol, projectProtocol } = await this.protocols();
    const actions = new Map<string, Action>();
    for (const [scope, protocol] of [["global", globalProtocol], ["project", projectProtocol]] as const) {
      const directory = this.directoryFor(scope);
      const selected = await resolveProtocolActions(directory, scopeLabel(scope), protocol);
      for (const [key, action] of selected) {
        if (typeof action === "string") actions.set(key, action);
        else {
          const link = action.link;
          const destination = link === "~" ? homedir() : link.startsWith("~/")
            ? join(homedir(), link.slice(2)) : resolve(directory, link);
          actions.set(key, { ...action, destination });
        }
      }
    }
    return actions;
  }

  private async protocols() {
    await installDefaultProtocol(this.directories.globalDirectory);
    const globalProtocol = await loadProtocol(this.directories.globalDirectory, "Global");
    if (!globalProtocol) throw new Error("Global Bootstrap protocol could not be installed.");
    const projectProtocol = await loadProtocol(this.directories.projectDirectory, "Project") ?? globalProtocol;
    return { globalProtocol, projectProtocol };
  }

  async compose(expressionContext?: BootstrapExpressionContext): Promise<string> {
    return (await this.composeSnapshot(expressionContext)).bootstrap;
  }

  async composeSnapshot(expressionContext?: BootstrapExpressionContext): Promise<BootstrapSnapshot> {
    const globalDirectory = this.directoryFor("global");
    const { globalProtocol, projectProtocol } = await this.protocols();
    const projectDirectory = this.directoryFor("project");
    const projectRoot = dirname(dirname(projectDirectory));
    const global = await resolveProtocolMemories(globalDirectory, "Global", globalProtocol, projectRoot, expressionContext);
    const project = await resolveProtocolMemories(projectDirectory, "Project", projectProtocol, projectRoot, expressionContext);
    const entries = [...global, ...project];

    return formatSnapshot(entries);
  }

  private directoryFor(scope: BootstrapScope): string {
    return scope === "global" ? this.directories.globalDirectory : this.directories.projectDirectory;
  }

  private pathFor(scope: BootstrapScope, id: string, type: BootstrapSourceType): string {
    this.validateId(id);
    return join(this.sourceDirectoryFor(scope, type), `${id}${type === "memory" ? ".md" : ".toml"}`);
  }

  private sourceDirectoryFor(scope: BootstrapScope, type: BootstrapSourceType): string {
    return join(this.directoryFor(scope), type === "memory" ? "memories" : "commands");
  }

  private validateId(id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
      throw new Error(`Invalid Bootstrap ID "${id}". Use letters, digits, hyphens, or underscores.`);
    }
  }
}

export function formatSnapshot(entries: BootstrapSessionEntry[]): BootstrapSnapshot {
  const ordinary: BootstrapSessionEntry[] = [];
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.type === "command" && "deferred" in entry && entry.deferred) continue;
    if (entry.type === "command" && entry.section !== undefined) {
      const items = groups.get(entry.section) ?? [];
      items.push(formatSessionEntry(entry));
      groups.set(entry.section, items);
    } else ordinary.push(entry);
  }
  return {
    entries,
    bootstrap: ordinary.length ? `<bootstrap>\n${ordinary.map(formatSessionEntry).join("\n\n")}\n</bootstrap>` : "",
    sections: Object.fromEntries([...groups].map(([name, items]) => [name, `<${name}>\n${items.join("\n\n")}\n</${name}>`])),
  };
}

function formatSessionEntry(entry: BootstrapSessionEntry): string {
  if (entry.type === "memory") return escapeXml(entry.content.replace(/[\r\n]+$/, ""));
  return `${escapeXml(entry.description)}\n${escapeXml(entry.output.replace(/[\r\n]+$/, ""))}`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;");
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function scopeLabel(scope: BootstrapScope): "Global" | "Project" {
  return scope === "global" ? "Global" : "Project";
}
