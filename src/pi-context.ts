import type { Source, Table } from "./lookup.ts";
import { Mechanisms, type TranscriptMessage } from "./prompt.ts";

const isTable = (value: unknown): value is Table =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Translate Pi's transcript storage into the request hierarchy shown in pi-baseline.md.
 * The capture's <request> is the config root. Section tags remain data for the generic
 * matcher; the adapter knows only Pi's transport containers, not docs/tools/rules tags.
 */
export class PiContext extends Mechanisms {
  constructor(data: Table) {
    super(data);
    const check = (table: Table, path: string[]) => {
      for (const [name, value] of Object.entries(table)) {
        if (name === "replacement" && typeof value === "string") {
          if (path[0] === "tools")
            throw new Error("tools: structured provider declarations cannot be replaced with text; use system-prompt.tools for tagged guidance");
          if (path.join(".") === "system-prompt" || path.join(".") === "messages" ||
            path.join(".") === "messages.message")
            throw new Error(path.join(".") + ": select a tagged body within this transport container");
        } else if (isTable(value)) check(value, [...path, name]);
      }
    };
    check(data, []);
  }

  override discover(messages: TranscriptMessage[]): Source[] {
    return super.discover(messages, message =>
      message.role === "system" ? ["system-prompt"] : ["messages", "message"]);
  }
}
