import { Worker } from "bullmq";
import Redis from "ioredis";
import { config } from "../config/workflow.config.js";
import { runWorkflow } from "../services/workflowService.js";
import { createLogger } from "../utils/logger.js";

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
    logger.info(`🚀 Starting job ${job.id} for workflow: ${job.data.title}`);
    try {
      // runWorkflow executes the full pipeline
      const result = await runWorkflow(job.data);
      logger.info(`✅ Job ${job.id} completed successfully`);
      return result;
    } catch (err) {
      logger.error(`❌ Job ${job.id} failed: ${err.message}`);
      throw err; // Let BullMQ handle retries/failure state
    }
  },
  {
    connection: redisConnection,
    concurrency: config.workflow.maxWorkerConcurrency,
  }
);

worker.on("ready", () => {
  logger.info("👷 Worker is ready and listening to workflow-queue");
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
  await worker.close();
  redisConnection.disconnect();
  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
