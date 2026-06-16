import { createLogger } from "./logger.js";
import { config } from "../config/workflow.config.js";

const logger = createLogger("RenderQueue");

class Semaphore {
  constructor(max) {
    this.max = max;
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

// Global semaphore instance. 
// Set max concurrency based on CPU capacity (default 1) to prevent CPU deadlock.
const renderSemaphore = new Semaphore(config.workflow.maxFfmpegConcurrency || 1);

/**
 * Enqueues a render task to prevent CPU deadlock.
 * @param {Function} taskFn - An async function containing the FFmpeg execution.
 */
export async function enqueueRender(taskFn) {
  logger.info(`⏳ FFmpeg Render Task Queued. Current queue length: ${renderSemaphore.queue.length}`);
  await renderSemaphore.acquire();
  logger.info(`▶️ FFmpeg Render Task Started.`);
  try {
    return await taskFn();
  } finally {
    renderSemaphore.release();
    logger.info(`⏹️ FFmpeg Render Task Completed. Remaining in queue: ${renderSemaphore.queue.length}`);
  }
}
