// The Rust ↔ TypeScript agent-event contract, checked against the Rust
// source itself: every payload struct's serde field names (rename_all
// camelCase, read from the source) must equal its Zod schema's keys, with
// Rust `Option<…>` fields accepting both undefined and null on this side
// and every other field (bar `serde_json::Value`) required, and every
// closed enum's snake_case variants (rename_all read from the source)
// must equal its Zod enum's options.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type * as z from "zod";
import {
  AgentBlockPayloadSchema,
  AgentPermissionRequestPayloadSchema,
  AgentSessionExitedPayloadSchema,
  AgentSessionStartedPayloadSchema,
  AgentToolCallPayloadSchema,
  AgentToolResultPayloadSchema,
  AgentTurnDeltaPayloadSchema,
  AgentTurnSettledPayloadSchema,
  AgentTurnStatusSchema,
  CancelGranularitySchema,
  CapabilitiesSchema,
  PermissionDecisionSchema,
  ProbeReportSchema,
  ProviderIdSchema,
  TrustTierSchema,
} from "#lib/agent-events";

/** A Rust core source file, resolved from the repository root vitest runs in. */
function source(path: string): string {
  return readFileSync(join(process.cwd(), "crates/swarm-core/src", path), "utf8");
}

/** The body of `pub <kind> <name> { … }` — doc comments and attributes stripped. */
function body(src: string, kind: "struct" | "enum", name: string): string[] {
  const start = src.search(new RegExp(String.raw`pub ${kind} ${name} \{`));
  if (start === -1) throw new Error(`pub ${kind} ${name} not found`);
  const open = src.indexOf("{", start);
  const close = src.indexOf("\n}", open);
  return src
    .slice(open + 1, close)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("#["));
}

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const snake = (pascal: string) => pascal.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();

/** The `rename_all` rule of the `#[serde(…)]` attribute directly above `pub <kind> <name> {`. */
function renameAll(src: string, kind: "struct" | "enum", name: string): string | undefined {
  return new RegExp(
    String.raw`#\[serde\([^)\n]*\brename_all = "([^"]+)"[^)\n]*\)\]\s*pub ${kind} ${name} \{`,
  ).exec(src)?.[1];
}

/** Each serde field name (camelCase) mapped to its Rust type. */
function structFields(src: string, name: string): Map<string, string> {
  return new Map(
    body(src, "struct", name).flatMap((line) => {
      const match = /^pub (\w+): (.+),$/.exec(line);
      return match?.[1] && match[2] ? [[camel(match[1]), match[2]]] : [];
    }),
  );
}

function enumVariants(src: string, name: string): string[] {
  return body(src, "enum", name).flatMap((line) => {
    const match = /^([A-Z]\w*),$/.exec(line);
    return match?.[1] ? [snake(match[1])] : [];
  });
}

const emitter = source("events/emitter.rs");
const adapter = source("agent/adapter.rs");

const STRUCTS: readonly [string, string, z.ZodObject][] = [
  [emitter, "AgentSessionStartedPayload", AgentSessionStartedPayloadSchema],
  [emitter, "AgentTurnDeltaPayload", AgentTurnDeltaPayloadSchema],
  [emitter, "AgentBlockPayload", AgentBlockPayloadSchema],
  [emitter, "AgentToolCallPayload", AgentToolCallPayloadSchema],
  [emitter, "AgentToolResultPayload", AgentToolResultPayloadSchema],
  [emitter, "AgentPermissionRequestPayload", AgentPermissionRequestPayloadSchema],
  [emitter, "AgentTurnSettledPayload", AgentTurnSettledPayloadSchema],
  [emitter, "AgentSessionExitedPayload", AgentSessionExitedPayloadSchema],
  [adapter, "Capabilities", CapabilitiesSchema],
  [adapter, "ProbeReport", ProbeReportSchema],
];

const ENUMS: readonly [string, string, z.ZodEnum][] = [
  [adapter, "ProviderId", ProviderIdSchema],
  [adapter, "CancelGranularity", CancelGranularitySchema],
  [adapter, "PermissionDecision", PermissionDecisionSchema],
  [adapter, "AgentTurnStatus", AgentTurnStatusSchema],
  [source("agent/claude_code.rs"), "ClaudeCodeTrustTier", TrustTierSchema],
  [source("agent/codex/tier.rs"), "CodexTrustTier", TrustTierSchema],
];

describe("agent event contract (Rust source ↔ Zod)", () => {
  it.each(STRUCTS)("%#: %s fields match", (src, name, schema) => {
    expect(renameAll(src, "struct", name), `${name} rename_all`).toBe("camelCase");
    const fields = structFields(src, name);
    expect([...fields.keys()].toSorted()).toEqual(Object.keys(schema.shape).toSorted());
    for (const [field, type] of fields) {
      const accepts = (value: unknown) => schema.shape[field]?.safeParse(value).success;
      if (type.startsWith("Option<")) {
        // Without `skip_serializing_if`, serde writes `None` as `null`.
        expect(accepts(undefined), `${field} undefined`).toBe(true);
        expect(accepts(null), `${field} null`).toBe(true);
      } else if (type !== "serde_json::Value") {
        // A `serde_json::Value` is any JSON, mirrored as `z.unknown()`.
        expect(accepts(undefined), `${field} required`).toBe(false);
      }
    }
  });

  it.each(ENUMS)("%#: %s variants match", (src, name, schema) => {
    expect(renameAll(src, "enum", name), `${name} rename_all`).toBe("snake_case");
    expect(enumVariants(src, name)).toEqual(schema.options);
  });
});
