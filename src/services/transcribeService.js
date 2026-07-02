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

      const totalDuration = metadata.format.duration; // seconds
      const maxChunkDuration = 600; // 10 minutes (~19.2MB for 16kHz mono WAV)
      const numChunks = Math.ceil(totalDuration / maxChunkDuration);
      const chunkPaths = [];
      let processed = 0;

      for (let i = 0; i < numChunks; i++) {
        const startTime = i * maxChunkDuration;
        const outputPath = path.join(outputDir, `chunk_${i + 1}.wav`);
        chunkPaths.push(outputPath);

        ffmpeg(audioPath)
          .setStartTime(startTime)
          .setDuration(maxChunkDuration)
          .audioChannels(1)
          .audioFrequency(16000)
          .audioCodec("pcm_s16le")
          .output(outputPath)
          .on("end", () => {
            processed++;
            if (processed === numChunks) {
              // Phase 2 fix: probe ACTUAL duration of each chunk after encoding.
              // Do NOT use the nominal 600s stride — MP3 encoder delays and
              // re-encoding artefacts make the real boundary slightly different.
              const durationPromises = chunkPaths.map(
                (p) =>
                  new Promise((res, rej) =>
                    ffmpeg.ffprobe(p, (e, m) =>
                      e ? rej(e) : res(m.format.duration)
                    )
                  )
              );
              Promise.all(durationPromises)
                .then((actualDurations) => resolve({ paths: chunkPaths, actualDurations }))
                .catch(reject);
            }
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
 *
 * CRITICAL FIX (Phase 2): Uses measured `actualDurations[]` for offsets instead
 * of the nominal 600s stride. Each chunk's words are shifted by the cumulative
 * sum of *real* durations, not an assumed constant. This eliminates seconds-per-hour
 * of drift caused by MP3 encoder delay and FFmpeg re-encoding artefacts.
 *
 * @param {Array<Array<{word,start,end}>>} chunks  — normalized word arrays per chunk
 * @param {number[]} actualDurations               — real probed duration of each chunk (seconds)
 */
function mergeTranscript(chunks, actualDurations) {
  const masterWords = [];
  let cumulativeOffset = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunkWords = chunks[i];

    for (const w of chunkWords) {
      masterWords.push({
        word: w.word,
        start: w.start + cumulativeOffset,
        end:   w.end   + cumulativeOffset,
      });
    }

    // Advance by the MEASURED duration of this chunk (not a fixed constant)
    cumulativeOffset += actualDurations[i];
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
    let actualDurations = [];

    if (stats.size > 24 * 1024 * 1024) {
      logger.info("⚙️ Large file detected. Splitting into smaller chunks...");
      // Phase 2 fix: splitAudioFile now returns { paths, actualDurations }
      const { paths: chunkPaths, actualDurations: chunkDurations } = await splitAudioFile(audioPath, outputDir);
      actualDurations = chunkDurations;
      logger.info(`📏 Actual chunk durations: ${chunkDurations.map(d => d.toFixed(3) + "s").join(", ")}`);

      for (const chunk of chunkPaths) {
        const result = await transcribeChunk(chunk);
        rawChunks.push(result);
      }
      fs.rmSync(outputDir, { recursive: true, force: true });
    } else {
      const result = await transcribeChunk(audioPath);
      rawChunks.push(result);
      // Single chunk: probe its actual duration directly
      const { format } = await new Promise((resolve, reject) =>
        ffmpeg.ffprobe(audioPath, (e, m) => e ? reject(e) : resolve(m))
      );
      actualDurations = [format.duration];
    }

    // Save RAW output for debugging
    const rawPath = path.join(path.dirname(audioPath), `${path.parse(audioPath).name}-raw-transcript.json`);
    fs.writeFileSync(rawPath, JSON.stringify(rawChunks, null, 2));
    logger.info(`💾 Saved raw transcript to ${rawPath}`);

    // Normalize and merge using REAL chunk durations (Phase 2 fix)
    const normalizedChunks = rawChunks.map(c => normalizeTranscript(c, "whisper"));
    const finalTranscript = mergeTranscript(normalizedChunks, actualDurations);

    logger.info("✅ Transcription complete!");

    // Return standard stringified JSON containing the {words: [...]} structure
    return JSON.stringify({ words: finalTranscript }, null, 2);
  } catch (error) {
    logger.error("❌ Whisper API Transcription Error:", error);
    throw new Error("Failed to transcribe audio with Whisper.");
  }
}
