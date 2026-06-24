import { createLogger } from "../utils/logger.js";

const logger = createLogger("ThumbnailService");

const MALLARY_BASE_URL = process.env.MALLARY_API_BASE_URL || "https://mallary.ai";
const MALLARY_API_KEY = process.env.MALLARY_API_KEY;
const MALLARY_CDN_ORIGIN = "https://files.mallary.ai";

// ─── Format Constraints ───────────────────────────────────────────────────────

const THUMBNAIL_RULES = {
  youtube: {
    allowedMimes: ["image/jpeg", "image/jpg", "image/png"],
    maxBytes: 2 * 1024 * 1024, // 2 MB
    minWidth: 640,
    preferredWidth: 1280,
    preferredHeight: 720,
    label: "YouTube thumbnail",
  },
  facebook: {
    allowedMimes: ["image/jpeg", "image/jpg", "image/png"],
    maxBytes: 10 * 1024 * 1024, // 10 MB
    label: "Facebook thumbnail",
  },
  instagram: {
    allowedMimes: ["image/jpeg", "image/jpg", "image/png"],
    maxBytes: 8 * 1024 * 1024, // 8 MB
    label: "Instagram cover image",
  },
  tiktok: null, // TikTok does NOT use thumbnail_url
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the URL is already hosted on the Mallary CDN.
 */
export function isMallaryCdnUrl(url) {
  if (!url) return false;
  return url.startsWith(MALLARY_CDN_ORIGIN);
}

/**
 * Derive MIME type from a URL or a provided override.
 */
function mimeFromUrl(url, override) {
  if (override) return override.toLowerCase();
  const ext = url?.split("?")[0].split(".").pop()?.toLowerCase();
  const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  return map[ext] || "image/jpeg";
}

/**
 * Fetch a remote URL as a Buffer, following redirects.
 */
async function fetchRemoteBuffer(url) {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`Failed to fetch remote file: HTTP ${resp.status} for ${url}`);
  const arrayBuffer = await resp.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType: resp.headers.get("content-type") || "image/jpeg" };
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate thumbnail constraints for a platform.
 *
 * @param {Object} opts
 * @param {string} opts.url - The thumbnail URL to validate
 * @param {string} opts.platform - Target platform
 * @param {string} [opts.mimeType] - Override MIME type if known
 * @param {number} [opts.fileSizeBytes] - Override file size if known
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateThumbnailForPlatform({ url, platform, mimeType, fileSizeBytes }) {
  const errors = [];
  const rules = THUMBNAIL_RULES[platform?.toLowerCase()];

  if (!rules) {
    // TikTok or unknown — thumbnails not allowed
    if (platform?.toLowerCase() === "tiktok") {
      return { valid: true, errors: [], note: "TikTok does not use external thumbnail_url — skipping validation" };
    }
    return { valid: false, errors: [`Unknown platform: ${platform}`] };
  }

  if (!url) {
    return { valid: false, errors: [`${rules.label}: URL is required`] };
  }

  // Format check
  const mime = mimeFromUrl(url, mimeType);
  if (!rules.allowedMimes.includes(mime)) {
    errors.push(`${rules.label}: unsupported format "${mime}". Allowed: ${rules.allowedMimes.join(", ")}`);
  }

  // File size check (if known)
  if (fileSizeBytes && rules.maxBytes && fileSizeBytes > rules.maxBytes) {
    const mbLimit = (rules.maxBytes / 1024 / 1024).toFixed(0);
    const mbActual = (fileSizeBytes / 1024 / 1024).toFixed(2);
    errors.push(`${rules.label}: file is ${mbActual}MB, max is ${mbLimit}MB`);
  }

  return { valid: errors.length === 0, errors };
}

// ─── Mallary CDN Upload ───────────────────────────────────────────────────────

/**
 * Upload a thumbnail image to Mallary CDN via /api/v1/upload.
 * Accepts either a remote URL (fetched server-side) or a local Buffer.
 *
 * @param {string|Buffer} source - Remote URL or raw Buffer
 * @param {Object} [opts]
 * @param {string} [opts.mimeType] - MIME type override (e.g. "image/jpeg")
 * @param {string} [opts.filename] - Filename hint for the upload
 * @param {string} [opts.platform] - Platform context for logging
 * @returns {Promise<string>} Mallary CDN URL (https://files.mallary.ai/...)
 */
export async function uploadThumbnailToMallary(source, opts = {}) {
  if (!MALLARY_API_KEY) throw new Error("MALLARY_API_KEY is not set");

  const platform = opts.platform || "unknown";
  logger.info(`[${platform}] Uploading thumbnail to Mallary CDN...`);

  let buffer;
  let mimeType;
  let filename = opts.filename || "thumbnail.jpg";

  if (typeof source === "string") {
    // If already a Mallary CDN URL, skip upload
    if (isMallaryCdnUrl(source)) {
      logger.info(`[${platform}] Thumbnail already on Mallary CDN: ${source}`);
      return source;
    }

    logger.info(`[${platform}] Fetching remote thumbnail: ${source}`);
    const fetched = await fetchRemoteBuffer(source);
    buffer = fetched.buffer;
    mimeType = opts.mimeType || fetched.contentType || mimeFromUrl(source);
    // Derive filename from URL if not overridden
    const urlPath = source.split("?")[0].split("/").pop();
    if (urlPath && urlPath.includes(".")) filename = urlPath;
  } else {
    // Raw Buffer
    buffer = source;
    mimeType = opts.mimeType || "image/jpeg";
  }

  const uploadUrl = `${MALLARY_BASE_URL}/api/v1/upload`;
  logger.info(`[${platform}] Requesting presigned URL from ${uploadUrl} for ${filename} (${(buffer.length / 1024).toFixed(1)} KB, ${mimeType})`);

  // Step 1: Request presigned URL
  const initResponse = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MALLARY_API_KEY}`,
    },
    body: JSON.stringify({
      filename: filename,
      size: buffer.length,
      type: mimeType
    }),
  });

  const initText = await initResponse.text();
  let initData;
  try {
    initData = JSON.parse(initText);
  } catch {
    initData = { raw: initText };
  }

  if (!initResponse.ok) {
    const errMsg = initData?.message || initData?.error || `HTTP ${initResponse.status}`;
    logger.error(`[${platform}] Mallary CDN presigned URL request failed: ${errMsg} | Response: ${initText}`);
    throw new Error(`Mallary CDN presigned URL request failed: ${errMsg}`);
  }

  const presignedUrl = initData?.uploadUrl;
  const mediaUrl = initData?.mediaUrl;
  const uploadHeaders = initData?.headers || {};

  if (!presignedUrl || !mediaUrl) {
    logger.error(`[${platform}] Mallary upload response missing uploadUrl or mediaUrl: ${JSON.stringify(initData)}`);
    throw new Error("Mallary CDN upload succeeded but returned incomplete data");
  }

  logger.info(`[${platform}] Received presigned URL response: ${initText}`);
  logger.info(`[${platform}] Uploading raw binary data to S3...`);

  // Step 2: Upload raw file to presigned URL
  const putResponse = await fetch(presignedUrl, {
    method: "PUT",
    headers: uploadHeaders,
    body: buffer,
  });

  if (!putResponse.ok) {
    const putText = await putResponse.text();
    logger.error(`[${platform}] S3 PUT upload failed: HTTP ${putResponse.status} | Response: ${putText}`);
    throw new Error(`S3 PUT upload failed: HTTP ${putResponse.status}`);
  }

  logger.info(`[${platform}] Thumbnail uploaded to Mallary CDN: ${mediaUrl}`);
  return mediaUrl;
}

// ─── Per-Platform Payload Builder ─────────────────────────────────────────────

/**
 * Calculate a cover frame timestamp in ms from video duration (for TikTok).
 * Uses 10% into the video, capped at 3 seconds, minimum 500ms.
 *
 * @param {number} [durationSeconds] - Video duration in seconds
 * @returns {number} Timestamp in milliseconds
 */
export function calculateTikTokCoverTimestamp(durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) return 1000; // 1 second default
  const tenPercent = durationSeconds * 0.1 * 1000;
  return Math.min(Math.max(Math.round(tenPercent), 500), 3000);
}

/**
 * Attach the correct thumbnail/cover fields to a Mallary post payload,
 * following per-platform rules.
 *
 * @param {Object} params
 * @param {string} params.platform - "youtube" | "facebook" | "instagram" | "tiktok"
 * @param {Object} params.mediaObject - The media object in the Mallary body (mutated in place)
 * @param {Object} params.platformOptions - The platform_options[platform] object (mutated in place)
 * @param {string|null} params.thumbnailCdnUrl - Mallary CDN URL for thumbnail
 * @param {string} [params.aspectRatio] - Content aspect ratio e.g. "16:9", "9:16", "1:1"
 * @param {string} [params.postType] - Content type e.g. "video", "reel", "story", "photo"
 * @param {number} [params.videoDurationSeconds] - For TikTok timestamp calculation
 * @param {number} [params.photoIndex] - For TikTok photo cover index
 */
export function attachThumbnailToPayload({
  platform,
  mediaObject,
  platformOptions,
  thumbnailCdnUrl,
  aspectRatio,
  postType,
  videoDurationSeconds,
  photoIndex,
}) {
  const p = platform?.toLowerCase();

  // ── YouTube ─────────────────────────────────────────────────────────────────
  if (p === "youtube") {
    const isShort = aspectRatio === "9:16";
    if (isShort) {
      logger.info(`[youtube] Skipping thumbnail — YouTube Shorts do not support custom thumbnails`);
      return;
    }
    if (thumbnailCdnUrl) {
      mediaObject.thumbnail_url = thumbnailCdnUrl;
      logger.info(`[youtube] Attached thumbnail_url to media object: ${thumbnailCdnUrl}`);
    } else {
      logger.warn(`[youtube] No CDN thumbnail URL available — YouTube post will have no thumbnail`);
    }
    return;
  }

  // ── Facebook ─────────────────────────────────────────────────────────────────
  if (p === "facebook") {
    if (thumbnailCdnUrl) {
      platformOptions.thumbnail_url = thumbnailCdnUrl;
      logger.info(`[facebook] Attached thumbnail_url to platform_options: ${thumbnailCdnUrl}`);
    }
    return;
  }

  // ── Instagram ─────────────────────────────────────────────────────────────────
  if (p === "instagram") {
    const isVideoContent =
      postType === "reel" ||
      postType === "story" ||
      postType === "video" ||
      postType === "feed_video";
    if (isVideoContent && thumbnailCdnUrl) {
      mediaObject.cover_url = thumbnailCdnUrl;
      logger.info(`[instagram] Attached cover_url to media object (${postType}): ${thumbnailCdnUrl}`);
    } else if (!isVideoContent) {
      logger.info(`[instagram] Skipping cover — not a video post type`);
    } else {
      logger.warn(`[instagram] No CDN cover URL available — Instagram video will have no cover`);
    }
    return;
  }

  // ── TikTok ───────────────────────────────────────────────────────────────────
  if (p === "tiktok") {
    // Never send thumbnail_url for TikTok
    if (thumbnailCdnUrl) {
      logger.warn(`[tiktok] thumbnail_url is NOT sent for TikTok — using cover timestamp instead`);
    }
    if (postType === "photo") {
      platformOptions.photo_cover_index = typeof photoIndex === "number" ? photoIndex : 0;
      logger.info(`[tiktok] Attached photo_cover_index: ${platformOptions.photo_cover_index}`);
    } else {
      // Default: video cover timestamp
      const timestamp = calculateTikTokCoverTimestamp(videoDurationSeconds);
      platformOptions.video_cover_timestamp_ms = timestamp;
      logger.info(`[tiktok] Attached video_cover_timestamp_ms: ${timestamp}ms (video duration: ${videoDurationSeconds || "unknown"}s)`);
    }
    return;
  }

  logger.warn(`attachThumbnailToPayload: unknown platform "${platform}" — no thumbnail attached`);
}
