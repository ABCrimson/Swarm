import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { format } from "date-fns";
import { useMessageHistoryStore } from "#store/message-history";
import type { MetricPoint, Session } from "#store/types";
import { useWorkerStore } from "#store/workers";

/**
 * Export a session as formatted Markdown.
 */
export function exportAsMarkdown(session: Session): string {
  const workers = useWorkerStore.getState().workers;
  const messageHistory = useMessageHistoryStore.getState();

  const lines: string[] = [];

  lines.push(`# Session: ${session.name}`);
  lines.push("");
  lines.push(`- **ID:** \`${session.id}\``);
  lines.push(`- **Created:** ${format(new Date(session.createdAt), "PPpp")}`);
  lines.push(`- **Updated:** ${format(new Date(session.updatedAt), "PPpp")}`);
  lines.push(`- **Workers:** ${session.workerIds.length}`);

  if (session.metadata?.description) {
    lines.push(`- **Description:** ${session.metadata.description}`);
  }

  if (session.metadata?.tags && session.metadata.tags.length > 0) {
    lines.push(`- **Tags:** ${session.metadata.tags.join(", ")}`);
  }

  lines.push("");

  if (session.config && Object.keys(session.config).length > 0) {
    lines.push("## Configuration");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(session.config, null, 2));
    lines.push("```");
    lines.push("");
  }

  // Worker details
  lines.push("## Workers");
  lines.push("");

  for (const workerId of session.workerIds) {
    const worker = workers.get(workerId);
    if (worker) {
      lines.push(`### ${worker.name ?? workerId.slice(0, 8)}`);
      lines.push("");
      lines.push(`- **ID:** \`${worker.id}\``);
      lines.push(`- **State:** ${worker.state}`);
      lines.push(`- **Started:** ${format(new Date(worker.startedAt), "PPpp")}`);
      lines.push("");

      // Messages for this worker
      const messages = messageHistory.getMessages(workerId);
      if (messages.length > 0) {
        lines.push("#### Messages");
        lines.push("");

        for (const msg of messages) {
          const timestamp = format(new Date(msg.timestamp), "HH:mm:ss");
          const roleLabel = msg.role === "user" ? "User" : "Assistant";
          lines.push(`**[${timestamp}] ${roleLabel}:**`);
          lines.push("");
          lines.push(msg.content);
          lines.push("");

          if (msg.toolCalls && msg.toolCalls.length > 0) {
            lines.push("**Tool calls:**");
            for (const tc of msg.toolCalls) {
              lines.push(`- \`${tc.name}\`: ${JSON.stringify(tc.input)}`);
              if (tc.result) {
                lines.push(`  Result: ${tc.result}`);
              }
            }
            lines.push("");
          }
        }
      }
    } else {
      lines.push(`### Worker ${workerId.slice(0, 8)}`);
      lines.push("");
      lines.push("*Worker data not available*");
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Export a session as formatted JSON.
 */
export function exportAsJSON(session: Session): string {
  const workers = useWorkerStore.getState().workers;
  const messageHistory = useMessageHistoryStore.getState();

  const workerData: Record<string, unknown> = {};
  for (const workerId of session.workerIds) {
    const worker = workers.get(workerId);
    const messages = messageHistory.getMessages(workerId);
    workerData[workerId] = {
      worker: worker ?? null,
      messages,
    };
  }

  const exportData = {
    session,
    workers: workerData,
    exportedAt: new Date().toISOString(),
  };

  return JSON.stringify(exportData, null, 2);
}

/**
 * Export metrics data as CSV.
 */
export function exportMetricsCSV(metrics: MetricPoint[]): string {
  const lines: string[] = [];
  lines.push("time,cpu,memory,workerCount");

  for (const point of metrics) {
    lines.push(`${point.time},${point.cpu},${point.memory},${point.workerCount}`);
  }

  return lines.join("\n");
}

/**
 * Save content to a file using plugin-dialog file picker + plugin-fs writeTextFile.
 */
export async function saveToFile(
  content: string,
  defaultName: string,
  filterName: string,
  extension: string,
): Promise<string | null> {
  const filePath = await save({
    title: `Export As ${filterName}`,
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: [extension] }],
  });

  if (!filePath) return null;

  await writeTextFile(filePath, content);
  return filePath;
}
