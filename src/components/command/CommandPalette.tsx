import { type ExtractAtomValue, useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { computeFrecencyBonus } from "modern-cmdk";
import { Command } from "modern-cmdk/react";
import { useEffectEvent, useLayoutEffect, useState } from "react";
import { toast } from "sonner";

import { matchesBinding } from "#lib/keybindings";
import { createSnapshot } from "#lib/snapshots";
import { killWorker } from "#lib/tauri";
import { spawnWorkerFromSpec } from "#lib/worker-spawn";
import { type FrecencyEntry, frecencyAtom } from "#store/frecency";
import { useSessionStore } from "#store/sessions";
import {
  commandPaletteOpenAtom,
  currentPageAtom,
  graphViewAtom,
  keybindingsAtom,
  sidebarCollapsedAtom,
} from "#store/ui";
import { useWorkerAgentStore } from "#store/worker-agents";
import { useWorkerStore } from "#store/workers";

interface CommandDef {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly keywords: readonly string[];
  readonly action: () => void;
}

type FrecencyStorage = NonNullable<
  NonNullable<React.ComponentProps<typeof Command.Dialog>["frecency"]>["storage"]
>;
type FrecencyRecords = Awaited<ReturnType<FrecencyStorage["load"]>>["records"];
/** `modern-cmdk`'s branded item id — the `forceId` each item registers under. */
type ItemId = FrecencyRecords extends ReadonlyMap<infer K, unknown> ? K : never;

/** A persisted {@link FrecencyEntry} as the engine's record. */
function toRecord(entry: FrecencyEntry): { frequency: number; lastUsed: number } {
  return {
    frequency: entry.uses,
    lastUsed: Temporal.Instant.from(entry.lastUsed).epochMilliseconds,
  };
}

function errorText(err: unknown): string {
  return Error.isError(err) ? err.message : String(err);
}

/** The first `Worker N` no current worker is named — never reuses a live worker's name after a kill. */
function nextWorkerName(names: Iterable<string | undefined>): string {
  const taken = new Set(names);
  let n = 1;
  while (taken.has(`Worker ${n}`)) n++;
  return `Worker ${n}`;
}

/**
 * Global command palette (the remappable Command Palette binding,
 * Ctrl+K by default) built on `modern-cmdk`: navigation, worker spawn
 * (a real backend spawn under the first free `Worker N` name) and kill
 * (a real backend kill, confirmed from a toast first), the graph/list
 * view toggle and session snapshots.
 *
 * Ranking uses `modern-cmdk`'s own frecency engine, persisted through
 * {@link frecencyAtom}: a typed query is scored by the machine's
 * matcher plus each command's frecency bonus, and an empty query lists
 * commands by that same bonus. The engine records selections itself and
 * flushes them to storage when the dialog unmounts on close.
 *
 * The open/close shortcut is registered in a layout effect, so it is
 * live before the first paint — a Ctrl+K pressed the moment the window
 * appears is never lost. (The graph/list toggle shortcut belongs to the
 * Workers page, the only place it applies.)
 */
export function CommandPalette(): React.ReactElement {
  const store = useStore();
  const [open, setOpen] = useAtom(commandPaletteOpenAtom);
  const setPage = useSetAtom(currentPageAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const frecency = useAtomValue(frecencyAtom);
  const [graphView, setGraphView] = useAtom(graphViewAtom);
  const keybindings = useAtomValue(keybindingsAtom);
  const workers = useWorkerStore((s) => s.workers);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);

  const onKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (!matchesBinding(e, keybindings.commandPalette)) return;
    e.preventDefault();
    setOpen((prev) => !prev);
  });
  useLayoutEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const frecencyStorage: FrecencyStorage = {
    load: () => ({
      records: new Map(
        store
          .get(frecencyAtom)
          .entries()
          .map(([id, entry]) => [id as ItemId, toRecord(entry)]),
      ),
    }),
    save: (_namespace, data) => {
      store.set(
        frecencyAtom,
        new Map(
          data.records.entries().map(([id, record]) => [
            id,
            {
              uses: record.frequency,
              lastUsed: Temporal.Instant.fromEpochMilliseconds(record.lastUsed).toString(),
            },
          ]),
        ),
      );
    },
    [Symbol.dispose]() {},
  };

  const spawn = async () => {
    try {
      const id = await spawnWorkerFromSpec({
        name: nextWorkerName(workers.values().map((worker) => worker.name)),
      });
      if (id === null) toast.error("Spawning Workers Needs The Desktop App");
    } catch (err) {
      toast.error(`Spawn Failed: ${errorText(err)}`);
    }
  };

  const kill = async (id: string) => {
    try {
      await killWorker(id);
      useWorkerStore.getState().removeWorker(id);
      useWorkerAgentStore.getState().removeAgentMetadata(id);
    } catch (err) {
      toast.error(`Kill Failed: ${errorText(err)}`);
    }
  };

  // Killing is destructive and a palette selection is one keystroke, so
  // it only asks: the kill runs from the confirmation toast's action.
  const confirmKill = (id: string, name: string) => {
    toast.warning(`Kill ${name}?`, {
      id: `kill:${id}`,
      description: "This Stops Its Terminal Process",
      // Long enough to reach the action from the keyboard (Alt+T focuses toasts).
      duration: 10_000,
      action: { label: "Kill", onClick: () => void kill(id) },
      cancel: { label: "Keep", onClick: () => {} },
    });
  };

  const snapshot = async () => {
    const session = activeSessionId ? sessions.get(activeSessionId) : undefined;
    if (!session) {
      toast.error("No Active Session To Snapshot");
      return;
    }
    try {
      await createSnapshot(session);
      toast.success("Snapshot Created");
    } catch {
      toast.error("Failed To Create Snapshot");
    }
  };

  const navigate = (
    page: ExtractAtomValue<typeof currentPageAtom>,
    label: string,
    keywords: readonly string[],
  ): CommandDef => ({
    id: `nav:${page}`,
    label: `Go To ${label}`,
    group: "Navigation",
    keywords: ["navigate", ...keywords],
    action: () => setPage(page),
  });

  const commands: readonly CommandDef[] = [
    navigate("dashboard", "Dashboard", ["home"]),
    navigate("workers", "Workers", ["agents"]),
    navigate("sessions", "Sessions", ["history"]),
    navigate("metrics", "Metrics", ["performance", "stats"]),
    navigate("settings", "Settings", ["preferences", "config"]),
    // Tools/Logs/Workspace have no sidebar entry: the palette is their
    // only navigation path.
    navigate("tools", "Tools", ["custom", "builder"]),
    navigate("logs", "Logs", ["output", "console"]),
    navigate("workspace", "Workspace", ["files", "project"]),
    {
      id: "ui:toggle-sidebar",
      label: "Toggle Sidebar",
      group: "UI",
      keywords: ["panel", "collapse", "expand"],
      action: () => setSidebarCollapsed((prev) => !prev),
    },
    {
      id: "worker:spawn",
      label: "Spawn Worker",
      group: "Workers",
      keywords: ["create", "new", "add", "agent"],
      action: () => void spawn(),
    },
    ...workers.entries().map(([id, worker]): CommandDef => {
      const name = worker.name ?? id.slice(0, 8);
      return {
        id: `worker:kill:${id}`,
        label: `Kill ${name}`,
        group: "Workers",
        keywords: ["remove", "stop", "terminate"],
        action: () => confirmKill(id, name),
      };
    }),
    {
      id: "graph:toggle-view",
      label: graphView === "graph" ? "Switch To List View" : "Switch To Graph View",
      group: "Graph",
      keywords: ["toggle", "view", "graph", "list", "switch"],
      action: () => setGraphView((prev) => (prev === "graph" ? "list" : "graph")),
    },
    {
      id: "session:snapshot",
      label: "Snapshot Session",
      group: "Sessions",
      keywords: ["snapshot", "save", "backup", "state"],
      action: () => void snapshot(),
    },
  ];

  return (
    <Command.Dialog
      // The machine's `search` state survives CLOSE while the input
      // unmounts empty — on reopen the stale query silently filters
      // group children out of registration and the list corrupts.
      // Keying by `open` remounts the dialog (fresh machine, empty
      // search) each cycle, which also flushes the frecency engine.
      key={String(open)}
      open={open}
      onOpenChange={setOpen}
      label="SWARM Command Palette"
      description="Type A Command Or Search, Then Press Enter To Run It"
      frecency={{ enabled: true, namespace: "swarm-palette", storage: frecencyStorage }}
      className="swarm-cmdk"
      overlayClassName="swarm-cmdk-overlay"
      contentClassName="swarm-cmdk-content"
    >
      <PaletteBody commands={commands} frecency={frecency} onRun={() => setOpen(false)} />
    </Command.Dialog>
  );
}

/**
 * The palette's input and grouped list. Mounted fresh on every open
 * (the dialog is keyed by `open`), so `openedAt` fixes the moment the
 * empty-query order is computed for: commands by the engine's own
 * frecency bonus, highest first — a stable sort keeps definition order
 * among unused commands.
 */
function PaletteBody({
  commands,
  frecency,
  onRun,
}: {
  readonly commands: readonly CommandDef[];
  readonly frecency: ReadonlyMap<string, FrecencyEntry>;
  readonly onRun: () => void;
}): React.ReactElement {
  const [openedAt] = useState(Date.now);
  const bonus = (id: string) => {
    const entry = frecency.get(id);
    return entry ? computeFrecencyBonus(toRecord(entry), openedAt) : 0;
  };
  const groups = Map.groupBy(
    commands.toSorted((a, b) => bonus(b.id) - bonus(a.id)),
    (cmd) => cmd.group,
  );

  return (
    <>
      <Command.Input placeholder="Type A Command Or Search..." />
      <Command.List>
        <Command.Empty>No Commands Found.</Command.Empty>
        {[...groups].map(([groupName, cmds]) => (
          <Command.Group key={groupName} heading={groupName}>
            {cmds.map((cmd) => (
              <Command.Item
                key={cmd.id}
                // The id the frecency engine records selections under.
                forceId={cmd.id}
                // The machine scores `value` + `keywords`: the visible
                // label is what users type, so it is the value.
                value={cmd.label}
                keywords={cmd.keywords}
                onSelect={() => {
                  cmd.action();
                  onRun();
                }}
              >
                {cmd.label}
                {frecency.has(cmd.id) && (
                  <Command.Badge className="swarm-pill" data-tone="info" data-size="sm">
                    {frecency.get(cmd.id)?.uses}
                  </Command.Badge>
                )}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </>
  );
}
