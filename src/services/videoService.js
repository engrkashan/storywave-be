// import { execSync } from "child_process";
// import fs from "fs";
// import path from "path";

// export async function createVideo(imageUrl, audioPath, outputPath, srtPath) {
//   const tempDir = path.join(process.cwd(), "temp");
//   fs.mkdirSync(tempDir, { recursive: true });

//   let imagePath = imageUrl;
//   if (imageUrl.startsWith("http")) {
//     const localImage = path.join(tempDir, `story-bg-${Date.now()}.png`);
//     const res = await fetch(imageUrl);
//     const buffer = Buffer.from(await res.arrayBuffer());
//     fs.writeFileSync(localImage, buffer);
//     imagePath = localImage;
//   }

//   const subtitleStyle = [
//     "FontName=Arial",
//     "FontSize=20",
//     "PrimaryColour=&H00FFFFFF&",
//     "OutlineColour=&H000000&",
//     "BorderStyle=4",
//     "BackColour=&HAAFF00FF&",
//     "Outline=1",
//     "Shadow=0",
//     "Bold=0",
//     "Alignment=2",
//     "MarginV=60",
//   ].join(",");

//   const cmd = [
//     `ffmpeg -y -loop 1`,
//     `-i "${imagePath}"`,
//     `-i "${audioPath}"`,
//     `-vf "subtitles='${srtPath.replace(
//       /'/g,
//       "\\'"
//     )}':force_style='${subtitleStyle}'"`,
//     `-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest`,
//     `"${outputPath}"`,
//   ].join(" ");

//   try {
//     execSync(cmd, { stdio: "inherit" });
//   } catch (err) {
//     throw new Error("Video creation failed. Check FFmpeg output above.");
//   } finally {
//     if (imagePath !== imageUrl && fs.existsSync(imagePath)) {
//       fs.unlinkSync(imagePath);
//     }
//   }
// }


import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export async function createVideo(imageUrl, audioPath, outputPath, srtPath) {
  const tempDir = path.join(process.cwd(), "temp");
  fs.mkdirSync(tempDir, { recursive: true });

  let imagePath = imageUrl;
  if (imageUrl.startsWith("http")) {
    const localImage = path.join(tempDir, `story-bg-${Date.now()}.png`);
    const res = await fetch(imageUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(localImage, buffer);
    imagePath = localImage;
  }

  const subtitleStyle = [
    "FontName=Arial",
    "FontSize=20",
    "PrimaryColour=&H00FFFFFF&",
    "OutlineColour=&H000000&",
    "BorderStyle=4",
    "BackColour=&HAAFF00FF&",
    "Outline=1",
    "Shadow=0",
    "Bold=0",
    "Alignment=2",
    "MarginV=60",
  ].join(",");

  // Escape the SRT path for FFmpeg filter: use / instead of \, escape : as \:
  const escapedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  const cmd = [
    `ffmpeg -y -loop 1`,
    `-i "${imagePath}"`,
    `-i "${audioPath}"`,
    `-vf "subtitles=filename='${escapedSrtPath.replace(/'/g, "\\'")}':force_style='${subtitleStyle}'"`,  // Updated filter with explicit filename and escaping
    `-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest`,
    `"${outputPath}"`,
  ].join(" ");

  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    throw new Error("Video creation failed. Check FFmpeg output above.");
  } finally {
    if (imagePath !== imageUrl && fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }
  }
}