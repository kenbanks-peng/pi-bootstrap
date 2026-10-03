import { Worker } from "node:worker_threads";

/** Plain session data only; the real ExtensionAPI is never exposed to expressions. */
export interface BootstrapExpressionContext {
  allTools: readonly unknown[];
  activeTools: readonly string[];
}

// Plain JavaScript lets the worker run without a TypeScript loader.
// Build all values inside the VM; no host objects or callbacks cross into it.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { Script, createContext } = require("node:vm");
try {
  const script = new Script(
    '"use strict";' +
    'const snapshot = JSON.parse(' + JSON.stringify(workerData.data) + ');' +
    'function freeze(value) {' +
      'if (value && typeof value === "object") {' +
        'Object.values(value).forEach(freeze); Object.freeze(value);' +
      '}' +
      'return value;' +
    '}' +
    'freeze(snapshot);' +
    'const ALL_TOOLS = snapshot.allTools;' +
    'const pi = Object.freeze({' +
      'getAllTools: Object.freeze(() => ALL_TOOLS),' +
      'getActiveTools: Object.freeze(() => snapshot.activeTools),' +
    '});' +
    '(' + workerData.expression + '\\n)',
    { filename: workerData.sourceName },
  );
  const context = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  // The parent stops the worker on timeout. VM timeouts during microtasks can
  // corrupt Node async-hook state, so do not interrupt execution inside the VM.
  const output = script.runInContext(context);
  if (typeof output !== "string") throw new Error("Expression must return a string synchronously.");
  if (Buffer.byteLength(output, "utf8") > workerData.outputLimit) {
    throw new Error("Expression output exceeded " + workerData.outputLimit +
      " bytes (limit: " + workerData.outputLimit + " bytes).");
  }
  parentPort.postMessage({ output });
} catch (error) {
  parentPort.postMessage({ error: String(error && error.message || error) });
}
`;

export async function evaluateExpression(
  expression: string,
  data: BootstrapExpressionContext,
  sourceName: string,
  timeoutMs: number,
  outputLimit: number,
): Promise<string> {
  // JSON drops functions and prevents references to mutable host metadata.
  const serialized = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { expression, data: serialized, sourceName, outputLimit },
    });
    let settled = false;
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().then(() => {
        if (error) reject(error);
        else resolve(output!);
      }, reject);
    };
    const timer = setTimeout(() => {
      finish(new Error(`Expression timed out after ${timeoutMs}ms (limit: ${timeoutMs}ms).`));
    }, timeoutMs);
    worker.on("message", (result: { error?: string; output?: string }) => {
      if (typeof result.output === "string") finish(undefined, result.output);
      else finish(new Error(result.error ?? "Expression worker returned an invalid result."));
    });
    worker.on("error", error => finish(error));
    worker.on("exit", code => {
      finish(new Error(`Expression worker exited with status ${code} without a result.`));
    });
  });
}
