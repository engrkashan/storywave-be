import { Queue, Worker, QueueEvents } from "bullmq";
import { PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import path from "path";
import fs from "fs";
import { config } from "../src/config/workflow.config.js";
import { addWorkflowJob } from "../src/services/queueService.js";

const prisma = new PrismaClient();
const redisConnection = new IORedis(process.env.REDIS_URL || "redis://93.127.216.8:6379");

async function runBenchmark(imageCount) {
  console.log(`\n======================================================`);
  console.log(`🚀 STARTING BENCHMARK: ${imageCount} Images`);
  console.log(`======================================================\n`);

  // Create a dummy user if none exists
  let user = await prisma.user.findFirst();
  if (!user) {
    user = await prisma.user.create({
      data: {
        email: "benchmark@mallary.ai",
        passwordHash: "dummy",
        name: "Benchmark Runner"
      }
    });
  }

  // Create workflow record
  const workflow = await prisma.workflow.create({
    data: {
      user: { connect: { id: user.id } },
      title: `Benchmark - ${imageCount} Images`,
      type: "STORY",
      status: "PENDING",
      metadata: {
        prompt: `[BENCHMARK] Generate a ${imageCount} image story about space exploration.`,
        mediaType: "multi_image",
        imageCount: imageCount,
        imagePrompt: "cinematic space exploration, 4k",
        aspectRatio: "16:9",
        voice: {
          voice_id: "nPczCjzI2devNBz1zQrb",
          settings: { stability: 0.5, similarity_boost: 0.75 }
        },
        backgroundMusic: false
      }
    }
  });

  console.log(`📦 Enqueued Workflow ID: ${workflow.id}`);
  const startTime = Date.now();

  const queueEvents = new QueueEvents("story-workflows", { connection: redisConnection });
  
  await addWorkflowJob(workflow);

  console.log(`⏳ Waiting for workflow to complete...`);
  
  return new Promise((resolve, reject) => {
    queueEvents.on("completed", async ({ jobId, returnvalue }) => {
      if (jobId !== workflow.id) return;
      
      const endTime = Date.now();
      const totalSeconds = (endTime - startTime) / 1000;
      
      console.log(`✅ Workflow completed in ${totalSeconds.toFixed(1)}s`);
      await renderDashboard(workflow.id, totalSeconds, imageCount);
      
      resolve();
    });

    queueEvents.on("failed", ({ jobId, failedReason }) => {
      if (jobId !== workflow.id) return;
      console.error(`❌ Workflow failed: ${failedReason}`);
      reject(new Error(failedReason));
    });
  });
}

async function renderDashboard(workflowId, totalSeconds, imageCount) {
  // Find the latest perf-*.json file
  const tempDir = path.resolve(process.cwd(), "temp");
  const files = fs.readdirSync(tempDir)
    .filter(f => f.startsWith("perf-") && f.endsWith(".json"))
    .map(f => path.join(tempDir, f));
    
  if (files.length === 0) {
    console.log("⚠️ No telemetry found.");
    return;
  }
  
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const latestReport = files[0];
  
  const report = JSON.parse(fs.readFileSync(latestReport, "utf8"));
  
  const scenesPerMin = (imageCount / (totalSeconds / 60)).toFixed(2);
  const queueEvents = report.queueEvents || [];
  
  // Calculate average waiting tasks in segment queue
  const segmentQueue = queueEvents.filter(q => q.semaphoreName === "SegmentRender");
  let avgWait = 0;
  if (segmentQueue.length > 0) {
    avgWait = segmentQueue.reduce((acc, q) => acc + q.waiting, 0) / segmentQueue.length;
  }
  
  const imgTotal = report.summaryTable.find(r => r.category === "image")?.totalMs || 0;
  const vidTotal = report.summaryTable.find(r => r.category === "ffmpeg")?.totalMs || 0;
  
  const imgPct = ((imgTotal / report.totalDurationMs) * 100).toFixed(1);
  const vidPct = ((vidTotal / report.totalDurationMs) * 100).toFixed(1);

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  PIPELINE HEALTH DASHBOARD                    ║
╚═══════════════════════════════════════════════════════════════╝
  📊 Throughput:       ${scenesPerMin} scenes / minute
  ⏱️  Total Time:       ${totalSeconds.toFixed(1)}s
  📦 Processed:        ${imageCount} images / segments
  
  ⚙️  RESOURCE UTILIZATION
  - Image Gen Time:   ${(imgTotal/1000).toFixed(1)}s (${imgPct}% of total wall clock)
  - Segment Time:     ${(vidTotal/1000).toFixed(1)}s (${vidPct}% of total CPU time)
  - Avg Queue Depth:  ${avgWait.toFixed(1)} tasks waiting for FFmpeg
  - Peak Concurrent:  ${Math.max(0, ...segmentQueue.map(q => q.active))} FFmpeg instances
  
  💾 DISK I/O
  - Data Written:     ${(report.disk.bytesWritten / 1024 / 1024).toFixed(1)} MB
  - Data Read:        ${(report.disk.bytesRead / 1024 / 1024).toFixed(1)} MB
  - Temp Files:       ${report.disk.filesCreated} created, ${report.disk.filesDeleted} deleted

  ${avgWait > 5 ? '⚠️  WARNING: High FFmpeg Queue Depth (CPU Bound). Consider increasing MAX_SEGMENT_CONCURRENCY.' : '✅ Pipeline balanced.'}
  ${imgPct > 70 ? '⚠️  WARNING: High Image Generation Time (API Bound). Consider increasing IMAGE_CONCURRENCY.' : '✅ API throughput healthy.'}
`);
}

async function main() {
  const args = process.argv.slice(2);
  let sizes = [20, 80, 200, 500];
  
  if (args.length > 0) {
    sizes = args.map(a => parseInt(a, 10)).filter(n => !isNaN(n));
  }
  
  for (const size of sizes) {
    try {
      await runBenchmark(size);
    } catch (e) {
      console.error(`Benchmark failed for ${size} images:`, e);
    }
  }
  
  process.exit(0);
}

main().catch(console.error);
