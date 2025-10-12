import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);

/**
 * Creates a video from an array of images and a voiceover audio file.
 * - Dynamically matches image durations to audio length.
 * - Works natively on Linux (requires ffmpeg + ffprobe installed globally).
 *
 * @param {string[]} imagePaths - Full paths to image files (in order).
 * @param {string} audioFile - Path to the MP3 or WAV voiceover.
 * @param {string} outputFile - Path for the final MP4 file.
 * @returns {Promise<string>} Output file path.
 */
export async function createVideo(imagePaths, audioFile, outputFile) {
  const ffmpegPath = "ffmpeg"; 
  const ffprobePath = "ffprobe"; 

  if (!fs.existsSync(audioFile))
    throw new Error(`Audio file not found: ${audioFile}`);
  if (!Array.isArray(imagePaths) || imagePaths.length === 0)
    throw new Error("No images provided to create video.");

  // 1️⃣ Get audio duration
  const probeCmd = `${ffprobePath} -i "${audioFile}" -show_entries format=duration -v quiet -of csv="p=0"`;
  const { stdout } = await execAsync(probeCmd);
  const audioDuration = parseFloat(stdout.trim());
  if (isNaN(audioDuration)) throw new Error("Failed to detect audio duration.");

  const frameDuration = audioDuration / imagePaths.length;

  // 2️⃣ Build FFmpeg file list
  const tempListPath = path.join(process.cwd(), "temp_ffmpeg_list.txt");
  const listContent = imagePaths
    .map((img) => `file '${img.replace(/'/g, "'\\''")}'\nduration ${frameDuration}`)
    .join("\n");
  fs.writeFileSync(tempListPath, listContent, "utf-8");

  // 3️⃣ Add last frame hold (prevents ffmpeg truncation)
  fs.appendFileSync(
    tempListPath,
    `\nfile '${imagePaths[imagePaths.length - 1].replace(/'/g, "'\\''")}'\n`
  );

  // 4️⃣ Combine with audio
  const cmd = `${ffmpegPath} -f concat -safe 0 -i "${tempListPath}" -i "${audioFile}" \
    -c:v libx264 -r 30 -pix_fmt yuv420p -c:a aac -shortest "${outputFile}"`;

  try {
    await execAsync(cmd);
  } catch (err) {
    throw new Error(`FFmpeg failed: ${err.stderr || err.message}`);
  } finally {
    if (fs.existsSync(tempListPath)) fs.unlinkSync(tempListPath);
  }

  return outputFile;
}
