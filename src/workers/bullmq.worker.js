import { Worker } from "bullmq";
import Redis from "ioredis";
import { config } from "../config/workflow.config.js";
import { runWorkflow } from "../services/workflowService.js";
import { regenerateScene } from "../services/sceneRegenService.js";
import { runFinalAssembly } from "../services/finalAssemblyService.js";
import { createLogger } from "../utils/logger.js";
import { startAdaptiveController, stopAdaptiveController } from "../utils/adaptiveController.js";
import { segmentSemaphore } from "../utils/renderQueue.js";

const logger = createLogger("BullMQWorker");

const redisConnection = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
});

logger.info(`Starting BullMQ Worker with concurrency: ${config.workflow.maxWorkerConcurrency}`);

const worker = new Worker(
  "workflow-queue",
  async (job) => {
    logger.info(`🚀 Starting job ${job.id} (type: ${job.name})`);
    try {
      if (job.name === "regenerate-scene") {
        logger.info(`🎨 Processing scene regeneration for scene ${job.data.sceneId} (workflow: ${job.data.workflowId})`);
        const result = await regenerateScene(job.data);
        logger.info(`✅ Scene regen job ${job.id} completed successfully`);
        return result;
      }

      if (job.name === "merge-workflow") {
        logger.info(`🔀 Processing merge & final assembly for workflow: ${job.data.workflowId}`);
        const result = await runFinalAssembly(job.data.workflowId);
        logger.info(`✅ Merge job ${job.id} completed successfully`);
        return result;
      }

      // Default: "process-workflow" executes the full story generation pipeline
      logger.info(`🎬 Processing full workflow: "${job.data.title}"`);
      const result = await runWorkflow(job.data);
      if (result?.cancelled) {
        logger.info(`🚫 Job ${job.id} was cancelled by user — skipping retries`);
        return result;
      }
      logger.info(`✅ Workflow job ${job.id} completed successfully`);
      return result;
    } catch (err) {
      logger.error(`❌ Job ${job.id} (${job.name}) failed: ${err.message}`);
      throw err; // Let BullMQ handle retries/failure state
    }
  },
  {
    connection: redisConnection,
    concurrency: config.workflow.maxWorkerConcurrency,
    lockDuration: 300000,      // 5 minutes — time before lock expires if not renewed
    lockRenewTime: 60000,      // Renew lock every 60s (well within 5min window)
    stalledInterval: 300000,   // Only check for stalled jobs every 5 min (matches lockDuration)
    maxStalledCount: 0,        // Never auto-retry a stalled job — prevents ghost duplicates
  }
);

worker.on("ready", () => {
  logger.info("👷 Worker is ready and listening to workflow-queue");
  startAdaptiveController();
});

worker.on("error", (err) => {
  logger.error(`Worker error: ${err.message}`);
});

worker.on("failed", (job, err) => {
  if (job) {
    logger.error(`Job ${job.id} failed with error: ${err.message}`);
  }
});

// Handle graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}, closing worker...`);
  
  stopAdaptiveController();
  
  const metrics = segmentSemaphore.getMetrics();
  logger.info("📊 Final Queue Metrics:");
  logger.info(`   - Total Tasks Processed: ${metrics.totalTasks}`);
  logger.info(`   - Average Wait Time: ${metrics.avgWaitMs}ms`);
  logger.info(`   - Max Wait Time: ${metrics.maxWaitMs}ms`);
  logger.info(`   - Busy Time: ${metrics.busyTimeMs}ms`);
  logger.info(`   - Idle Time: ${metrics.idleTimeMs}ms`);
  logger.info(`   - Worker Utilization: ${metrics.utilizationPct}%`);

  await worker.close();
  redisConnection.disconnect();
  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
