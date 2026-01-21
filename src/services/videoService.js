import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export async function createVideo(imageUrl, audioPath, outputPath, srtPath) {
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
  const filterComplex = `[0:v]subtitles='${escapedAssPath}'`;

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

function convertSrtToAss(srtPath, assPath) {
  const srtContent = fs.readFileSync(srtPath, "utf8");
  const blocks = srtContent.trim().split(/\n\s*\n/);

  let ass = `[Script Info]
Title: Cinematic Shorts Subs
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding

; ---- GOLD GRADIENT FILL WITH BRIGHT STROKE & GLOW ----
Style: GoldGlow,Bebas Neue Bold,130,&H0000B8E6&,&H0000BFFF&,&H00FFFFFF&,&H64000000&,1,0,0,0,100,100,2,0,1,12,5,3,2,60,60,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 3) continue;

    const [startStr, endStr] = lines[1].split(" --> ");
    const fullText = lines.slice(2).join(" ").trim();
    if (!fullText) continue;

    const words = fullText.split(/\s+/);

    const startSec = parseSrtTime(startStr);
    const endSec = parseSrtTime(endStr);
    const totalDuration = endSec - startSec;

    // 🔥 3–4 words per screen
    const chunkSize = 3;
    const chunks = [];
    for (let i = 0; i < words.length; i += chunkSize) {
      chunks.push(words.slice(i, i + chunkSize).join(" "));
    }

    const chunkDuration = totalDuration / chunks.length;

    chunks.forEach((chunk, index) => {
      const s = startSec + index * chunkDuration;
      const e = s + chunkDuration;

      ass += `Dialogue: 0,${secToAssTime(s)},${secToAssTime(e)},GoldGlow,,0,0,0,,{\\an2\\pos(960,900)\\bord12\\shad5\\be4}${chunk}\n`;
    });
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
