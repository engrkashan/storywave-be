/**
 * finalAssemblyService.js
 * Storywave Editor — Merge & Continue final assembly.
 *
 * Reconstructs the final video from persisted Scene records (Cloudinary assets)
 * using the exact same rendering pipeline as the original workflow:
 *   1. Load workflow + scenes from DB
 *   2. Download each active scene asset from Cloudinary to temp
 *   3. Re-run renderMediaSegment (subtitles, normalization)
 *   4. concatSegments with the locked audio track
 *   5. Upload final video to Cloudinary
 *   6. Create Video DB record + update Workflow
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { cloudinary } from "../config/cloudinary.config.js";
import prisma from "../config/prisma.client.js";
import { deleteTempFiles } from "../utils/deleteTemp.js";
import { createLogger } from "../utils/logger.js";
import {
  concatSegments,
  renderMediaSegment,
  convertTranscriptToAss,
} from "./videoService.js";
import {
  validateCanonicalTimeline,
  logSyncDiagnostics,
  buildSubtitleGroups,
  secToMs,
  msToSec,
} from "./timelineService.js";
const TEMP_ROOT = path.resolve(process.cwd(), "temp");
fs.mkdirSync(TEMP_ROOT, { recursive: true });
const logger = createLogger("FinalAssemblyService");

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  timeout: 60000,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 32,
  timeout: 60000,
});

/**
 * Download a URL to a local file path with persistent keep-alive agents, redirect support,
 * and exponential backoff retry. Eliminates Undici/Fetch ConnectTimeoutError.
 */
function downloadFileOnce(url, destPath, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const isHttps = url.startsWith("https");
    const client = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    let timer = null;
    const req = client.get(
      url,
      {
        agent,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "*/*",
        },
      },
      (res) => {
        // Follow redirects (301, 302, 307, 308)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timer);
          const redirectUrl = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          return downloadFileOnce(redirectUrl, destPath, timeoutMs).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          clearTimeout(timer);
          return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ""}`));
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          const buffer = Buffer.concat(chunks);
          if (buffer.length === 0) {
            return reject(new Error("Received empty 0-byte payload"));
          }
          try {
            fs.writeFileSync(destPath, buffer);
            resolve(destPath);
          } catch (writeErr) {
            reject(writeErr);
          }
        });
        res.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      }
    );

    timer = setTimeout(() => {
      req.destroy(new Error(`Connection timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function downloadFile(url, destPath, retries = 4, timeoutMs = 60000) {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await downloadFileOnce(url, destPath, timeoutMs);
      return destPath;
    } catch (err) {
      lastError = err;
      if (fs.existsSync(destPath)) {
        try { fs.unlinkSync(destPath); } catch (_) { }
      }

      if (attempt < retries) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 6000);
        logger.warn(`⚠️ [FinalAssembly Download] Attempt ${attempt}/${retries} failed for ${path.basename(destPath)} (${err.message}). Retrying in ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        logger.error(`❌ [FinalAssembly Download] All ${retries} attempts failed for ${url}: ${err.message}`);
      }
    }
  }

  throw new Error(`Download failed for ${path.basename(destPath)}: ${lastError?.message || String(lastError)}`);
}

/**
 * Upload the final merged video to Cloudinary.
 */
function uploadLargePromise(filePath, options) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_large(filePath, options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

async function uploadFinalVideo(videoPath, filename) {
  const stats = fs.statSync(videoPath);
  logger.info(`📦 [FinalAssembly] Video size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  const uploaded = await uploadLargePromise(videoPath, {
    resource_type: "video",
    folder: "videos",
    public_id: path.parse(filename).name,
    chunk_size: 20000000,
    timeout: 3600000,
    overwrite: true,
  });

  logger.info(`[FinalAssembly] Final video uploaded: ${uploaded.secure_url}`);
  return uploaded.secure_url;
}

/**
 * runFinalAssembly — The Merge & Continue entry point.
 *
 * @param {string} workflowId
 */
export async function runFinalAssembly(workflowId) {
  logger.info(`EDITOR_MERGE_STARTED workflowId=${workflowId}`);

  // ── 1. Load workflow and scenes from DB ────────────────────────────────────
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
    include: { story: true },
  });
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

  const meta = workflow.metadata || {};
  const title = meta._editorTitle || workflow.title;
  const userId = meta._editorUserId || workflow.userId;
  const dualPlatform = meta.dualPlatform ?? false;
  const aspectRatio = meta._editorAspectRatio || meta.aspectRatio || "16:9";
  const characterTalk = meta._editorCharacterTalk ?? false;
  const hasVoiceSelected = meta._editorHasVoiceSelected ?? false;
  let actualAudioDuration = meta._editorActualAudioDuration || 0;
  const finalAudioUrl = meta._editorFinalAudioUrl || workflow.story?.audioURL || null;
  let masterTimeline = meta._editorMasterTimeline || meta.masterTimeline || null;

  if (!masterTimeline || !Array.isArray(masterTimeline.scenes) || masterTimeline.scenes.length === 0) {
    logger.warn(`⚠️ [FinalAssembly] masterTimeline not found in metadata for workflow ${workflowId} — dynamically reconstructing canonical timeline from DB scenes`);
    const dbScenes = await prisma.scene.findMany({
      where: { workflowId },
      orderBy: { index: "asc" },
    });

    const uniqueScenes = [];
    const seenIndices = new Set();
    let calculatedDurationMs = 0;

    for (const sc of dbScenes) {
      if (!seenIndices.has(sc.index)) {
        seenIndices.add(sc.index);
        const durationSec = sc.durationSec || 5.0;
        const durationMs = secToMs(durationSec);
        const startMs = sc.startSec !== null && sc.startSec !== undefined ? secToMs(sc.startSec) : calculatedDurationMs;
        const endMs = sc.endSec !== null && sc.endSec !== undefined ? secToMs(sc.endSec) : (startMs + durationMs);
        calculatedDurationMs = endMs;

        uniqueScenes.push({
          index: sc.index,
          sceneIndex: sc.index,
          sceneId: `scene_${String(sc.index + 1).padStart(3, "0")}`,
          startMs,
          endMs,
          durationMs,
          startSec: msToSec(startMs),
          endSec: msToSec(endMs),
          durationSec: msToSec(durationMs),
          audioStartMs: startMs,
          audioEndMs: endMs,
          subtitleStartMs: startMs,
          subtitleEndMs: endMs,
          narration: sc.narration || "",
        });
      }
    }

    if (uniqueScenes.length === 0) {
      throw new Error(`[FinalAssembly] Workflow ${workflowId} has no scenes in database — cannot assemble`);
    }

    if (!actualAudioDuration) {
      actualAudioDuration = msToSec(calculatedDurationMs);
    }

    const words = masterTimeline?.words || meta.timelineWords || [];
    const subtitleGroups = words.length > 0 ? buildSubtitleGroups(words) : (masterTimeline?.subtitleGroups || []);

    masterTimeline = {
      version: 2,
      actualSceneCount: uniqueScenes.length,
      totalDuration: actualAudioDuration,
      totalDurationMs: secToMs(actualAudioDuration),
      scenes: uniqueScenes,
      subtitleGroups,
      words,
    };
    logger.info(`🗺️ [FinalAssembly] Reconstructed canonical masterTimeline with ${uniqueScenes.length} scenes (totalDuration: ${actualAudioDuration.toFixed(1)}s)`);
  }

  // Run integrity validation on canonical timeline
  const val = validateCanonicalTimeline(masterTimeline, secToMs(actualAudioDuration));
  if (!val.valid) {
    logger.warn(`⚠️ [FinalAssembly Timeline Integrity Warning]: ${val.errors.join(" | ")}`);
  } else {
    logger.info(`✅ [FinalAssembly Timeline Integrity Validated]: 0ms drift across ${masterTimeline.scenes.length} scenes`);
  }

  // Determine ratios to assemble
  const ratiosToGenerate = dualPlatform ? ["16:9", "9:16"] : [aspectRatio];

  // Set workflow to PROCESSING
  await prisma.workflow.update({
    where: { id: workflowId },
    data: { status: "PROCESSING" },
  });
  logger.info(`[FinalAssembly] Workflow ${workflowId} → PROCESSING`);

  const assemblyTempDir = path.join(TEMP_ROOT, `assembly_${workflowId}_${Date.now()}`);
  fs.mkdirSync(assemblyTempDir, { recursive: true });

  const videoResults = {};

  try {
    // ── 2. Parallel download audio & scene assets from Cloudinary ────────────
    let finalAudioLocalPath = null;
    const downloadTasks = [];

    if (finalAudioUrl) {
      finalAudioLocalPath = path.join(assemblyTempDir, "final_audio.mp3");
      logger.info(`[FinalAssembly] Downloading audio: ${finalAudioUrl}`);
      downloadTasks.push(() => downloadFile(finalAudioUrl, finalAudioLocalPath));
    }

    // Pre-load scenes and prepare directories for each ratio
    const ratioScenesMap = {};
    for (const currentRatio of ratiosToGenerate) {
      const ratioDir = path.join(assemblyTempDir, currentRatio.replace(":", "_"));
      fs.mkdirSync(ratioDir, { recursive: true });

      const scenes = await prisma.scene.findMany({
        where: {
          workflowId,
          ratio: currentRatio,
          status: "GENERATED",
        },
        orderBy: { index: "asc" },
      });

      ratioScenesMap[currentRatio] = { scenes, ratioDir };

      for (const scene of scenes) {
        if (!scene.assetUrl) continue;
        const ext = scene.assetType === "video" ? "mp4" : "jpg";
        const assetLocalPath = path.join(
          ratioDir,
          `scene_${String(scene.index).padStart(3, "0")}.${ext}`
        );
        scene._assetLocalPath = assetLocalPath;
        downloadTasks.push(() =>
          downloadFile(scene.assetUrl, assetLocalPath).catch((err) => {
            logger.error(`❌ [FinalAssembly] Failed downloading scene ${scene.index} [${currentRatio}]: ${err.message}`);
            throw err;
          })
        );
      }
    }

    logger.info(`⚡ [FinalAssembly] Starting controlled batch download of ${downloadTasks.length} assets (audio + scene visuals)...`);
    const DOWNLOAD_CONCURRENCY = 8;
    for (let i = 0; i < downloadTasks.length; i += DOWNLOAD_CONCURRENCY) {
      const batch = downloadTasks.slice(i, i + DOWNLOAD_CONCURRENCY);
      await Promise.all(batch.map((taskFn) => taskFn()));
    }
    logger.info(`✅ [FinalAssembly] All ${downloadTasks.length} assets downloaded successfully`);

    // ── 3. For each ratio, assemble final video ──────────────────────────────
    for (const currentRatio of ratiosToGenerate) {
      const { scenes, ratioDir } = ratioScenesMap[currentRatio] || {};
      if (!scenes || scenes.length === 0) {
        logger.warn(`[FinalAssembly] No GENERATED scenes for ratio ${currentRatio} — skipping`);
        continue;
      }

      logger.info(`[FinalAssembly] Assembling ratio: ${currentRatio}`);

      const isVertical = currentRatio === "9:16";
      const width = isVertical ? 1080 : 1920;
      const height = isVertical ? 1920 : 1080;

      const videoFilename = `${workflowId}-${currentRatio.replace(":", "_")}-merge-${Date.now()}.mp4`;
      const videoPath = path.join(assemblyTempDir, videoFilename);

      // For each scene: renderMediaSegment from locally downloaded file
      const segmentFiles = new Array(scenes.length).fill(null);

      for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const assetLocalPath = scene._assetLocalPath;
        if (!assetLocalPath || !fs.existsSync(assetLocalPath)) {
          logger.warn(`[FinalAssembly] Scene asset missing at ${assetLocalPath} — skipping`);
          continue;
        }

        // Build subtitle .ass file for this scene slot
        const sceneId = `scene_${String(scene.index + 1).padStart(3, "0")}`;
        const segmentPath = path.join(ratioDir, `${sceneId}_seg.mp4`);
        segmentFiles[i] = segmentPath;

        const segmentAssPath = path.join(assemblyTempDir, `subs-${sceneId}-${Date.now()}.ass`);
        convertTranscriptToAss(masterTimeline, segmentAssPath, currentRatio, scene.index);
        const escapedSegmentAssPath = segmentAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");

        try {
          await renderMediaSegment(
            assetLocalPath,
            segmentPath,
            scene.durationSec,
            width,
            height,
            escapedSegmentAssPath
          );
          logger.info(`[FinalAssembly] Rendered segment ${scene.index} (${scene.durationSec}s)`);
        } catch (err) {
          logger.error(`[FinalAssembly] Failed to render segment ${scene.index}: ${err.message}`);
          segmentFiles[i] = null;
        } finally {
          if (fs.existsSync(segmentAssPath)) fs.unlinkSync(segmentAssPath);
        }
      }

      const validSegments = segmentFiles.filter(Boolean);
      if (validSegments.length === 0) {
        logger.warn(`[FinalAssembly] No valid segments for ratio ${currentRatio} — skipping concat`);
        continue;
      }

      // Concat all segments with audio
      const useSegmentAudioOnly = characterTalk && !hasVoiceSelected;
      const mixSegmentAudio = characterTalk && hasVoiceSelected;

      await concatSegments(validSegments, finalAudioLocalPath, videoPath, actualAudioDuration, null, {
        useSegmentAudioOnly,
        mixSegmentAudio,
        masterTimeline,
      });
      logger.info(`[FinalAssembly] Concatenated ${validSegments.length} segments for ${currentRatio}`);

      // Upload final video
      const finalUrl = await uploadFinalVideo(videoPath, videoFilename);
      videoResults[currentRatio] = { url: finalUrl };
      logger.info(`[FinalAssembly] Final video uploaded for ${currentRatio}: ${finalUrl}`);
    }

    if (Object.keys(videoResults).length === 0) {
      throw new Error("[FinalAssembly] No video was produced — all ratios failed");
    }

    // ── 4. Create Video DB record ────────────────────────────────────────────
    const primaryUrl = videoResults[aspectRatio]?.url || Object.values(videoResults)[0]?.url;
    const videoRecord = await prisma.video.create({
      data: {
        title: dualPlatform ? `${title} (Dual Version)` : title,
        fileURL: primaryUrl,
        video_16_9: videoResults["16:9"]?.url || null,
        video_9_16: videoResults["9:16"]?.url || null,
        userId,
      },
    });
    logger.info(`[FinalAssembly] Video DB record created: ${videoRecord.id}`);

    // ── 5. Mark workflow COMPLETED ───────────────────────────────────────────
    const freshMeta = (await prisma.workflow.findUnique({
      where: { id: workflowId },
      select: { metadata: true },
    }))?.metadata || {};

    await prisma.workflow.update({
      where: { id: workflowId },
      data: {
        videoId: videoRecord.id,
        status: "COMPLETED",
        metadata: {
          ...freshMeta,
          result: {
            ...(freshMeta.result || {}),
            hasMedia: true,
            hasVideo: true,
            mergedAt: new Date().toISOString(),
          },
        },
      },
    });

    // Update story audioURL (in case it wasn't set)
    if (workflow.story && finalAudioUrl) {
      await prisma.story.update({
        where: { id: workflow.story.id },
        data: { audioURL: finalAudioUrl },
      }).catch(() => { }); // non-fatal
    }

    // 🚀 Auto-publish to social media via Mallary.ai if configured
    try {
      const autoPublishEnabled = process.env.MALLARY_AUTO_PUBLISH === "true" || meta.autoPublish === true;
      if (autoPublishEnabled && primaryUrl && meta.autoPublish !== false) {
        const freshStory = await prisma.story.findUnique({ where: { id: workflow.story?.id || workflow.storyId } });
        const { autoPublishStory } = await import("./socialPublishService.js");
        await autoPublishStory(workflowId, {
          videoUrl: primaryUrl,
          audioUrl: finalAudioUrl,
          story: freshStory,
          aspectRatio: meta.aspectRatio || aspectRatio,
          delayMinutes: meta.autoPublishDelayMinutes,
        });
        logger.info("📡 [FinalAssembly] Auto-publish to Mallary triggered successfully");
      }
    } catch (publishErr) {
      logger.error(`⚠️ [FinalAssembly] Auto-publish to Mallary failed (non-fatal): ${publishErr.message}`);
    }

    logger.info(`EDITOR_MERGE_COMPLETED workflowId=${workflowId}`);

    return {
      success: true,
      workflowId,
      video: primaryUrl,
      videoId: videoRecord.id,
    };
  } catch (err) {
    logger.error(`EDITOR_MERGE_FAILED workflowId=${workflowId} error="${err.message}"`);

    // Return to USER_CONFIRMATION_REQUIRED so user can retry merge
    const freshMeta = (await prisma.workflow.findUnique({
      where: { id: workflowId },
      select: { metadata: true },
    }))?.metadata || {};

    await prisma.workflow.update({
      where: { id: workflowId },
      data: {
        status: "USER_CONFIRMATION_REQUIRED",
        metadata: {
          ...freshMeta,
          mergeError: err.message,
          mergeFailedAt: new Date().toISOString(),
        },
      },
    }).catch(() => { });

    throw err;
  } finally {
    deleteTempFiles(assemblyTempDir);
  }
}
