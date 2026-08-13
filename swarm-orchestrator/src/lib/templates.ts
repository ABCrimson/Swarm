import { load } from "@tauri-apps/plugin-store";

import { createSession as createSessionIpc } from "#lib/tauri";
import { spawnWorkerFromSpec } from "#lib/worker-spawn";
import { useSessionStore } from "#store/sessions";
import type { Session, SessionTemplate, WorkerSpawnSpec } from "#store/types";

/** plugin-store key for user templates. */
const USER_TEMPLATES_KEY = "swarm:templates";

/**
 * Built-in session templates shipped with the application.
 *
 * Includes presets for single-agent, multi-agent parallel,
 * supervisor-worker hierarchy, and sequential pipeline patterns.
 */
export const BUILT_IN_TEMPLATES: readonly SessionTemplate[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Single Agent",
    description:
      "A Single Autonomous Agent For Focused Tasks. Ideal For Simple Queries Or Standalone Operations.",
    workerConfigs: [
      {
        name: "Agent",
        role: "general",
        model: "sonnet",
        systemPrompt: "You are a helpful AI assistant.",
      },
    ],
    builtIn: true,
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Multi-Agent Parallel",
    description:
      "Multiple Agents Working Independently In Parallel. Great For Batch Processing Or Diverse Task Sets.",
    workerConfigs: [
      {
        name: "Agent Alpha",
        role: "analyst",
        model: "sonnet",
        systemPrompt: "You are an analytical agent focused on data analysis and research.",
      },
      {
        name: "Agent Beta",
        role: "coder",
        model: "sonnet",
        systemPrompt: "You are a coding agent focused on implementation and debugging.",
      },
      {
        name: "Agent Gamma",
        role: "reviewer",
        model: "sonnet",
        systemPrompt: "You are a review agent focused on quality assurance and testing.",
      },
    ],
    builtIn: true,
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    name: "Supervisor + Workers",
    description:
      "A Supervisor Agent Coordinates Task Distribution Across Worker Agents. Best For Complex Multi-Step Workflows.",
    workerConfigs: [
      {
        name: "Supervisor",
        role: "supervisor",
        model: "opus",
        systemPrompt:
          "You are a supervisor agent. Coordinate and delegate tasks to worker agents. Synthesize their outputs into cohesive results.",
      },
      {
        name: "Worker 1",
        role: "worker",
        model: "sonnet",
        systemPrompt:
          "You are a worker agent. Execute tasks assigned by the supervisor efficiently and accurately.",
      },
      {
        name: "Worker 2",
        role: "worker",
        model: "sonnet",
        systemPrompt:
          "You are a worker agent. Execute tasks assigned by the supervisor efficiently and accurately.",
      },
    ],
    builtIn: true,
  },
  {
    id: "00000000-0000-0000-0000-000000000004",
    name: "Pipeline",
    description:
      "Sequential Processing Pipeline Where Each Agent's Output Feeds Into The Next. Ideal For Staged Transformations.",
    workerConfigs: [
      {
        name: "Stage 1: Input",
        role: "input",
        model: "haiku",
        systemPrompt:
          "You are the first stage of a processing pipeline. Parse and structure incoming data for downstream processing.",
      },
      {
        name: "Stage 2: Process",
        role: "processor",
        model: "sonnet",
        systemPrompt:
          "You are the processing stage. Transform and enrich the structured data from Stage 1.",
      },
      {
        name: "Stage 3: Output",
        role: "output",
        model: "sonnet",
        systemPrompt:
          "You are the final stage. Format and present the processed results in a clear, actionable format.",
      },
    ],
    builtIn: true,
  },
] as const;

/**
 * Get the plugin-store instance for templates.
 */
async function getTemplateStore() {
  return load("swarm-templates.json", { defaults: {}, autoSave: true });
}

/**
 * Load user-created templates from plugin-store.
 */
export async function loadUserTemplates(): Promise<SessionTemplate[]> {
  const store = await getTemplateStore();
  const templates = await store.get<SessionTemplate[]>(USER_TEMPLATES_KEY);
  return templates ?? [];
}

/**
 * Save a user template to plugin-store.
 */
export async function saveUserTemplate(template: SessionTemplate): Promise<void> {
  const store = await getTemplateStore();
  const existing = await store.get<SessionTemplate[]>(USER_TEMPLATES_KEY);
  const templates = existing ?? [];
  templates.push(template);
  await store.set(USER_TEMPLATES_KEY, templates);
}

/**
 * Delete a user template from plugin-store.
 */
export async function deleteUserTemplate(templateId: string): Promise<void> {
  const store = await getTemplateStore();
  const existing = await store.get<SessionTemplate[]>(USER_TEMPLATES_KEY);
  if (!existing) return;
  const filtered = existing.filter((t) => t.id !== templateId);
  await store.set(USER_TEMPLATES_KEY, filtered);
}

/**
 * Create a template from a session's current configuration.
 */
export function createTemplateFromSession(
  name: string,
  description: string,
  workerConfigs: WorkerSpawnSpec[],
): SessionTemplate {
  return {
    id: crypto.randomUUID(),
    name,
    description,
    workerConfigs,
    builtIn: false,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Get all templates: built-in + user-created.
 */
export async function getAllTemplates(): Promise<SessionTemplate[]> {
  const userTemplates = await loadUserTemplates();
  return [...BUILT_IN_TEMPLATES, ...userTemplates];
}

/**
 * Applies a session template: creates a new session named after the
 * template, then spawns one worker per `workerConfigs` entry into that
 * session (see `spawnWorkerFromSpec`, `#lib/worker-spawn`) — process
 * options go to Rust, agent metadata (role/model/systemPrompt) is
 * stored client-side and each worker is registered against the new
 * session via `session_add_worker`. This is what makes a template's
 * agent configuration real instead of decorative.
 *
 * A worker whose spawn fails is skipped (logged, not thrown) so the
 * rest of the template still applies.
 *
 * @returns The created session and the worker IDs that spawned
 * successfully, in template order.
 */
export async function applyTemplate(
  template: SessionTemplate,
): Promise<{ readonly session: Session; readonly workerIds: string[] }> {
  const session = await createSessionIpc(template.name);
  useSessionStore.getState().addSession(session);

  const workerIds: string[] = [];
  for (const spec of template.workerConfigs) {
    try {
      workerIds.push(await spawnWorkerFromSpec(spec, session.id));
    } catch (err) {
      console.error(
        `applyTemplate: failed to spawn worker "${spec.name}" from template "${template.name}"`,
        err,
      );
    }
  }

  return { session, workerIds };
}
