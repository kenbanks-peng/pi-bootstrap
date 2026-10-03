import { homedir } from "node:os";
import { join } from "node:path";

export function getBootstrapDirectory(home = homedir(), agentDirectory = process.env.PI_CODING_AGENT_DIR): string {
  return join(agentDirectory || join(home, ".config", "pi", "agent"), "extensions", "pi-bootstrap");
}
