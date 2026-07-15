// ── Custom Tool Runtime ─────────────────────────────
// Converts user-authored custom tool definitions (Tools page builder)
// into Anthropic tool schemas, and executes their scripts in a
// sandboxed Blob Worker — off the main thread, no Tauri IPC bridge,
// hard-terminated on timeout.

import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import * as z from "zod";
import type { SwarmToolResult } from "#lib/tools";

// ── Canonical definition types + persistence schema ─
// The single source of truth for the custom-tool shape — ToolBuilder
// re-exports these for its form, and the store validates persisted
// values against the schema so a corrupted entry degrades to "no
// custom tools" instead of crashing consumers.

/** A single parameter definition for a custom tool. */
export interface ToolParam {
  readonly id: string;
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "object" | "array";
  readonly description: string;
}

/** Full definition of a custom tool. */
export interface CustomToolDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly params: readonly ToolParam[];
  readonly script: string;
}

const ToolParamSchema: z.ZodType<ToolParam> = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  description: z.string(),
});

const CustomToolDefSchema: z.ZodType<CustomToolDef> = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  params: z.array(ToolParamSchema),
  script: z.string(),
});

export const CustomToolListSchema: z.ZodType<readonly CustomToolDef[]> =
  z.array(CustomToolDefSchema);

/** How long a custom tool script may run before its worker is terminated. */
const SCRIPT_TIMEOUT_MS = 10_000;

// ── Anthropic schema conversion ─────────────────────

/**
 * Converts a custom tool definition into the Anthropic tool format —
 * the exact JSON the ToolBuilder's live preview shows. Params with an
 * empty name are skipped (the builder allows adding a row before
 * naming it); all named params are required, matching the preview.
 */
export function customToolToAnthropic(def: CustomToolDef): Tool {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];

  for (const param of def.params) {
    if (param.name) {
      properties[param.name] = { type: param.type, description: param.description };
      required.push(param.name);
    }
  }

  return {
    name: def.name,
    description: def.description,
    input_schema: { type: "object", properties, required },
  };
}

// ── Sandboxed execution ─────────────────────────────

/**
 * Builds the Worker source that hosts a custom tool script.
 *
 * The user's script becomes the body of an async function receiving
 * `input`; its return value is posted back as the tool result. Exported
 * separately from {@link runCustomTool} so the wrapping contract is
 * unit-testable without a real Worker.
 */
export function buildWorkerSource(script: string): string {
  return `
self.onmessage = async (e) => {
  try {
    const result = await (async (input) => {
${script}
    })(e.data);
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
`;
}

/**
 * Runs a custom tool's script in a dedicated Blob Worker.
 *
 * Sandboxing properties: the script executes off the main thread with
 * no DOM and no Tauri IPC bridge (workers don't inherit
 * `__TAURI_INTERNALS__`), and a hung script is hard-terminated after
 * {@link SCRIPT_TIMEOUT_MS}. The app CSP allows `worker-src blob:`
 * specifically for this path (tauri.conf.json).
 */
export function runCustomTool(
  def: CustomToolDef,
  input: Record<string, unknown>,
): Promise<SwarmToolResult> {
  const url = URL.createObjectURL(
    new Blob([buildWorkerSource(def.script)], { type: "text/javascript" }),
  );
  const worker = new Worker(url);

  return new Promise<SwarmToolResult>((resolve) => {
    const finish = (result: SwarmToolResult): void => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ success: false, error: `Tool "${def.name}" Timed Out After 10s` });
    }, SCRIPT_TIMEOUT_MS);

    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: unknown; error?: string }>) => {
      if (e.data.ok) {
        finish({ success: true, data: e.data.result });
      } else {
        finish({ success: false, error: e.data.error ?? "Unknown Error" });
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      finish({ success: false, error: e.message || `Tool "${def.name}" Failed To Start` });
    };

    worker.postMessage(input);
  });
}
