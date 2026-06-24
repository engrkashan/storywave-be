import { Worker } from "bullmq";
import Redis from "ioredis";
import { config } from "../config/workflow.config.js";
import { createLogger } from "../utils/logger.js";
import { createMallaryBatchPost } from "../services/mallaryService.js";
import { isMallaryCdnUrl } from "../services/thumbnailService.js";
import prisma from "../config/prisma.client.js";

const logger = createLogger("PublishWorker");

const MALLARY_CDN_ORIGIN = "https://files.mallary.ai";

const redisConnection = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
});

logger.info(`Starting Publish Worker with exactly 1 job per 30 seconds rate-limit`);

/**
 * Verify that thumbnail/cover URLs in a batch payload are valid Mallary CDN URLs.
 * Logs detailed diagnostics for debugging.
 *
 * @param {Object} batchData - The batchData object passed from scheduleBatchStoryPost
 */
function verifyThumbnailPayload(batchData) {
  const { platforms = [], platformOptions = {}, mediaObjects = {}, _debug = {} } = batchData;
  const platform = platforms[0]?.toLowerCase();

  logger.info(`[${platform}] ── Thumbnail Verification ─────────────────────────`);
  logger.info(`[${platform}] Source thumbnail URL: ${_debug.thumbnailSourceUrl || "(none)"}`);
  logger.info(`[${platform}] CDN thumbnail URL:    ${_debug.thumbnailCdnUrl || "(none)"}`);
  logger.info(`[${platform}] Aspect ratio:         ${_debug.aspectRatio || "unknown"}`);
  logger.info(`[${platform}] Post type:            ${_debug.postType || "unknown"}`);

  // Check CDN URL validity
  if (_debug.thumbnailCdnUrl) {
    if (isMallaryCdnUrl(_debug.thumbnailCdnUrl)) {
      logger.info(`[${platform}] ✅ CDN URL verified — belongs to ${MALLARY_CDN_ORIGIN}`);
    } else {
      logger.warn(`[${platform}] ⚠️ CDN URL does NOT belong to ${MALLARY_CDN_ORIGIN}: ${_debug.thumbnailCdnUrl}`);
    }
  }

  // Platform-specific verification
  if (platform === "youtube") {
    const mediaObj = mediaObjects?.youtube || batchData.media?.[0] || {};
    const hasThumbnail = !!mediaObj.thumbnail_url;
    const isShort = _debug.aspectRatio === "9:16";

    if (isShort) {
      logger.info(`[youtube] Shorts detected — thumbnail correctly omitted`);
    } else if (hasThumbnail) {
      logger.info(`[youtube] ✅ thumbnail_url found in media object: ${mediaObj.thumbnail_url}`);
    } else {
      logger.warn(`[youtube] ⚠️ thumbnail_url is MISSING from media object`);
    }
  }

  if (platform === "instagram") {
    const mediaObj = mediaObjects?.instagram || batchData.media?.[0] || {};
    const hasCover = !!mediaObj.cover_url;
    if (hasCover) {
      logger.info(`[instagram] ✅ cover_url found in media object: ${mediaObj.cover_url}`);
    } else {
      logger.info(`[instagram] cover_url not set (may be image post or no cover provided)`);
    }
  }

  if (platform === "facebook") {
    const fbOpts = platformOptions?.facebook || {};
    const hasThumbnail = !!fbOpts.thumbnail_url;
    if (hasThumbnail) {
      logger.info(`[facebook] ✅ thumbnail_url found in platform_options: ${fbOpts.thumbnail_url}`);
    } else {
      logger.info(`[facebook] thumbnail_url not set in platform_options`);
    }
  }

  if (platform === "tiktok") {
    const tkOpts = platformOptions?.tiktok || {};
    const hasTimestamp = tkOpts.video_cover_timestamp_ms !== undefined;
    const hasCoverIndex = tkOpts.photo_cover_index !== undefined;
    const hasThumbUrl = !!tkOpts.thumbnail_url;

    if (hasThumbUrl) {
      logger.warn(`[tiktok] ❌ thumbnail_url should NOT be present for TikTok! Found: ${tkOpts.thumbnail_url}`);
    } else {
      logger.info(`[tiktok] ✅ thumbnail_url correctly absent`);
    }

    if (hasTimestamp) {
      logger.info(`[tiktok] ✅ video_cover_timestamp_ms: ${tkOpts.video_cover_timestamp_ms}ms`);
    } else if (hasCoverIndex) {
      logger.info(`[tiktok] ✅ photo_cover_index: ${tkOpts.photo_cover_index}`);
    } else {
      logger.warn(`[tiktok] ⚠️ No cover field found (expected video_cover_timestamp_ms or photo_cover_index)`);
    }
  }

  logger.info(`[${platform}] ─────────────────────────────────────────────────────`);
}

const worker = new Worker(
  "publish-queue",
  async (job) => {
    const { socialPostId, batchData } = job.data;
    const platform = batchData?.platforms?.[0] || "unknown";
    logger.info(`🚀 Starting publish job ${job.id} for SocialPost: ${socialPostId} [${platform}]`);

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

      // ── Verify thumbnail payload before sending ─────────────────────────
      verifyThumbnailPayload(batchData);

      // ── Log full payload for debugging ──────────────────────────────────
      const payloadForLog = {
        profileId: batchData.profileId,
        platforms: batchData.platforms,
        message: batchData.message?.substring(0, 100) + (batchData.message?.length > 100 ? "..." : ""),
        mediaUrl: batchData.mediaUrl,
        scheduledAt: batchData.scheduledAt,
        platformOptions: batchData.platformOptions,
        mediaObjects: batchData.mediaObjects,
      };
      logger.info(`[${platform}] Final batchData payload (trimmed):\n${JSON.stringify(payloadForLog, null, 2)}`);

      // ── Execute Mallary API ──────────────────────────────────────────────
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
