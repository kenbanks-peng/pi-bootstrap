import { parse } from "smol-toml";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { evaluateExpression, type BootstrapExpressionContext } from "./bootstrap-expression.js";

export type { BootstrapExpressionContext } from "./bootstrap-expression.js";

export const COMMAND_TIMEOUT_MS = 1_000;
export const COMMAND_OUTPUT_LIMIT_BYTES = 1_048_576;
export const BOOTSTRAP_VERSION = 1;

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
  | { type: "command"; description: string; argv: [string, ...string[]]; output: string }
  | { type: "command"; description: string; expression: string; output: string };

export const DEFAULT_PROTOCOL = `version = ${BOOTSTRAP_VERSION}

[[rule]]
glob = "*.md"
action = "memory"

[[rule]]
glob = "*.toml"
action = "command"
`;

interface BootstrapRuleV1 {
  glob: string;
  action: BootstrapAction;
}

export interface BootstrapProtocolV1 {
  version: typeof BOOTSTRAP_VERSION;
  rule: BootstrapRuleV1[];
}

type CommandSourceV1 =
  | { version: typeof BOOTSTRAP_VERSION; description: string; argv: [string, ...string[]]; cwd?: string }
  | { version: typeof BOOTSTRAP_VERSION; description: string; expression: string };

const protocolFilename = "protocol.toml";
const utf8 = new TextDecoder("utf-8", { fatal: true });

export async function installDefaultProtocol(sourceRoot: string): Promise<void> {
  await mkdir(sourceRoot, { recursive: true });
  try {
    await writeFile(resolve(sourceRoot, protocolFilename), DEFAULT_PROTOCOL, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
}

export async function loadProtocol(sourceRoot: string, scopeLabel: string): Promise<BootstrapProtocolV1 | undefined> {
  try {
    return parseProtocol(await readUtf8(resolve(sourceRoot, protocolFilename), `${scopeLabel} protocol`), scopeLabel);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function resolveProtocolMemories(sourceRoot: string, scopeLabel: string, protocol: BootstrapProtocolV1, projectRoot: string, expressionContext?: BootstrapExpressionContext): Promise<BootstrapSessionEntry[]> {
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
        sessionEntries.push(await runCommandSource(sourcePath, projectRoot, scopeLabel, expressionContext));
      }
    }
  }

  return sessionEntries;
}

function parseProtocol(text: string, scopeLabel: string): BootstrapProtocolV1 {
  const value = parseToml(text, `${scopeLabel} protocol`);
  if (!isRecord(value) || value.version !== BOOTSTRAP_VERSION || !Array.isArray(value.rule) || value.rule.length === 0) {
    throw new Error(`${scopeLabel} protocol must contain version = ${BOOTSTRAP_VERSION} and one or more [[rule]] entries.`);
  }

  const rules = value.rule.map((rule, index) => parseRule(rule, index, scopeLabel));
  return { version: BOOTSTRAP_VERSION, rule: rules };
}

function parseRule(value: unknown, index: number, scopeLabel: string): BootstrapRuleV1 {
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

function selectFiles(protocol: BootstrapProtocolV1, files: Record<BootstrapAction, string[]>, scopeLabel: string): Array<{ rule: BootstrapRuleV1; filenames: string[] }> {
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

async function runCommandSource(sourcePath: string, projectRoot: string, scopeLabel: string, expressionContext?: BootstrapExpressionContext): Promise<Extract<BootstrapSessionEntry, { type: "command" }>> {
  const sourceName = basename(sourcePath);
  try {
    const source = parseCommandSource(await readUtf8(sourcePath, `${scopeLabel} command source "${sourceName}"`), sourceName, scopeLabel);
    if ("expression" in source) {
      if (!expressionContext) throw new Error("Expression commands require a Pi session context.");
      return { type: "command", description: source.description, expression: source.expression, output: await evaluateExpression(source.expression, expressionContext, sourceName, COMMAND_TIMEOUT_MS, COMMAND_OUTPUT_LIMIT_BYTES) };
    }
    const cwd = await commandCwd(source.cwd, projectRoot, sourceName, scopeLabel);
    const output = await execute(source.argv, cwd, sourceName, scopeLabel);
    try {
      return { type: "command", description: source.description, argv: source.argv, output: utf8.decode(output) };
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

function parseCommandSource(text: string, sourceName: string, scopeLabel: string): CommandSourceV1 {
  const value = parseToml(text, `${scopeLabel} command source "${sourceName}"`);
  const label = `${scopeLabel} command source "${sourceName}"`;
  if (!isRecord(value) || value.version !== BOOTSTRAP_VERSION) {
    throw new Error(`${label} must contain version = ${BOOTSTRAP_VERSION}.`);
  }
  if (typeof value.description !== "string" || value.description.trim().length === 0 || /[\r\n]/.test(value.description)) {
    throw new Error(`${label} description must be a non-empty single-line string.`);
  }
  if (("argv" in value) === ("expression" in value)) {
    throw new Error(`${label} must contain exactly one of argv or expression.`);
  }
  if ("expression" in value) {
    if (typeof value.expression !== "string" || value.expression.trim().length === 0) {
      throw new Error(`${label} expression must be a non-empty string.`);
    }
    if ("cwd" in value) throw new Error(`${label} cwd is only supported with argv.`);
    return { version: BOOTSTRAP_VERSION, description: value.description, expression: value.expression };
  }
  if (!Array.isArray(value.argv) || value.argv.length === 0 || !value.argv.every((part) => typeof part === "string")) {
    throw new Error(`${label} must contain a non-empty argv string array.`);
  }
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length === 0)) {
    throw new Error(`${scopeLabel} command source "${sourceName}" has an invalid cwd.`);
  }
  return { version: BOOTSTRAP_VERSION, description: value.description, argv: value.argv as [string, ...string[]], ...(value.cwd === undefined ? {} : { cwd: value.cwd }) };
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
