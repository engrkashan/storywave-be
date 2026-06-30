import { createLogger } from "./logger.js";
import { config } from "../config/workflow.config.js";

const logger = createLogger("RenderQueue");

class Semaphore {
  constructor(max, name) {
    this.max = max;
    this.name = name;
    this.count = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.count--;
    if (this.queue.length > 0) {
      this.count++;
      const nextResolve = this.queue.shift();
      nextResolve();
    }
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
const segmentSemaphore = new Semaphore(
  config.workflow.maxSegmentConcurrency || 2,
  "SegmentRender"
);

/**
 * Enqueues a final-merge render task (concat + subtitle burn).
 * Serializes heavy ffmpeg jobs to prevent CPU thrashing.
 * @param {Function} taskFn - An async function containing the FFmpeg execution.
 */
export async function enqueueRender(taskFn) {
  logger.info(
    `⏳ [FinalMerge] Task queued. Waiting: ${renderSemaphore.queue.length}, Active: ${renderSemaphore.count}/${renderSemaphore.max}`
  );
  await renderSemaphore.acquire();
  logger.info(`▶️  [FinalMerge] Task started.`);
  try {
    return await taskFn();
  } finally {
    renderSemaphore.release();
    logger.info(
      `⏹️  [FinalMerge] Task done. Remaining queued: ${renderSemaphore.queue.length}`
    );
  }
}

/**
 * Enqueues a segment render task (per-clip ffmpeg encode).
 * Allows controlled parallelism without overloading the CPU.
 * @param {Function} taskFn - An async function containing the FFmpeg execution.
 */
export async function enqueueSegmentRender(taskFn) {
  logger.info(
    `⏳ [SegmentRender] Task queued. Waiting: ${segmentSemaphore.queue.length}, Active: ${segmentSemaphore.count}/${segmentSemaphore.max}`
  );
  await segmentSemaphore.acquire();
  try {
    return await taskFn();
  } finally {
    segmentSemaphore.release();
    logger.info(
      `⏹️  [SegmentRender] Task done. Remaining queued: ${segmentSemaphore.queue.length}`
    );
  }
}
