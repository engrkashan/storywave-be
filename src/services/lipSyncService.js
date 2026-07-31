import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import Replicate from "replicate";
import { createLogger } from "../utils/logger.js";
import { config } from "../config/workflow.config.js";
import { enqueueRender } from "../utils/renderQueue.js";

const logger = createLogger("LipSyncService");

/**
 * Extracts high-fidelity WAV audio from a video file using FFmpeg.
 *
 * @param {string} videoPath       - Path to source video MP4 file
 * @param {string} outputAudioPath - Destination WAV audio file path
 * @returns {Promise<string>} Path to extracted audio file
 */
export async function extractAudioFromVideo(videoPath, outputAudioPath) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Source video file does not exist: ${videoPath}`);
  }

  const args = [
    "-y",
    "-loglevel", "error",
    "-i", videoPath,
    "-vn",
    "-acodec", "pcm_s16le",
    "-ar", "44100",
    "-ac", "2",
    outputAudioPath,
  ];

  logger.info(`🎙️ Extracting audio from video: ${path.basename(videoPath)}...`);

  await enqueueRender(async () => {
    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", args);
      let errorLog = "";
      ff.stderr.on("data", (data) => (errorLog += data.toString()));
      ff.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(errorLog || `FFmpeg audio extraction exited with code ${code}`));
      });
      ff.on("error", (err) => reject(err));
    });
  });

  logger.info(`✅ Audio extracted successfully → ${outputAudioPath}`);
  return outputAudioPath;
}

/**
 * Concatenates multiple audio WAV files into a single continuous master audio track.
 *
 * @param {Array<string>} audioFiles - List of WAV audio file paths
 * @param {string} outputPath       - Destination combined WAV file path
 * @returns {Promise<string>} Path to combined audio file
 */
export async function combineAudioFiles(audioFiles, outputPath) {
  if (!audioFiles || audioFiles.length === 0) {
    throw new Error("No audio files provided to combine.");
  }

  const tempDir = path.dirname(outputPath);
  const listFilePath = path.join(tempDir, `audio_list_${Date.now()}.txt`);
  const listContent = audioFiles.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n") + "\n";
  fs.writeFileSync(listFilePath, listContent, "utf8");

  const args = [
    "-y",
    "-loglevel", "error",
    "-f", "concat",
    "-safe", "0",
    "-i", listFilePath,
    "-c", "copy",
    outputPath,
  ];

  logger.info(`🎵 Combining ${audioFiles.length} audio tracks into master audio...`);

  try {
    await enqueueRender(async () => {
      await new Promise((resolve, reject) => {
        const ff = spawn("ffmpeg", args);
        let errorLog = "";
        ff.stderr.on("data", (data) => (errorLog += data.toString()));
        ff.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(errorLog || `FFmpeg audio concat exited with code ${code}`));
        });
        ff.on("error", (err) => reject(err));
      });
    });
    logger.info(`✅ Master audio combined → ${outputPath}`);
    return outputPath;
  } finally {
    if (fs.existsSync(listFilePath)) fs.unlinkSync(listFilePath);
  }
}

/**
 * Applies AI lip-syncing to drive a character's mouth movement using an audio track.
 *
 * @param {string} videoPath  - Source video file path
 * @param {string} audioPath  - Driving speech audio file path
 * @param {string} outputPath - Output lip-synced video path
 * @param {object} options    - Custom settings (e.g. replicateToken, model)
 * @returns {Promise<string>} Path to lip-synced video file
 */
export async function applyLipSync(videoPath, audioPath, outputPath, options = {}) {
  logger.info(`👄 Applying AI Lip-Sync to video clip: ${path.basename(videoPath)}...`);

  const replicateToken = options.replicateToken || process.env.REPLICATE_API_TOKEN;

  if (replicateToken) {
    try {
      const replicate = new Replicate({ auth: replicateToken });
      const videoBuffer = fs.readFileSync(videoPath);
      const audioBuffer = fs.readFileSync(audioPath);

      const videoDataUrl = `data:video/mp4;base64,${videoBuffer.toString("base64")}`;
      const audioDataUrl = `data:audio/wav;base64,${audioBuffer.toString("base64")}`;

      // Call Wav2Lip / SyncLabs model on Replicate
      const output = await replicate.run(
        "devxpy/wav2lip:e8405c1608c02741f23b9ac4c28c19327f45f9a657907c300237c15276709849",
        {
          input: {
            face: videoDataUrl,
            audio: audioDataUrl,
            pads: "0 10 0 0",
            smooth: true,
          },
        }
      );

      let lipSyncedUrl = Array.isArray(output) ? output[0] : output;
      if (typeof lipSyncedUrl === "object" && lipSyncedUrl.url) {
        lipSyncedUrl = lipSyncedUrl.url;
      }

      if (lipSyncedUrl && typeof lipSyncedUrl === "string") {
        const res = await fetch(lipSyncedUrl);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(outputPath, buffer);
        logger.info(`✅ AI Lip-Sync applied via Wav2Lip → ${outputPath}`);
        return outputPath;
      }
    } catch (err) {
      logger.warn(`⚠️ Replicate Lip-Sync failed: ${err.message}. Falling back to FFmpeg audio-video sync...`);
    }
  }

  // FFmpeg Fallback: Mux audio onto video and sync durations
  const args = [
    "-y",
    "-loglevel", "error",
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v",
    "-map", "1:a",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outputPath,
  ];

  await enqueueRender(async () => {
    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", args);
      let errorLog = "";
      ff.stderr.on("data", (data) => (errorLog += data.toString()));
      ff.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(errorLog || `FFmpeg lip-sync fallback exited with code ${code}`));
      });
      ff.on("error", (err) => reject(err));
    });
  });

  logger.info(`✅ Audio-video sync completed → ${outputPath}`);
  return outputPath;
}
