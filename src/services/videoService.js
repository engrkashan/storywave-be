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

  const assPath = path.join(tempDir, `subs-${Date.now()}.ass`);
  convertSrtToAss(srtPath, assPath);

  // Escape Windows-style paths for FFmpeg
  const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");

  // 🌀 Animation filter — slow zoom-in (Ken Burns effect)
  // Adjust `zoom` and `x/y` speeds for slower/faster movement
  const zoomEffect = `zoompan=z='min(zoom+0.0003,1.1)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1024x1024`;

  // 🏷️ Title text overlay at the bottom
  const titleOverlay = titleText
    ? `,drawtext=text='${escapeFFmpegText(
        titleText
      )}':fontfile='Lucida Grande':fontcolor=white:fontsize=36:borderw=2:x=(w-text_w)/2:y=h-80`
    : "";

  const filterComplex = `[0:v]${zoomEffect}${titleOverlay}[zoomed];[zoomed]subtitles='${escapedAssPath}'[vout]`;

  const cmd = [
    `ffmpeg -y -loop 1`,
    `-i "${imagePath}"`,
    `-i "${audioPath}"`,
    `-filter_complex "${filterComplex}"`,
    `-map "[vout]" -map 1:a`,
    `-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest`,
    `"${outputPath}"`,
  ].join(" ");

  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    throw new Error("🎥 Video creation failed. Check FFmpeg output above.");
  } finally {
    if (imagePath !== imageUrl && fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }
    if (fs.existsSync(assPath)) {
      fs.unlinkSync(assPath);
    }
  }
}

// 🧩 Escape special characters for FFmpeg drawtext
function escapeFFmpegText(text) {
  return text.replace(/[:'"]/g, "\\$&");
}

function convertSrtToAss(srtPath, assPath) {
  const srtContent = fs.readFileSync(srtPath, "utf8");
  const blocks = srtContent.trim().split(/\n\s*\n/);
  let ass = `[Script Info]\nTitle: Karaoke Subs\nScriptType: v4.00+\nPlayResX: 1024\nPlayResY: 1024\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n`;
  ass += `Style: Default,Times,44,&H00FFFFFF&,&H000000FF&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,3,1,2,50,50,60,1\n\n`;
  ass += `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) continue;
    const timeLine = lines[1].trim();
    const [startStr, endStr] = timeLine.split(" --> ");
    const text = lines.slice(2).join("\\N").trim();
    if (!text) continue;
    const startSec = parseSrtTime(startStr);
    const endSec = parseSrtTime(endStr);
    const durSec = endSec - startSec;
    const durCs = Math.floor(durSec * 100);
    const words = text.split(/\s+/);
    const numWords = words.length;
    if (numWords === 0) continue;
    const baseDur = Math.floor(durCs / numWords);
    const remainder = durCs % numWords;
    const durs = Array(numWords).fill(baseDur);
    for (let i = 0; i < remainder; i++) {
      durs[i] += 1;
    }
    const karaokeText = words
      .map((word, i) => `{\\k${durs[i]}}${word}`)
      .join(" ");
    const startAss = secToAssTime(startSec);
    const endAss = secToAssTime(endSec);
    ass += `Dialogue: 0,${startAss},${endAss},Default,,0,0,0,,${karaokeText}\n`;
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
