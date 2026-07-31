import { exec, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { getAudioDuration } from "./audioService.js";
import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../utils/logger.js";
import { config } from "../config/workflow.config.js";
import { enqueueRender, enqueueSegmentRender } from "../utils/renderQueue.js";
import { getPerfSession } from "../utils/perfLogger.js";
import { buildSubtitleGroups } from "./timelineService.js";

const logger = createLogger("VideoService");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const ZOOM_CYCLE_SECONDS = 20; // Total time for one full In-Out pulse (6s in, 6s out)
const MAX_ZOOM_LEVEL = 1.2;   // Maximum zoom factor
const FPS = 30;               // Standard frame rate

export async function createVideoWithTimeline(imageUrl, audioPath, outputPath, masterTimeline, aspectRatio = "16:9", audioDurationParam = null) {
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
  // Pass timeline object and null for sceneIndex (use all subtitles)
  convertTranscriptToAss(masterTimeline, assPath, aspectRatio, null);

  const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const audioDuration = audioDurationParam || await getAudioDuration(audioPath);

  if (!audioDuration || isNaN(audioDuration)) {
    logger.warn("⚠️ Could not detect audio duration. Fallback to -shortest only.");
  }

  // Determine target dimensions
  const isVertical = aspectRatio === "9:16";
  const width = isVertical ? 1080 : 1920;
  const height = isVertical ? 1920 : 1080;

  // Cinematic Zoom Pulse calculations
  const totalFrames = Math.ceil(audioDuration * FPS);
  const cycleFrames = ZOOM_CYCLE_SECONDS * FPS; // fixed 12s cycle (6s in, 6s out)
  const center = (1 + MAX_ZOOM_LEVEL) / 2;
  const amplitude = (MAX_ZOOM_LEVEL - 1) / 2;

  const upscaleFactor = 4;
  const upWidth = width * upscaleFactor;
  const upHeight = height * upscaleFactor;

  // Scale image to match aspect ratio, crop excess, then apply zoompan
  const commonScale = [
    `[0:v]scale=${upWidth}:${upHeight}:force_original_aspect_ratio=increase`,
    `crop=${upWidth}:${upHeight}`,
    `setsar=1`
  ].join(",");

  const filterComplex = [
    commonScale,
    `zoompan=z='${center}-${amplitude}*cos(2*PI*on/${cycleFrames})':d=${totalFrames}:x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2))':s=${width}x${height}:fps=${FPS}`,
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

export async function createVideo(imageUrl, audioPath, outputPath, transcriptPath, aspectRatio = "16:9") {
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
  convertTranscriptToAss(transcriptPath, assPath, aspectRatio);

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
  const totalFrames = Math.ceil(audioDuration * FPS);
  const cycleFrames = ZOOM_CYCLE_SECONDS * FPS; // fixed 12s cycle (6s in, 6s out)
  const center = (1 + MAX_ZOOM_LEVEL) / 2;
  const amplitude = (MAX_ZOOM_LEVEL - 1) / 2;

  const upscaleFactor = 4;
  const upWidth = width * upscaleFactor;
  const upHeight = height * upscaleFactor;

  // Scale image to match aspect ratio, crop excess, then apply zoompan
  const commonScale = [
    `[0:v]scale=${upWidth}:${upHeight}:force_original_aspect_ratio=increase`,
    `crop=${upWidth}:${upHeight}`,
    `setsar=1`
  ].join(",");

  const filterComplex = [
    commonScale,
    `zoompan=z='${center}-${amplitude}*cos(2*PI*on/${cycleFrames})':d=${totalFrames}:x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2))':s=${width}x${height}:fps=${FPS}`,
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

/**
 * Convert transcript data to an ASS subtitle file.
 *
 * Accepts two calling conventions:
 *
 * NEW (Master Timeline):
 *   convertTranscriptToAss(timeline, assPath, aspectRatio, sceneIndex)
 *   - `timeline`   — the master timeline object from timelineService
 *   - `sceneIndex` — integer (0-based) or null for single-image (all subtitles)
 *   Uses pre-computed subtitleGroups from the timeline. Zero drift.
 *
 * LEGACY (file path):
 *   convertTranscriptToAss(transcriptPath, assPath, aspectRatio, startTime, duration)
 *   - `transcriptPath` — path to JSON or SRT file
 *   Preserved for backward compatibility.
 */
export function convertTranscriptToAss(transcriptSourceOrPath, assPath, aspectRatio = "16:9", sceneIndexOrStartTime = null, durationLegacy = null) {
  const perf = getPerfSession();
  const stopTimer = perf?.start("subtitle", "Transcript to ASS Conversion", { assPath });

  const isVertical = aspectRatio === "9:16";
  const resX = isVertical ? 1080 : 1920;
  const resY = isVertical ? 1920 : 1080;
  const fontSize = isVertical ? 80 : 130;
  const posX = resX / 2;
  const posY = isVertical ? 1400 : 900;

  const header = `[Script Info]\nTitle: Cinematic Shorts Subs\nScriptType: v4.00+\nPlayResX: ${resX}\nPlayResY: ${resY}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\n; ---- GOLD GRADIENT FILL WITH BRIGHT STROKE & GLOW ----\nStyle: GoldGlow,Bebas Neue Bold,${fontSize},&H0000B8E6&,&H0000BFFF&,&H00FFFFFF&,&H64000000&,1,0,0,0,100,100,2,0,1,12,5,3,2,60,60,120,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

  // ── NEW PATH: Timeline object ─────────────────────────────────────────────
  if (transcriptSourceOrPath && typeof transcriptSourceOrPath === "object" && transcriptSourceOrPath.subtitleGroups) {
    const timeline = transcriptSourceOrPath;
    const scene = sceneIndexOrStartTime !== null ? timeline.scenes[sceneIndexOrStartTime] : null;
    const dialogues = _assDialoguesFromTimeline(timeline.subtitleGroups, scene, posX, posY);
    fs.writeFileSync(assPath, header + dialogues);
    stopTimer?.();
    return;
  }

  // ── LEGACY PATH: File path string ────────────────────────────────────────
  const transcriptPath = transcriptSourceOrPath;
  const startTime = typeof sceneIndexOrStartTime === "number" && sceneIndexOrStartTime % 1 !== 0
    ? sceneIndexOrStartTime   // float → it's a legacy startTime
    : 0;
  const duration = durationLegacy;

  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    try {
      const json = JSON.parse(content);
      if (json.words && Array.isArray(json.words)) {
        const dialogues = parseJsonToAss(json.words, posX, posY, startTime, duration);
        fs.writeFileSync(assPath, header + dialogues);
        stopTimer?.();
        return;
      }
    } catch (_) { /* not JSON, fall through to SRT */ }

    const dialogues = parseSrtToAss(content, posX, posY, startTime, duration);
    fs.writeFileSync(assPath, header + dialogues);
    stopTimer?.();
  } catch (err) {
    stopTimer?.();
    throw err;
  }
}

function parseJsonToAss(words, posX, posY, startTime, duration) {
  const groups = buildSubtitleGroups(words);
  const durationSec = duration !== null ? duration : Infinity;
  return _assDialoguesFromTimeline(groups, { startSec: startTime, endSec: startTime + durationSec }, posX, posY);
}
/**
 * Build ASS dialogue lines from pre-computed timeline subtitle groups.
 * Groups are already in absolute time — just filter the scene window
 * and rebase by subtracting scene.startSec.
 *
 * @param {Array<{start,end,text}>} groups  — from timeline.subtitleGroups
 * @param {{startSec,endSec,durationSec}|null} scene — null = use all (single image)
 * @param {number} posX
 * @param {number} posY
 * @returns {string} ASS dialogue lines
 */
function _assDialoguesFromTimeline(groups, scene, posX, posY) {
  let dialogues = "";
  const startSec = scene ? scene.startSec : 0;
  const endSec = scene ? scene.endSec : Infinity;

  for (const g of groups) {
    // Include group if it overlaps the scene window
    if (g.end <= startSec || g.start >= endSec) continue;

    // Rebase to segment-local time
    const s = Math.max(0, g.start - startSec);
    const e = Math.min(scene ? scene.durationSec : g.end, g.end - startSec);

    if (e <= s) continue;

    dialogues += `Dialogue: 0,${secToAssTime(s)},${secToAssTime(e)},GoldGlow,,0,0,0,,{\\an2\\pos(${posX},${posY})\\bord12\\shad5\\be4}${g.text}\n`;
  }

  return dialogues;
}

function parseSrtToAss(srtContent, posX, posY, startTime, duration) {
  let dialogueLines = "";
  const blocks = srtContent.trim().split(/\n\s*\n/);

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
      let s = startSec + index * chunkDuration;
      let e = s + chunkDuration;

      if (duration !== null) {
        const endTime = startTime + duration;
        if (e <= startTime || s >= endTime) return;
        s = Math.max(0, s - startTime);
        e = Math.min(duration, e - startTime);
      }

      dialogueLines += `Dialogue: 0,${secToAssTime(s)},${secToAssTime(e)},GoldGlow,,0,0,0,,{\\an2\\pos(${posX},${posY})\\bord12\\shad5\\be4}${chunk}\n`;
    });
  }
  return dialogueLines;
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
  // Math.round (not Math.floor) for accurate centisecond representation
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  // Guard against rounding up to 100cs
  if (cs >= 100) {
    return secToAssTime(Math.floor(sec) + 1);
  }
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
        const finalPrompt = (commonPrompt && !uniquePrompt.includes("STYLE & TONAL ENVELOPE"))
          ? `${uniquePrompt}\n\nSTYLE & ATMOSPHERE: ${commonPrompt}`
          : uniquePrompt;

        logger.info(`🎬 Generating video clip ${i + 1}/${prompts.length} (Attempt ${attempt}) using Gemini Omni Flash (gemini-omni-flash-preview)...`);

        const activeReferences = [];
        for (const charId of sceneCharacters) {
          if (fetchedReferences[charId]) activeReferences.push(fetchedReferences[charId]);
        }
        if (activeReferences.length === 0 && characterAssets.length > 0 && fetchedReferences[characterAssets[0].id]) {
          activeReferences.push(fetchedReferences[characterAssets[0].id]);
        }

        let previousFrameData = null;
        if (previousClipLastFrame && fs.existsSync(previousClipLastFrame)) {
          previousFrameData = fs.readFileSync(previousClipLastFrame).toString("base64");
        }

        let videoBuffer = null;

        // Approach 1: Try GoogleGenAI SDK interactions API with Gemini Omni Flash
        try {
          const inputParts = [{ text: finalPrompt }];
          if (previousFrameData) {
            inputParts.push({
              inlineData: { mimeType: "image/png", data: previousFrameData }
            });
          }
          for (const ref of activeReferences) {
            if (ref.imageBytes) {
              inputParts.push({
                inlineData: { mimeType: ref.mimeType || "image/png", data: ref.imageBytes }
              });
            }
          }

          const interaction = await ai.interactions.create({
            model: "gemini-omni-flash-preview",
            input: inputParts.length === 1 ? finalPrompt : inputParts,
          });

          if (interaction.output_video?.data) {
            videoBuffer = Buffer.from(interaction.output_video.data, "base64");
          } else if (interaction.steps) {
            for (const step of interaction.steps) {
              if (step.type === "model_output" && Array.isArray(step.content)) {
                for (const item of step.content) {
                  if (item.type === "video" && item.data) {
                    videoBuffer = Buffer.from(item.data, "base64");
                    break;
                  }
                }
              }
            }
          }
        } catch (sdkErr) {
          logger.warn(`Gemini Omni Flash SDK call failed: ${sdkErr.message}. Trying REST API fallback...`);
        }

        // Approach 2: REST API fallback for Gemini Omni Flash
        if (!videoBuffer) {
          const apiKey = process.env.GEMINI_API_KEY;
          const url = `https://generativelanguage.googleapis.com/v1beta/interactions?key=${apiKey}`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "gemini-omni-flash-preview",
              input: finalPrompt,
            }),
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Gemini Omni Flash REST error (${res.status}): ${errText}`);
          }

          const json = await res.json();
          if (json.steps) {
            for (const step of json.steps) {
              if (step.type === "model_output" && Array.isArray(step.content)) {
                for (const item of step.content) {
                  if (item.type === "video" && item.data) {
                    videoBuffer = Buffer.from(item.data, "base64");
                    break;
                  }
                }
              }
            }
          }
        }

        if (!videoBuffer) {
          throw new Error("No video output received from Gemini Omni Flash model.");
        }

        const clipFilename = `clip_${String(i).padStart(3, "0")}.mp4`;
        const filePath = path.join(tempDir, clipFilename);
        fs.writeFileSync(filePath, videoBuffer);

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

  // SYNC FIX (A2): trim every segment to EXACTLY `duration` seconds so that the
  // sum of rendered segment durations equals the audio duration with no
  // accumulation of frame-rounding error. zoompan uses d=ceil(duration*FPS)
  // which can emit one extra frame; the trim+setpts forces the output length to
  // the requested duration so concatSegments (concat demuxer) lands precisely on
  // the audio timeline instead of drifting toward the tail of the video.
  const exactDuration = Number(duration).toFixed(3);
  const trimFilter = `,trim=duration=${exactDuration},setpts=PTS-STARTPTS`;

  let args;
  if (isVideo) {
    args = [
      "-y", "-loglevel", "error",
      "-threads", String(config.workflow.ffmpegThreads),
      "-i", itemPath,
      "-vf", `${commonScale},fps=30${trimFilter}${subFilter}`,
      "-t", String(duration),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      outputPath
    ];
  } else {
    const totalFrames = Math.ceil(duration * FPS);
    const cycleFrames = ZOOM_CYCLE_SECONDS * FPS; // fixed 12s cycle (6s in, 6s out)
    const center = (1 + MAX_ZOOM_LEVEL) / 2;
    const amplitude = (MAX_ZOOM_LEVEL - 1) / 2;

    // Upscale by 4x to eliminate zoompan subpixel jitter (staircasing)
    const upscaleFactor = 4;
    const upWidth = width * upscaleFactor;
    const upHeight = height * upscaleFactor;

    const upScaleFilter = `scale=${upWidth}:${upHeight}:force_original_aspect_ratio=increase:out_color_matrix=bt709:out_range=tv:flags=bicubic,crop=${upWidth}:${upHeight},setsar=1`;

    // zoompan receives the upscaled image, animates it, and outputs back at 1080p (s=widthxheight)
    const zoomFilter = `zoompan=z='${center}-${amplitude}*cos(2*PI*on/${cycleFrames})':d=${totalFrames}:x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2))':s=${width}x${height}:fps=${FPS}`;
    const filter = `${upScaleFilter},${zoomFilter},fps=30${trimFilter}${subFilter}`;

    args = [
      "-y", "-loglevel", "error",
      "-threads", String(config.workflow.ffmpegThreads),
      "-i", itemPath,
      "-vf", filter,
      "-t", String(duration),
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

    // SYNC VERIFY (A2): confirm the stitched video duration matches the audio
    // timeline. With exact-duration segment trimming in renderMediaSegment, the
    // concat of all segments should land on audioDuration. A mismatch here means
    // residual frame-rounding drift was NOT fully eliminated.
    try {
      const finalDur = await getAudioDuration(outputPath);
      const delta = Math.abs((finalDur || 0) - (audioDuration || 0));
      if (delta > 0.1) {
        logger.warn(`⚠️ [SyncVerify] Final video duration ${finalDur?.toFixed(3)}s vs audio ${audioDuration?.toFixed(3)}s (Δ=${delta.toFixed(3)}s) over ${segmentFiles.length} segments.`);
      } else {
        logger.info(`✅ [SyncVerify] Final video duration ${finalDur?.toFixed(3)}s matches audio ${audioDuration?.toFixed(3)}s across ${segmentFiles.length} segments.`);
      }
    } catch (probeErr) {
      logger.warn(`⚠️ [SyncVerify] Could not probe final duration: ${probeErr.message}`);
    }
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
