/**
 * Session replay recording and playback.
 *
 * Records timestamped events during a session and provides a
 * `ReplayPlayer` class for playback with variable speed,
 * pause, and seek support.
 *
 * @module replay
 */

/** A single recorded replay event with a timestamp and typed payload. */
export interface ReplayEvent {
  readonly timestamp: number;
  readonly type:
    | "worker-spawn"
    | "worker-kill"
    | "worker-state"
    | "ai-message"
    | "bus-message"
    | "metrics";
  readonly data: Record<string, unknown>;
}

/** A complete replay session containing all recorded events. */
export interface ReplaySession {
  readonly id: string;
  readonly sessionId: string;
  readonly events: ReplayEvent[];
  readonly startTime: number;
  readonly endTime: number;
}

// ── Recording ──────────────────────────────────────

let recordedEvents: ReplayEvent[] = [];
let recordingSessionId = crypto.randomUUID();
let recordingStartTime = 0;

/** Record a new event with an automatic timestamp. */
export function recordEvent(event: Omit<ReplayEvent, "timestamp">): void {
  const now = Date.now();
  if (recordedEvents.length === 0) {
    recordingStartTime = now;
  }
  recordedEvents.push({ ...event, timestamp: now });
}

/** Returns the current replay session built from recorded events. */
export function getReplaySession(): ReplaySession {
  const events = [...recordedEvents];
  const startTime = recordingStartTime;
  const endTime = events.length > 0 ? events[events.length - 1].timestamp : startTime;

  return {
    id: crypto.randomUUID(),
    sessionId: recordingSessionId,
    events,
    startTime,
    endTime,
  };
}

/** Clears all recorded events and resets the session. */
export function clearRecording(): void {
  recordedEvents = [];
  recordingSessionId = crypto.randomUUID();
  recordingStartTime = 0;
}

// ── Playback ───────────────────────────────────────

/**
 * Replays a recorded session with variable speed and seek support.
 *
 * Events are dispatched via the `onEvent` callback in chronological
 * order. Playback speed is adjustable (1 = real-time, 2 = double speed).
 */
export class ReplayPlayer {
  private readonly session: ReplaySession;
  private currentIndex = 0;
  private playing = false;
  private speed = 1;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private currentTimestamp: number;

  /** Callback invoked for each event during playback. */
  onEvent: ((event: ReplayEvent) => void) | null = null;

  /** Callback invoked when playback state changes (play/pause/seek). */
  onStateChange: (() => void) | null = null;

  constructor(session: ReplaySession) {
    this.session = session;
    this.currentTimestamp = session.startTime;
  }

  /** Start or resume playback at the given speed (default 1x). */
  play(speed = 1): void {
    this.speed = speed;
    this.playing = true;
    this.onStateChange?.();
    this.scheduleNext();
  }

  /** Pause playback. */
  pause(): void {
    this.playing = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.onStateChange?.();
  }

  /** Seek to a specific timestamp. Adjusts the event index accordingly. */
  seek(timestamp: number): void {
    const clamped = Math.max(this.session.startTime, Math.min(timestamp, this.session.endTime));
    this.currentTimestamp = clamped;

    // Find the first event at or after the target timestamp
    this.currentIndex = 0;
    for (let i = 0; i < this.session.events.length; i++) {
      if (this.session.events[i].timestamp >= clamped) {
        this.currentIndex = i;
        break;
      }
      this.currentIndex = this.session.events.length;
    }

    this.onStateChange?.();

    // If playing, restart the scheduling from the new position
    if (this.playing) {
      if (this.timerId !== null) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }
      this.scheduleNext();
    }
  }

  /** Whether the player is currently playing. */
  isPlaying(): boolean {
    return this.playing;
  }

  /** The current playback timestamp. */
  getCurrentTimestamp(): number {
    return this.currentTimestamp;
  }

  /** The current playback speed multiplier. */
  getSpeed(): number {
    return this.speed;
  }

  /** The total duration of the session in milliseconds. */
  getDuration(): number {
    return this.session.endTime - this.session.startTime;
  }

  /** Progress as a value between 0 and 1. */
  getProgress(): number {
    const duration = this.getDuration();
    if (duration === 0) return 0;
    return (this.currentTimestamp - this.session.startTime) / duration;
  }

  /** Dispose of the player and cancel any pending timers. */
  dispose(): void {
    this.pause();
    this.onEvent = null;
    this.onStateChange = null;
  }

  private scheduleNext(): void {
    if (!this.playing || this.currentIndex >= this.session.events.length) {
      if (this.currentIndex >= this.session.events.length) {
        this.playing = false;
        this.onStateChange?.();
      }
      return;
    }

    const event = this.session.events[this.currentIndex];
    const delay = Math.max(0, (event.timestamp - this.currentTimestamp) / this.speed);

    this.timerId = setTimeout(() => {
      this.timerId = null;
      this.currentTimestamp = event.timestamp;
      this.currentIndex++;
      this.onEvent?.(event);
      this.onStateChange?.();
      this.scheduleNext();
    }, delay);
  }
}
