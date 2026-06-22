import { Worker } from "bullmq";
import Redis from "ioredis";
import { config } from "../config/workflow.config.js";
import { createLogger } from "../utils/logger.js";
import { createMallaryBatchPost } from "../services/mallaryService.js";
import prisma from "../config/prisma.client.js";

const logger = createLogger("PublishWorker");

const redisConnection = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
});

logger.info(`Starting Publish Worker with exactly 1 job per 30 seconds rate-limit`);

const worker = new Worker(
  "publish-queue",
  async (job) => {
    const { socialPostId, batchData } = job.data;
    logger.info(`🚀 Starting publish job ${job.id} for SocialPost: ${socialPostId}`);

    try {
      // Fetch the latest SocialPost
      const socialPost = await prisma.socialPost.findUnique({
        where: { id: socialPostId },
      });

      if (!socialPost) {
        throw new Error(`SocialPost ${socialPostId} not found`);
      }

      if (socialPost.status === "CANCELLED") {
        logger.info(`🚫 Job ${job.id} skipped - SocialPost was cancelled`);
        return { cancelled: true };
      }

      // Execute Mallary API
      const response = await createMallaryBatchPost(batchData);

      const mallaryJobId =
        response?.jobs?.[0]?.jobId ||
        response?.batch_id ||
        response?.id ||
        response?.job_id ||
        null;

      // Update to SCHEDULED (or PUBLISHED if no scheduling)
      await prisma.socialPost.update({
        where: { id: socialPostId },
        data: {
          status: "SCHEDULED",
          mallaryJobId: mallaryJobId ? String(mallaryJobId) : null,
          metadata: response,
          errorMessage: null,
        },
      });

      logger.info(`✅ Job ${job.id} completed successfully. Mallary Job ID: ${mallaryJobId}`);
      return response;
    } catch (err) {
      logger.error(`❌ Job ${job.id} failed: ${err.message}`);
      
      // Check if we have more retries left
      const isRetrying = job.attemptsMade < job.opts.attempts;
      
      await prisma.socialPost.update({
        where: { id: socialPostId },
        data: {
          status: isRetrying ? "RETRYING" : "FAILED",
          errorMessage: err.message,
        },
      });

      throw err; // Re-throw so BullMQ records the failure and attempts backoff
    }
  },
  {
    connection: redisConnection,
    concurrency: 1, // Only process 1 at a time
    limiter: {
      max: 1,
      duration: 30000, // 30 seconds delay between each job globally
    },
    lockDuration: 60000,
  }
);

worker.on("ready", () => {
  logger.info("👷 Worker is ready and listening to publish-queue");
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
  logger.info(`Received ${signal}, closing publish worker...`);
  await worker.close();
  redisConnection.disconnect();
  // process.exit(0) is handled by the main index.js, we shouldn't exit the whole process here 
  // as other workers might be running in the same process.
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
