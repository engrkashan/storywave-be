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

// 3. Helper function to add a workflow job to the queue
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

// ─── Storywave Editor: Scene Regeneration Job ─────────────────────────────────
/**
 * Dispatch a scene regeneration job.
 * @param {{ workflowId: string, sceneId: string }} payload
 */
export async function addSceneRegenJob(payload) {
  try {
    const job = await workflowQueue.add("regenerate-scene", payload, {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 1,           // No automatic retries — caller retries via UI
    });
    logger.info(`✅ Added scene-regen job ${job.id} for scene ${payload.sceneId} (workflow ${payload.workflowId})`);
    return job;
  } catch (err) {
    logger.error(`❌ Failed to add scene-regen job: ${err.message}`);
    throw err;
  }
}

// ─── Storywave Editor: Merge & Continue Job ────────────────────────────────────
/**
 * Dispatch a merge-workflow (final assembly) job.
 * @param {{ workflowId: string }} payload
 */
export async function addMergeJob(payload) {
  try {
    const job = await workflowQueue.add("merge-workflow", payload, {
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 1,
    });
    logger.info(`✅ Added merge-workflow job ${job.id} for workflow ${payload.workflowId}`);
    return job;
  } catch (err) {
    logger.error(`❌ Failed to add merge job: ${err.message}`);
    throw err;
  }
}

