import { Queue } from "bullmq";
import Redis from "ioredis";
import { config } from "../config/workflow.config.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("QueueService");

// 1. Setup Redis Connection
const redisConnection = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
});

redisConnection.on("error", (err) => {
  logger.error(`Redis connection error: ${err.message}`);
});

// 2. Setup BullMQ Queue
export const workflowQueue = new Queue("workflow-queue", {
  connection: redisConnection,
});

// 3. Helper function to add a job to the queue
export async function addWorkflowJob(payload) {
  try {
    const job = await workflowQueue.add("process-workflow", payload, {
      removeOnComplete: true, // Keep Redis clean
      removeOnFail: false,    // Keep failed jobs for inspection
      attempts: 1,            // ❌ NO automatic retries — prevents duplicate story generation on lock loss
    });
    logger.info(`✅ Added workflow job ${job.id} to queue. Title: ${payload.title}`);
    return job;
  } catch (err) {
    logger.error(`❌ Failed to add workflow to queue: ${err.message}`);
    throw err;
  }
}

// 4. Helper function to cancel a job in the queue (waiting jobs only)
export async function cancelWorkflowJob(bullJobId) {
  try {
    const job = await workflowQueue.getJob(bullJobId);
    if (!job) {
      logger.warn(`No BullMQ job found with id: ${bullJobId}`);
      return false;
    }
    const state = await job.getState();
    if (state === "waiting" || state === "delayed") {
      await job.remove();
      logger.info(`🗑️ Removed queued job ${bullJobId} (was: ${state})`);
      return true;
    }
    if (state === "active") {
      // Force the job to fail immediately — this evicts it from the active set
      // The cooperative CancelledError in the worker will also fire at the next checkpoint
      try {
        await job.moveToFailed(new Error("Cancelled by user"), job.token || "0", false);
        logger.info(`🛑 Forced active job ${bullJobId} to failed state (cancelled)`);
        return true;
      } catch (e) {
        logger.warn(`⚠️ Could not force-fail active job ${bullJobId}: ${e.message}`);
      }
    }
    logger.info(`ℹ️ Job ${bullJobId} is '${state}' — no action needed`);
    return false;
  } catch (err) {
    logger.error(`❌ Failed to cancel job ${bullJobId}: ${err.message}`);
    throw err;
  }
}
