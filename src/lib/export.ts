/**
 * Session export formats (Markdown, JSON, metrics CSV), the JSON import
 * parser, and the dialog-driven file round-trip both directions use.
 *
 * One JSON format is written — `exportAsJSON`'s `{ session, workers,
 * exportedAt }` wrapper — and `parseSessionExport` reads it back. It
 * also accepts a bare `Session` object, the legacy context-menu export
 * shape, so session files saved in that shape keep importing.
 *
 * File I/O goes through a native dialog, never a hand-built path:
 * `@tauri-apps/plugin-dialog` grants the fs scope for exactly the file
 * the user picked (`allow_file` on that one path), so `saveToFile` /
 * `readFromFile` read or write that path directly, in place. The app has
 * no static fs scope and no rename grant, so a `.tmp` sibling plus rename
 * would be refused as a forbidden path. A transport without workspace
 * browsing (the `pnpm build:web` page) has no such dialogs, so both
 * functions reject there instead of failing inside the plugin.
 *
 * @module export
 */

import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import * as z from "zod";
import { hasCapability } from "#lib/tauri";
import { formatClock, formatDateTime } from "#lib/time";
import { useMessageHistoryStore } from "#store/message-history";
import type { MetricPoint, Session } from "#store/types";
import { SessionSchema } from "#store/types";
import { useWorkerStore } from "#store/workers";

/**
 * Export a session as formatted Markdown: metadata, configuration, and
 * every worker's state plus its chat transcript (tool calls included).
 */
export function exportAsMarkdown(session: Session): string {
  const workers = useWorkerStore.getState().workers;
  const messageHistory = useMessageHistoryStore.getState();

  const lines = [
    `# Session: ${session.name}`,
    "",
    `- **ID:** \`${session.id}\``,
    `- **Created:** ${formatDateTime(Temporal.Instant.from(session.createdAt))}`,
    `- **Updated:** ${formatDateTime(Temporal.Instant.from(session.updatedAt))}`,
    `- **Workers:** ${session.workerIds.length}`,
  ];

  if (session.metadata?.description) {
    lines.push(`- **Description:** ${session.metadata.description}`);
  }
  if (session.metadata?.tags?.length) {
    lines.push(`- **Tags:** ${session.metadata.tags.join(", ")}`);
  }
  lines.push("");

  if (session.config && Object.keys(session.config).length > 0) {
    lines.push(
      "## Configuration",
      "",
      "```json",
      JSON.stringify(session.config, null, 2),
      "```",
      "",
    );
  }

  lines.push("## Workers", "");

  for (const workerId of session.workerIds) {
    const worker = workers.get(workerId);
    if (!worker) {
      lines.push(`### Worker ${workerId.slice(0, 8)}`, "", "*Worker Data Not Available*", "");
      continue;
    }

    lines.push(
      `### ${worker.name ?? workerId.slice(0, 8)}`,
      "",
      `- **ID:** \`${worker.id}\``,
      `- **State:** ${worker.state}`,
      `- **Started:** ${formatDateTime(Temporal.Instant.from(worker.startedAt))}`,
      "",
    );

    const messages = messageHistory.getMessages(workerId);
    if (messages.length === 0) continue;

    lines.push("#### Messages", "");
    for (const msg of messages) {
      const timestamp = formatClock(Temporal.Instant.from(msg.timestamp));
      const roleLabel = msg.role === "user" ? "User" : "Assistant";
      lines.push(`**[${timestamp}] ${roleLabel}:**`, "", msg.content, "");

      if (msg.toolCalls?.length) {
        lines.push("**Tool Calls:**");
        for (const tc of msg.toolCalls) {
          lines.push(`- \`${tc.name}\`: ${JSON.stringify(tc.input)}`);
          if (tc.result) lines.push(`  Result: ${tc.result}`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

/**
 * Export a session as formatted JSON: `{ session, workers, exportedAt }`,
 * where `workers` maps each of the session's worker ids to its live store
 * record (`null` once the worker is gone) and chat transcript.
 * `parseSessionExport` reads this format back.
 */
export function exportAsJSON(session: Session): string {
  const workers = useWorkerStore.getState().workers;
  const messageHistory = useMessageHistoryStore.getState();

  const workerData = Object.fromEntries(
    session.workerIds.map((workerId) => [
      workerId,
      { worker: workers.get(workerId) ?? null, messages: messageHistory.getMessages(workerId) },
    ]),
  );

  return JSON.stringify(
    { session, workers: workerData, exportedAt: new Date().toISOString() },
    null,
    2,
  );
}

/**
 * Either JSON shape a session file can have: the `exportAsJSON` wrapper
 * (only its `session` is read; `workers`/`exportedAt` describe another
 * run's processes and are ignored) or a bare `Session`.
 */
const SessionFileSchema = z.union([
  z.object({ session: SessionSchema }).transform((file) => file.session),
  SessionSchema,
]);

/**
 * Parses the text of a session JSON file (see `SessionFileSchema`).
 *
 * @returns The validated session, or `null` when the text is not JSON or
 * matches neither shape.
 */
export function parseSessionExport(text: string): Session | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = SessionFileSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Export metrics history as CSV: a `time,cpu,memory,workerCount` header plus one row per point. */
export function exportMetricsCSV(metrics: readonly MetricPoint[]): string {
  return [
    "time,cpu,memory,workerCount",
    ...metrics.map((point) => `${point.time},${point.cpu},${point.memory},${point.workerCount}`),
  ].join("\n");
}

/** Filename-hostile characters on Windows, macOS or Linux, plus control characters. */
const RESERVED_FILENAME_CHARS = /[<>:"/\\|?*\p{Cc}]/gu;

/** Windows device names, which are reserved as a filename stem whatever the extension. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)$/;

/**
 * A default filename stem for a session: lowercased, whitespace runs
 * collapsed to `-`, characters no desktop OS accepts in a filename
 * removed, and leading/trailing dots or dashes trimmed (Windows drops a
 * trailing dot silently). Falls back to `"session"` when nothing
 * printable is left, and prefixes a Windows device name (`con`, `nul`,
 * `com1`, …) so the default never names a device.
 */
export function sessionFileSlug(name: string): string {
  const slug = name
    .replaceAll(RESERVED_FILENAME_CHARS, "")
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/g, "-")
    .replaceAll(/^[.-]+|[.-]+$/g, "");
  if (slug === "") return "session";
  return WINDOWS_DEVICE_NAME.test(slug) ? `session-${slug}` : slug;
}

/** Rejects the file round-trip on a transport without the dialog and fs plugins. */
function requireFileDialogs(): void {
  if (!hasCapability("workspaceBrowsing")) throw new Error("File Dialogs Need The Desktop App");
}

/**
 * Asks for a destination with the native save dialog and writes
 * `content` to exactly that path (see the module doc for why the write is
 * direct).
 *
 * @returns The chosen path, or `null` when the dialog was cancelled.
 * @throws When the transport has no native file dialogs.
 */
export async function saveToFile(
  content: string,
  defaultName: string,
  filterName: string,
  extension: string,
): Promise<string | null> {
  requireFileDialogs();
  const filePath = await save({
    title: `Export As ${filterName}`,
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: [extension] }],
  });
  if (filePath == null) return null;

  await writeTextFile(filePath, content);
  return filePath;
}

/**
 * Asks for one file with the native open dialog and reads it as text.
 *
 * @returns The file's contents, or `null` when the dialog was cancelled.
 * @throws When the transport has no native file dialogs.
 */
export async function readFromFile(
  title: string,
  filterName: string,
  extension: string,
): Promise<string | null> {
  requireFileDialogs();
  const filePath = await open({
    title,
    multiple: false,
    directory: false,
    filters: [{ name: filterName, extensions: [extension] }],
  });
  if (filePath == null) return null;

  return readTextFile(filePath);
}
