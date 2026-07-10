// ── Metrics Ring Buffer & Aggregation ──────────────
// Pure functions for fixed-size sample storage and downsampling.

import type { MetricPoint } from "#store/types";

// ── Ring Buffer ────────────────────────────────────

/** Generic fixed-capacity ring buffer for time-series sample storage. */
export interface RingBuffer<T> {
  readonly items: T[];
  readonly capacity: number;
  readonly head: number;
  readonly size: number;
}

/** Create a new empty ring buffer with the given capacity. */
export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  return {
    items: new Array<T>(capacity),
    capacity,
    head: 0,
    size: 0,
  };
}

/**
 * Push an item into the ring buffer, returning an updated buffer descriptor.
 *
 * O(1) amortized: the backing `items` array is mutated in place (only the
 * slot at `head` is written) rather than copied, so this stays cheap
 * regardless of `capacity`. Callers relying on the previous descriptor's
 * `items` array remaining unchanged after a push should not do so — the
 * array is shared and mutated, only `head`/`size` are new.
 */
export function ringBufferPush<T>(buf: RingBuffer<T>, item: T): RingBuffer<T> {
  buf.items[buf.head] = item;
  return {
    items: buf.items,
    capacity: buf.capacity,
    head: (buf.head + 1) % buf.capacity,
    size: Math.min(buf.size + 1, buf.capacity),
  };
}

/** Read all items from the ring buffer in insertion order. */
export function ringBufferToArray<T>(buf: RingBuffer<T>): T[] {
  if (buf.size === 0) return [];
  if (buf.size < buf.capacity) {
    // Buffer not full yet — items are 0..size-1
    return buf.items.slice(0, buf.size);
  }
  // Buffer is full — head points to oldest item
  return [...buf.items.slice(buf.head), ...buf.items.slice(0, buf.head)];
}

// ── LTTB Downsampling ──────────────────────────────
// Largest-Triangle-Three-Buckets algorithm for time-series downsampling.
// Preserves visual shape while reducing point count for rendering.

/**
 * Downsample a MetricPoint array using the LTTB algorithm.
 * Returns at most `maxPoints` data points that best represent the shape.
 */
export function downsampleLTTB(data: MetricPoint[], maxPoints: number): MetricPoint[] {
  const len = data.length;
  if (len <= maxPoints || maxPoints < 3) return data;

  const result: MetricPoint[] = [data[0]]; // Always keep first
  const bucketSize = (len - 2) / (maxPoints - 2);

  let prevIndex = 0;

  for (let i = 1; i < maxPoints - 1; i++) {
    // Calculate bucket boundaries
    const rangeStart = Math.floor((i - 1) * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor(i * bucketSize) + 1, len - 1);

    // Calculate average point for the next bucket (look-ahead)
    const nextStart = Math.floor(i * bucketSize) + 1;
    const nextEnd = Math.min(Math.floor((i + 1) * bucketSize) + 1, len - 1);

    let avgX = 0;
    let avgY = 0;
    const nextCount = nextEnd - nextStart + 1;

    for (let j = nextStart; j <= nextEnd; j++) {
      avgX += data[j].time;
      avgY += data[j].cpu;
    }
    avgX /= nextCount;
    avgY /= nextCount;

    // Find point in current bucket with largest triangle area
    const prevPoint = data[prevIndex];
    let maxArea = -1;
    let maxAreaIndex = rangeStart;

    for (let j = rangeStart; j <= rangeEnd; j++) {
      const area = Math.abs(
        (prevPoint.time - avgX) * (data[j].cpu - prevPoint.cpu) -
          (prevPoint.time - data[j].time) * (avgY - prevPoint.cpu),
      );
      if (area > maxArea) {
        maxArea = area;
        maxAreaIndex = j;
      }
    }

    result.push(data[maxAreaIndex]);
    prevIndex = maxAreaIndex;
  }

  result.push(data[len - 1]); // Always keep last
  return result;
}

/**
 * Simple nth-point sampling for when LTTB precision is not needed.
 */
export function downsampleNth(data: MetricPoint[], maxPoints: number): MetricPoint[] {
  const len = data.length;
  if (len <= maxPoints) return data;

  const step = len / maxPoints;
  const result: MetricPoint[] = [];

  for (let i = 0; i < maxPoints; i++) {
    result.push(data[Math.floor(i * step)]);
  }

  // Always include last point
  if (result[result.length - 1] !== data[len - 1]) {
    result[result.length - 1] = data[len - 1];
  }

  return result;
}

// ── Multi-worker aggregation ───────────────────────

/** Per-worker metric snapshot used for cross-worker aggregation. */
export interface WorkerMetricSnapshot {
  workerId: string;
  cpu: number;
  memory: number;
  messagesSent: number;
  toolCalls: number;
  errors: number;
}

/**
 * Aggregate per-worker metrics into system totals.
 */
export function aggregateWorkerMetrics(snapshots: WorkerMetricSnapshot[]): {
  totalCpu: number;
  totalMemory: number;
  totalMessages: number;
  totalToolCalls: number;
  totalErrors: number;
  workerCount: number;
} {
  let totalCpu = 0;
  let totalMemory = 0;
  let totalMessages = 0;
  let totalToolCalls = 0;
  let totalErrors = 0;

  for (const s of snapshots) {
    totalCpu += s.cpu;
    totalMemory += s.memory;
    totalMessages += s.messagesSent;
    totalToolCalls += s.toolCalls;
    totalErrors += s.errors;
  }

  return {
    totalCpu,
    totalMemory,
    totalMessages,
    totalToolCalls,
    totalErrors,
    workerCount: snapshots.length,
  };
}
