import dotenv from "dotenv";
dotenv.config();

export const config = {
  workflow: {
    maxWorkerConcurrency: parseInt(process.env.MAX_WORKER_CONCURRENCY || "1", 10),
    maxFfmpegConcurrency: parseInt(process.env.MAX_FFMPEG_CONCURRENCY || "1", 10),
    // Controls parallel segment renders per workflow (independent from final-merge semaphore)
    maxSegmentConcurrency: parseInt(process.env.MAX_SEGMENT_CONCURRENCY || "2", 10),
    maxApiConcurrency: parseInt(process.env.MAX_API_CONCURRENCY || "5", 10),
    imageConcurrency: parseInt(process.env.IMAGE_CONCURRENCY || "3", 10),
    ffmpegThreads: parseInt(process.env.FFMPEG_THREADS || "2", 10),
    enableQueue: process.env.ENABLE_QUEUE !== "false", // Default to true
  },
  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  // ─── AI Image Model Configuration ─────────────────────────────────────────
  // Store all model IDs here so upgrades are a single-line change.
  // Never scatter model strings throughout the codebase.
  ai: {
    image: {
      // Tier 1 — Primary: best quality, multimodal, supports reference images
      primaryModel: process.env.GEMINI_IMAGE_PRIMARY_MODEL || "gemini-3-pro-image",
      // Tier 2 — Fallback: used ONLY when primaryModel fails (quota, timeout, server error)
      fallbackModel: process.env.GEMINI_IMAGE_FALLBACK_MODEL || "gemini-3.1-flash-image-preview",
      // Text model used exclusively for intelligent safety prompt repair
      repairModel: process.env.GEMINI_REPAIR_MODEL || "gemini-2.5-flash",
      // OpenAI model used as fallback for prompt repair when Gemini repair model is unavailable
      openaiRepairModel: process.env.OPENAI_REPAIR_MODEL || "gpt-5",
    },
  },
};
