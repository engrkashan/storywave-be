import axios from "axios";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { execFile } from "child_process";
import ytdlp from "yt-dlp-exec";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function extractContentFromUrl(url) {
  if (isVideoUrl(url)) {
    console.log("🎬 Detected video URL, downloading and transcribing...");
    const videoPath = await downloadVideo(url);
    const transcript = await transcribeVideo(videoPath);
    fs.unlinkSync(videoPath); // cleanup
    return transcript;
  } else {
    console.log("📰 Detected webpage, scraping text content...");
    return await extractFromUrl(url);
  }
}

// Detect if URL is video (YouTube or direct mp4, mov, etc.)
function isVideoUrl(url) {
  return (
    url.includes("youtube.com") ||
    url.includes("youtu.be") ||
    /\.(mp4|mov|avi|mkv|webm)$/i.test(url)
  );
}

// Download YouTube or direct video
async function downloadVideo(url) {
  const outputPath = path.join(process.cwd(), `temp-${Date.now()}.mp4`);
  await ytdlp(url, {
    output: outputPath,
    format: "mp4",
  });
  return outputPath;
}


// Scrape plain text from HTML page
export async function extractFromUrl(url) {
  const { data } = await axios.get(url);
  const $ = cheerio.load(data);
  return $("body").text().replace(/\s+/g, " ").trim();
}

// Transcribe long videos in chunks (modified to return only the plain text story)
export async function transcribeVideo(filePath) {
  const tempDir = path.join(process.cwd(), "temp_audio_chunks");
  fs.mkdirSync(tempDir, { recursive: true });

  const audioPath = path.join(tempDir, `source-${Date.now()}.wav`);
  execSync(`ffmpeg -y -i "${filePath}" -ac 1 -ar 16000 -vn "${audioPath}"`, {
    stdio: "ignore",
  });

  const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
  const totalDuration = parseFloat(execSync(durationCmd).toString().trim());
  const chunkDuration = 25 * 60;

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

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}