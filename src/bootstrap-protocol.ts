import { parse } from "smol-toml";
import type { Action } from "./replace.js";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { evaluateExpression, type BootstrapExpressionContext } from "./bootstrap-expression.js";

export type { BootstrapExpressionContext } from "./bootstrap-expression.js";

export const COMMAND_TIMEOUT_MS = 1_000;
export const COMMAND_OUTPUT_LIMIT_BYTES = 1_048_576;


export type BootstrapAction = "memory" | "command";

export class CommandSourceError extends Error {
  constructor(readonly sourceName: string, message: string, readonly exitCode?: number) {
    super(message);
  }
}

class CommandExitError extends Error {
  constructor(readonly exitCode: number, message: string) {
    super(message);
  }
}

export type BootstrapSessionEntry =
  | { type: "memory"; content: string }
  | { type: "command"; description: string; section?: string[]; argv: [string, ...string[]]; output: string }
  | { type: "command"; description: string; section?: string[]; expression: string; output: string; deferred?: true; sourceName?: string };

export const DEFAULT_PROTOCOL = `enabled = true

[[rule]]
glob = "*.md"
action = "memory"

[[rule]]

glob = "*.toml"
action = "command"
`;

interface BootstrapRule {
  glob: string;
  action: BootstrapAction;
}

export interface BootstrapProtocol {
  enabled: boolean;
  rule: BootstrapRule[];
}

type RequestSource = { description: string; section: string[]; action: Action };

type CommandSource =
  | RequestSource
  | { description: string; section?: string[]; argv: [string, ...string[]]; cwd?: string }
  | { description: string; section?: string[]; expression: string };

const protocolFilename = "config.toml";
const utf8 = new TextDecoder("utf-8", { fatal: true });

export async function installDefaultProtocol(sourceRoot: string): Promise<void> {
  await mkdir(sourceRoot, { recursive: true });
  try {
    await writeFile(resolve(sourceRoot, protocolFilename), DEFAULT_PROTOCOL, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
}

export async function loadProtocol(sourceRoot: string, scopeLabel: string): Promise<BootstrapProtocol | undefined> {
  try {
    return parseProtocol(await readUtf8(resolve(sourceRoot, protocolFilename), `${scopeLabel} protocol`), scopeLabel);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function resolveProtocolMemories(sourceRoot: string, scopeLabel: string, protocol: BootstrapProtocol, projectRoot: string, expressionContext?: BootstrapExpressionContext): Promise<BootstrapSessionEntry[]> {
  if (!protocol.enabled) return [];
  const files = {
    memory: await listDirectFiles(join(sourceRoot, "memories"), scopeLabel),
    command: await listDirectFiles(join(sourceRoot, "commands"), scopeLabel),
  };
  const selected = selectFiles(protocol, files, scopeLabel);
  const sessionEntries: BootstrapSessionEntry[] = [];

  for (const { rule, filenames } of selected) {
    for (const filename of filenames) {
      const sourcePath = resolve(sourceRoot, rule.action === "memory" ? "memories" : "commands", filename);
      if (rule.action === "memory") {
        sessionEntries.push({ type: "memory", content: await readUtf8(sourcePath, `${scopeLabel} source "${filename}"`) });
      } else {
        const entry = await runCommandSource(sourcePath, projectRoot, scopeLabel, expressionContext);
        if (entry) sessionEntries.push(entry);
      }
    }
  }

  return sessionEntries;
}

/** Read action definitions without executing argv or expressions. */
export async function resolveProtocolActions(sourceRoot: string, scopeLabel: string, protocol: BootstrapProtocol): Promise<Map<string, Action>> {
  if (!protocol.enabled) return new Map();
  const files = {
    memory: await listDirectFiles(join(sourceRoot, "memories"), scopeLabel),
    command: await listDirectFiles(join(sourceRoot, "commands"), scopeLabel),
  };
  const actions = new Map<string, Action>();
  const owners = new Map<string, string>();
  for (const { rule, filenames } of selectFiles(protocol, files, scopeLabel)) {
    if (rule.action !== "command") continue;
    for (const filename of filenames) {
      const path = join(sourceRoot, "commands", filename);
      const source = parseCommandSource(await readUtf8(path, `${scopeLabel} command source "${filename}"`), filename, scopeLabel);
      if (!("action" in source)) continue;
      const key = JSON.stringify(source.section);
      if (actions.has(key)) {
        throw new Error(`${scopeLabel} conflicting actions for ${source.section.join(".")}: "${owners.get(key)}" and "${filename}".`);
      }
      owners.set(key, filename);
      actions.set(key, source.action);
    }
  }
  return actions;
}

function parseProtocol(text: string, scopeLabel: string): BootstrapProtocol {
  const value = parseToml(text, `${scopeLabel} config`);
  if (!isRecord(value) || (value.enabled !== undefined && typeof value.enabled !== "boolean")) {
    throw new Error(`${scopeLabel} config enabled must be a boolean.`);
  }
  const enabled = value.enabled ?? true;
  if (!enabled && value.rule === undefined) return { enabled, rule: [] };
  if (!isRecord(value) || !Array.isArray(value.rule) || value.rule.length === 0) {
    throw new Error(`${scopeLabel} protocol must contain one or more [[rule]] entries.`);
  }

  const rules = value.rule.map((rule, index) => parseRule(rule, index, scopeLabel));
  return { enabled, rule: rules };
}

function parseRule(value: unknown, index: number, scopeLabel: string): BootstrapRule {
  if (!isRecord(value) || typeof value.glob !== "string" || !isSupportedBasenameGlob(value.glob)) {
    throw new Error(`${scopeLabel} protocol rule ${index + 1} has an unsupported direct-file glob.`);
  }
  if (value.action !== "memory" && value.action !== "command") {
    throw new Error(`${scopeLabel} protocol rule ${index + 1} has invalid action "${String(value.action)}".`);
  }
  if (value.action === "command" && !value.glob.endsWith(".toml")) {
    throw new Error(`${scopeLabel} protocol rule ${index + 1} must select *.toml files for command.`);
  }
  return { glob: value.glob, action: value.action };
}

function isSupportedBasenameGlob(glob: string): boolean {
  return glob.length > 0
    && !glob.includes("/")
    && !glob.includes("\\")
    && glob !== "."
    && glob !== ".."
    && !glob.includes("**")
    && !/[?\[\]{}]/.test(glob);
}

async function listDirectFiles(sourceRoot: string, scopeLabel: string): Promise<string[]> {
  try {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw new Error(`${scopeLabel} protocol source root "${sourceRoot}" cannot be read: ${errorMessage(error)}`);
  }
}

function selectFiles(protocol: BootstrapProtocol, files: Record<BootstrapAction, string[]>, scopeLabel: string): Array<{ rule: BootstrapRule; filenames: string[] }> {
  const matched = new Set<string>();
  return protocol.rule.map((rule, index) => {
    const matches = files[rule.action].filter((filename) => matchesGlob(filename, rule.glob));
    for (const filename of matches) {
      const key = `${rule.action}/${filename}`;
      if (matched.has(key)) {
        throw new Error(`${scopeLabel} protocol rules overlap on source "${filename}" (rule ${index + 1}).`);
      }
      matched.add(key);
    }
    return { rule, filenames: matches };
  });
}

function matchesGlob(filename: string, glob: string): boolean {
  const expression = `^${glob.split("*").map(escapeRegExp).join(".*")}$`;
  return new RegExp(expression).test(filename);
}

async function runCommandSource(sourcePath: string, projectRoot: string, scopeLabel: string, expressionContext?: BootstrapExpressionContext): Promise<Extract<BootstrapSessionEntry, { type: "command" }> | undefined> {
  const sourceName = basename(sourcePath);
  try {
    const source = parseCommandSource(await readUtf8(sourcePath, `${scopeLabel} command source "${sourceName}"`), sourceName, scopeLabel);
    if ("action" in source) return undefined;
    if ("expression" in source) {
      if (!expressionContext) throw new Error("Expression commands require a Pi session context.");
      // Skill metadata arrives with before_agent_start. Preserve the source now.
      const deferred = expressionContext.allSkills === undefined &&
        ((source.section?.[0]?.replaceAll("_", "-") === "system-prompt" && source.section[1] === "skills") ||
          source.expression.includes("ALL_SKILLS") || source.expression.includes("getSkills"));
      return { type: "command", description: source.description, ...(source.section === undefined ? {} : { section: source.section }), expression: source.expression,
        output: deferred ? "" : await evaluateExpression(source.expression, expressionContext, sourceName, COMMAND_TIMEOUT_MS, COMMAND_OUTPUT_LIMIT_BYTES),
        ...(deferred ? { deferred: true as const, sourceName } : {}) };
    }
    const cwd = await commandCwd(source.cwd, projectRoot, sourceName, scopeLabel);
    const output = await execute(source.argv, cwd, sourceName, scopeLabel);
    try {
      return { type: "command", description: source.description, ...(source.section === undefined ? {} : { section: source.section }), argv: source.argv, output: utf8.decode(output) };
    } catch {
      throw new Error(`${scopeLabel} command source "${sourceName}" produced invalid UTF-8 stdout.`);
    }
  } catch (error) {
    if (error instanceof CommandSourceError) throw error;
    throw new CommandSourceError(
      sourceName,
      errorMessage(error),
      error instanceof CommandExitError ? error.exitCode : undefined,
    );
  }
}

function parseCommandSource(text: string, sourceName: string, scopeLabel: string): CommandSource {
  const value = parseToml(text, `${scopeLabel} command source "${sourceName}"`);
  const label = `${scopeLabel} command source "${sourceName}"`;
  if (!isRecord(value)) {
    throw new Error(`${label} must be a TOML table.`);
  }
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.trim().length === 0 || /[\r\n]/.test(value.description))) {
    throw new Error(`${label} description must be a non-empty single-line string.`);
  }
  const description = typeof value.description === "string" ? value.description : "";
  const actions = ["argv", "expression", "replacement", "refer"].filter(key => key in value);
  if (actions.length !== 1) {
    throw new Error(`${label} must contain exactly one of argv, expression, replacement, or refer.`);
  }
  if ("target" in value) throw new Error(`${label} target is not supported; use section.`);
  const path = typeof value.section === "string" ? value.section.split(".") : value.section;
  if (value.section !== undefined && (!Array.isArray(path) || !path.length ||
    !path.every(part => typeof part === "string" && /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(part)))) {
    throw new Error(`${label} section must be a tag path or a non-empty array of tag names.`);
  }
  const section = path as string[] | undefined;
  if ("replacement" in value || "refer" in value) {
    if (!section) throw new Error(`${label} section is required for replacement or refer.`);
    const allowed = new Set(["description", "section", actions[0], ...(actions[0] === "refer" ? ["link"] : [])]);
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new Error(`${label} does not support "${key}" with ${actions[0]}.`);
    }
    if ("replacement" in value) {
      if (typeof value.replacement !== "string") throw new Error(`${label} replacement must be a string.`);
      return { description, section, action: value.replacement };
    }
    if (typeof value.refer !== "string" || typeof value.link !== "string" || !value.link.trim()) {
      throw new Error(`${label} refer requires a string and a non-empty link.`);
    }
    return { description, section, action: { refer: value.refer, link: value.link } };
  }
  if ("link" in value) throw new Error(`${label} link requires refer.`);
  const destination = section === undefined ? {} : { section };
  if ("expression" in value) {
    if (typeof value.expression !== "string" || value.expression.trim().length === 0) {
      throw new Error(`${label} expression must be a non-empty string.`);
    }
    if ("cwd" in value) throw new Error(`${label} cwd is only supported with argv.`);
    return { description, ...destination, expression: value.expression };
  }
  if (!Array.isArray(value.argv) || value.argv.length === 0 || !value.argv.every((part) => typeof part === "string")) {
    throw new Error(`${label} must contain a non-empty argv string array.`);
  }
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length === 0)) {
    throw new Error(`${scopeLabel} command source "${sourceName}" has an invalid cwd.`);
  }
  return { description, ...destination, argv: value.argv as [string, ...string[]], ...(value.cwd === undefined ? {} : { cwd: value.cwd }) };
}

async function commandCwd(cwd: string | undefined, projectRoot: string, sourceName: string, scopeLabel: string): Promise<string> {
  const requested = cwd ?? ".";
  if (isAbsolute(requested)) {
    throw new Error(`${scopeLabel} command source "${sourceName}" cwd must be relative beneath the current project root.`);
  }
  const candidate = resolve(projectRoot, requested);
  if (!isContained(projectRoot, candidate)) {
    throw new Error(`${scopeLabel} command source "${sourceName}" cwd must not escape the current project root.`);
  }
  try {
    const [root, resolvedCwd] = await Promise.all([realpath(projectRoot), realpath(candidate)]);
    if (!isContained(root, resolvedCwd)) {
      throw new Error(`${scopeLabel} command source "${sourceName}" cwd must not escape the current project root.`);
    }
    return resolvedCwd;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must not escape")) throw error;
    throw new Error(`${scopeLabel} command source "${sourceName}" cwd cannot be resolved: ${errorMessage(error)}`);
  }
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function execute(argv: [string, ...string[]], cwd: string, sourceName: string, scopeLabel: string): Promise<Buffer> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const fail = (message: string) => finish(() => reject(new Error(`${scopeLabel} command source "${sourceName}": ${message}`)));
    const timer = setTimeout(() => {
      fail(`timed out after ${COMMAND_TIMEOUT_MS}ms (limit: ${COMMAND_TIMEOUT_MS}ms).`);
      child.kill();
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > COMMAND_OUTPUT_LIMIT_BYTES) {
        fail(`stdout exceeded ${COMMAND_OUTPUT_LIMIT_BYTES} bytes (limit: ${COMMAND_OUTPUT_LIMIT_BYTES} bytes).`);
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    // Drain stderr so a noisy command cannot block on a full pipe.
    child.stderr.resume();
    child.on("error", (error) => fail(`execution failed: ${errorMessage(error)}`));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const message = `exited with status ${code ?? "none"}${signal ? ` (signal ${signal})` : ""}.`;
        if (typeof code === "number") {
          finish(() => reject(new CommandExitError(code, `${scopeLabel} command source "${sourceName}": ${message}`)));
        } else {
          fail(message);
        }
        return;
      }
      finish(() => resolveOutput(Buffer.concat(chunks)));
    });
  });
}

function parseToml(text: string, label: string): unknown {
  try {
    return parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid TOML: ${errorMessage(error)}`);
  }
}

async function readUtf8(path: string, label: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw error;
  }
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
