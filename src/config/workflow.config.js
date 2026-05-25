export const config = {
  workflow: {
    maxWorkerConcurrency: parseInt(process.env.MAX_WORKER_CONCURRENCY || "1", 10),
    maxFfmpegConcurrency: parseInt(process.env.MAX_FFMPEG_CONCURRENCY || "1", 10),
    maxApiConcurrency: parseInt(process.env.MAX_API_CONCURRENCY || "5", 10),
    ffmpegThreads: parseInt(process.env.FFMPEG_THREADS || "1", 10),
    enableQueue: process.env.ENABLE_QUEUE !== "false", // Default to true
  },
  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
  }
};
