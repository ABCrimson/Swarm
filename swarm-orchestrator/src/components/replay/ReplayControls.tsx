/**
 * Replay transport controls: play/pause, speed selection, and seek slider.
 *
 * Designed for glass-panel styling with OKLCH-only colors.
 * Reads playback state from a `ReplayPlayer` instance and
 * provides callbacks for transport actions.
 */

import { useEffect, useState } from "react";

import type { ReplayPlayer } from "#lib/replay";

type ReplayControlsProps = {
  readonly player: ReplayPlayer;
};

const SPEED_OPTIONS = [0.5, 1, 2, 4, 8] as const;

/**
 * Transport controls for session replay playback.
 *
 * Renders play/pause, speed selector, and a seek slider.
 * Subscribes to the player's state changes for reactive updates.
 */
export function ReplayControls({ player }: ReplayControlsProps): React.ReactElement {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState(0);

  // Sync state from player
  useEffect(() => {
    const sync = () => {
      setPlaying(player.isPlaying());
      setSpeed(player.getSpeed());
      setProgress(player.getProgress());
    };

    player.onStateChange = sync;
    sync();

    return () => {
      player.onStateChange = null;
    };
  }, [player]);

  const handlePlayPause = () => {
    if (player.isPlaying()) {
      player.pause();
    } else {
      player.play(player.getSpeed());
    }
  };

  const handleSpeedChange = (newSpeed: number) => {
    setSpeed(newSpeed);
    if (player.isPlaying()) {
      player.play(newSpeed);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fraction = Number.parseFloat(e.target.value);
    const duration = player.getDuration();
    const timestamp =
      player.getCurrentTimestamp() - player.getProgress() * duration + fraction * duration;
    player.seek(timestamp);
  };

  return (
    <div
      className="glass-panel rounded-lg flex items-center gap-3 px-4 py-2"
      role="toolbar"
      aria-label="Replay controls"
    >
      {/* Play / Pause */}
      <button
        type="button"
        className="swarm-btn"
        data-variant="ghost"
        data-size="sm"
        onClick={handlePlayPause}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "Pause" : "Play"}
      </button>

      {/* Speed selector */}
      <div className="flex items-center gap-1">
        {SPEED_OPTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="swarm-btn"
            data-variant={speed === s ? "primary" : "ghost"}
            data-size="sm"
            onClick={() => handleSpeedChange(s)}
            aria-label={`${s}x speed`}
            aria-pressed={speed === s}
          >
            {s}x
          </button>
        ))}
      </div>

      {/* Seek slider */}
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={progress}
        onChange={handleSeek}
        className="flex-1"
        aria-label="Seek position"
        style={{
          accentColor: "oklch(0.78 0.18 205)",
        }}
      />

      {/* Progress indicator */}
      <span
        className="font-mono text-xs tabular-nums"
        style={{ color: "oklch(0.55 0.04 220)", minWidth: 48, textAlign: "right" }}
      >
        {Math.round(progress * 100)}%
      </span>
    </div>
  );
}
