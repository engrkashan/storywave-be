import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import path from "path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("AudioService");

/**
 * Merge multiple MP3 audio files into one MP3 sequentially.
 * If only one file is passed, just copy it.
 */
export async function mergeAudioFiles(files, outputFile) {
  return new Promise((resolve, reject) => {
    if (!files || files.length === 0) {
      return reject(new Error("No audio files provided for merging"));
    }

    // If only one file → just copy it
    if (files.length === 1) {
      fs.copyFileSync(files[0], outputFile);
      logger.info(`Single file copied to ${outputFile}`);
      return resolve(outputFile);
    }

    // Create a temporary list file for ffmpeg concat demuxer
    const listFile = path.join(
      process.cwd(),
      "public",
      "podcasts",
      `merge_list_${Date.now()}.txt`,
    );
    // Ensure directory exists
    fs.mkdirSync(path.dirname(listFile), { recursive: true });

    const fileContent = files
      .map((f) => `file '${path.resolve(f)}'`)
      .join("\n");
    fs.writeFileSync(listFile, fileContent);

    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .save(outputFile)
      .on("end", () => {
        logger.info(`Audio merged successfully to ${outputFile}`);
        fs.unlinkSync(listFile);
        resolve(outputFile);
      })
      .on("error", (err) => {
        logger.error("FFMPEG Merge Error:", err.message);
        reject(err);
      });
  });
}

/**
 * Get duration of an audio file in seconds using ffprobe
 */
export async function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        logger.error("FFMPEG Duration Error:", err.message);
        return reject(err);
      }
      const duration = metadata?.format?.duration || 0;
      resolve(duration); // Return float for precision
    });
  });
}

/**
 * Mix background audio tracks (SFX) with specific start times into a main audio track.
 *
 * @param {string} mainFile - Path to the primary continuous audio file (e.g., narration)
 * @param {Array<{file: string, delayMs: number}>} sfxLayers - Array of SFX objects
 * @param {string} outputFile - Destination path
 */
export async function mixAudioFiles(mainFile, sfxLayers, outputFile) {
  return new Promise(async (resolve, reject) => {
    if (!sfxLayers || sfxLayers.length === 0) {
      fs.copyFileSync(mainFile, outputFile);
      logger.info(`No SFX layers to mix. Copied main file to ${outputFile}`);
      return resolve(outputFile);
    }

    let command = ffmpeg().input(mainFile);

    let filterComplex = "";
    const inputCount = sfxLayers.length + 1; // 1 for the main file

    // 1. Main narration — normalized to 1.0 (no volume boost, prevents clipping when mixed)
    filterComplex += `[0]volume=1.0[main];`;

    const delayOutputs = [];

    // 2. Apply volume reduction + precise timing delay to each SFX layer (no fading)
    for (let i = 0; i < sfxLayers.length; i++) {
      const layer = sfxLayers[i];
      command = command.input(layer.file);
      const inputIdx = i + 1;
      const delayOutput = `s${inputIdx}`;
      delayOutputs.push(`[${delayOutput}]`);

      // adelay positions the SFX at exactly the word timestamp (stereo: left|right)
      const delayStr = `${Math.round(layer.delayMs)}|${Math.round(layer.delayMs)}`;

      // volume=0.35 keeps SFX as a subtle background layer; no fade so it starts instantly
      filterComplex += `[${inputIdx}]volume=0.35,adelay=${delayStr}[${delayOutput}];`;
    }

    // 3. Mix narration with all SFX layers.
    // normalize=0 → each stream plays at its own volume; without this, amix divides
    // narration by input count (e.g. 0.5x when 1 SFX is active), making it quiet
    // at the start and suddenly louder once the SFX ends — the "slow start" effect.
    // duration=first → output length matches narration (not the longest SFX).
    // dropout_transition=0 → no ramp when a stream ends (instant).
    // alimiter=limit=-1dB → prevents audio clipping when multiple SFX layers overlap
    filterComplex += `[main]${delayOutputs.join("")}amix=inputs=${inputCount}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=-1dB`;

    command
      .complexFilter(filterComplex)
      .save(outputFile)
      .on("end", () => {
        logger.info(`Audio layered and mixed successfully to ${outputFile}`);
        resolve(outputFile);
      })
      .on("error", (err) => {
        logger.error("FFMPEG Mix Error:", err.message);
        reject(err);
      });
  });
}
