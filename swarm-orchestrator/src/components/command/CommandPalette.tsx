import { useAtom, useAtomValue } from "jotai";
import { Command } from "modern-cmdk/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

// Temporal is available as a global in the target runtime (Node 25.8.1 / Chromium 146+).
declare const Temporal: { Now: { instant(): { toString(): string } } };

import { rankCommands } from "#lib/command-ranking";
import { matchesBinding } from "#lib/keybindings";
import { createSnapshot } from "#lib/snapshots";
import type { FrecencyEntry } from "#store/frecency";
import { frecencyAtom, frecencyScoreAtom } from "#store/frecency";
import { useSessionStore } from "#store/sessions";
import {
  commandPaletteOpenAtom,
  currentPageAtom,
  graphViewAtom,
  keybindingsAtom,
  sidebarCollapsedAtom,
} from "#store/ui";
import { useWorkerStore } from "#store/workers";

interface CommandDef {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly keywords: readonly string[];
  readonly action: () => void;
}

/**
 * Global command palette (Ctrl+K) built on `modern-cmdk`.
 *
 * Provides navigation, worker management, graph controls, and session
 * operations. Typed queries filter and rank by match relevance (see
 * #lib/command-ranking); frecency (frequency + recency) breaks ties
 * and orders the list when the query is empty.
 */
export function CommandPalette(): React.ReactElement {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom);
  const [, setPage] = useAtom(currentPageAtom);
  const [, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom);
  const [frecency, setFrecency] = useAtom(frecencyAtom);
  const getScore = useAtomValue(frecencyScoreAtom);
  const [query, setQuery] = useState("");

  // A stale query must not leak into the next open.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const [graphView, setGraphView] = useAtom(graphViewAtom);
  const workers = useWorkerStore((s) => s.workers);
  const addWorker = useWorkerStore((s) => s.addWorker);
  const removeWorker = useWorkerStore((s) => s.removeWorker);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);

  // Palette open + graph/list toggle — bindings are remappable in
  // Settings (see #lib/keybindings).
  const keybindings = useAtomValue(keybindingsAtom);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesBinding(e, keybindings.commandPalette)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (matchesBinding(e, keybindings.graphToggle)) {
        e.preventDefault();
        setGraphView((prev) => (prev === "graph" ? "list" : "graph"));
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setOpen, setGraphView, keybindings]);

  const recordUsage = (commandId: string) => {
    setFrecency((prev) => {
      const next = new Map(prev);
      const existing = next.get(commandId);
      const entry: FrecencyEntry = {
        uses: (existing?.uses ?? 0) + 1,
        lastUsed: Temporal.Now.instant().toString(),
      };
      next.set(commandId, entry);
      return next;
    });
  };

  const staticCommands: readonly CommandDef[] = [
    {
      id: "nav:dashboard",
      label: "Go To Dashboard",
      group: "Navigation",
      keywords: ["navigate", "home"],
      action: () => setPage("dashboard"),
    },
    {
      id: "nav:workers",
      label: "Go To Workers",
      group: "Navigation",
      keywords: ["navigate", "agents"],
      action: () => setPage("workers"),
    },
    {
      id: "nav:sessions",
      label: "Go To Sessions",
      group: "Navigation",
      keywords: ["navigate", "history"],
      action: () => setPage("sessions"),
    },
    {
      id: "nav:metrics",
      label: "Go To Metrics",
      group: "Navigation",
      keywords: ["navigate", "performance", "stats"],
      action: () => setPage("metrics"),
    },
    {
      id: "nav:settings",
      label: "Go To Settings",
      group: "Navigation",
      keywords: ["navigate", "preferences", "config"],
      action: () => setPage("settings"),
    },
    // Tools/Logs/Workspace have no sidebar entry — the palette is their
    // only navigation path (they were unreachable before these commands).
    {
      id: "nav:tools",
      label: "Go To Tools",
      group: "Navigation",
      keywords: ["navigate", "custom", "builder"],
      action: () => setPage("tools"),
    },
    {
      id: "nav:logs",
      label: "Go To Logs",
      group: "Navigation",
      keywords: ["navigate", "output", "console"],
      action: () => setPage("logs"),
    },
    {
      id: "nav:workspace",
      label: "Go To Workspace",
      group: "Navigation",
      keywords: ["navigate", "files", "project"],
      action: () => setPage("workspace"),
    },
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
      action: () => {
        addWorker({
          id: crypto.randomUUID(),
          state: "idle",
          name: `Worker ${workers.size + 1}`,
          startedAt: new Date().toISOString(),
        });
      },
    },
    {
      id: "graph:zoom-fit",
      label: "Zoom To Fit",
      group: "Graph",
      keywords: ["fit", "view", "zoom", "graph"],
      action: () => {
        setPage("workers");
        setGraphView("graph");
      },
    },
    {
      id: "graph:reset-layout",
      label: "Reset Layout",
      group: "Graph",
      keywords: ["layout", "reset", "elk", "arrange"],
      action: () => {
        setPage("workers");
        setGraphView("graph");
      },
    },
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
      action: () => {
        if (!activeSessionId) {
          toast.error("No Active Session To Snapshot");
          return;
        }
        const session = sessions.get(activeSessionId);
        if (!session) return;
        void createSnapshot(session)
          .then(() => toast.success("Snapshot Created"))
          .catch(() => toast.error("Failed To Create Snapshot"));
      },
    },
  ];

  const killCommands: readonly CommandDef[] = [...workers.entries()].map(([id, worker]) => ({
    id: `worker:kill:${id}`,
    label: `Kill ${worker.name ?? id.slice(0, 8)}`,
    group: "Workers",
    keywords: ["remove", "stop", "terminate"],
    action: () => removeWorker(id),
  }));

  const allCommands = rankCommands([...staticCommands, ...killCommands], query, getScore);

  const groups = (() => {
    const map = new Map<string, CommandDef[]>();
    for (const cmd of allCommands) {
      const group = map.get(cmd.group);
      if (group) {
        group.push(cmd);
      } else {
        map.set(cmd.group, [cmd]);
      }
    }
    return map;
  })();

  const handleSelect = (commandId: string) => {
    const cmd = allCommands.find((c) => c.id === commandId);
    if (cmd) {
      recordUsage(cmd.id);
      cmd.action();
    }
    setOpen(false);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      filter={false}
      label="SWARM Command Palette"
      className="swarm-cmdk"
      overlayClassName="swarm-cmdk-overlay"
      contentClassName="swarm-cmdk-content"
    >
      <Command.Input placeholder="Type A Command Or Search..." onValueChange={setQuery} />
      <Command.List>
        {/* Command.Empty keys off the machine's registered-item count,
            which tracks our tree-level filtering (items deregister on
            unmount) — it renders exactly when ranking filters everything
            out. */}
        <Command.Empty>No Commands Found.</Command.Empty>
        {[...groups.entries()].map(([groupName, cmds]) => (
          <Command.Group key={groupName} heading={groupName}>
            {cmds.map((cmd) => (
              <Command.Item
                // The query in the key forces a remount (deregister +
                // re-register) on every keystroke, so the machine's
                // keyboard-navigation order tracks the RANKED order —
                // items otherwise keep their original registration
                // position and Enter could execute a command that is
                // not the one rendered first.
                key={`${query}::${cmd.id}`}
                value={cmd.id}
                keywords={[...cmd.keywords]}
                onSelect={() => handleSelect(cmd.id)}
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
    </Command.Dialog>
  );
}
