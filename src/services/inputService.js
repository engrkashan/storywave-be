import axios from "axios";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === CONFIG ===
const UPLOADS_DIR = path.join(process.cwd(), "tmp_uploads");
const COOKIES_PATH = path.join(process.cwd(), "cookies.txt");

// Ensure directories exist
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Auto-clean files older than 2 hours
setInterval(() => {
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(UPLOADS_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > TWO_HOURS) {
          fs.rmSync(filePath, { recursive: true, force: true });
          console.log("Cleaned old file:", file);
        }
      } catch (e) {}
    });
  });
}, 30 * 60 * 1000); // Every 30 min

// === MAIN FUNCTION ===
export async function extractContentFromUrl(url) {
  if (isVideoUrl(url)) {
    console.log("Detected video URL, downloading and transcribing...");
    const videoPath = await downloadVideo(url);
    const transcript = await transcribeVideo(videoPath);
    fs.unlinkSync(videoPath); // cleanup
    return transcript;
  } else {
    console.log("Detected webpage, scraping text content...");
    return await extractFromUrl(url);
  }
}

// Detect video URLs
function isVideoUrl(url) {
  return (
    url.includes("youtube.com") ||
    url.includes("youtu.be") ||
    /\.(mp4|mov|avi|mkv|webm)$/i.test(url)
  );
}

// === DOWNLOAD USING yt-dlp DIRECTLY (WITH COOKIES) ===
async function downloadVideo(url) {
  const outputPath = path.join(UPLOADS_DIR, `video-${Date.now()}.mp4`);

  const command = [
    "yt-dlp",
    "--cookies", `"${COOKIES_PATH}"`,
    "--output", `"${outputPath}"`,
    "--format", '"best[ext=mp4]/best"',
    "--merge-output-format", "mp4",
    "--retries", "3",
    "--sleep-interval", "5",
    "--user-agent", '"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
    "--add-header", '"Referer: https://www.youtube.com/"',
    `"${url}"`
  ].join(" ");

  console.log("Running yt-dlp:", command.replace(/\\"/g, '"').replace(/"/g, "'"));

  try {
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000, // 2 min
    });

    if (stderr && !stderr.includes("[download]")) {
      console.warn("yt-dlp warning:", stderr);
    }

    console.log("Download success:", outputPath);
    return outputPath;
  } catch (err) {
    console.error("Download failed:", err.message);
    throw new Error(`Video download failed: ${err.message}`);
  }
}

// === SCRAPE WEBPAGE ===
export async function extractFromUrl(url) {
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(data);
    return $("body").text().replace(/\s+/g, " ").trim();
  } catch (err) {
    throw new Error(`Failed to scrape ${url}: ${err.message}`);
  }
}

// === TRANSCRIBE VIDEO IN CHUNKS ===
export async function transcribeVideo(filePath) {
  const audioDir = path.join(UPLOADS_DIR, `audio-${Date.now()}`);
  fs.mkdirSync(audioDir, { recursive: true });
  const audioPath = path.join(audioDir, "source.wav");

  try {
    execSync(`ffmpeg -y -i "${filePath}" -ac 1 -ar 16000 -vn "${audioPath}"`, {
      stdio: "ignore",
    });

    const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
    const totalDuration = parseFloat(execSync(durationCmd).toString().trim());
    const chunkDuration = 25 * 60; // 25 min
    let offset = 0;
    let allText = "";

    while (offset < totalDuration) {
      const chunkFile = path.join(audioDir, `chunk-${offset}.wav`);
      const end = Math.min(offset + chunkDuration, totalDuration);

      execSync(
        `ffmpeg -y -i "${audioPath}" -ss ${offset} -to ${end} -c copy "${chunkFile}"`,
        { stdio: "ignore" }
      );

      console.log(`Transcribing chunk ${formatTime(offset)} → ${formatTime(end)}`);
      const response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(chunkFile),
        model: "whisper-1",
      });

      allText += response.text.trim() + " ";
      fs.unlinkSync(chunkFile);
      offset = end;
    }

    return allText.trim();
  } finally {
    // Always clean up
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    if (fs.existsSync(audioDir)) fs.rmSync(audioDir, { recursive: true, force: true });
  }
}

// === HELPER ===
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}