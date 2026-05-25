module.exports = {
  apps: [
    {
      name: "storywave-api",
      script: "src/app.js",
      instances: 1, // API can have 1 or more instances
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
      }
    },
    {
      name: "storywave-worker",
      script: "src/workers/bullmq.worker.js",
      instances: 1, // IMPORTANT: Keep instances=1 to respect BullMQ concurrency logic
      autorestart: true,
      watch: false,
      max_memory_restart: "2G", // FFmpeg can use more memory
      env: {
        NODE_ENV: "production",
      }
    }
  ]
};
