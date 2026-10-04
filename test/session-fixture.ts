import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { BootstrapRepository } from "../src/bootstrap-repository.ts";
import type { Action } from "../src/replace.ts";
import { stringify } from "smol-toml";

export async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-bootstrap-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const repository = new BootstrapRepository({
    globalDirectory: join(root, "global"),
    projectDirectory: join(projectRoot, ".agents", "bootstrap"),
  });
  for (const dir of Object.values(repository.directories)) {
    await mkdir(join(dir, "memories"), { recursive: true });
    await mkdir(join(dir, "commands"), { recursive: true });
  }
  return { root, projectRoot, repository,
    global: repository.directories.globalDirectory,
    project: repository.directories.projectDirectory,
  };
}

/** Replace only this fixture's request actions, leaving executable sources intact. */
export async function actions(root: string, values: Record<string, Action>) {
  const directory = join(root, "commands");
  await mkdir(directory, { recursive: true });
  for (const file of await readdir(directory)) {
    if (/^request-\d+\.toml$/.test(file)) await rm(join(directory, file));
  }
  for (const [index, [target, action]] of Object.entries(values).entries()) {
    await command(root, `request-${index}.toml`, stringify({
      description: "Request action", section: target,
      ...(typeof action === "string" ? { replacement: action } : action),
    }));
  }
}

export const memoryProtocol = '[[rule]]\nglob = "*.md"\naction = "memory"\n';
export const commandProtocol = '[[rule]]\nglob = "*.toml"\naction = "command"\n';
export const protocol = (root: string, content: string) => writeFile(join(root, "config.toml"), content);
export const memory = (root: string, name: string, content: string | Buffer) => writeFile(join(root, "memories", name), content);
export const command = (root: string, name: string, content: string | Buffer) => writeFile(join(root, "commands", name), content);
export const executable = (code: string, cwd?: string) => `description = "Test command"\nargv = ${JSON.stringify([process.execPath, "-e", code])}\n${cwd === undefined ? "" : `cwd = ${JSON.stringify(cwd)}\n`}`;
