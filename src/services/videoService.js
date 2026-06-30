import { exec, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getAudioDuration } from "./audioService.js";
import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../utils/logger.js";
import { config } from "../config/workflow.config.js";
import { enqueueRender, enqueueSegmentRender } from "../utils/renderQueue.js";
import { getPerfSession } from "../utils/perfLogger.js";

const logger = createLogger("VideoService");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const ZOOM_CYCLE_SECONDS = 12; // Total time for one full In-Out pulse (6s in, 6s out)
const MAX_ZOOM_LEVEL = 1.2;   // Maximum zoom factor
const FPS = 30;               // Standard frame rate

export async function createVideo(imageUrl, audioPath, outputPath, srtPath, aspectRatio = "16:9") {
  const TEMP_DIR = path.resolve(process.cwd(), "temp");
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  let imagePath = imageUrl;
  if (imageUrl.startsWith("http")) {
    const localImage = path.join(TEMP_DIR, `story-bg-${Date.now()}.png`);
    const res = await fetch(imageUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(localImage, buffer);
    imagePath = localImage;
  }

  const assPath = path.join(TEMP_DIR, `subs-${Date.now()}.ass`);
  convertSrtToAss(srtPath, assPath, aspectRatio);

  const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const audioDuration = await getAudioDuration(audioPath);

  if (!audioDuration || isNaN(audioDuration)) {
    logger.warn("⚠️ Could not detect audio duration. Fallback to -shortest only.");
  }

  // Determine target dimensions
  const isVertical = aspectRatio === "9:16";
  const width = isVertical ? 1080 : 1920;
  const height = isVertical ? 1920 : 1080;

  // Cinematic Zoom Pulse calculations
  const cycleFrames = ZOOM_CYCLE_SECONDS * FPS;
  const center = (1 + MAX_ZOOM_LEVEL) / 2;
  const amplitude = (MAX_ZOOM_LEVEL - 1) / 2;
  const totalFrames = Math.ceil(audioDuration * FPS);

  const filterComplex = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `setsar=1`,
    `zoompan=z='${center}-${amplitude}*cos(2*PI*on/${cycleFrames})':d=${totalFrames}:x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2))':s=${width}x${height}`,
    `subtitles='${escapedAssPath}'[vfinal]`
  ].join(",");

  const filterScriptPath = path.join(TEMP_DIR, `filter-${Date.now()}.txt`);
  fs.writeFileSync(filterScriptPath, filterComplex, "utf8");

  const args = [
    "-y",
    "-loglevel", "error",
    "-loop", "1",
    "-i", imagePath,
    "-i", audioPath,
    "-filter_complex_script", filterScriptPath,
    "-map", "[vfinal]",
    "-map", "1:a",
    "-c:v", "libx264",
    "-crf", "17",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-shortest",
    "-threads", String(config.workflow.ffmpegThreads)
  ];

  if (audioDuration) {
    args.push("-t", String(audioDuration));
  }
  args.push(outputPath);

  try {
    await enqueueRender(async () => {
      await new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", args);

        let errorLog = "";
        ff.stderr.on("data", (data) => {
          errorLog += data.toString();
        });

        ff.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(errorLog || `FFmpeg exited with code ${code}`));
        });

        ff.on("error", (err) => reject(err));
      });
    });
  } catch (err) {
    logger.error(`FFmpeg Error: ${err.message}`);
    throw new Error("🎥 Video creation failed. Check FFmpeg output above.");
  } finally {
    if (imagePath !== imageUrl && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
    if (fs.existsSync(filterScriptPath)) fs.unlinkSync(filterScriptPath);
  }
}

function convertSrtToAss(srtPath, assPath, aspectRatio = "16:9") {
  const perf = getPerfSession();
  const stopTimer = perf?.start("subtitle", "SRT to ASS Conversion", { srtPath });
  const srtContent = fs.readFileSync(srtPath, "utf8");
  const blocks = srtContent.trim().split(/\n\s*\n/);

  const isVertical = aspectRatio === "9:16";
  const resX = isVertical ? 1080 : 1920;
  const resY = isVertical ? 1920 : 1080;
  const fontSize = isVertical ? 80 : 130; // Slightly smaller fonts for vertical
  const posX = resX / 2;
  const posY = isVertical ? 1400 : 900; // Position lower for vertical, standard for horizontal

  let ass = `[Script Info]
Title: Cinematic Shorts Subs
ScriptType: v4.00+
PlayResX: ${resX}
PlayResY: ${resY}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding

; ---- GOLD GRADIENT FILL WITH BRIGHT STROKE & GLOW ----
Style: GoldGlow,Bebas Neue Bold,${fontSize},&H0000B8E6&,&H0000BFFF&,&H00FFFFFF&,&H64000000&,1,0,0,0,100,100,2,0,1,12,5,3,2,60,60,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) continue;

    const [startStr, endStr] = lines[1].split(" --> ");
    const fullText = lines.slice(2).join(" ").trim();
    if (!fullText) continue;

    const words = fullText.split(/\s+/);

    const startSec = parseSrtTime(startStr);
    const endSec = parseSrtTime(endStr);
    const totalDuration = endSec - startSec;

    // 🔥 3–4 words per screen
    const chunkSize = 3;
    const chunks = [];
    for (let i = 0; i < words.length; i += chunkSize) {
      chunks.push(words.slice(i, i + chunkSize).join(" "));
    }

    const chunkDuration = totalDuration / chunks.length;

    chunks.forEach((chunk, index) => {
      const s = startSec + index * chunkDuration;
      const e = s + chunkDuration;

      ass += `Dialogue: 0,${secToAssTime(s)},${secToAssTime(e)},GoldGlow,,0,0,0,,{\\an2\\pos(${posX},${posY})\\bord12\\shad5\\be4}${chunk}\n`;
    });
  }

  fs.writeFileSync(assPath, ass);
  stopTimer?.();
}

function parseSrtTime(timeStr) {
  const [hms, ms] = timeStr.split(",");
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s + Number(ms) / 1000;
}

function secToAssTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/**
 * Generate video clips using Gemini Veo 3.1
 */
/**
 * Extracts the last frame of a video using FFmpeg
 */
export async function extractLastFrame(videoPath, outputPath) {
  return await enqueueRender(async () => {
    try {
      await new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", [
          "-y",
          "-loglevel", "error",
          "-sseof", "-0.1",
          "-i", videoPath,
          "-vframes", "1",
          outputPath
        ]);

        ff.stderr.on("data", () => { }); // Consume stream to prevent maxBuffer leaks

        ff.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exited with code ${code}`));
        });

        ff.on("error", (err) => reject(err));
      });
      return outputPath;
    } catch (err) {
      logger.error("❌ Failed to extract last frame:", err.message);
      return null;
    }
  });
}

export async function generateVideoClips(prompts, tempDir, aspectRatio = "16:9", characterAssets = [], commonPrompt = null, onCheckCancelled = null) {
  const results = [];
  let previousClipLastFrame = null;

  // Pre-fetch all available character references
  const fetchedReferences = {};
  for (const asset of characterAssets) {
    if (asset.url) {
      try {
        const res = await fetch(asset.url);
        const buffer = Buffer.from(await res.arrayBuffer());
        const mimeType = res.headers.get("content-type") || "image/png";
        fetchedReferences[asset.id] = { imageBytes: buffer.toString("base64"), mimeType };
      } catch (err) {
        logger.warn(`Could not fetch video character reference: ${err.message}`);
      }
    }
  }

  for (let i = 0; i < prompts.length; i++) {
    // ✅ Cancellation check between every single video clip
    if (onCheckCancelled) await onCheckCancelled();

    let attempt = 0;
    const MAX_RETRIES = 3;
    let success = false;

    while (attempt < MAX_RETRIES && !success) {
      try {
        attempt++;
        const promptObj = prompts[i];
        const uniquePrompt = typeof promptObj === "object" ? promptObj.prompt : promptObj;
        const sceneCharacters = typeof promptObj === "object" ? promptObj.charactersInScene || [] : [];
        const finalPrompt = commonPrompt ? `${commonPrompt} UNIQUE SCENE DETAIL: ${uniquePrompt}` : uniquePrompt;

        logger.info(`🎬 Generating video clip ${i + 1}/${prompts.length} (Attempt ${attempt}) using Veo 3.1 Fast...`);

        const videoConfig = {
          model: "veo-3.1-generate-preview",
          prompt: finalPrompt,
          config: {
            aspectRatio: aspectRatio === "9:16" ? "9:16" : "16:9"
          }
        };

        // Add character references for identity lock based on characters in scene
        const activeReferences = [];
        for (const charId of sceneCharacters) {
          if (fetchedReferences[charId]) activeReferences.push(fetchedReferences[charId]);
        }
        // Fallback for single character mode
        if (activeReferences.length === 0 && characterAssets.length > 0 && fetchedReferences[characterAssets[0].id]) {
          activeReferences.push(fetchedReferences[characterAssets[0].id]);
        }

        if (activeReferences.length > 0) {
          videoConfig.referenceImages = activeReferences;
        }

        // Add bridge logic: use last frame of previous clip as starting point
        if (previousClipLastFrame) {
          const lastFrameData = fs.readFileSync(previousClipLastFrame).toString("base64");
          videoConfig.image = {
            imageBytes: lastFrameData,
            mimeType: "image/png"
          };
        }

        // 📺 Start the video generation operation
        let operation = await ai.models.generateVideos(videoConfig);

        // ⏳ Poll the operation status until the video is ready
        while (!operation.done) {
          logger.info(`⏳ Clip ${i + 1}: Waiting for video generation...`);
          await new Promise((resolve) => setTimeout(resolve, 10000));
          // ✅ Check cancellation on every poll tick (every 10s)
          if (onCheckCancelled) await onCheckCancelled();

          operation = await ai.operations.getVideosOperation({
            operation: operation,
          });
        }

        const clipFilename = `clip_${String(i).padStart(3, "0")}.mp4`;
        const filePath = path.join(tempDir, clipFilename);

        // 💾 Download the generated video
        await ai.files.download({
          file: operation.response.generatedVideos[0].video,
          downloadPath: filePath
        });

        logger.info(`✅ Clip ${i + 1} saved to ${filePath}`);
        results.push({ filePath, error: null });

        // Extract last frame for the next clip's "bridge"
        const lastFramePath = path.join(tempDir, `last_frame_${i}.png`);
        const extracted = await extractLastFrame(filePath, lastFramePath);
        if (extracted) {
          previousClipLastFrame = extracted;
        }

        success = true; // Mark as successful to exit while loop

      } catch (err) {
        const isQuotaError = err.message.toLowerCase().includes("quota") || err.message.includes("429");
        if (isQuotaError || attempt >= MAX_RETRIES) {
          logger.error(`❌ Video generation failed for clip ${i + 1} (Attempt ${attempt}):`, err.message);
          results.push({ filePath: null, error: err });
          break; // Stop retrying
        }
        logger.warn(`⚠️ Video generation failed for clip ${i + 1} (Attempt ${attempt}). Retrying in 5s...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  return results;
}

/**
 * Renders a single media item (image or video clip) to a standardised H.264
 * segment file. All calls go through enqueueSegmentRender so concurrency is
 * capped by MAX_SEGMENT_CONCURRENCY rather than running unbounded.
 *
 * Encoding params are identical to the final stitch pass so the merge can
 * use "-c:v copy" and avoid a second full re-encode.
 */
export async function renderMediaSegment(itemPath, outputPath, duration, width, height, escapedAssPath) {
  const isVideo = itemPath.endsWith(".mp4");
  const commonScale = `scale=${width}:${height}:force_original_aspect_ratio=increase:out_color_matrix=bt709:out_range=tv:flags=bicubic,crop=${width}:${height},setsar=1`;

  // Subtitle filter — applied in the segment pass so the merge only needs copy
  const subFilter = escapedAssPath ? `,subtitles='${escapedAssPath}'` : "";

  let args;
  if (isVideo) {
    args = [
      "-y", "-loglevel", "error",
      "-threads", String(config.workflow.ffmpegThreads),
      "-i", itemPath,
      "-vf", `${commonScale},fps=30${subFilter}`,
      "-t", String(duration),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      outputPath
    ];
  } else {
    const cycleFrames = ZOOM_CYCLE_SECONDS * FPS;
    const center = (1 + MAX_ZOOM_LEVEL) / 2;
    const amplitude = (MAX_ZOOM_LEVEL - 1) / 2;
    const totalFrames = Math.ceil(duration * FPS);

    // zoompan now receives 1 frame, and outputs totalFrames frames (d=totalFrames)
    const zoomFilter = `zoompan=z='${center}-${amplitude}*cos(2*PI*on/${cycleFrames})':d=${totalFrames}:x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2))':s=${width}x${height}`;
    const filter = `${commonScale},${zoomFilter},fps=30${subFilter}`;

    args = [
      "-y", "-loglevel", "error",
      "-threads", String(config.workflow.ffmpegThreads),
      "-i", itemPath,
      "-vf", filter,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      outputPath
    ];
  }

  // ⚠️ All segment ffmpeg calls MUST go through enqueueSegmentRender
  // to respect MAX_SEGMENT_CONCURRENCY and prevent CPU overload.
  return enqueueSegmentRender(() => new Promise((resolve, reject) => {
    const perf = getPerfSession();
    const stopFfmpeg = perf?.startFfmpeg(`Segment Render: ${path.basename(itemPath)}`, args, {
      itemPath,
      outputPath,
      duration,
      width,
      height,
    });

    const ff = spawn("ffmpeg", args);
    let errorLog = "";
    ff.stderr.on("data", (data) => errorLog += data.toString());
    ff.on("close", (code) => {
      stopFfmpeg?.(code, errorLog, outputPath);
      if (code === 0) resolve();
      else reject(new Error(`Segment render failed for ${itemPath}: ${errorLog || code}`));
    });
    ff.on("error", (err) => {
      stopFfmpeg?.(1, err.message, null);
      reject(err);
    });
  }));
}

/**
 * Merges pre-rendered segments into a single video, synchronized with audio.
 * Phase 5 Safe Disk Cleanup is implemented here.
 */
export async function concatSegments(segmentFiles, audioPath, outputPath, audioDuration, assPathToRemove) {
  const SEGMENT_TEMP_DIR = path.dirname(outputPath);
  const TEMP_DIR = path.resolve(process.cwd(), "temp");
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  fs.mkdirSync(SEGMENT_TEMP_DIR, { recursive: true });

  const segmentsListPath = path.join(SEGMENT_TEMP_DIR, `segments-${Date.now()}.txt`);
  let segmentsContent = segmentFiles.map(f => `file '${f.replace(/\\/g, "/")}'`).join("\n") + "\n";
  fs.writeFileSync(segmentsListPath, segmentsContent, "utf8");

  logger.info(`✅ Segments ready. Starting final merge pass (copy-stream)...`);

  // Final merge: concat demuxer + audio mix.
  // -c:v copy — NO re-encode. Segments already carry burned subtitles.
  // -c:a aac  — encode the audio track (always a stream transcode needed).
  const mergeArgs = [
    "-y",
    "-loglevel", "error",
    "-f", "concat",
    "-safe", "0",
    "-i", segmentsListPath,
    "-i", audioPath,
    "-map", "0:v",
    "-map", "1:a",
    "-c:v", "copy",         // ✅ Bitstream copy — no re-encode, instant
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-t", String(audioDuration),
    "-threads", String(config.workflow.ffmpegThreads),
    outputPath
  ];

  try {
    await enqueueRender(async () => {
      await new Promise((resolve, reject) => {
        const perf = getPerfSession();
        const stopFfmpeg = perf?.startFfmpeg("Final Merge", mergeArgs, {
          segmentsListPath,
          audioPath,
          outputPath,
        });

        const ff = spawn("ffmpeg", mergeArgs);
        let errorLog = "";
        ff.stderr.on("data", (data) => errorLog += data.toString());
        ff.on("close", (code) => {
          stopFfmpeg?.(code, errorLog, outputPath);
          if (code === 0) resolve();
          else reject(new Error(errorLog || `FFmpeg merge exited with code ${code}`));
        });
        ff.on("error", (err) => {
          stopFfmpeg?.(1, err.message, null);
          reject(err);
        });
      });
    });
    logger.info(`✅ Final video assembled: ${outputPath}`);
  } catch (err) {
    logger.error("FFmpeg Merge Error:", err.message);
    throw new Error("🎥 Multi-media video creation failed (merge pass).");
  } finally {
    // Always clean up: segments, list file, subtitle ASS
    if (assPathToRemove && fs.existsSync(assPathToRemove)) fs.unlinkSync(assPathToRemove);
    if (fs.existsSync(segmentsListPath)) fs.unlinkSync(segmentsListPath);
    segmentFiles.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { } });
  }
}

function pad(n) {
  return n.toString().padStart(2, "0");
}
