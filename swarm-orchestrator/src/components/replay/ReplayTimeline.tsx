/**
 * Visual timeline for session replay showing event markers and playback position.
 *
 * Renders a horizontal track with colored markers for each event type
 * and a position indicator for the current playback timestamp.
 */

import { useEffect, useState } from "react";

import type { ReplayEvent, ReplayPlayer, ReplaySession } from "#lib/replay";

type ReplayTimelineProps = {
  readonly session: ReplaySession;
  readonly player: ReplayPlayer;
};

/** OKLCH color mapping for each replay event type. */
const EVENT_COLORS: Record<ReplayEvent["type"], string> = {
  "worker-spawn": "oklch(0.82 0.18 140)",
  "worker-kill": "oklch(0.72 0.20 10)",
  "worker-state": "oklch(0.82 0.19 70)",
  "ai-message": "oklch(0.72 0.20 290)",
  "bus-message": "oklch(0.80 0.14 195)",
  metrics: "oklch(0.55 0.04 220)",
};

/** Human-readable labels for event types. */
const EVENT_LABELS: Record<ReplayEvent["type"], string> = {
  "worker-spawn": "Spawn",
  "worker-kill": "Kill",
  "worker-state": "State",
  "ai-message": "AI",
  "bus-message": "Bus",
  metrics: "Metric",
};

/**
 * Horizontal timeline component for session replay visualization.
 *
 * Shows event markers positioned proportionally along a track,
 * colored by event type. Includes a playback position indicator
 * and a legend for event types present in the session.
 */
export function ReplayTimeline({ session, player }: ReplayTimelineProps): React.ReactElement {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const sync = () => {
      setProgress(player.getProgress());
    };

    const prev = player.onStateChange;
    player.onStateChange = () => {
      prev?.();
      sync();
    };
    sync();

    return () => {
      player.onStateChange = prev ?? null;
    };
  }, [player]);

  const duration = session.endTime - session.startTime;

  // Compute marker positions as fractions 0-1
  const markers = (() => {
    if (duration === 0) return [];
    return session.events.map((event, i) => ({
      id: i,
      type: event.type,
      position: (event.timestamp - session.startTime) / duration,
      color: EVENT_COLORS[event.type],
    }));
  })();

  // Unique event types present for the legend
  const eventTypes = (() => {
    const types = new Set(session.events.map((e) => e.type));
    return [...types];
  })();

  return (
    <div className="glass-panel rounded-lg p-3 space-y-2">
      {/* Timeline track */}
      <div
        className="relative rounded-full overflow-hidden"
        style={{
          height: 24,
          background: "oklch(0.06 0.02 220)",
          border: "1px solid oklch(0.22 0.04 220)",
        }}
        role="progressbar"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Replay timeline"
      >
        {/* Event markers */}
        {markers.map((marker) => (
          <div
            key={marker.id}
            style={{
              position: "absolute",
              left: `${marker.position * 100}%`,
              top: 2,
              bottom: 2,
              width: 3,
              borderRadius: 1,
              background: marker.color,
              opacity: 0.7,
              transform: "translateX(-50%)",
            }}
            title={`${EVENT_LABELS[marker.type]}`}
          />
        ))}

        {/* Playback position indicator */}
        <div
          style={{
            position: "absolute",
            left: `${progress * 100}%`,
            top: 0,
            bottom: 0,
            width: 2,
            background: "oklch(0.95 0.02 220)",
            boxShadow: "0 0 6px oklch(0.78 0.18 205 / 0.6)",
            transform: "translateX(-50%)",
            transition: "left 0.05s linear",
          }}
        />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3">
        {eventTypes.map((type) => (
          <div key={type} className="flex items-center gap-1.5">
            <div
              className="rounded-full"
              style={{
                width: 8,
                height: 8,
                background: EVENT_COLORS[type],
              }}
            />
            <span className="font-mono text-xs" style={{ color: "oklch(0.55 0.04 220)" }}>
              {EVENT_LABELS[type]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
