import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { getAudioDuration } from "./audioService.js";
import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../utils/logger.js";
import { config } from "../config/workflow.config.js";

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
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    `setsar=1`,
    `zoompan=z='${center}-${amplitude}*cos(2*PI*on/${cycleFrames})':d=${totalFrames}:x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2))':s=${width}x${height}`,
    `subtitles='${escapedAssPath}'`
  ].join(",");

  const cmd = [
    `ffmpeg -y -loop 1`,
    `-i "${imagePath}"`,
    `-i "${audioPath}"`,
    `-filter_complex "${filterComplex}"`,
    `-map 0:v -map 1:a`,
    `-c:v libx264 -crf 17 -preset veryfast -pix_fmt yuv420p -c:a copy -shortest -threads ${config.workflow.ffmpegThreads}`,
    audioDuration ? `-t ${audioDuration}` : "",
    `"${outputPath}"`,
  ].join(" ");

  try {
    await new Promise((resolve, reject) => {
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          logger.error(`FFmpeg Error: ${stderr || error.message}`);
          return reject(error);
        }
        resolve();
      });
    });
  } catch (err) {
    throw new Error("🎥 Video creation failed. Check FFmpeg output above.");
  } finally {
    if (imagePath !== imageUrl && fs.existsSync(imagePath))
      fs.unlinkSync(imagePath);
    if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
  }
}

function convertSrtToAss(srtPath, assPath, aspectRatio = "16:9") {
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
  // Use FFmpeg to get the last frame: -sseof -0.1 gets near the end
  const cmd = `ffmpeg -y -sseof -0.1 -i "${videoPath}" -vframes 1 "${outputPath}"`;
  try {
    await new Promise((resolve, reject) => {
      exec(cmd, (error) => {
        if (error) return reject(error);
        resolve();
      });
    });
    return outputPath;
  } catch (err) {
    logger.error("❌ Failed to extract last frame:", err.message);
    return null;
  }
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
 * Creates a video from multiple images or video clips, synchronized with audio.
 */
export async function createMultiMediaVideo(mediaItems, audioPath, outputPath, srtPath, aspectRatio = "16:9") {
  const TEMP_DIR = path.resolve(process.cwd(), "temp");
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const audioDuration = await getAudioDuration(audioPath);
  const transitionDuration = 0.5;
  const transitionType = "fade";
  const clipDuration = (audioDuration + (transitionDuration * (mediaItems.length - 1))) / mediaItems.length;

  const isVertical = aspectRatio === "9:16";
  const width = isVertical ? 1080 : 1920;
  const height = isVertical ? 1920 : 1080;

  const assPath = path.join(TEMP_DIR, `subs-${Date.now()}.ass`);
  convertSrtToAss(srtPath, assPath, aspectRatio);
  const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");



  let inputs = "";
  let filter = "";

  mediaItems.forEach((item, i) => {
    const isVideo = item.endsWith(".mp4");
    const commonScale = `scale=${width}:${height}:force_original_aspect_ratio=increase:out_color_matrix=bt709:out_range=tv:flags=bicubic,crop=${width}:${height},setsar=1`;

    if (isVideo) {
      inputs += `-i "${item}" `;
      filter += `[${i}:v]setpts=PTS-STARTPTS,${commonScale},fps=30,trim=duration=${clipDuration}[v${i}]; `;
    } else {
      // 🎬 CINEMATIC ZOOM PULSE
      const cycleFrames = ZOOM_CYCLE_SECONDS * FPS;
      const center = (1 + MAX_ZOOM_LEVEL) / 2;
      const amplitude = (MAX_ZOOM_LEVEL - 1) / 2;
      const totalFrames = Math.ceil(clipDuration * FPS);

      inputs += `-loop 1 -t ${clipDuration} -i "${item}" `;
      filter += `[${i}:v]${commonScale},` +
        `zoompan=z='${center}-${amplitude}*cos(2*PI*on/${cycleFrames})':d=${totalFrames}` +
        `:x='floor(iw/2-(iw/zoom/2))':y='floor(ih/2-(ih/zoom/2))':s=${width}x${height}[v${i}]; `;
    }
  });

  // 2. Chain xfade filters OR simple concat if duration is 0
  let lastOutput = "v0";
  if (mediaItems.length > 1) {
    if (transitionDuration > 0) {
      for (let i = 1; i < mediaItems.length; i++) {
        const nextOutput = `vt${i}`;
        const offset = i * (clipDuration - transitionDuration);
        filter += `[${lastOutput}][v${i}]xfade=transition=${transitionType}:duration=${transitionDuration}:offset=${offset}[${nextOutput}]; `;
        lastOutput = nextOutput;
      }
    } else {
      // Hard cuts (simple concat)
      let concatParams = "";
      for (let i = 0; i < mediaItems.length; i++) {
        concatParams += `[v${i}]`;
      }
      filter += `${concatParams}concat=n=${mediaItems.length}:v=1:a=0[vconcat]; `;
      lastOutput = "vconcat";
    }
  }

  // 3. Final overlay (Subtitles) and Audio mixing
  const finalVideoLabel = lastOutput;
  // Note: We amix the generated video audio (if any) with the main narration audioPath
  // But usually, images have no audio, so we mainly care about the subtitles and audioPath
  // const mixingFilter = `[${finalVideoLabel}]subtitles='${escapedAssPath}'[finalv]`;

  // const cmd = [
  //   `ffmpeg -y`,
  //   inputs,
  //   `-i "${audioPath}"`,
  //   `-filter_complex "${filter}${mixingFilter}"`,
  //   `-map "[finalv]" -map ${mediaItems.length}:a`,
  //   `-c:v libx264 -crf 17 -preset slower -pix_fmt yuv420p -c:a aac -b:a 192k -shortest`,
  //   `-t ${audioDuration}`,
  //   `"${outputPath}"`,
  // ].join(" ");

  // Final overlay (Subtitles) - No logo needed
  const mixingFilter = `[${lastOutput}]subtitles='${escapedAssPath}'[finalv]`;
  const audioIndex = mediaItems.length;

  const cmd = [
    `ffmpeg -y`,
    inputs,
    `-i "${audioPath}"`,
    `-filter_complex "${filter}${mixingFilter}"`,
    `-map "[finalv]" -map ${audioIndex}:a`, // Point to narration audio
    `-c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -threads ${config.workflow.ffmpegThreads}`,
    `-t ${audioDuration}`,
    `"${outputPath}"`,
  ].join(" ");

  try {
    logger.info(`🎬 Stitching video with ${transitionDuration > 0 ? transitionType : "hard cut"} transitions...`);
    await new Promise((resolve, reject) => {
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          logger.error(`FFmpeg Error: ${stderr || error.message}`);
          return reject(error);
        }
        resolve();
      });
    });
  } catch (err) {
    logger.error("FFmpeg Error:", err.message);
    throw new Error("🎥 Multi-media video creation failed.");
  } finally {
    if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
  }
}

function pad(n) {
  return n.toString().padStart(2, "0");
}
