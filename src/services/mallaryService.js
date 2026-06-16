import { createLogger } from "../utils/logger.js";

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
    const errMsg = data?.message || data?.error || `HTTP ${response.status}`;
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
 * Create/schedule a post on Mallary
 * @param {Object} postData
 * @param {string} postData.platform - e.g. "instagram", "youtube", "tiktok", "facebook"
 * @param {string} postData.channelId - Mallary channel/account ID
 * @param {string} postData.caption - Post caption/description
 * @param {string} postData.mediaUrl - URL of the video/image to post
 * @param {string|null} postData.scheduledAt - ISO datetime string for scheduling (null = immediate)
 * @param {string|null} postData.thumbnailUrl - Thumbnail URL (for YouTube etc.)
 * @param {string[]} postData.tags - Hashtags/tags for the post
 * @param {string|null} postData.title - Post title (for YouTube)
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
  } = postData;

  logger.info(`Creating Mallary post: platform=${platform}, channel=${channelId}, scheduled=${scheduledAt}`);

  const body = {
    message: caption || title || "New post",
    platforms: [platform],
    media: mediaUrl ? [{ url: mediaUrl }] : [],
    scheduled_at: scheduledAt,
    platform_options: {
      [platform]: {
        title: title,
        thumbnail_url: thumbnailUrl,
        tags: tags,
      }
    }
  };

  try {
    const data = await mallaryFetch("/api/v1/post", {
      method: "POST",
      body: JSON.stringify(body),
    });

    logger.info(`Mallary post created: job_id=${data?.id || data?.job_id}`);
    return data;
  } catch (err) {
    logger.error(`Failed to create Mallary post [${platform}]: ${err.message}`);
    throw err;
  }
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
 * Build a schedule time 1 hour from now (default auto-post delay)
 */
export function getDefaultScheduleTime(offsetMinutes = 60) {
  const now = new Date();
  now.setMinutes(now.getMinutes() + offsetMinutes);
  return now.toISOString();
}
