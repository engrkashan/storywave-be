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
  sfxVolume = parseFloat(process.env.SFX_VOLUME || "0.9")
) {
  return new Promise(async (resolve, reject) => {
    if (!sfxLayers || sfxLayers.length === 0) {
      fs.copyFileSync(mainFile, outputFile);
      logger.info(`No SFX layers to mix. Copied main file to ${outputFile}`);
      return resolve(outputFile);
    }

    let command = ffmpeg().input(mainFile);
    let filterComplex = "";
    const delayOutputs = [];

    // Process each SFX layer with clean fade transitions & exact delay positioning
    for (let i = 0; i < sfxLayers.length; i++) {
      const layer = sfxLayers[i];
      command = command.input(layer.file);
      const sfxDuration = await getAudioDuration(layer.file);
      const inputIdx = i + 1;
      const delayOutput = `s${inputIdx}`;
      delayOutputs.push(`[${delayOutput}]`);

      // adelay positions the SFX at exactly the word timestamp (stereo: left|right)
      const delayStr = `${Math.round(layer.delayMs)}|${Math.round(layer.delayMs)}`;

      // Calculate fade-out start to avoid abrupt cut-offs
      const fadeOutStart = Math.max(0, sfxDuration - 0.3);

      const sfxFilters = [
        `volume=${sfxVolume}`,
        `afade=t=in:st=0:d=0.03`,
        `afade=t=out:st=${fadeOutStart}:d=0.3`,
        `adelay=${delayStr}`
      ].join(",");

      filterComplex += `[${inputIdx}:a]${sfxFilters}[${delayOutput}];`;
    }

    // Combine all SFX layers
    if (sfxLayers.length > 1) {
      filterComplex += `${delayOutputs.join("")}amix=inputs=${sfxLayers.length}:normalize=0[mixed_sfx];`;
    } else {
      filterComplex += `${delayOutputs[0]}anull[mixed_sfx];`;
    }

    // Mix narration track [0:a] directly with [mixed_sfx] using amix and alimiter to keep audio clear and prevent clipping
    filterComplex += `[0:a][mixed_sfx]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,alimiter=limit=-0.5dB`;

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

/**
 * Mix full cinematic soundscape: Narration + Continuous Ambience + Foley SFX + Tension Drones + Background Music.
 */
export async function mixCinematicSoundscape({
  narrationFile,
  backgroundMusicFile = null,
  soundscapeAssets = [],
  outputFile,
}) {
  return new Promise(async (resolve, reject) => {
    if (!fs.existsSync(narrationFile)) {
      return reject(new Error(`Narration file missing: ${narrationFile}`));
    }

    if (!soundscapeAssets || soundscapeAssets.length === 0) {
      if (backgroundMusicFile && fs.existsSync(backgroundMusicFile)) {
        // Simple narration + music mix
        let command = ffmpeg()
          .input(narrationFile)
          .input(backgroundMusicFile)
          .inputOptions(["-stream_loop -1"])
          .complexFilter(`[1:a]volume=0.15[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0,alimiter=limit=-0.5dB`)
          .save(outputFile)
          .on("end", () => resolve(outputFile))
          .on("error", reject);
        return;
      }
      fs.copyFileSync(narrationFile, outputFile);
      return resolve(outputFile);
    }

    let command = ffmpeg().input(narrationFile);
    const hasMusic = backgroundMusicFile && fs.existsSync(backgroundMusicFile);
    if (hasMusic) {
      command = command.input(backgroundMusicFile).inputOptions(["-stream_loop -1"]);
    }

    let filterComplex = "";
    const sfxOutputs = [];
    const baseOffset = hasMusic ? 2 : 1;

    for (let i = 0; i < soundscapeAssets.length; i++) {
      const asset = soundscapeAssets[i];
      const inputIdx = baseOffset + i;
      command = command.input(asset.file);

      const delayMs = Math.round(asset.delayMs || 0);
      const delayStr = `${delayMs}|${delayMs}`;
      const vol = asset.volume || 0.35;
      const fadeIn = asset.fadeInSec || 0.1;
      const fadeOut = asset.fadeOutSec || 0.4;

      const dur = asset.durationSec || (await getAudioDuration(asset.file).catch(() => 3.0));
      const fadeOutStart = Math.max(0, dur - fadeOut);

      const outLabel = `layer_${i}`;
      sfxOutputs.push(`[${outLabel}]`);

      filterComplex += `[${inputIdx}:a]volume=${vol},afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fadeOutStart}:d=${fadeOut},adelay=${delayStr}[${outLabel}];`;
    }

    // Combine all soundscape asset tracks
    if (sfxOutputs.length > 1) {
      filterComplex += `${sfxOutputs.join("")}amix=inputs=${sfxOutputs.length}:normalize=0[mixed_soundscape];`;
    } else {
      filterComplex += `${sfxOutputs[0]}anull[mixed_soundscape];`;
    }

    // Final mix with narration & optional music (soft ambient music at volume=0.08)
    if (hasMusic) {
      filterComplex += `[1:a]volume=0.08[bg_music];[bg_music][0:a]sidechaincompress=threshold=0.03:ratio=5:attack=20:release=300[ducked_music];[0:a][ducked_music][mixed_soundscape]amix=inputs=3:duration=first:dropout_transition=2:normalize=0,alimiter=limit=-0.5dB`;
    } else {
      filterComplex += `[0:a][mixed_soundscape]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,alimiter=limit=-0.5dB`;
    }

    logger.info(`🎛️ [Cinematic Sound Mixer] Mixing ${soundscapeAssets.length} sound layers + ${hasMusic ? "Music" : "No Music"} + Narration...`);

    command
      .complexFilter(filterComplex)
      .save(outputFile)
      .on("end", () => {
        logger.info(`✅ Cinematic Soundscape mixed successfully to ${outputFile}`);
        resolve(outputFile);
      })
      .on("error", (err) => {
        logger.error("❌ FFMPEG Cinematic Soundscape Mix Error:", err.message);
        reject(err);
      });
  });
}

