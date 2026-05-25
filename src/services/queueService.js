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
      attempts: 3,            // Retry failed jobs 3 times
      backoff: {
        type: "exponential",
        delay: 5000,
      },
    });
    logger.info(`✅ Added workflow job ${job.id} to queue. Title: ${payload.title}`);
    return job;
  } catch (err) {
    logger.error(`❌ Failed to add workflow to queue: ${err.message}`);
    throw err;
  }
}
