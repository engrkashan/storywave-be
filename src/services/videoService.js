import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { getAudioDurationInSeconds } from "get-audio-duration";

/**
 * Creates a video from one image, one voiceover, and multiple subtitles.
 *
 * @param {string} imageUrl - Path or URL to the single image
 * @param {string} audioPath - Path to the voiceover MP3
 * @param {string} outputPath - Path to save output video
 * @param {string[]} scenes - Array of subtitle texts (scenes)
 */
export async function createVideo(imageUrl, audioPath, outputPath, scenes) {
  const tempDir = path.join(process.cwd(), "temp");
  fs.mkdirSync(tempDir, { recursive: true });

  const srtPath = path.join(tempDir, `subtitles-${Date.now()}.srt`);

  // 1️⃣ Calculate total duration of the audio
  const duration = await getAudioDurationInSeconds(audioPath);
  const segmentDuration = duration / scenes.length;

  // 2️⃣ Generate .srt subtitles file
  let srt = "";
  let currentTime = 0;
  for (let i = 0; i < scenes.length; i++) {
    const start = formatTime(currentTime);
    const end = formatTime(currentTime + segmentDuration);
    srt += `${i + 1}\n${start} --> ${end}\n${scenes[i].trim()}\n\n`;
    currentTime += segmentDuration;
  }
  fs.writeFileSync(srtPath, srt);

  // 3️⃣ Download image if it's a URL (Cloudinary or generated)
  let imagePath = imageUrl;
  if (imageUrl.startsWith("http")) {
    const localImage = path.join(tempDir, `story-bg-${Date.now()}.png`);
    const res = await fetch(imageUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(localImage, buffer);
    imagePath = localImage;
  }

  // 4️⃣ FFmpeg command to merge static image + audio + subtitles
  const cmd = `
    ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" \
    -vf "subtitles='${srtPath}':force_style='FontName=Arial,FontSize=36,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=1,Alignment=2'" \
    -c:v libx264 -t ${duration} -pix_fmt yuv420p -c:a aac -shortest "${outputPath}"
  `;

  execSync(cmd, { stdio: "inherit" });

  // cleanup
  fs.unlinkSync(srtPath);
  if (imagePath !== imageUrl && fs.existsSync(imagePath))
    fs.unlinkSync(imagePath);

  console.log(`🎬 Video created at ${outputPath}`);
}

// Helper: format seconds → "00:00:00,000"
function formatTime(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(sec % 60)).padStart(2, "0");
  const ms = "000";
  return `${h}:${m}:${s},${ms}`;
}
