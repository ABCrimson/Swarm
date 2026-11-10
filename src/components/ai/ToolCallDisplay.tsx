import { useState } from "react";
import { Pill } from "#components/ui/Pill";
import { escapeForDisplay } from "#lib/display-escape";
import { HighlightedJson } from "./HighlightedJson.tsx";

// ── Types ───────────────────────────────────────────

type ToolStatus = "executing" | "complete" | "error";

interface ToolCallDisplayProps {
  /** Tool name (e.g., "spawn_worker"). */
  readonly name: string;
  /** Tool input as a record. */
  readonly input: Record<string, unknown>;
  /** Tool result, once the call has run. */
  readonly result?: string;
  /** Current execution status. */
  readonly status: ToolStatus;
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  executing: "Executing",
  complete: "Complete",
  error: "Error",
};

// ── Styles (utilities; literals with no token wait for the Q-9 design direction) ──

const CONTAINER =
  "my-1.5 overflow-hidden rounded-md border border-border bg-[oklch(0.10_0.02_220/0.8)]";

const HEADER =
  "flex w-full cursor-pointer items-center gap-2 border-none px-3 py-2 text-left text-inherit select-none [font-family:inherit] [font-size:inherit]";

/** Per-tool accent classes for the built-in tools; custom tools get the neutral default. */
const TOOL_BADGE_CLASSES: Record<string, string> = {
  spawn_worker: "bg-[oklch(0.18_0.06_205/0.4)] text-plasma border-[oklch(0.35_0.10_205)]",
  kill_worker: "bg-[oklch(0.18_0.06_10/0.4)] text-rose border-[oklch(0.35_0.10_10)]",
  run_command: "bg-[oklch(0.18_0.06_70/0.4)] text-amber border-[oklch(0.35_0.10_70)]",
  read_file: "bg-[oklch(0.18_0.06_140/0.4)] text-lime border-[oklch(0.35_0.10_140)]",
  write_file:
    "bg-[oklch(0.18_0.06_290/0.4)] text-[oklch(0.72_0.20_290)] border-[oklch(0.35_0.10_290)]",
  get_metrics:
    "bg-[oklch(0.18_0.06_170/0.4)] text-[oklch(0.78_0.18_170)] border-[oklch(0.35_0.10_170)]",
};

const DEFAULT_BADGE_CLASSES =
  "bg-[oklch(0.18_0.04_220/0.4)] text-[oklch(0.65_0.06_220)] border-[oklch(0.30_0.05_220)]";

const JSON_BOX =
  "border-t border-[oklch(0.18_0.03_220)] bg-surface-0 px-3.5 py-2.5 text-[12px] leading-[1.6]";

const SECTION_LABEL =
  "block bg-surface-0 px-3.5 pt-1.5 pb-0.5 font-display text-(length:--text-md) font-semibold tracking-[-0.01em] text-fg-dim";

const EXPAND_BUTTON =
  "block w-full cursor-pointer border-0 border-t border-[oklch(0.18_0.03_220)] bg-surface-0 px-3.5 py-1 text-center text-[11px] text-[oklch(0.65_0.10_205)]";

// ── Status Indicator ────────────────────────────────

function StatusGlyph({ status }: { readonly status: ToolStatus }): React.ReactElement {
  switch (status) {
    case "executing":
      return (
        <span
          className="inline-block size-2 rounded-full bg-amber motion-safe:animate-[tool-pulse_1.5s_ease-in-out_infinite]"
          aria-hidden="true"
        />
      );
    case "complete":
      return (
        <span className="text-[16px] leading-none text-lime" aria-hidden="true">
          ✓
        </span>
      );
    case "error":
      return (
        <span className="text-[16px] leading-none text-rose" aria-hidden="true">
          ✗
        </span>
      );
  }
}

function StatusIndicator({ status }: { readonly status: ToolStatus }): React.ReactElement {
  return (
    <span aria-hidden="true" className="inline-grid size-4 shrink-0 place-items-center">
      <StatusGlyph status={status} />
    </span>
  );
}

// ── Collapsible Result Viewer ───────────────────────

/** Results longer than this start collapsed. */
const COLLAPSE_THRESHOLD = 500;

function parseJson(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function ResultViewer({ result }: { readonly result: string }): React.ReactElement {
  const [collapsed, setCollapsed] = useState(result.length > COLLAPSE_THRESHOLD);
  const parsed = parseJson(result);

  if (collapsed) {
    return (
      <div>
        <pre
          className={`${JSON_BOX} m-0 max-h-30 overflow-hidden font-mono wrap-anywhere whitespace-pre-wrap`}
        >
          {result.slice(0, 200)}…
        </pre>
        <button type="button" onClick={() => setCollapsed(false)} className={EXPAND_BUTTON}>
          Show Full Result
        </button>
      </div>
    );
  }

  return parsed.ok ? (
    <HighlightedJson data={parsed.value} className={JSON_BOX} />
  ) : (
    <pre className={`${JSON_BOX} m-0 font-mono wrap-anywhere whitespace-pre-wrap text-fg`}>
      {result}
    </pre>
  );
}

/**
 * The collapse is the details element's own `::details-content` box: a grid
 * whose single row runs 0fr to 1fr, with `content-visibility` transitioned
 * discretely so the closed content stays rendered until the row has shrunk.
 * WebKit has no `interpolate-size`, which is why this is not a height
 * transition. An engine without `::details-content` drops these rules and
 * the card opens and closes instantly.
 */
const DISCLOSURE =
  "details-content:grid details-content:grid-rows-[0fr] details-content:transition-[grid-template-rows,content-visibility] details-content:transition-discrete details-content:duration-200 details-content:ease-in-out open:details-content:grid-rows-[1fr] motion-reduce:details-content:transition-none";

// ── Component ───────────────────────────────────────

/**
 * Collapsible card for one tool call: a status indicator (reduced-motion
 * aware), the tool's name badge, and — expanded — its input and result
 * as highlighted JSON (long results start collapsed). The expand button's
 * accessible name carries the tool and its status.
 */
export function ToolCallDisplay({
  name,
  input,
  result,
  status,
}: ToolCallDisplayProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const badgeClasses = TOOL_BADGE_CLASSES[name] ?? DEFAULT_BADGE_CLASSES;

  return (
    <details open={expanded} className={`${CONTAINER} ${DISCLOSURE}`}>
      {/* biome-ignore lint/a11y/useSemanticElements: a summary is the details element's own disclosure control; the explicit role names it a button for assistive tech, as the card did before. */}
      <summary
        role="button"
        className={`${HEADER} list-none transition-[background-color] duration-150 ease-(--ease-out) [&::-webkit-details-marker]:hidden ${expanded ? "bg-[oklch(0.12_0.03_220/0.5)]" : "bg-transparent"}`}
        onClick={(event) => {
          // The attribute follows React state, not the browser's own toggle.
          event.preventDefault();
          setExpanded(!expanded);
        }}
        aria-expanded={expanded}
        aria-label={`Tool Call: ${escapeForDisplay(name)}, ${STATUS_LABEL[status]}`}
      >
        <StatusIndicator status={status} />
        <Pill tone="neutral" size="sm" className={`font-mono ${badgeClasses}`}>
          {escapeForDisplay(name)}
        </Pill>
        <span className="ml-auto text-[14px] text-[oklch(0.55_0.03_220)]" aria-hidden="true">
          {expanded ? "▴" : "▾"}
        </span>
      </summary>

      <div className="min-h-0 overflow-hidden">
        <span className={SECTION_LABEL}>Input</span>
        <HighlightedJson data={input} className={JSON_BOX} />
        {result !== undefined && (
          <>
            <span className={SECTION_LABEL}>Result</span>
            <ResultViewer result={result} />
          </>
        )}
      </div>
    </details>
  );
}
