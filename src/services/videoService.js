import { execSync } from "child_process";
import fs from "fs";
import path from "path";

/**
 * Creates a video from one image, one voiceover, and a pre-generated SRT file.
 *
 * @param {string} imageUrl - Path or URL to the single image
 * @param {string} audioPath - Path to the voiceover MP3
 * @param {string} outputPath - Path to save output video
 * @param {string} srtPath - Path to the pre-generated SRT subtitles file
 */
export async function createVideo(imageUrl, audioPath, outputPath, srtPath) {
  const tempDir = path.join(process.cwd(), "temp");
  fs.mkdirSync(tempDir, { recursive: true });

  // 1️⃣ & 2️⃣ Subtitle generation and timing logic REMOVED.
  // SRT file is provided via srtPath parameter.

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
    ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" \\
    -vf "subtitles='${srtPath}':force_style='FontName=Arial,FontSize=36,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=1,Alignment=2'" \\
    -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "${outputPath}"
  `;
  // The -shortest flag ensures the video ends when the audio ends.

  execSync(cmd, { stdio: "inherit" });

  // cleanup
  // srtPath cleanup is now handled in runWorkflow.js
  if (imagePath !== imageUrl && fs.existsSync(imagePath))
    fs.unlinkSync(imagePath);

  console.log(`🎬 Video created at ${outputPath}`);
}

