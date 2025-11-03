import axios from "axios";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import ytdlp from "yt-dlp-exec";

const TEMP_DIR = path.join(process.cwd(), "temp");
fs.mkdirSync(TEMP_DIR, { recursive: true });
// ✅ Ensure yt-dlp is accessible on VPS
process.env.PATH = `${process.env.PATH}:/root/.local/bin`;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Detect if URL is a video
function isVideoUrl(url) {
  return (
    url.includes("youtube.com") ||
    url.includes("youtu.be") ||
    /\.(mp4|mov|avi|mkv|webm)$/i.test(url)
  );
}

/**
 * Extracts text content from a webpage or transcribes a video.
 */
export async function extractContentFromUrl(url) {
  if (isVideoUrl(url)) {
    console.log("🎬 Detected video URL — downloading and transcribing...");
    const videoPath = await downloadVideo(url);
    const transcript = await transcribeVideo(videoPath);
    try {
      fs.unlinkSync(videoPath);
    } catch (e) {
      console.warn("⚠️ Failed to delete video:", e.message);
    }
    return transcript;
  } else {
    console.log("📰 Detected webpage — scraping text content...");
    return await extractFromUrl(url);
  }
}

/**
 * Downloads YouTube or direct video using yt-dlp
 */
async function downloadVideo(url) {
  const outputPath = path.join(TEMP_DIR, `video-${Date.now()}.mp4`);
  console.log("⬇️ Downloading video with yt-dlp...");

  try {
    await ytdlp(url, {
      output: outputPath,
      format: "mp4",
      quiet: true,
    });

    console.log("✅ Video downloaded:", outputPath);
    return outputPath;
  } catch (error) {
    console.error("❌ Video download failed:", error.message);
    throw new Error("Video download failed");
  }
}

/**
 * Scrape plain text from HTML page
 */
export async function extractFromUrl(url) {
  const { data } = await axios.get(url);
  const $ = cheerio.load(data);
  return $("body").text().replace(/\s+/g, " ").trim();
}

/**
 * Transcribes large videos safely in 5-minute chunks using OpenAI Whisper
 */
export async function transcribeVideo(filePath) {
  const tempDir = path.join(TEMP_DIR, `audio_chunks_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const baseAudio = path.join(tempDir, `audio-${Date.now()}.wav`);

  // ✅ Step 1: Convert video to 16kHz mono WAV
  console.log("🎧 Extracting audio...");
  execSync(
    `ffmpeg -y -i "${filePath}" -ac 1 -ar 16000 -vn -f wav "${baseAudio}"`,
    { stdio: "ignore" }
  );

  // ✅ Step 2: Get total duration
  const duration = parseFloat(
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${baseAudio}"`
    )
      .toString()
      .trim()
  );

  console.log(`🎞️ Audio duration: ${formatTime(duration)}`);

  const chunkDuration = 300; // 5 minutes per chunk
  let offset = 0;
  let allText = "";

  // ✅ Step 3: Split & transcribe each chunk with retry
  while (offset < duration) {
    const end = Math.min(offset + chunkDuration, duration);
    const chunkFile = path.join(tempDir, `chunk-${offset}.wav`);

    execSync(
      `ffmpeg -y -i "${baseAudio}" -ss ${offset} -to ${end} -c copy "${chunkFile}"`,
      { stdio: "ignore" }
    );

    const sizeMB = fs.statSync(chunkFile).size / (1024 * 1024);
    console.log(
      `🎙️ Transcribing chunk ${formatTime(offset)} → ${formatTime(
        end
      )} (${sizeMB.toFixed(2)} MB)`
    );

    try {
      const text = await safeTranscribe(chunkFile);
      allText += text + " ";
    } catch (err) {
      console.error("❌ Skipping chunk due to repeated errors:", chunkFile);
    }

    try {
      fs.unlinkSync(chunkFile);
    } catch (e) {
      console.warn("⚠️ Failed to delete chunk:", e.message);
    }

    offset = end;
  }

  // ✅ Step 4: Cleanup
  try {
    fs.unlinkSync(baseAudio);
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {
    console.warn("⚠️ Cleanup failed:", e.message);
  }

  return allText.trim();
}

/**
 * Retry wrapper for Whisper API
 */
async function safeTranscribe(chunkFile) {
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(chunkFile),
        model: "whisper-1",
      });
      return response.text.trim();
    } catch (err) {
      attempt++;
      console.warn(
        `⚠️ Whisper API failed (attempt ${attempt}): ${err.message}`
      );
      if (attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt)); // exponential backoff
    }
  }
}

/**
 * Helper: Format seconds to hh:mm:ss
 */
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}:${s}`;
}
