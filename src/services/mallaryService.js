import { createLogger } from "../utils/logger.js";
import {
  isMallaryCdnUrl,
  uploadThumbnailToMallary,
  attachThumbnailToPayload,
  validateThumbnailForPlatform,
} from "./thumbnailService.js";

const logger = createLogger("MallaryService");

const MALLARY_BASE_URL = process.env.MALLARY_API_BASE_URL || "https://mallary.ai";
const MALLARY_API_KEY = process.env.MALLARY_API_KEY;

/**
 * Generic fetch wrapper for Mallary REST API
 */
async function mallaryFetch(endpoint, options = {}) {
  if (!MALLARY_API_KEY) {
    throw new Error("MALLARY_API_KEY is not set in environment variables");
  }

  const url = `${MALLARY_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${MALLARY_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    let errMsg = data?.message || data?.error || `HTTP ${response.status}`;
    if (typeof errMsg === "object") {
      errMsg = JSON.stringify(errMsg);
    }
    logger.error(`Mallary API error [${response.status}] ${endpoint}: ${errMsg}`);
    throw new Error(`Mallary API error: ${errMsg}`);
  }

  return data;
}

/**
 * Get all connected channels/accounts from Mallary
 * Returns channels grouped by platform
 */
export async function getMallaryChannels() {
  try {
    logger.info("Fetching Mallary channels...");
    const response = await mallaryFetch("/api/v1/platforms");
    let channelsList = [];

    const profiles = response?.data?.profiles || [];
    for (const profile of profiles) {
      const platformProfiles = profile.platform_profiles || {};
      for (const [platform, channelData] of Object.entries(platformProfiles)) {
        channelsList.push({
          platform,
          id: channelData.id,
          username: channelData.username,
          name: channelData.username, // Fallback since some platforms don't return name
          avatar: channelData.avatar,
          profileId: profile.id,
          profileName: profile.name,
        });
      }
    }

    logger.info(`Fetched ${channelsList.length} connected channels across ${profiles.length} profiles`);
    return channelsList;
  } catch (err) {
    logger.error(`Failed to fetch Mallary channels: ${err.message}`);
    throw err;
  }
}

/**
 * Get brand/account info from Mallary
 */
export async function getMallaryBrands() {
  try {
    const data = await mallaryFetch("/api/brands");
    return data;
  } catch (err) {
    logger.error(`Failed to fetch Mallary brands: ${err.message}`);
    throw err;
  }
}

/**
 * Create/schedule a post on Mallary with correct per-platform thumbnail logic.
 *
 * @param {Object} postData
 * @param {string} postData.platform - e.g. "instagram", "youtube", "tiktok", "facebook"
 * @param {string} postData.channelId - Mallary channel/account ID
 * @param {string} postData.caption - Post caption/description
 * @param {string} postData.mediaUrl - URL of the video/image to post
 * @param {string|null} postData.scheduledAt - ISO datetime string for scheduling (null = immediate)
 * @param {string|null} postData.thumbnailUrl - Thumbnail URL (uploaded to Mallary CDN first)
 * @param {string[]} postData.tags - Hashtags/tags for the post
 * @param {string|null} postData.title - Post title (for YouTube)
 * @param {string} [postData.aspectRatio] - "16:9" | "9:16" | "1:1" | "4:5"
 * @param {string} [postData.postType] - "video" | "reel" | "story" | "photo" | "feed_video"
 * @param {number} [postData.videoDurationSeconds] - Video duration (for TikTok timestamp)
 */
export async function createMallaryPost(postData) {
  const {
    platform,
    channelId,
    caption,
    mediaUrl,
    scheduledAt = null,
    thumbnailUrl = null,
    tags = [],
    title = null,
    aspectRatio = "16:9",
    postType = "video",
    videoDurationSeconds,
  } = postData;

  const platformLower = platform?.toLowerCase();
  logger.info(`Creating Mallary post: platform=${platformLower}, channel=${channelId}, scheduled=${scheduledAt}, aspectRatio=${aspectRatio}, postType=${postType}`);

  // ── Validate thumbnail before upload ─────────────────────────────────────
  if (thumbnailUrl && platformLower !== "tiktok") {
    const validation = validateThumbnailForPlatform({ url: thumbnailUrl, platform: platformLower });
    if (!validation.valid) {
      logger.warn(`[${platformLower}] Thumbnail validation failed: ${validation.errors.join("; ")}`);
      // For Facebook: continue without thumbnail (will be retried later without it)
      // For YouTube/Instagram: warn but still attempt CDN upload
    }
  }

  // ── Upload thumbnail to Mallary CDN ──────────────────────────────────────
  let thumbnailCdnUrl = null;
  if (thumbnailUrl && platformLower !== "tiktok") {
    try {
      thumbnailCdnUrl = await uploadThumbnailToMallary(thumbnailUrl, { platform: platformLower });
      logger.info(`[${platformLower}] Thumbnail CDN URL: ${thumbnailCdnUrl}`);
    } catch (uploadErr) {
      logger.warn(`[${platformLower}] Thumbnail CDN upload failed: ${uploadErr.message} — continuing without thumbnail`);
      thumbnailCdnUrl = null;
    }
  }

  // ── Build platform-specific options ──────────────────────────────────────
  const platformOptions = buildPlatformOptions(platformLower, {
    title,
    tags,
    aspectRatio,
    postType,
    videoDurationSeconds,
  });

  // ── Build media object ────────────────────────────────────────────────────
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

  const mediaObject = mediaUrl ? { url: mediaUrl, type: getMediaType(mediaUrl) } : {};

  // ── Attach thumbnail/cover to correct location per platform ───────────────
  attachThumbnailToPayload({
    platform: platformLower,
    mediaObject,
    platformOptions,
    thumbnailCdnUrl,
    aspectRatio,
    postType,
    videoDurationSeconds,
  });

  const body = {
    message: caption || title || "New post",
    platforms: [platformLower],
    media: mediaUrl ? [mediaObject] : [],
    scheduled_at: scheduledAt,
    platform_options: {
      [platformLower]: platformOptions,
    },
  };

  logger.info(`[${platformLower}] Final payload before submission:\n${JSON.stringify(body, null, 2)}`);

  // ── Submit to Mallary ─────────────────────────────────────────────────────
  // Facebook: retry without thumbnail if Meta rejects cover
  if (platformLower === "facebook" && thumbnailCdnUrl) {
    try {
      const data = await mallaryFetch("/api/v1/post", {
        method: "POST",
        body: JSON.stringify(body),
      });
      logger.info(`[facebook] Post created: job_id=${data?.id || data?.job_id}`);
      return data;
    } catch (err) {
      if (err.message.includes("thumbnail") || err.message.includes("cover") || err.message.includes("image")) {
        logger.warn(`[facebook] Thumbnail rejected by platform (${err.message}) — retrying without thumbnail`);
        delete body.platform_options.facebook.thumbnail_url;
        logger.info(`[facebook] Retry payload:\n${JSON.stringify(body, null, 2)}`);
        const retryData = await mallaryFetch("/api/v1/post", {
          method: "POST",
          body: JSON.stringify(body),
        });
        logger.info(`[facebook] Post created (no thumbnail): job_id=${retryData?.id || retryData?.job_id}`);
        return retryData;
      }
      throw err;
    }
  }

  // Instagram: retry without cover if Meta rejects
  if (platformLower === "instagram" && thumbnailCdnUrl) {
    try {
      const data = await mallaryFetch("/api/v1/post", {
        method: "POST",
        body: JSON.stringify(body),
      });
      logger.info(`[instagram] Post created: job_id=${data?.id || data?.job_id}`);
      return data;
    } catch (err) {
      if (err.message.includes("cover") || err.message.includes("thumbnail") || err.message.includes("image")) {
        logger.warn(`[instagram] Cover image rejected by Meta (${err.message}) — retrying without cover`);
        if (body.media?.[0]) delete body.media[0].cover_url;
        logger.info(`[instagram] Retry payload:\n${JSON.stringify(body, null, 2)}`);
        const retryData = await mallaryFetch("/api/v1/post", {
          method: "POST",
          body: JSON.stringify(body),
        });
        logger.info(`[instagram] Post created (no cover): job_id=${retryData?.id || retryData?.job_id}`);
        return retryData;
      }
      throw err;
    }
  }

  try {
    const data = await mallaryFetch("/api/v1/post", {
      method: "POST",
      body: JSON.stringify(body),
    });
    logger.info(`[${platformLower}] Post created: job_id=${data?.id || data?.job_id}`);
    return data;
  } catch (err) {
    logger.error(`Failed to create Mallary post [${platformLower}]: ${err.message}`);
    throw err;
  }
}

/**
 * Create/schedule a batch post on Mallary for multiple platforms at once.
 *
 * @param {Object} batchData
 * @param {string} batchData.profileId - Mallary profile ID
 * @param {string[]} batchData.platforms - Array of platforms
 * @param {string} batchData.message - Global post caption
 * @param {string} batchData.mediaUrl - URL of the video/image to post
 * @param {string|null} batchData.scheduledAt - ISO datetime string for scheduling
 * @param {Object} batchData.platformOptions - Platform specific overrides (already built by caller)
 * @param {string} batchData.idempotencyKey - Key to prevent duplicate requests
 * @param {Object} [batchData.thumbnailUrls] - Map of platform -> thumbnail CDN URL (already uploaded)
 * @param {Object} [batchData.mediaObjects] - Map of platform -> media object with cover_url / thumbnail_url
 */
export async function createMallaryBatchPost(batchData) {
  const {
    profileId,
    platforms,
    message,
    mediaUrl,
    scheduledAt = null,
    scheduledTimezone = undefined,
    platformOptions = {},
    idempotencyKey,
    mediaObjects = {},
  } = batchData;

  logger.info(
    `Creating Mallary batch post: platforms=[${platforms.join(",")}], profile=${profileId}, scheduled=${scheduledAt} tz=${scheduledTimezone || "UTC"}`
  );

  // Build media array — use platform-specific media object if provided (contains cover_url),
  // otherwise fall back to a bare url object
  // For single-platform batch calls, pick the first platform's media object
  const primaryPlatform = platforms[0]?.toLowerCase();
  const mediaObj = mediaObjects[primaryPlatform] || (mediaUrl ? { url: mediaUrl } : null);
  const mediaArray = mediaObj ? [mediaObj] : [];

  const body = {
    message: message || "New post",
    platforms: platforms,
    profile_id: profileId !== "default" ? profileId : undefined,
    media: mediaArray,
    scheduled_at: scheduledAt,
    scheduled_timezone: scheduledTimezone,
    platform_options: platformOptions,
  };

  const headers = {};
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  logger.info(`Batch post final payload:\n${JSON.stringify(body, null, 2)}`);

  try {
    const data = await mallaryFetch("/api/v1/post", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    logger.info(
      `Mallary batch post created: job_id=${data?.id || data?.job_id} for platforms [${platforms.join(",")}]`
    );
    return data;
  } catch (err) {
    if (err.message.includes("429")) {
      logger.error(
        `Mallary API Rate Limited (429) for batch post [${platforms.join(",")}]`
      );
    } else {
      logger.error(
        `Failed to create Mallary batch post [${platforms.join(",")}]: ${err.message}`
      );
    }
    throw err;
  }
}

/**
 * Build platform_options for a single platform with correct fields.
 *
 * @param {string} platform
 * @param {Object} opts
 * @param {string} [opts.title]
 * @param {string[]} [opts.tags]
 * @param {string} [opts.aspectRatio]
 * @param {string} [opts.postType]
 * @param {number} [opts.videoDurationSeconds]
 * @returns {Object}
 */
export function buildPlatformOptions(platform, opts = {}) {
  const { title, tags = [], aspectRatio = "16:9", postType = "video", videoDurationSeconds } = opts;
  const p = platform?.toLowerCase();

  if (p === "youtube") {
    return {
      title: title || undefined,
      tags: tags.length ? tags : undefined,
      visibility: "public",
    };
  }

  if (p === "tiktok") {
    const baseOpts = {
      disable_comment: false,
      disable_duet: false,
      disable_stitch: false,
    };
    if (postType === "photo") {
      baseOpts.photo_cover_index = 0;
    } else {
      // Inline TikTok cover timestamp: 10% into video, min 500ms, max 3000ms
      const dur = videoDurationSeconds || 0;
      const ts = dur > 0 ? Math.min(Math.max(Math.round(dur * 0.1 * 1000), 500), 3000) : 1000;
      baseOpts.video_cover_timestamp_ms = ts;
    }
    return baseOpts;
  }

  if (p === "instagram" || p === "facebook") {
    return {
      post_type: postType === "reel" ? "reel" : postType === "story" ? "story" : "feed",
    };
  }

  return {};
}

/**
 * Get the status of a specific Mallary post job
 * @param {string} jobId - Mallary job ID
 */
export async function getMallaryPostStatus(jobId) {
  try {
    const data = await mallaryFetch(`/api/v1/jobs/${jobId}`);
    return data;
  } catch (err) {
    logger.error(`Failed to get Mallary post status [${jobId}]: ${err.message}`);
    throw err;
  }
}

/**
 * List all posts from Mallary (with optional filters)
 * @param {Object} filters
 * @param {string} filters.platform - Filter by platform
 * @param {string} filters.status - Filter by status
 * @param {number} filters.page - Page number
 * @param {number} filters.limit - Items per page
 */
export async function listMallaryPosts(filters = {}) {
  try {
    const params = new URLSearchParams();
    if (filters.platform) params.set("platform", filters.platform);
    if (filters.status) params.set("status", filters.status);
    if (filters.page) params.set("page", String(filters.page));
    if (filters.limit) params.set("limit", String(filters.limit));

    const query = params.toString() ? `?${params.toString()}` : "";
    const data = await mallaryFetch(`/api/v1/posts${query}`);
    return data;
  } catch (err) {
    logger.error(`Failed to list Mallary posts: ${err.message}`);
    throw err;
  }
}

/**
 * Delete / cancel a scheduled Mallary post
 * @param {string} jobId - Mallary job ID
 */
export async function deleteMallaryPost(jobId) {
  try {
    const data = await mallaryFetch(`/api/v1/posts/${jobId}`, {
      method: "DELETE",
    });
    logger.info(`Mallary post deleted: ${jobId}`);
    return data;
  } catch (err) {
    logger.error(`Failed to delete Mallary post [${jobId}]: ${err.message}`);
    throw err;
  }
}

/**
 * Update a scheduled Mallary post (reschedule, edit caption, etc.)
 * @param {string} jobId - Mallary job ID
 * @param {Object} updates - Fields to update
 */
export async function updateMallaryPost(jobId, updates) {
  try {
    const data = await mallaryFetch(`/api/v1/posts/${jobId}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
    logger.info(`Mallary post updated: ${jobId}`);
    return data;
  } catch (err) {
    logger.error(`Failed to update Mallary post [${jobId}]: ${err.message}`);
    throw err;
  }
}

/**
 * Check if Mallary API is reachable and key is valid
 */
export async function pingMallary() {
  try {
    const data = await mallaryFetch("/api/health");
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Build a schedule time N minutes from now (default auto-post delay)
 */
export function getDefaultScheduleTime(offsetMinutes = 60) {
  const now = new Date();
  now.setMinutes(now.getMinutes() + offsetMinutes);
  return now.toISOString();
}
