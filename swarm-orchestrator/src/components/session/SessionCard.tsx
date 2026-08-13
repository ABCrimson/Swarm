import { formatDistanceToNow } from "date-fns";
import { motion } from "motion/react";

import { Pill } from "#components/ui/Pill";
import { pluralizeWorkers } from "#lib/format";
import type { Session } from "#store/types";
import { useWorkerStore } from "#store/workers";

interface SessionCardProps {
  readonly session: Session;
  readonly isActive: boolean;
  readonly onActivate: (id: string) => void;
  readonly onContextMenu: (e: React.MouseEvent, id: string) => void;
}

/**
 * Selectable session card with name, worker count, relative timestamp,
 * and tags. Highlights active session with violet OKLCH glow.
 */
export function SessionCard({
  session,
  isActive,
  onActivate,
  onContextMenu,
}: SessionCardProps): React.ReactElement {
  const handleClick = () => {
    onActivate(session.id);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu(e, session.id);
  };

  const relativeTime = formatDistanceToNow(new Date(session.updatedAt), {
    addSuffix: true,
  });

  // `session.workerIds` only ever grows (there is no `session_remove_worker`
  // command in Rust to prune it when a worker is killed) — intersecting
  // with the live worker store gives an honest count of workers that
  // still actually exist, instead of a number that climbs forever. The
  // persisted `workerIds` list itself is left untouched.
  const workers = useWorkerStore((s) => s.workers);
  const liveWorkerCount = session.workerIds.filter((id) => workers.has(id)).length;

  return (
    <motion.button
      type="button"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      whileHover={{ scale: 1.015 }}
      whileTap={{ scale: 0.99 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className="w-full text-left rounded-xl p-4 cursor-pointer transition-colors"
      style={{
        background: isActive ? "oklch(0.18 0.06 290 / 0.6)" : "oklch(0.14 0.02 220 / 0.5)",
        backdropFilter: "blur(12px) saturate(1.5)",
        border: isActive
          ? "1px solid oklch(0.65 0.28 290 / 0.6)"
          : "1px solid oklch(0.28 0.04 220 / 0.5)",
        boxShadow: isActive
          ? "0 0 20px oklch(0.55 0.25 290 / 0.15), inset 0 1px 0 oklch(1 0 0 / 0.05)"
          : "inset 0 1px 0 oklch(1 0 0 / 0.03)",
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h3
          className="text-sm font-semibold truncate"
          style={{
            fontFamily: "var(--font-display)",
            color: isActive ? "oklch(0.92 0.08 290)" : "oklch(0.88 0.02 220)",
          }}
        >
          {session.name}
        </h3>

        <Pill tone="info" size="sm" className="shrink-0">
          {pluralizeWorkers(liveWorkerCount)}
        </Pill>
      </div>

      <p
        className="mt-1.5 text-xs"
        style={{
          fontFamily: "var(--font-body)",
          color: "oklch(0.55 0.03 220)",
        }}
      >
        {relativeTime}
      </p>

      {session.metadata?.tags && session.metadata.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {session.metadata.tags.map((tag) => (
            <Pill key={tag} tone="neutral" size="sm" maxWidth={120}>
              {tag}
            </Pill>
          ))}
        </div>
      )}
    </motion.button>
  );
}
