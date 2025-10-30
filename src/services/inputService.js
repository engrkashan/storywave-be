import axios from "axios";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import ytdlp from "yt-dlp-exec";

// ✅ Ensure yt-dlp is accessible in all environments
process.env.PATH = `${process.env.PATH}:/root/.local/bin`;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Detect if URL is a video (YouTube or direct file)
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
    fs.unlinkSync(videoPath); // cleanup
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
  const outputPath = path.join(process.cwd(), `temp-${Date.now()}.mp4`);
  console.log("⬇️ Downloading video with yt-dlp...");

  try {
    await ytdlp(url, {
      output: outputPath,
      format: "b[ext=mp4]/best", // ✅ safer than just mp4
      binaryPath:
        process.env.NODE_ENV === "production"
          ? "/root/.local/bin/yt-dlp"
          : undefined,
      cookies: "/var/www/storywave-be/cookies.txt", // ✅ Use your cookies
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.7444.59 Safari/537.36",
      addHeader: ["Referer: https://www.youtube.com/"],
      extractorArgs: "youtube:player_client=tv,web", // helps bypass nsig lock
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
 * Transcribes long videos in chunks using OpenAI Whisper
 */
export async function transcribeVideo(filePath) {
  const tempDir = path.join(process.cwd(), "temp_audio_chunks");
  fs.mkdirSync(tempDir, { recursive: true });

  const audioPath = path.join(tempDir, `source-${Date.now()}.wav`);
  execSync(`ffmpeg -y -i "${filePath}" -ac 1 -ar 16000 -vn "${audioPath}"`, {
    stdio: "ignore",
  });

  const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
  const totalDuration = parseFloat(execSync(durationCmd).toString().trim());
  const chunkDuration = 25 * 60; // 25 minutes per chunk

  let offset = 0;
  let allText = "";

  while (offset < totalDuration) {
    const chunkFile = path.join(tempDir, `chunk-${offset}.wav`);
    const end = Math.min(offset + chunkDuration, totalDuration);

    execSync(
      `ffmpeg -y -i "${audioPath}" -ss ${offset} -to ${end} -c copy "${chunkFile}"`,
      { stdio: "ignore" }
    );

    console.log(`🎙️ Transcribing chunk ${formatTime(offset)} → ${formatTime(end)}`);

    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(chunkFile),
      model: "whisper-1",
    });

    allText += response.text.trim() + " ";
    fs.unlinkSync(chunkFile);
    offset = end;
  }

  fs.unlinkSync(audioPath);
  fs.rmSync(tempDir, { recursive: true, force: true });
  return allText.trim();
}

/**
 * Helper: Format seconds to hh:mm:ss
 */
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}
