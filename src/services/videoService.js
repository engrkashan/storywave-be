import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export async function createVideo(imageUrl, audioPath, outputPath, srtPath) {
  const tempDir = path.join(process.cwd(), "temp");
  fs.mkdirSync(tempDir, { recursive: true });

  // Download image if it's a URL
  let imagePath = imageUrl;
  if (imageUrl.startsWith("http")) {
    const localImage = path.join(tempDir, `story-bg-${Date.now()}.png`);
    const res = await fetch(imageUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(localImage, buffer);
    imagePath = localImage;
  }

  // Cleanly build one-liner FFmpeg command
  const cmd = [
    `ffmpeg -y -loop 1`,
    `-i "${imagePath}"`,
    `-i "${audioPath}"`,
    `-vf "subtitles='${srtPath.replace(
      /'/g,
      "\\'"
    )}':force_style='FontName=Arial,FontSize=14,PrimaryColour=&H00FFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=1,Alignment=2,MarginV=60'"`,
    `-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest`,
    `"${outputPath}"`,
  ].join(" ");

  console.log("▶️ Running FFmpeg:\n", cmd, "\n");

  try {
    execSync(cmd, { stdio: "inherit" });
    console.log(`🎬 Video created at ${outputPath}`);
  } catch (err) {
    console.error("❌ FFmpeg failed:", err.message);
    throw new Error("Video creation failed. Check FFmpeg output above.");
  } finally {
    // Cleanup downloaded image if temporary
    if (imagePath !== imageUrl && fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }
  }
}
