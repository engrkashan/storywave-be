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

// Ensure directory exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Auto-clean files older than 2 hours
setInterval(() => {
  const now = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) return;
    files.forEach((file) => {
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
}, 30 * 60 * 1000); // Every 30 minutes

// === MAIN FUNCTION ===
export async function extractContentFromUrl(url) {
  if (isVideoUrl(url)) {
    console.log("Detected video URL, downloading and transcribing...");
    const videoPath = await downloadVideo(url);
    const transcript = await transcribeVideo(videoPath);
    fs.unlinkSync(videoPath); // cleanup video
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

// === COOKIE-FREE DOWNLOAD (MOBILE CLIENT EMULATION) ===
async function downloadVideo(url) {
  const YTDLP_PATH = "/root/.local/bin/yt-dlp"; // ✅ absolute path
  const outputPath = path.join(UPLOADS_DIR, `video-${Date.now()}.mp4`);
  
  const baseCommand = [
    YTDLP_PATH,
    "--user-agent", '"Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36"',
    "--add-header", '"Referer: https://m.youtube.com/"',
    "--extractor-args", '"youtube:player_client=android_sdk,tv,web"',
    "--sleep-requests", "1",
    "--retries", "3",
    "--fragment-retries", "5",
    "--output", `"${outputPath}"`,
    "--format", '"best[ext=mp4]/best"',
    "--merge-output-format", "mp4",
    `"${url}"`
  ];

  let command = baseCommand.join(" ");
  console.log("Running yt-dlp (no cookies):", command);

  try {
    const { stdout, stderr } = await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 180000,
    });
    console.log(stdout);
    if (stderr && !stderr.includes("[download]")) console.warn(stderr);
    return outputPath;
  } catch (err) {
    console.warn("Cookie-free download failed, trying with cookies:", err.message);

    // 🔹 Use cookies.txt file instead of Chrome profile
    const cookieCommand = [
      YTDLP_PATH,
      "--user-agent", '"Mozilla/5.0 (Linux; Android 13; SM-G991B)"',
      "--add-header", '"Referer: https://m.youtube.com/"',
      "--cookies", "/var/www/storywave-be/cookies.txt", // ✅ using cookies.txt
      "--extractor-args", '"youtube:player_client=tv,web"',
      "--sleep-requests", "1",
      "--retries", "3",
      "--fragment-retries", "5",
      "--output", `"${outputPath}"`,
      "--format", '"best[ext=mp4]/best"',
      "--merge-output-format", "mp4",
      `"${url}"`
    ].join(" ");

    console.log("Running yt-dlp (with cookies.txt):", cookieCommand);

    const { stdout: cookieStdout, stderr: cookieStderr } = await execAsync(cookieCommand, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 180000,
    });

    console.log(cookieStdout);
    if (cookieStderr && !cookieStderr.includes("[download]")) console.warn(cookieStderr);

    return outputPath;
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
    // Convert to mono 16kHz WAV
    execSync(`ffmpeg -y -i "${filePath}" -ac 1 -ar 16000 -vn "${audioPath}"`, {
      stdio: "ignore",
    });

    // Get total duration
    const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
    const totalDuration = parseFloat(execSync(durationCmd).toString().trim());
    const chunkDuration = 25 * 60; // 25 minutes
    let offset = 0;
    let allText = "";

    while (offset < totalDuration) {
      const chunkFile = path.join(audioDir, `chunk-${offset}.wav`);
      const end = Math.min(offset + chunkDuration, totalDuration);

      // Extract chunk
      execSync(
        `ffmpeg -y -i "${audioPath}" -ss ${offset} -to ${end} -c copy "${chunkFile}"`,
        { stdio: "ignore" }
      );

      console.log(
        `Transcribing chunk ${formatTime(offset)} → ${formatTime(end)}`
      );
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
    // Always clean up audio files
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    if (fs.existsSync(audioDir))
      fs.rmSync(audioDir, { recursive: true, force: true });
  }
}

// === HELPER ===
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
