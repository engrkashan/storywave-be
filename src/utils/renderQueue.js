import { createLogger } from "./logger.js";
import { config } from "../config/workflow.config.js";
import { getPerfSession } from "./perfLogger.js";

const logger = createLogger("RenderQueue");

class Semaphore {
  constructor(max, name) {
    this.max = max;
    this.name = name;
    this.count = 0;
    this.queue = [];

    // Telemetry metrics
    this.metrics = {
      totalTasks: 0,
      totalWaitMs: 0,
      maxWaitMs: 0,
      busyTimeMs: 0,
      idleTimeMs: 0,
    };
    
    this.lastStateChange = Date.now();
  }

  _updateTimeMetrics() {
    const now = Date.now();
    const duration = now - this.lastStateChange;
    if (this.count > 0) {
      this.metrics.busyTimeMs += duration;
    } else {
      this.metrics.idleTimeMs += duration;
    }
    this.lastStateChange = now;
  }

  async acquire() {
    this._updateTimeMetrics();
    
    if (this.count < this.max) {
      this.count++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push({ resolve, enqueuedAt: Date.now() });
    });
  }

  _processQueue() {
    while (this.count < this.max && this.queue.length > 0) {
      this._updateTimeMetrics();
      this.count++;
      const nextTask = this.queue.shift();
      
      const waitMs = Date.now() - nextTask.enqueuedAt;
      this.metrics.totalWaitMs += waitMs;
      this.metrics.maxWaitMs = Math.max(this.metrics.maxWaitMs, waitMs);
      
      nextTask.resolve();
    }
  }

  release() {
    this._updateTimeMetrics();
    this.metrics.totalTasks++;
    
    this.count--;
    this._processQueue();
  }

  setMax(newMax) {
    if (newMax === this.max) return;
    this.max = newMax;
    this._processQueue();
  }

  getMetrics() {
    this._updateTimeMetrics(); // Flush latest chunk
    const avgWaitMs = this.metrics.totalTasks > 0 ? (this.metrics.totalWaitMs / this.metrics.totalTasks) : 0;
    return {
      name: this.name,
      max: this.max,
      active: this.count,
      queued: this.queue.length,
      totalTasks: this.metrics.totalTasks,
      avgWaitMs: Math.round(avgWaitMs),
      maxWaitMs: this.metrics.maxWaitMs,
      busyTimeMs: this.metrics.busyTimeMs,
      idleTimeMs: this.metrics.idleTimeMs,
      utilizationPct: this.metrics.busyTimeMs > 0 ? (this.metrics.busyTimeMs / (this.metrics.busyTimeMs + this.metrics.idleTimeMs) * 100).toFixed(1) : "0.0"
    };
  }
}

// ─── Final-merge semaphore ────────────────────────────────────────────────────
// Allows only MAX_FFMPEG_CONCURRENCY final-stitch ffmpeg jobs at once.
// These are the heavy, long-duration jobs (concat + subtitle burn).
const renderSemaphore = new Semaphore(
  config.workflow.maxFfmpegConcurrency || 1,
  "FinalMerge"
);

// ─── Segment-render semaphore ─────────────────────────────────────────────────
// Allows up to MAX_SEGMENT_CONCURRENCY parallel segment renders.
// Kept separate from the final-merge semaphore so they do not starve each other.
export const segmentSemaphore = new Semaphore(
  config.workflow.maxSegmentConcurrency || 2,
  "SegmentRender"
);

/**
 * Enqueues a final-merge render task (concat + subtitle burn).
 * Serializes heavy ffmpeg jobs to prevent CPU thrashing.
 * @param {Function} taskFn - An async function containing the FFmpeg execution.
 */
export async function enqueueRender(taskFn) {
  const waiting = renderSemaphore.queue.length;
  const active = renderSemaphore.count;
  logger.info(
    `⏳ [FinalMerge] Task queued. Waiting: ${waiting}, Active: ${active}/${renderSemaphore.max}`
  );
  const perf = getPerfSession();
  perf?.recordQueueEvent('FinalMerge', 'queued', waiting, active, renderSemaphore.max);

  const queueWaitStart = process.hrtime.bigint();
  await renderSemaphore.acquire();
  const queueWaitMs = Number(process.hrtime.bigint() - queueWaitStart) / 1_000_000;

  logger.info(`▶️  [FinalMerge] Task started. Queue wait: ${(queueWaitMs / 1000).toFixed(2)}s`);
  perf?.recordQueueEvent('FinalMerge', 'acquired', renderSemaphore.queue.length, renderSemaphore.count, renderSemaphore.max);
  if (queueWaitMs > 0) perf?.start('queue-wait', 'FinalMerge queue wait')();

  try {
    return await taskFn();
  } finally {
    renderSemaphore.release();
    logger.info(
      `⏹️  [FinalMerge] Task done. Remaining queued: ${renderSemaphore.queue.length}`
    );
    perf?.recordQueueEvent('FinalMerge', 'released', renderSemaphore.queue.length, renderSemaphore.count, renderSemaphore.max);
  }
}

/**
 * Enqueues a segment render task (per-clip ffmpeg encode).
 * Allows controlled parallelism without overloading the CPU.
 * @param {Function} taskFn - An async function containing the FFmpeg execution.
 */
export async function enqueueSegmentRender(taskFn) {
  const waiting = segmentSemaphore.queue.length;
  const active = segmentSemaphore.count;
  logger.info(
    `⏳ [SegmentRender] Task queued. Waiting: ${waiting}, Active: ${active}/${segmentSemaphore.max}`
  );
  const perf = getPerfSession();
  perf?.recordQueueEvent('SegmentRender', 'queued', waiting, active, segmentSemaphore.max);

  const queueWaitStart = process.hrtime.bigint();
  await segmentSemaphore.acquire();
  const queueWaitMs = Number(process.hrtime.bigint() - queueWaitStart) / 1_000_000;

  logger.info(`▶️  [SegmentRender] Slot acquired. Queue wait: ${(queueWaitMs / 1000).toFixed(2)}s`);
  perf?.recordQueueEvent('SegmentRender', 'acquired', segmentSemaphore.queue.length, segmentSemaphore.count, segmentSemaphore.max);

  try {
    return await taskFn();
  } finally {
    segmentSemaphore.release();
    logger.info(
      `⏹️  [SegmentRender] Task done. Remaining queued: ${segmentSemaphore.queue.length}`
    );
    perf?.recordQueueEvent('SegmentRender', 'released', segmentSemaphore.queue.length, segmentSemaphore.count, segmentSemaphore.max);
  }
}
