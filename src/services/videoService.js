import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { getAudioDuration } from "./audioService.js";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function createVideo(imageUrl, audioPath, outputPath, srtPath) {
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
  convertSrtToAss(srtPath, assPath);

  const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
  const filterComplex = `[0:v]subtitles='${escapedAssPath}'`;
  const audioDuration = await getAudioDuration(audioPath);

  if (!audioDuration || isNaN(audioDuration)) {
    console.warn("⚠️ Could not detect audio duration. Fallback to -shortest only.");
  }

  const cmd = [
    `ffmpeg -y -loop 1`,
    `-i "${imagePath}"`,
    `-i "${audioPath}"`,
    `-filter_complex "${filterComplex}"`,
    `-map 0:v -map 1:a`,
    `-c:v libx264 -crf 17 -preset slower -pix_fmt yuv420p -c:a copy -shortest`,
    audioDuration ? `-t ${audioDuration}` : "",
    `"${outputPath}"`,
  ].join(" ");

  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    throw new Error("🎥 Video creation failed. Check FFmpeg output above.");
  } finally {
    if (imagePath !== imageUrl && fs.existsSync(imagePath))
      fs.unlinkSync(imagePath);
    if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
  }
}

function convertSrtToAss(srtPath, assPath) {
  const srtContent = fs.readFileSync(srtPath, "utf8");
  const blocks = srtContent.trim().split(/\n\s*\n/);

  let ass = `[Script Info]
Title: Cinematic Shorts Subs
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding

; ---- GOLD GRADIENT FILL WITH BRIGHT STROKE & GLOW ----
Style: GoldGlow,Bebas Neue Bold,130,&H0000B8E6&,&H0000BFFF&,&H00FFFFFF&,&H64000000&,1,0,0,0,100,100,2,0,1,12,5,3,2,60,60,120,1

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

      ass += `Dialogue: 0,${secToAssTime(s)},${secToAssTime(e)},GoldGlow,,0,0,0,,{\\an2\\pos(960,900)\\bord12\\shad5\\be4}${chunk}\n`;
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
export async function generateVideoClips(prompts, tempDir, aspectRatio = "16:9") {
  const results = [];

  for (let i = 0; i < prompts.length; i++) {
    try {
      console.log(`🎬 Generating video clip ${i + 1}/${prompts.length} using Veo 3.1...`);

      // 📺 Start the video generation operation
      let operation = await ai.models.generateVideos({
        model: "veo-3.1-generate-preview",
        prompt: prompts[i],
        config: {
          aspectRatio: aspectRatio === "1:1" ? "1:1" : "16:9"
        }
      });

      // ⏳ Poll the operation status until the video is ready
      while (!operation.done) {
        console.log(`⏳ Clip ${i + 1}: Waiting for video generation...`);
        await new Promise((resolve) => setTimeout(resolve, 10000));

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

      console.log(`✅ Clip ${i + 1} saved to ${filePath}`);
      results.push({ filePath, error: null });

    } catch (err) {
      console.error(`❌ Video generation failed for clip ${i + 1}:`, err.message);
      results.push({ filePath: null, error: err });
    }
  }
  return results;
}

/**
 * Creates a video from multiple images or video clips, synchronized with audio.
 */
export async function createMultiMediaVideo(mediaItems, audioPath, outputPath, srtPath) {
  const TEMP_DIR = path.resolve(process.cwd(), "temp");
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const audioDuration = await getAudioDuration(audioPath);
  const clipDuration = audioDuration / mediaItems.length;

  // Prepare subtitle path
  const assPath = path.join(TEMP_DIR, `subs-${Date.now()}.ass`);
  convertSrtToAss(srtPath, assPath);
  const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");

  // Build FFmpeg command for stitching
  // We'll use the 'concat' or 'filter_complex' to ensure perfect transitions

  let inputs = "";
  let filter = "";

  mediaItems.forEach((item, i) => {
    const isVideo = item.endsWith(".mp4");
    if (isVideo) {
      inputs += `-i "${item}" `;
      filter += `[${i}:v]setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,trim=duration=${clipDuration}[v${i}]; `;
      filter += `[${i}:a]volume=0.1,atrim=duration=${clipDuration},asetpts=PTS-STARTPTS[a${i}]; `;
    } else {
      inputs += `-loop 1 -t ${clipDuration} -i "${item}" `;
      filter += `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]; `;
      filter += `anullsrc=r=44100:cl=stereo:d=${clipDuration}[a${i}]; `;
    }
  });

  const concatFilter = mediaItems.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${mediaItems.length}:v=1:a=1[outv][outa]; `;
  const mixingFilter = `[outa][${mediaItems.length}:a]amix=inputs=2:duration=first:dropout_transition=2[mixeda]; [outv]subtitles='${escapedAssPath}'[finalv]`;

  const cmd = [
    `ffmpeg -y`,
    inputs,
    `-i "${audioPath}"`,
    `-f lavfi -i anullsrc=r=44100:cl=stereo -t 0.1`, // Extra silent pad if needed
    `-filter_complex "${filter}${concatFilter}${mixingFilter}"`,
    `-map "[finalv]" -map "[mixeda]"`,
    `-c:v libx264 -crf 17 -preset slower -pix_fmt yuv420p -c:a aac -b:a 192k -shortest`,
    `-t ${audioDuration}`,
    `"${outputPath}"`,
  ].join(" ");

  try {
    console.log("🎬 Stitching video...");
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    console.error("FFmpeg Error:", err.message);
    throw new Error("🎥 Multi-media video creation failed.");
  } finally {
    if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
  }
}

function pad(n) {
  return n.toString().padStart(2, "0");
}
