/**
 * Session templates: the built-in presets, user templates persisted in
 * plugin-store (`swarm-templates.json`, key `swarm:templates`), building
 * a template from a live session, and applying a template (one new
 * session plus one spawned worker per `workerConfigs` entry).
 *
 * A template is a list of worker spawn specs and nothing more: applying
 * one spawns independent workers, each with its own role, model and
 * system prompt. Nothing routes work between them, so the built-in
 * descriptions only promise what applying actually does.
 *
 * @module templates
 */

import type { LazyStore } from "@tauri-apps/plugin-store";
import { errorMessage } from "#lib/is-error";
import { templatesStore } from "#lib/lazy-store";
import { createSession as createSessionIpc } from "#lib/tauri";
import { spawnWorkerFromSpec } from "#lib/worker-spawn";
import { useSessionStore } from "#store/sessions";
import type { Session, SessionTemplate, WorkerSpawnSpec } from "#store/types";
import { SessionTemplateSchema } from "#store/types";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

/** plugin-store key for user templates. */
const USER_TEMPLATES_KEY = "swarm:templates";

/**
 * Built-in session templates shipped with the application: a single
 * agent, three parallel specialists, a supervisor with two workers, and
 * a three-stage pipeline.
 */
export const BUILT_IN_TEMPLATES: readonly SessionTemplate[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Single Agent",
    description:
      "Spawns One General-Purpose Agent. Ideal For Simple Queries Or Standalone Operations.",
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
      "Spawns An Analyst, A Coder And A Reviewer That Work Independently. Great For Batch Processing Or Diverse Task Sets.",
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
      "Spawns A Supervisor Agent (Opus) And Two Worker Agents (Sonnet), Each Prompted For Its Role. Agents Run Independently — You Hand Work Between Them.",
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
      "Spawns Input, Process And Output Stage Agents, Each Prompted For Its Stage. Agents Run Independently — You Pass Each Stage's Output To The Next.",
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
];

/** The persisted list exactly as stored (anything but an array reads as empty). */
async function readStoredEntries(store: LazyStore): Promise<unknown[]> {
  const stored = await store.get<unknown>(USER_TEMPLATES_KEY);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Loads user-created templates from plugin-store. Entries that no longer
 * validate against `SessionTemplateSchema` (hand-edited, or saved by a
 * different build) are skipped instead of reaching the UI half-shaped;
 * they stay in the store untouched.
 */
export async function loadUserTemplates(): Promise<SessionTemplate[]> {
  const entries = await readStoredEntries(templatesStore);
  return entries.flatMap((entry) => {
    const parsed = SessionTemplateSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** What `userTemplatesResource` resolves to — it never rejects. */
export interface UserTemplatesResult {
  readonly templates: readonly SessionTemplate[];
  /** `true` when the store could not be read; `templates` is then empty. */
  readonly failed: boolean;
}

/** The in-flight or settled user-template read `userTemplatesResource` hands out, until a write invalidates it. */
let userTemplatesCache: Promise<UserTemplatesResult> | null = null;

/** Who to tell when the cached read is dropped (see `subscribeUserTemplates`). */
const invalidationListeners = new Set<() => void>();

/**
 * The user templates as one cached promise, for a render-time `use()`
 * (`TemplateSelector`). Every call returns the same promise until
 * `saveUserTemplate` (or `invalidateUserTemplates`)
 * drops it, so re-rendering or re-mounting never refetches, while the
 * first read after a write sees that write. A store failure resolves to
 * `{ failed: true }` instead of rejecting, so the UI can say so in place
 * rather than hand the error to an error boundary.
 *
 * Doubles as the `getSnapshot` of a `useSyncExternalStore` over
 * `subscribeUserTemplates`: the snapshot is the promise itself, stable
 * until a write replaces it.
 */
export function userTemplatesResource(): Promise<UserTemplatesResult> {
  userTemplatesCache ??= loadUserTemplates().then(
    (templates) => ({ templates, failed: false }),
    (err: unknown) => {
      console.error("userTemplatesResource: could not read the template store", err);
      return { templates: [], failed: true };
    },
  );
  return userTemplatesCache;
}

/**
 * Registers `listener` to run whenever the cached read is dropped, so a
 * component that stays mounted (e.g. inside a hidden `<Activity>`) can
 * read the store again after a write.
 *
 * @returns The unsubscribe function.
 */
export function subscribeUserTemplates(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

/** Drops the cached `userTemplatesResource` read so the next call reads the store again, and tells subscribers. */
export function invalidateUserTemplates(): void {
  userTemplatesCache = null;
  for (const listener of invalidationListeners) listener();
}

/** Tail of the serialized template-store writes (see `serializeWrite`). */
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `write` after every earlier template write has finished. Each
 * write is a read-modify-write of one array, so two overlapping writes
 * (a double-clicked Save) would otherwise both
 * read the old list and the second would drop the first's change.
 */
function serializeWrite(write: () => Promise<void>): Promise<void> {
  const run = writeQueue.then(write, write);
  writeQueue = run.catch(() => {});
  return run.finally(invalidateUserTemplates);
}

/** Appends a user template to plugin-store. */
export function saveUserTemplate(template: SessionTemplate): Promise<void> {
  return serializeWrite(async () => {
    const store = templatesStore;
    await store.set(USER_TEMPLATES_KEY, [...(await readStoredEntries(store)), template]);
  });
}

/**
 * Rebuilds spawn specs for the workers a session references: each
 * worker's name from the live worker store plus its role/model/system
 * prompt from the agent-metadata store. Workers known to neither store
 * (killed before this run, or never spawned here) are skipped: nothing
 * about them is left to reproduce. Process options the frontend never
 * learns (`cwd`, `repoRoot`, …) are omitted; `spawnWorkerFromSpec` falls
 * back to the persisted default project root when the template is
 * applied.
 */
export function workerSpecsForSession(session: Session): WorkerSpawnSpec[] {
  const { workers } = useWorkerStore.getState();
  const { metadata } = useWorkerAgentStore.getState();
  return session.workerIds.flatMap((workerId, index) => {
    const worker = workers.get(workerId);
    const agent = metadata.get(workerId);
    if (worker == null && agent == null) return [];
    return [{ name: worker?.name ?? `Worker ${index + 1}`, ...agent }];
  });
}

/**
 * Creates a template from a session's workers (see
 * `workerSpecsForSession`). `workerConfigs` is empty when none of the
 * session's workers can be reproduced; callers should refuse to save
 * that, since applying it would spawn nothing.
 */
export function createTemplateFromSession(
  session: Session,
  details: { readonly name: string; readonly description: string },
): SessionTemplate {
  return {
    id: crypto.randomUUID(),
    name: details.name,
    description: details.description,
    workerConfigs: workerSpecsForSession(session),
    builtIn: false,
    createdAt: new Date().toISOString(),
  };
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
 * Adds the created session to `useSessionStore` itself (safe because
 * `createSession`, `#lib/tauri`, returns a validated, normalized
 * `Session`) — Rust also emits `session_created` as part of
 * `create_session`, which `useSessionEvents` (mounted at the app root)
 * writes independently from this same call. Those two writes race in
 * either order; `useSessionEvents`' handler merges into whatever's
 * already in the store instead of replacing it, so neither write can
 * clobber `workerIds` the other has already grown — see the comment
 * there for the full ordering analysis.
 *
 * A worker whose spawn fails (thrown error) or degrades to `null` (no
 * Tauri IPC bridge — see `spawnWorkerFromSpec`) is skipped, logged, recorded
 * in `failures` as "<worker name>: <reason>", and does not stop the rest of
 * the template from applying. Callers should compare the returned
 * `workerIds.length` against `template.workerConfigs.length` to detect a
 * partial or total failure and report it, with `failures`, honestly instead
 * of always toasting success.
 *
 * @returns The created session, the worker IDs that spawned successfully (in
 * template order), and `failures`, one entry per worker that did not.
 */
export async function applyTemplate(template: SessionTemplate): Promise<{
  readonly session: Session;
  readonly workerIds: string[];
  readonly failures: string[];
}> {
  const session = await createSessionIpc(template.name);
  useSessionStore.getState().addSession(session);

  const workerIds: string[] = [];
  const failures: string[] = [];
  for (const spec of template.workerConfigs) {
    try {
      const workerId = await spawnWorkerFromSpec(spec, session.id);
      if (workerId === null) {
        console.error(
          `applyTemplate: spawnWorkerFromSpec returned null for worker "${spec.name}" from template "${template.name}" (no Tauri IPC bridge)`,
        );
        failures.push(`${spec.name}: No Tauri IPC Bridge`);
        continue;
      }
      workerIds.push(workerId);
    } catch (err) {
      console.error(
        `applyTemplate: failed to spawn worker "${spec.name}" from template "${template.name}"`,
        err,
      );
      failures.push(`${spec.name}: ${errorMessage(err)}`);
    }
  }

  return { session, workerIds, failures };
}
