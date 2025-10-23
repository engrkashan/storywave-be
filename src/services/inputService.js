import axios from "axios";
import * as cheerio from "cheerio";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function extractFromUrl(url) {
  const { data } = await axios.get(url);
  const $ = cheerio.load(data);
  return $("body").text().replace(/\s+/g, " ").trim();
}

/**
 * Transcribes long videos by splitting audio into smaller chunks before sending to OpenAI Whisper.
 * Handles any length (1 minute → 3 hours).
 */
export async function transcribeVideo(filePath) {
  const tempDir = path.join(process.cwd(), "temp_audio_chunks");
  fs.mkdirSync(tempDir, { recursive: true });

  // 1️⃣ Extract audio as mono WAV (16-bit PCM)
  const audioPath = path.join(tempDir, `source-${Date.now()}.wav`);
  execSync(`ffmpeg -y -i "${filePath}" -ac 1 -ar 16000 -vn "${audioPath}"`, {
    stdio: "ignore",
  });

  // 2️⃣ Get total audio duration
  const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
  const totalDuration = parseFloat(execSync(durationCmd).toString().trim());
  const chunkDuration = 25 * 60; 

  let offset = 0;
  let allText = "";

  while (offset < totalDuration) {
    const chunkFile = path.join(tempDir, `chunk-${offset}.wav`);
    const end = Math.min(offset + chunkDuration, totalDuration);

    // 3️⃣ Cut chunk
    execSync(
      `ffmpeg -y -i "${audioPath}" -ss ${offset} -to ${end} -c copy "${chunkFile}"`,
      { stdio: "ignore" }
    );

    // 4️⃣ Transcribe chunk
    console.log(`🎙️ Transcribing chunk from ${offset}s to ${end}s...`);
    let success = false;
    let retries = 3;
    let text = "";

    while (!success && retries > 0) {
      try {
        const response = await openai.audio.transcriptions.create({
          file: fs.createReadStream(chunkFile),
          model: "whisper-1",
        });
        text = response.text.trim();
        success = true;
      } catch (err) {
        console.warn(`⚠️ Whisper chunk failed (retrying): ${err.message}`);
        retries--;
        if (retries === 0) throw err;
      }
    }

    allText += `\n[${formatTime(offset)} - ${formatTime(end)}]\n${text}\n`;
    offset = end;
    fs.unlinkSync(chunkFile);
  }

  fs.unlinkSync(audioPath);
  fs.rmSync(tempDir, { recursive: true, force: true });

  return allText.trim();
}

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
