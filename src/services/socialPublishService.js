import { Queue } from "bullmq";
import Redis from "ioredis";
import prisma from "../config/prisma.client.js";
import { config } from "../config/workflow.config.js";
import { createLogger } from "../utils/logger.js";
import {
  createMallaryPost,
  createMallaryBatchPost,
  deleteMallaryPost,
  getMallaryPostStatus,
  getDefaultScheduleTime,
  updateMallaryPost,
  buildPlatformOptions,
} from "./mallaryService.js";
import {
  uploadThumbnailToMallary,
  validateThumbnailForPlatform,
  attachThumbnailToPayload,
} from "./thumbnailService.js";

const logger = createLogger("SocialPublishService");

const redisConnection = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
});

export const publishQueue = new Queue("publish-queue", {
  connection: redisConnection,
});

const SUPPORTED_PLATFORMS = ["youtube", "facebook", "instagram", "tiktok"];

/**
 * Build SEO-aware caption from story metadata.
 * Uses seoContent if available, falls back to title.
 *
 * @param {Object} story - Prisma story record
 * @param {string} platform - Target platform
 */
function buildCaption(story, platform) {
  const seo = story.seoContent;

  if (seo && typeof seo === "object") {
    // Platform-specific captions from SEO metadata
    if (seo[platform]?.description) {
      const desc = seo[platform].description;
      const tags = seo[platform]?.hashtags || seo?.hashtags || [];
      const tagString = tags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ");
      return `${desc}\n\n${tagString}`.trim();
    }

    // Generic SEO description
    if (seo.description) {
      const tags = seo.hashtags || seo.tags || [];
      const tagString = tags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ");
      return `${seo.description}\n\n${tagString}`.trim();
    }
  }

  // Fallback to story title
  return story.title;
}

/**
 * Extract tags array from story SEO metadata
 * @param {Object} story
 * @param {string} platform
 */
function buildTags(story, platform) {
  const seo = story.seoContent;
  if (!seo || typeof seo !== "object") return [];
  const platformTags = seo[platform]?.hashtags || seo[platform]?.tags || [];
  const genericTags = seo.hashtags || seo.tags || [];
  const all = [...platformTags, ...genericTags];
  return [...new Set(all)]; // deduplicate
}

/**
 * Determine the correct post type string for a platform based on aspect ratio and media type.
 *
 * @param {string} platform
 * @param {string} aspectRatio - "16:9" | "9:16" | "1:1" | "4:5"
 * @param {string} mediaType - "video" | "image" | "photo"
 * @returns {string}
 */
function resolvePostType(platform, aspectRatio, mediaType = "video") {
  const p = platform?.toLowerCase();

  if (p === "instagram") {
    if (mediaType === "image" || mediaType === "photo") return "image";
    if (aspectRatio === "9:16") return "reel"; // Reels and Stories are 9:16
    if (aspectRatio === "1:1" || aspectRatio === "4:5") return "feed_video";
    return "video";
  }

  if (p === "tiktok") {
    if (mediaType === "image" || mediaType === "photo") return "photo";
    return "video";
  }

  if (p === "youtube") {
    return "video"; // Shorts are handled by aspectRatio check in thumbnail service
  }

  if (p === "facebook") {
    return mediaType === "image" ? "image" : "video";
  }

  return "video";
}

/**
 * Upload a thumbnail to Mallary CDN with validation.
 * Returns CDN URL or null on failure (non-fatal).
 *
 * @param {string|null} thumbnailUrl - Source thumbnail URL
 * @param {string} platform - Target platform
 * @returns {Promise<string|null>}
 */
async function prepareThumbnailCdnUrl(thumbnailUrl, platform) {
  if (!thumbnailUrl || platform?.toLowerCase() === "tiktok") return null;

  const validation = validateThumbnailForPlatform({ url: thumbnailUrl, platform });
  if (!validation.valid) {
    logger.warn(`[${platform}] Thumbnail validation errors: ${validation.errors.join("; ")}`);
    // Still attempt upload — server-side validation may differ
  }

  try {
    const cdnUrl = await uploadThumbnailToMallary(thumbnailUrl, { platform });
    logger.info(`[${platform}] Thumbnail uploaded to Mallary CDN: ${cdnUrl}`);
    return cdnUrl;
  } catch (err) {
    logger.warn(`[${platform}] Thumbnail CDN upload failed: ${err.message} — continuing without thumbnail`);
    return null;
  }
}

/**
 * Auto-publish a completed story to all enabled Mallary channels.
 * Called automatically when a workflow completes.
 *
 * @param {string} workflowId - The completed workflow ID
 * @param {Object} options
 * @param {string} options.videoUrl - The primary video URL (16:9 for landscape, 9:16 for portrait)
 * @param {string} options.audioUrl - The audio/voiceover URL (fallback)
 * @param {Object} options.story - The story record from DB (with seoContent, title, coverArtURL)
 * @param {string[]} options.platforms - Platforms to post to (defaults to all supported)
 */
export async function autoPublishStory(workflowId, options = {}) {
  const {
    videoUrl,
    audioUrl,
    story,
    platforms = SUPPORTED_PLATFORMS,
  } = options;

  if (!process.env.MALLARY_AUTO_PUBLISH || process.env.MALLARY_AUTO_PUBLISH !== "true") {
    logger.info(`Auto-publish disabled (MALLARY_AUTO_PUBLISH != 'true'). Skipping.`);
    return;
  }

  if (!videoUrl && !audioUrl) {
    logger.warn(`autoPublishStory: no media URL available for workflow ${workflowId}. Skipping.`);
    return;
  }

  logger.info(`🚀 Auto-publishing workflow ${workflowId} to: ${platforms.join(", ")}`);

  // Use provided delay or default to 1 hour (60 mins)
  const delayMinutes = options.delayMinutes || 60;
  const scheduledAt = getDefaultScheduleTime(delayMinutes);
  const aspectRatio = options.aspectRatio || "16:9";

  // Fetch channels from Mallary to find connected ones
  let channels = [];
  try {
    const { getMallaryChannels } = await import("./mallaryService.js");
    channels = await getMallaryChannels();
  } catch (err) {
    logger.error(`Failed to fetch Mallary channels for auto-publish: ${err.message}`);
    return;
  }

  const results = [];

  for (const platform of platforms) {
    // Custom Routing: 16:9 videos only go to YouTube
    if (aspectRatio === "16:9" && platform.toLowerCase() !== "youtube") {
      logger.info(`Skipping ${platform} for 16:9 story`);
      continue;
    }

    const platformChannels = channels.filter(
      (ch) => ch.platform?.toLowerCase() === platform.toLowerCase()
    );

    if (platformChannels.length === 0) {
      continue;
    }

    for (const channel of platformChannels) {
      const channelNameLower = (channel.name || channel.profileName || channel.username || "").toLowerCase();

      // Custom Routing: Channel matching for YouTube
      if (platform.toLowerCase() === "youtube") {
        if (aspectRatio === "16:9") {
          if (!channelNameLower.includes("history of the caribbean")) {
            continue; // Skip if it's not the History channel
          }
        } else if (aspectRatio === "9:16") {
          if (!channelNameLower.includes("caribvibes tv") && !channelNameLower.includes("carribvibes")) {
            continue; // Skip if it's not CaribVibes TV
          }
        }
      }

      try {
        const mediaUrl = videoUrl || audioUrl;
        const caption = buildCaption(story, platform);
        const tags = buildTags(story, platform);
        const title = story?.seoContent?.[platform]?.title || story?.seoContent?.title || story.title;
        const postType = resolvePostType(platform, aspectRatio, "video");

        // Select cover art thumbnail matching aspect ratio
        let thumbnailUrl = story?.coverArtURL_9_16 || story?.coverArtURL || null;
        if (aspectRatio === "16:9" && platform.toLowerCase() === "youtube") {
          thumbnailUrl = story?.coverArtURL_16_9 || story?.coverArtURL || null;
        }

        // Upload thumbnail to Mallary CDN
        logger.info(`[${platform}] Preparing thumbnail for auto-publish: ${thumbnailUrl}`);
        const thumbnailCdnUrl = await prepareThumbnailCdnUrl(thumbnailUrl, platform);

        // Build post params (createMallaryPost will handle per-platform attachment)
        const postParams = {
          platform: platform.toLowerCase(),
          channelId: channel.id || channel.channel_id,
          caption,
          mediaUrl,
          scheduledAt,
          thumbnailUrl: thumbnailCdnUrl, // already a CDN URL
          tags,
          title,
          aspectRatio,
          postType,
        };

        const result = await createMallaryPost(postParams);

        const mallaryJobId = result?.jobs?.[0]?.jobId || result?.batch_id || result?.id || result?.job_id || null;

        // Save SocialPost record to DB
        const socialPost = await prisma.socialPost.create({
          data: {
            mallaryJobId: mallaryJobId ? String(mallaryJobId) : null,
            platform: platform.toLowerCase(),
            channelId: String(channel.id || channel.channel_id),
            channelName: channel.name || channel.username || platform,
            caption,
            mediaUrl,
            scheduledAt: new Date(scheduledAt),
            status: "SCHEDULED",
            metadata: result,
            thumbnailUrl: thumbnailCdnUrl,
            workflowId,
          },
        });

        logger.info(`✅ Auto-published to ${platform} [${channel.name}]: SocialPost ${socialPost.id}`);
        results.push({ platform, channel: channel.name, socialPostId: socialPost.id, status: "SCHEDULED" });
      } catch (err) {
        logger.error(`❌ Failed to auto-publish to ${platform} [${channel.name}]: ${err.message}`);

        // Still save a failed record
        try {
          await prisma.socialPost.create({
            data: {
              platform: platform.toLowerCase(),
              channelId: String(channel.id || channel.channel_id),
              channelName: channel.name || channel.username || platform,
              caption: buildCaption(story, platform),
              mediaUrl: videoUrl || audioUrl,
              scheduledAt: new Date(scheduledAt),
              status: "FAILED",
              errorMessage: err.message,
              workflowId,
            },
          });
        } catch (dbErr) {
          logger.error(`Failed to save failed SocialPost record: ${dbErr.message}`);
        }

        results.push({ platform, channel: channel.name, status: "FAILED", error: err.message });
      }
    }
  }

  logger.info(`Auto-publish complete for workflow ${workflowId}: ${results.length} posts attempted`);
  return results;
}

/**
 * Manually schedule a batch of story posts from the dashboard.
 * Groups by profileId and builds per-platform options including thumbnail logic.
 *
 * @param {Object} params
 * @param {string} params.workflowId
 * @param {Array} params.platforms - Array of platform config objects from the frontend
 * @param {string} params.scheduledAt
 * @param {string} [params.scheduledTimezone]
 * @param {string} [params.idempotencyKey]
 */
export async function scheduleBatchStoryPost(params) {
  const { workflowId, platforms, scheduledAt, scheduledTimezone, idempotencyKey } = params;

  logger.info(`Scheduling queue posts for workflow ${workflowId} at ${scheduledAt} ${scheduledTimezone || ""} (idempotency: ${idempotencyKey})`);

  const results = [];
  let index = 0;

  for (const p of platforms) {
    const pPlatform = p.platform?.toLowerCase();
    const pProfileId = p.profileId || "default";
    const aspectRatio = p.aspectRatio || (pPlatform === "youtube" ? "16:9" : "9:16");
    const mediaType = p.mediaUrl?.match(/\.(mp4|mov|webm|avi|mkv)/i) ? "video" : "image";
    const postType = resolvePostType(pPlatform, aspectRatio, mediaType);

    // ── Upload thumbnail to Mallary CDN ──────────────────────────────────
    logger.info(`[${pPlatform}] Preparing thumbnail: ${p.thumbnailUrl || "(none)"}`);
    const thumbnailCdnUrl = await prepareThumbnailCdnUrl(p.thumbnailUrl, pPlatform);

    if (p.thumbnailUrl && thumbnailCdnUrl) {
      logger.info(`[${pPlatform}] Thumbnail CDN URL: ${thumbnailCdnUrl}`);
    } else if (p.thumbnailUrl && !thumbnailCdnUrl) {
      logger.warn(`[${pPlatform}] Thumbnail CDN upload failed — post will be scheduled without thumbnail`);
    }

    // ── Build platform_options with correct per-platform structure ────────
    const platformOpts = buildPlatformOptions(pPlatform, {
      title: p.title,
      tags: p.tags,
      aspectRatio,
      postType,
      videoDurationSeconds: p.videoDurationSeconds,
    });

    // ── Build media object — attach thumbnail/cover in the right place ────
    const getMediaType = (url) => {
      const ext = url?.split("?")[0].split(".").pop()?.toLowerCase();
      const map = {
        mp4: "video/mp4",
        mov: "video/quicktime",
        webm: "video/webm",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
      };
      return map[ext] || "video/mp4"; // Default to video/mp4
    };
    const mediaObject = p.mediaUrl ? { url: p.mediaUrl, type: getMediaType(p.mediaUrl) } : {};
    attachThumbnailToPayload({
      platform: pPlatform,
      mediaObject,
      platformOptions: platformOpts,
      thumbnailCdnUrl,
      aspectRatio,
      postType,
      videoDurationSeconds: p.videoDurationSeconds,
    });

    const platformOptions = { [pPlatform]: platformOpts };

    // ── Create SocialPost record (PENDING) ────────────────────────────────
    const socialPost = await prisma.socialPost.create({
      data: {
        platform: pPlatform,
        channelId: String(p.channelId),
        channelName: p.channelName || p.platform,
        caption: p.caption,
        mediaUrl: p.mediaUrl,
        scheduledAt: new Date(scheduledAt),
        status: "PENDING",
        thumbnailUrl: thumbnailCdnUrl,
        workflowId,
      },
    });

    results.push(socialPost);
    logger.info(`✅ Created SocialPost ${socialPost.id} (${pPlatform}) -> Queueing...`);

    // ── Build batchData for the queue worker ─────────────────────────────
    const batchData = {
      profileId: pProfileId,
      platforms: [pPlatform],
      message: p.caption,
      mediaUrl: p.mediaUrl,
      scheduledAt,
      scheduledTimezone,
      platformOptions,
      idempotencyKey: `${idempotencyKey}_${index}`,
      // Pass platform-specific media object (may contain cover_url/thumbnail_url)
      mediaObjects: { [pPlatform]: mediaObject },
      // For debugging/verification in the worker
      _debug: {
        thumbnailSourceUrl: p.thumbnailUrl,
        thumbnailCdnUrl,
        platform: pPlatform,
        aspectRatio,
        postType,
      },
    };

    // Add to publish-queue (global limiter: 1 job per 30 seconds)
    await publishQueue.add(
      "publish-job",
      {
        socialPostId: socialPost.id,
        batchData,
      },
      {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
      }
    );

    index++;
  }

  return results;
}

/**
 * Manually schedule a story post from the dashboard (LEGACY/AUTO).
 *
 * @param {Object} params
 * @param {string} params.workflowId - Workflow ID
 * @param {string} params.platform - Platform to post to
 * @param {string} params.channelId - Channel ID on Mallary
 * @param {string} params.channelName - Channel display name
 * @param {string} params.mediaUrl - Media URL to post
 * @param {string} params.caption - Post caption
 * @param {string} params.scheduledAt - ISO datetime for scheduling
 * @param {string|null} params.thumbnailUrl - Thumbnail URL
 * @param {string[]} params.tags - Tags/hashtags
 * @param {string|null} params.title - Post title
 * @param {string} [params.aspectRatio] - Content aspect ratio
 */
export async function scheduleStoryPost(params) {
  const {
    workflowId,
    platform,
    channelId,
    channelName,
    mediaUrl,
    caption,
    scheduledAt,
    thumbnailUrl = null,
    tags = [],
    title = null,
    aspectRatio = "16:9",
  } = params;

  logger.info(`Scheduling post: ${platform} [${channelName}] at ${scheduledAt}`);

  const thumbnailCdnUrl = await prepareThumbnailCdnUrl(thumbnailUrl, platform);

  try {
    const result = await createMallaryPost({
      platform: platform.toLowerCase(),
      channelId,
      caption,
      mediaUrl,
      scheduledAt,
      thumbnailUrl: thumbnailCdnUrl,
      tags,
      title,
      aspectRatio,
    });

    const mallaryJobId = result?.jobs?.[0]?.jobId || result?.batch_id || result?.id || result?.job_id || null;

    const socialPost = await prisma.socialPost.create({
      data: {
        mallaryJobId: mallaryJobId ? String(mallaryJobId) : null,
        platform: platform.toLowerCase(),
        channelId: String(channelId),
        channelName: channelName || platform,
        caption,
        mediaUrl,
        scheduledAt: new Date(scheduledAt),
        status: "SCHEDULED",
        metadata: result,
        thumbnailUrl: thumbnailCdnUrl,
        workflowId,
      },
    });

    logger.info(`✅ Post scheduled: SocialPost ${socialPost.id}`);
    return socialPost;
  } catch (err) {
    logger.error(`Failed to schedule post: ${err.message}`);
    throw err;
  }
}

/**
 * Cancel a scheduled post — deletes from Mallary and marks DB record as CANCELLED.
 * @param {string} socialPostId - Our DB SocialPost ID
 */
export async function cancelSocialPost(socialPostId) {
  const socialPost = await prisma.socialPost.findUnique({ where: { id: socialPostId } });
  if (!socialPost) throw new Error(`SocialPost ${socialPostId} not found`);

  if (socialPost.mallaryJobId) {
    try {
      await deleteMallaryPost(socialPost.mallaryJobId);
    } catch (err) {
      logger.warn(`Failed to delete Mallary post ${socialPost.mallaryJobId}: ${err.message}`);
    }
  }

  return await prisma.socialPost.update({
    where: { id: socialPostId },
    data: { status: "CANCELLED" },
  });
}

/**
 * Reschedule an existing post to a new time.
 * @param {string} socialPostId - Our DB SocialPost ID
 * @param {string} newScheduledAt - New ISO datetime
 */
export async function rescheduleSocialPost(socialPostId, newScheduledAt) {
  const socialPost = await prisma.socialPost.findUnique({ where: { id: socialPostId } });
  if (!socialPost) throw new Error(`SocialPost ${socialPostId} not found`);

  if (socialPost.mallaryJobId) {
    try {
      await updateMallaryPost(socialPost.mallaryJobId, { scheduled_at: newScheduledAt });
    } catch (err) {
      logger.warn(`Failed to update Mallary post ${socialPost.mallaryJobId}: ${err.message}`);
    }
  }

  return await prisma.socialPost.update({
    where: { id: socialPostId },
    data: { scheduledAt: new Date(newScheduledAt) },
  });
}

/**
 * Sync the status of all pending/scheduled posts from Mallary.
 * This is called by the cron job every 5 minutes.
 */
export async function syncPostStatuses() {
  try {
    const pendingPosts = await prisma.socialPost.findMany({
      where: {
        status: { in: ["PENDING", "SCHEDULED"] },
        mallaryJobId: { not: null },
      },
      take: 50, // process in batches
    });

    if (pendingPosts.length === 0) return;

    logger.info(`Syncing ${pendingPosts.length} pending social posts...`);

    for (const post of pendingPosts) {
      try {
        const statusData = await getMallaryPostStatus(post.mallaryJobId);
        const newStatus = mapMallaryStatus(statusData?.status || statusData?.state);

        if (newStatus && newStatus !== post.status) {
          await prisma.socialPost.update({
            where: { id: post.id },
            data: {
              status: newStatus,
              publishedAt: newStatus === "PUBLISHED" ? new Date() : undefined,
              metadata: statusData,
            },
          });
          logger.info(`Updated SocialPost ${post.id}: ${post.status} → ${newStatus}`);
        }
      } catch (err) {
        logger.error(`Failed to sync post ${post.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`syncPostStatuses error: ${err.message}`);
  }
}

/**
 * Map Mallary API status strings to our SocialPostStatus enum
 */
export function mapMallaryStatus(mallaryStatus) {
  if (!mallaryStatus) return null;
  const s = mallaryStatus.toLowerCase();
  if (["published", "posted", "completed", "success", "succeeded"].includes(s)) return "PUBLISHED";
  if (["scheduled"].includes(s)) return "SCHEDULED";
  if (["pending", "processing", "in_progress", "uploading", "queued", "running"].includes(s)) return "PENDING";
  if (["failed", "error", "failure"].includes(s)) return "FAILED";
  if (["cancelled", "canceled"].includes(s)) return "CANCELLED";
  if (["retrying", "retry"].includes(s)) return "RETRYING";
  
  // fallback for unknown but truthy status
  return "PENDING";
}
