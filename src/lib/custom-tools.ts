/**
 * Custom tool runtime: the canonical shape of a user-authored tool (the
 * Tools page builder), the naming rules the Anthropic API enforces on
 * it, its conversion into an Anthropic tool definition and an input
 * schema, and sandboxed execution of its script in a Blob Worker — off
 * the main thread, with no Tauri IPC bridge, hard-terminated on timeout.
 *
 * @module custom-tools
 */

import * as z from "zod";
import type { ChatTool } from "#lib/anthropic";
import type { SwarmToolResult } from "#lib/tools";

// ── Canonical definition types ──────────────────────

/** JSON Schema types a custom tool parameter can take. */
export const PARAM_TYPES = ["string", "number", "boolean", "object", "array"] as const;

/** A single parameter definition for a custom tool. */
export interface ToolParam {
  readonly id: string;
  /** Empty while the builder row is still unnamed; such rows are never sent. */
  readonly name: string;
  readonly type: (typeof PARAM_TYPES)[number];
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

// ── API naming rules ────────────────────────────────

/**
 * The Anthropic API's tool-name contract. A name outside it 400s the
 * entire request (built-in tools included), so it is enforced at save
 * time (ToolBuilder), at hydrate time and at request assembly.
 */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** The API's contract for `input_schema` property keys — the same stakes as {@link TOOL_NAME_PATTERN}. */
const PARAM_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

/** Whether a custom tool name is safe to send to the Anthropic API. */
export function isValidToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

/** Whether a parameter name is safe to send as an `input_schema` property key. */
export function isValidParamName(name: string): boolean {
  return PARAM_NAME_PATTERN.test(name);
}

/** Everything that would stop a tool definition from being saved, keyed for the builder UI. */
export interface CustomToolIssues {
  /** Title Case problem with the tool name, if any. */
  readonly name?: string;
  /** Title Case problem per parameter row id. */
  readonly params: ReadonlyMap<string, string>;
}

/**
 * Validates a definition the way the API and the tool runtime will see
 * it: the name must match {@link TOOL_NAME_PATTERN} and not be taken
 * (`takenNames` holds the built-in tool names and every other custom
 * tool's name), and every named parameter must match
 * {@link PARAM_NAME_PATTERN} and be unique within the tool.
 */
export function customToolIssues(
  def: Pick<CustomToolDef, "name" | "params">,
  takenNames: ReadonlySet<string>,
): CustomToolIssues {
  const name = !isValidToolName(def.name)
    ? "Use 1–64 Letters, Digits, Underscores Or Hyphens — The API Rejects Anything Else."
    : takenNames.has(def.name)
      ? "Name Already In Use By Another Tool."
      : undefined;

  const params = new Map<string, string>();
  const counts = Map.groupBy(
    def.params.filter((param) => param.name !== ""),
    (param) => param.name,
  );
  for (const param of def.params) {
    if (param.name === "") continue;
    if (!isValidParamName(param.name)) {
      params.set(
        param.id,
        "Use 1–64 Letters, Digits, Underscores, Dots Or Hyphens — The API Rejects Anything Else.",
      );
    } else if ((counts.get(param.name)?.length ?? 0) > 1) {
      params.set(param.id, "Duplicate Parameter Name.");
    }
  }
  return { name, params };
}

/** Whether {@link customToolIssues} found nothing blocking. */
export function hasNoIssues(issues: CustomToolIssues): boolean {
  return issues.name === undefined && issues.params.size === 0;
}

// ── Persistence schema ──────────────────────────────

// Parameter names are deliberately not pattern-checked here: a tool
// persisted with a free-text name ("file path") must survive hydration —
// the next save rewrites the whole list, so a dropped tool would be erased
// with its script. Invalid or duplicate names never reach the API
// (sentParams filters them) and the builder flags them on edit.
const ToolParamSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(PARAM_TYPES),
  description: z.string(),
});

const CustomToolDefSchema = z.object({
  id: z.string(),
  name: z.string().regex(TOOL_NAME_PATTERN),
  description: z.string(),
  params: z.array(ToolParamSchema),
  script: z.string(),
});

/**
 * Validates a persisted value entry-by-entry, keeping the valid tools —
 * one corrupted or invalid-named entry drops only itself, not the
 * user's whole collection. A tool whose parameter names the API would
 * reject is kept: those parameters are left out of requests instead.
 */
export function parsePersistedCustomTools(raw: unknown): CustomToolDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = CustomToolDefSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

// ── Anthropic schema conversion ─────────────────────

/**
 * The parameters actually sent: named, API-valid, first occurrence of
 * each name — the same filter for the tool definition and for input
 * validation, so the two can never disagree.
 */
function sentParams(def: CustomToolDef): ToolParam[] {
  const seen = new Set<string>();
  return def.params.filter((param) => {
    if (!isValidParamName(param.name) || seen.has(param.name)) return false;
    seen.add(param.name);
    return true;
  });
}

/**
 * Converts a custom tool definition into the Anthropic tool format —
 * also the exact JSON the ToolBuilder's live preview shows. Every sent
 * parameter is required. `properties` is built with own-property
 * semantics (`Object.fromEntries`), so even a name like `__proto__`
 * serializes as an ordinary key.
 */
export function customToolToAnthropic(def: CustomToolDef): ChatTool {
  const params = sentParams(def);
  return {
    name: def.name,
    description: def.description,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(
        params.map((param) => [param.name, { type: param.type, description: param.description }]),
      ),
      required: params.map((param) => param.name),
    },
  };
}

const PARAM_VALUE_SCHEMAS: Record<ToolParam["type"], z.ZodType> = {
  string: z.string(),
  number: z.number(),
  boolean: z.boolean(),
  object: z.record(z.string(), z.unknown()),
  array: z.array(z.unknown()),
};

/**
 * The Zod schema a model's input for this tool must satisfy before its
 * script runs — mirrors {@link customToolToAnthropic}: every sent
 * parameter required, with its declared JSON type.
 */
export function customToolInputSchema(def: CustomToolDef): z.ZodType<Record<string, unknown>> {
  return z.looseObject(
    Object.fromEntries(
      sentParams(def).map((param) => [param.name, PARAM_VALUE_SCHEMAS[param.type]]),
    ),
  );
}

// ── Sandboxed execution ─────────────────────────────

/** How long a custom tool script may run before its worker is terminated. */
const SCRIPT_TIMEOUT_MS = 10_000;

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
  const { promise, resolve } = Promise.withResolvers<SwarmToolResult>();

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
    finish(
      e.data.ok
        ? { success: true, data: e.data.result }
        : { success: false, error: e.data.error ?? "Unknown Error" },
    );
  };

  worker.onerror = (e: ErrorEvent) => {
    finish({ success: false, error: e.message || `Tool "${def.name}" Failed To Start` });
  };

  worker.postMessage(input);
  return promise;
}
