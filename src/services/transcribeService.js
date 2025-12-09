

import OpenAI from "openai";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg"; // make sure this is installed: npm i fluent-ffmpeg

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Split a large audio file into smaller chunks under 24 MB each.
 */
async function splitAudioFile(audioPath, outputDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outputDir, { recursive: true });

    // Probe duration of the audio file
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) return reject(err);

      const duration = metadata.format.duration; // seconds
      const maxChunkDuration = 480; // ≈8 minutes (~24MB for MP3)
      const numChunks = Math.ceil(duration / maxChunkDuration);
      const chunkPaths = [];

      let processed = 0;
      for (let i = 0; i < numChunks; i++) {
        const startTime = i * maxChunkDuration;
        const outputPath = path.join(outputDir, `chunk_${i + 1}.mp3`);
        chunkPaths.push(outputPath);

        ffmpeg(audioPath)
          .setStartTime(startTime)
          .setDuration(maxChunkDuration)
          .audioCodec("libmp3lame")
          .output(outputPath)
          .on("end", () => {
            processed++;
            if (processed === numChunks) resolve(chunkPaths);
          })
          .on("error", reject)
          .run();
      }
    });
  });
}

/**
 * Transcribes a single audio file using Whisper API.
 */
async function transcribeChunk(chunkPath) {
  console.log(`🎧 Transcribing: ${path.basename(chunkPath)}`);
  const result = await openai.audio.transcriptions.create({
    file: fs.createReadStream(chunkPath),
    model: "whisper-1",
    response_format: "srt",
  });
  return result;
}

/**
 * Merge multiple SRT chunks into a single coherent SRT file with fixed timestamps.
 */
function mergeSRTs(srtChunks) {
  let merged = "";
  let offset = 0;

  for (const srt of srtChunks) {
    const lines = srt.split("\n");
    for (let line of lines) {
      // Adjust timestamps
      if (line.includes("-->")) {
        const [start, end] = line.split(" --> ");
        const newStart = shiftTime(start, offset);
        const newEnd = shiftTime(end, offset);
        line = `${newStart} --> ${newEnd}`;
      }
      merged += line + "\n";
    }

    // Estimate offset: last timestamp in current SRT
    const lastTime = srt.match(/(\d{2}:\d{2}:\d{2},\d{3})/g);
    if (lastTime && lastTime.length > 0) {
      offset += timeToSeconds(lastTime[lastTime.length - 1]);
    }
  }

  return merged.trim();
}

function timeToSeconds(timeStr) {
  const [h, m, s] = timeStr.replace(",", ":").split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

function shiftTime(timeStr, offsetSec) {
  const [h, m, sMs] = timeStr.split(":");
  const [s, ms] = sMs.split(",");
  let totalMs =
    ((+h * 3600 + +m * 60 + +s + offsetSec) * 1000) + +ms;
  const newH = Math.floor(totalMs / 3600000);
  totalMs %= 3600000;
  const newM = Math.floor(totalMs / 60000);
  totalMs %= 60000;
  const newS = Math.floor(totalMs / 1000);
  const newMs = totalMs % 1000;
  return `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}:${String(newS).padStart(2, "0")},${String(newMs).padStart(3, "0")}`;
}

/**
 * Transcribe large audio file with timestamps (SRT format),
 * automatically splitting if above size limit.
 */
export async function transcribeWithTimestamps(audioPath) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  try {
    console.log("🗣️ Starting large-audio transcription...");

    const outputDir = path.join(path.dirname(audioPath), "chunks");
    const stats = fs.statSync(audioPath);

    let srtChunks = [];

    if (stats.size > 24 * 1024 * 1024) {
      console.log("⚙️ Large file detected. Splitting into smaller chunks...");
      const chunkPaths = await splitAudioFile(audioPath, outputDir);
      for (const chunk of chunkPaths) {
        const srt = await transcribeChunk(chunk);
        srtChunks.push(srt);
      }
      fs.rmSync(outputDir, { recursive: true, force: true });
    } else {
      const srt = await transcribeChunk(audioPath);
      srtChunks = [srt];
    }

    const finalSRT = mergeSRTs(srtChunks);
    console.log("✅ Transcription complete!");
    return finalSRT;
  } catch (error) {
    console.error("❌ Whisper API Transcription Error:", error);
    throw new Error("Failed to transcribe audio with Whisper.");
  }
}
