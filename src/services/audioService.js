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
 * @param {number} [sfxVolume] - Sound effects volume level multiplier (default: 1.25 / 125%)
 */
export async function mixAudioFiles(
  mainFile,
  sfxLayers,
  outputFile,
  sfxVolume = parseFloat(process.env.SFX_VOLUME || "1")
) {
  return new Promise(async (resolve, reject) => {
    if (!sfxLayers || sfxLayers.length === 0) {
      fs.copyFileSync(mainFile, outputFile);
      logger.info(`No SFX layers to mix. Copied main file to ${outputFile}`);
      return resolve(outputFile);
    }

    let command = ffmpeg().input(mainFile);

    let filterComplex = "";

    // 1. Split main narration for sidechain compression
    // [main_mix] will be mixed at the end. [main_sc] acts as the sidechain trigger.
    filterComplex += `[0:a]asplit=2[main_mix][main_sc];`;

    const delayOutputs = [];

    // 2. Process each SFX layer with cinematic fading and EQ
    for (let i = 0; i < sfxLayers.length; i++) {
      const layer = sfxLayers[i];
      command = command.input(layer.file);
      const sfxDuration = await getAudioDuration(layer.file);
      const inputIdx = i + 1;
      const delayOutput = `s${inputIdx}`;
      delayOutputs.push(`[${delayOutput}]`);

      // adelay positions the SFX at exactly the word timestamp (stereo: left|right)
      const delayStr = `${Math.round(layer.delayMs)}|${Math.round(layer.delayMs)}`;

      // Calculate fade-out start to avoid abrupt cut-offs.
      const fadeOutStart = Math.max(0, sfxDuration - 0.4);

      // Immediate attack (0.05s fade-in) for 100% sync alignment on the exact word timestamp.
      // Clean 0.4s fade-out near the end of clip. Boosted sound effects volume for high-impact cinematic feel.
      const sfxFilters = [
        `volume=${sfxVolume}`,
        `equalizer=f=1000:width_type=o:width=2:g=-6`,
        `afade=t=in:st=0:d=0.05`,
        `afade=t=out:st=${fadeOutStart}:d=0.4`,
        `adelay=${delayStr}`
      ].join(",");

      filterComplex += `[${inputIdx}:a]${sfxFilters}[${delayOutput}];`;
    }

    // 3. Mix all SFX layers together before ducking
    if (sfxLayers.length > 1) {
      filterComplex += `${delayOutputs.join("")}amix=inputs=${sfxLayers.length}:normalize=0[mixed_sfx];`;
    } else {
      filterComplex += `${delayOutputs[0]}anull[mixed_sfx];`; // Simple passthrough if only 1 SFX
    }

    // 4. Duck the mixed SFX against the main narration using sidechaincompress
    // Boosted threshold 0.12 and ratio 4 ensures SFX remains loud, clear, and prominent alongside narration.
    filterComplex += `[mixed_sfx][main_sc]sidechaincompress=threshold=0.12:ratio=4:attack=20:release=400[ducked_sfx];`;

    // 5. Final cinematic mix with alimiter to prevent clipping
    filterComplex += `[main_mix][ducked_sfx]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,alimiter=limit=-1dB`;

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

/**
 * Convert any audio file to lossless 48kHz mono PCM WAV.
 * Eliminates MP3 encoder delay (~13ms/chunk) before Whisper transcription,
 * preventing cumulative drift in the Master Timeline.
 */
export async function convertToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(48000)
      .audioCodec("pcm_s16le")
      .output(outputPath)
      .on("end", () => {
        logger.info(`✅ Converted to lossless WAV: ${outputPath}`);
        resolve(outputPath);
      })
      .on("error", (err) => {
        logger.error("WAV conversion error:", err.message);
        reject(err);
      })
      .run();
  });
}
