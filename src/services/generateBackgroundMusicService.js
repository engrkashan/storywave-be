import axios from "axios";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("MusicService");

export async function generateBackgroundMusic({
  title,
  storyType,
  musicStyle: customMusicStyle,
  tempDir,
}) {
  const apiUrl = "https://api.sunoapi.org/api/v1/generate";
  const headers = {
    Authorization: `Bearer ${process.env.SUNO_API_KEY}`,
    "Content-Type": "application/json",
  };

  let musicStyle = customMusicStyle?.trim();
  let genreKey = "bg_general.mp3";

  if (storyType?.toLowerCase().includes("true_crime")) {
    genreKey = "bg_true_crime.mp3";
    if (!musicStyle) musicStyle = "slow dark ambient, suspenseful, minimalistic, cinematic tension";
  } else if (storyType?.toLowerCase().includes("storytelling") || storyType?.toLowerCase().includes("cinematic")) {
    genreKey = "bg_cinematic.mp3";
    if (!musicStyle) musicStyle = "slow cinematic ambient, emotional strings, soft piano, atmospheric";
  } else if (storyType?.toLowerCase().includes("documentary") || storyType?.toLowerCase().includes("history")) {
    genreKey = "bg_documentary.mp3";
    if (!musicStyle) musicStyle = "slow documentary ambient, thoughtful, gentle piano and pads";
  } else if (storyType?.toLowerCase().includes("howto") || storyType?.toLowerCase().includes("education")) {
    genreKey = "bg_howto.mp3";
    if (!musicStyle) musicStyle = "slow calm lo-fi, gentle background, motivational yet relaxed";
  } else if (storyType?.toLowerCase().includes("advertisement") || storyType?.toLowerCase().includes("ad")) {
    genreKey = "bg_ad.mp3";
    if (!musicStyle) musicStyle = "upbeat corporate commercial background music, energetic, modern, high production value";
  }

  if (!musicStyle) {
    musicStyle = "slow ambient background music, calm, emotional, cinematic";
  }

  // ⚡ Strategy 4: Check local BGM cache before calling Suno API
  const bgCacheDir = path.join(process.cwd(), "public", "bg_music_cache");
  fs.mkdirSync(bgCacheDir, { recursive: true });
  const bgCachePath = path.join(bgCacheDir, genreKey);

  if (fs.existsSync(bgCachePath)) {
    const cachedDest = path.join(tempDir, `bg-music-${Date.now()}.mp3`);
    fs.copyFileSync(bgCachePath, cachedDest);
    logger.info(`🎵 [Background Music Strategy 4 Hit] Using cached BGM track for genre "${storyType || "general"}" -> ${cachedDest}`);
    return cachedDest;
  }

  const body = {
    customMode: true,
    instrumental: true,
    style: musicStyle,
    title: (title || "Background Story Music").substring(0, 60),
    model: "V5",
    callBackUrl:
      "https://www.youtube.com/watch?v=OPugs48z2GU&list=RDOPugs48z2GU&start_radio=1",
  };

  try {
    logger.info(
      `[Background Music] Generating with style: "${musicStyle}" (story type: ${storyType || "general"})`,
    );

    // Step 1: Submit generation request
    const generateRes = await axios.post(apiUrl, body, { headers });

    if (generateRes.data.code !== 200) {
      throw new Error(
        `Suno API error: ${generateRes.data.msg || "Unknown error"}`,
      );
    }

    const taskId = generateRes.data.data.taskId;
    logger.info(`[Background Music] Task created: ${taskId}`);

    // Step 2: Poll for completion
    const pollUrl = "https://api.sunoapi.org/api/v1/generate/record-info";
    let status = "PENDING";
    let pollCount = 0;
    const maxPolls = 40;
    let audioUrl = null;

    while (status !== "SUCCESS" && pollCount < maxPolls) {
      await new Promise((r) => setTimeout(r, 10000)); // 10s polling
      pollCount++;

      const pollRes = await axios.get(`${pollUrl}?taskId=${taskId}`, {
        headers,
      });

      if (pollRes.data.code !== 200) {
        throw new Error(`Polling failed: ${pollRes.data.msg}`);
      }

      status = pollRes.data.data.status || "UNKNOWN";
      logger.info(
        `[Background Music] Status (${pollCount}/${maxPolls}): ${status}`,
      );

      if (["FAILED", "SENSITIVE_WORD_ERROR"].includes(status)) {
        throw new Error(pollRes.data.data.errorMessage || "Generation failed");
      }

      if (status === "SUCCESS") {
        audioUrl = pollRes.data.data.response?.sunoData?.[0]?.audioUrl;
        break;
      }
    }

    if (!audioUrl || !audioUrl.startsWith("http")) {
      logger.info("Invalid audioUrl:", audioUrl);
      throw new Error("Invalid or missing audio URL");
    }

    // Step 3: Download the music file
    const musicFilename = `bg-music-${Date.now()}.mp3`;
    const musicPath = path.join(tempDir, musicFilename);
    logger.info("Downloading music from:", audioUrl);
    const downloadRes = await axios.get(audioUrl, {
      responseType: "arraybuffer",
    });
    fs.writeFileSync(musicPath, Buffer.from(downloadRes.data));
    try {
      fs.copyFileSync(musicPath, bgCachePath);
      logger.info(`[Background Music] Cached for future Strategy 4 reuse: ${bgCachePath}`);
    } catch (e) {
      logger.warn(`Failed to copy to BGM cache: ${e.message}`);
    }

    logger.info(`[Background Music] Saved: ${musicPath}`);
    return musicPath;
  } catch (err) {
    logger.error(`[Background Music] Failed: ${err.message}`);
    return null;
  }
}

export async function mixAudioWithBackground(voicePath, musicPath, outputPath) {
  if (!musicPath || !fs.existsSync(musicPath)) {
    logger.info("[Audio Mix] No background music → copying voice only");
    fs.copyFileSync(voicePath, outputPath);
    return;
  }

  const bgVolume = parseFloat(process.env.BG_MUSIC_VOLUME || "0.04");

  const cmd = [
    `ffmpeg -y`,
    `-i "${voicePath}"`,
    `-stream_loop -1 -i "${musicPath}"`,
    `-filter_complex "[1:a]volume=${bgVolume}[bg]; [bg][0:a]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=200[ducked]; [0:a][ducked]amix=inputs=2:duration=first[a]"`,
    `-map "[a]" -c:a libmp3lame -b:a 192k`,
    `"${outputPath}"`,
  ].join(" ");

  // `-filter_complex "[1:a]volume=0.2,highpass=f=100,lowpass=f=8000[bg]; [0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[a]"`,
  try {
    logger.info("[Audio Mix] Mixing voice + background music (looping)...");
    await new Promise((resolve, reject) => {
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          logger.error("[Audio Mix] FFmpeg error:", stderr || error.message);
          return reject(error);
        }
        resolve();
      });
    });
    logger.info("[Audio Mix] Success →", outputPath);
  } catch (err) {
    logger.error("[Audio Mix] FFmpeg failed:", err.message);
    fs.copyFileSync(voicePath, outputPath);
  }
}
