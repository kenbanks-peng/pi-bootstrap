
import { BootstrapRepository, scopeLabel, type BootstrapScope, type BootstrapSource, type BootstrapSourceType } from "./bootstrap-repository.js";

export interface BootstrapCommandUI {
  hasUI: boolean;
  editor(title: string, initialValue: string): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

const api = "/bootstrap list [global|project] [memory|command]\n/bootstrap add [global|project] [memory|command]\n/bootstrap edit <id> [memory|command]\n/bootstrap delete <id> [memory|command]";
const usage = "Usage: /bootstrap list [global|project] [memory|command] | add [global|project] [memory|command] | edit <id> [memory|command] | delete <id> [memory|command]";
const commandTemplate = [
  'description = "Working tree status"',
  '# Keep exactly one action: argv, expression, replacement, or refer.',
  'argv = ["git", "status", "--short"]',
  'cwd = "."',
  '# For an expression, remove argv and cwd:',
  '# expression = \'ALL_TOOLS.map(t => t.name).join("\\n")\'',
  '# For request actions, remove argv and cwd. Description is not inserted.',
  '# section = "system_prompt.tools"',
  '# replacement = "New tool instructions"',
  '# Or use refer and link instead of replacement:',
  '# refer = "Read $link"',
  '# link = "links/tools.md"',
  "",
].join("\n");


export async function runBootstrapCommand(args: string, bootstraps: BootstrapRepository, ui: BootstrapCommandUI): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const [operation, ...arguments_] = tokens;

  try {
    switch (operation) {
      case "list":
        await listBootstraps(arguments_, bootstraps, ui);
        return;
      case "add":
        await addBootstrap(arguments_, bootstraps, ui);
        return;
      case "edit":
        await editBootstrap(arguments_, bootstraps, ui);
        return;
      case "delete":
        await deleteBootstrap(arguments_, bootstraps, ui);
        return;
      case undefined:
        ui.notify(api);
        return;
      default:
        ui.notify(usage, "error");
    }
  } catch (error) {
    ui.notify(errorMessage(error), "error");
  }
}

async function listBootstraps(arguments_: string[], bootstraps: BootstrapRepository, ui: BootstrapCommandUI): Promise<void> {
  const { scope, type } = parseScopeAndType(arguments_, true);
  const scopes: BootstrapScope[] = scope === undefined ? ["global", "project"] : [scope];
  const lists = await Promise.all(scopes.map(async (currentScope) => {
    const sources = (await bootstraps.list(currentScope)).filter((source) => type === undefined || source.type === type);
    const contents = await Promise.all(sources.map(async (source) => ({ source, content: await bootstraps.read(currentScope, source) })));
    return formatBootstrapList(currentScope, contents);
  }));
  ui.notify(lists.join("\n\n"));
}

async function addBootstrap(arguments_: string[], bootstraps: BootstrapRepository, ui: BootstrapCommandUI): Promise<void> {
  requireInteractiveUI(ui, "Adding");
  const { scope = "project", type = "memory" } = parseScopeAndType(arguments_, true);
  const content = await ui.editor(`Add ${scopeLabel(scope)} ${type} Bootstrap`, type === "command" ? commandTemplate : "");
  if (content === undefined) {
    ui.notify(`${scopeLabel(scope)} ${type} Bootstrap addition cancelled.`);
    return;
  }

  const id = await bootstraps.create(scope, type, content);
  ui.notify(`Added ${scopeLabel(scope)} ${type} Bootstrap "${id}".`);
}

async function editBootstrap(arguments_: string[], bootstraps: BootstrapRepository, ui: BootstrapCommandUI): Promise<void> {
  requireInteractiveUI(ui, "Editing");
  const [id, typeArgument] = arguments_;
  if (id === undefined || arguments_.length > 2) throw new Error(usage);
  const source = await sourceForId(id, typeArgument, bootstraps);
  const content = await bootstraps.read(source.scope, source);
  const updatedContent = await ui.editor(`Edit ${scopeLabel(source.scope)} ${source.type} Bootstrap`, content);
  if (updatedContent === undefined) {
    ui.notify(`${scopeLabel(source.scope)} ${source.type} Bootstrap edit cancelled.`);
    return;
  }

  await bootstraps.edit(source.scope, source, updatedContent);
  ui.notify(`Edited ${scopeLabel(source.scope)} ${source.type} Bootstrap "${id}".`);
}

async function deleteBootstrap(arguments_: string[], bootstraps: BootstrapRepository, ui: BootstrapCommandUI): Promise<void> {
  const [id, typeArgument] = arguments_;
  if (id === undefined || arguments_.length > 2) throw new Error(usage);
  const source = await sourceForId(id, typeArgument, bootstraps);
  await bootstraps.delete(source.scope, source);
  ui.notify(`Deleted ${scopeLabel(source.scope)} ${source.type} Bootstrap "${id}".`);
}

function parseScopeAndType(arguments_: string[], allowEmpty: boolean): { scope?: BootstrapScope; type?: BootstrapSourceType } {
  if ((!allowEmpty && arguments_.length === 0) || arguments_.length > 2) throw new Error(usage);
  let scope: BootstrapScope | undefined;
  let type: BootstrapSourceType | undefined;
  for (const value of arguments_) {
    if (value === "global" || value === "project") {
      if (scope !== undefined) throw new Error(usage);
      scope = value;
    } else if (value === "memory" || value === "command") {
      if (type !== undefined) throw new Error(usage);
      type = value;
    } else {
      throw new Error(usage);
    }
  }
  return { scope, type };
}

function requireInteractiveUI(ui: BootstrapCommandUI, operation: string): void {
  if (!ui.hasUI) throw new Error(`${operation} a Bootstrap requires interactive UI. ${usage}`);
}

async function sourceForId(id: string, typeArgument: string | undefined, bootstraps: BootstrapRepository): Promise<BootstrapSource & { scope: BootstrapScope }> {
  if (typeArgument !== undefined && typeArgument !== "memory" && typeArgument !== "command") throw new Error(usage);
  const requestedType = typeArgument as BootstrapSourceType | undefined;
  const sources = (await Promise.all(
    (["global", "project"] as const).map(async (scope) => (await bootstraps.list(scope))
      .filter((source) => source.id === id && (requestedType === undefined || source.type === requestedType))
      .map((source) => ({ ...source, scope }))),
  )).flat();

  if (sources.length === 0) throw new Error(`Bootstrap "${id}" does not exist.`);
  if (sources.length > 1) throw new Error(`Bootstrap "${id}" is ambiguous. Specify memory or command, or remove the duplicate.`);
  return sources[0]!;
}

function formatBootstrapList(scope: BootstrapScope, bootstraps: Array<{ source: BootstrapSource; content: string }>): string {
  const label = `${scope}:`;
  return bootstraps.length === 0
    ? `${label} none`
    : `${label}\n${bootstraps.map(({ source, content }) => `- ${source.type}: ${content} [${source.id}]`).join("\n")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Bootstrap operation failed.";
}
