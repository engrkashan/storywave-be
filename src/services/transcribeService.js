import OpenAI from "openai";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg"; // make sure this is installed: npm i fluent-ffmpeg
import { createLogger } from "../utils/logger.js";

const logger = createLogger("TranscribeService");

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
 * Requests verbose_json with word-level timestamps.
 */
async function transcribeChunk(chunkPath) {
  logger.info(`🎧 Transcribing: ${path.basename(chunkPath)}`);
  const result = await openai.audio.transcriptions.create({
    file: fs.createReadStream(chunkPath),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });
  return result;
}

/**
 * Normalizes provider-specific transcript data into a standard internal format.
 */
function normalizeTranscript(data, provider = "whisper") {
  if (provider === "whisper") {
    // Whisper verbose_json format has a `words` array
    if (!data || !data.words || !Array.isArray(data.words)) {
      return [];
    }
    return data.words.map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
    }));
  }
  // Add other providers here later (e.g. ElevenLabs, Deepgram)
  return [];
}

/**
 * Merges multiple normalized JSON transcripts into a single coherent timeline.
 * Adds the appropriate time offset to each chunk's words.
 */
function mergeTranscript(chunks, maxChunkDuration = 480) {
  let masterWords = [];
  
  for (let i = 0; i < chunks.length; i++) {
    const chunkWords = chunks[i];
    const offset = i * maxChunkDuration; 
    
    for (const w of chunkWords) {
      masterWords.push({
        word: w.word,
        start: w.start + offset,
        end: w.end + offset
      });
    }
  }

  return masterWords;
}

/**
 * Transcribe large audio file with timestamps,
 * automatically splitting if above size limit.
 * Saves raw output for debugging and returns the normalized JSON transcript.
 */
export async function transcribeWithTimestamps(audioPath) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  try {
    logger.info("🗣️ Starting large-audio transcription...");

    const outputDir = path.join(path.dirname(audioPath), "chunks");
    const stats = fs.statSync(audioPath);

    let rawChunks = [];
    const maxChunkDuration = 480;

    if (stats.size > 24 * 1024 * 1024) {
      logger.info("⚙️ Large file detected. Splitting into smaller chunks...");
      const chunkPaths = await splitAudioFile(audioPath, outputDir);
      for (const chunk of chunkPaths) {
        const result = await transcribeChunk(chunk);
        rawChunks.push(result);
      }
      fs.rmSync(outputDir, { recursive: true, force: true });
    } else {
      const result = await transcribeChunk(audioPath);
      rawChunks.push(result);
    }

    // Save RAW output for debugging
    const rawPath = path.join(path.dirname(audioPath), `${path.parse(audioPath).name}-raw-transcript.json`);
    fs.writeFileSync(rawPath, JSON.stringify(rawChunks, null, 2));
    logger.info(`💾 Saved raw transcript to ${rawPath}`);

    // Normalize and Merge
    const normalizedChunks = rawChunks.map(c => normalizeTranscript(c, "whisper"));
    const finalTranscript = mergeTranscript(normalizedChunks, maxChunkDuration);
    
    logger.info("✅ Transcription complete!");
    
    // Return standard stringified JSON containing the {words: [...]} structure
    return JSON.stringify({ words: finalTranscript }, null, 2);
  } catch (error) {
    logger.error("❌ Whisper API Transcription Error:", error);
    throw new Error("Failed to transcribe audio with Whisper.");
  }
}
