import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export async function createVideo(
  titleText = "",
  imageUrl,
  audioPath,
  outputPath,
  srtPath
) {
  const TEMP_DIR = path.resolve(process.cwd(), "temp");
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  let imagePath = imageUrl;
  if (imageUrl.startsWith("http")) {
    const localImage = path.join(TEMP_DIR, `story-bg-${Date.now()}.png`);
    const res = await fetch(imageUrl);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(localImage, buffer);
    imagePath = localImage;
  }

  const assPath = path.join(TEMP_DIR, `subs-${Date.now()}.ass`);
  convertSrtToAss(srtPath, assPath);

  const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");

  // 🏷️ Title text overlay (no zoom)
  const titleOverlay = titleText
    ? `drawtext=text='${escapeFFmpegText(
        titleText
      )}':fontsize=40:borderw=2:fontcolor=white:x=(w-text_w)/2:y=50,`
    : "";

  // ✅ Correct filter chain: image → (drawtext optional) → subtitles
  const filterComplex = `[0:v]${titleOverlay}subtitles='${escapedAssPath}'`;

  const cmd = [
    `ffmpeg -y -loop 1`,
    `-i "${imagePath}"`,
    `-i "${audioPath}"`,
    `-filter_complex "${filterComplex}"`,
    `-map 0:v -map 1:a`,
    `-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest`,
    `"${outputPath}"`,
  ].join(" ");

  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    throw new Error("🎥 Video creation failed. Check FFmpeg output above.");
  } finally {
    if (imagePath !== imageUrl && fs.existsSync(imagePath))
      fs.unlinkSync(imagePath);
    if (fs.existsSync(assPath)) fs.unlinkSync(assPath);
  }
}

// 🧩 Escape special characters for FFmpeg drawtext
function escapeFFmpegText(text) {
  return text.replace(/[:'"]/g, "\\$&");
}

function convertSrtToAss(srtPath, assPath) {
  const srtContent = fs.readFileSync(srtPath, "utf8");
  const blocks = srtContent.trim().split(/\n\s*\n/);

  let ass = `[Script Info]
Title: Karaoke Subs
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080


[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVuSans,180,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,4,2,2,60,60,100,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) continue;
    const timeLine = lines[1].trim();
    const [startStr, endStr] = timeLine.split(" --> ");
    const text = lines.slice(2).join("\\N").trim();
    if (!text) continue;
    const startSec = parseSrtTime(startStr);
    const endSec = parseSrtTime(endStr);
    const startAss = secToAssTime(startSec);
    const endAss = secToAssTime(endSec);
    ass += `Dialogue: 0,${startAss},${endAss},Default,,0,0,0,,${text}\n`;
  }

  fs.writeFileSync(assPath, ass);
}

function parseSrtTime(timeStr) {
  const [hms, ms] = timeStr.split(",");
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s + Number(ms) / 1000;
}

function secToAssTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function pad(n) {
  return n.toString().padStart(2, "0");
}
