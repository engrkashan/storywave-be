import fs from "fs";
import OpenAI from "openai";
import path from "path";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("VoiceoverService");
import { FishAudioClient } from "fish-audio";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { cloudinary } from "../config/cloudinary.config.js";
import {
  mergeAudioFiles,
  mixAudioFiles,
  getAudioDuration,
} from "./audioService.js";

// ─── API Clients ──────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const fishAudio = new FishAudioClient({ apiKey: process.env.FISH_API_KEY });
const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVEN_LAB_API_KEY,
});

// ─── OpenAI voice allowlist (gpt-4o-mini-tts supported values) ───────────────
const OPENAI_VALID_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanScript(script, preserveEmotions = false) {
  let cleaned = script
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/\[.*?\]/g, "");

  if (preserveEmotions) {
    cleaned = cleaned.replace(/\(Pause\)/g, "(break)");
  } else {
    cleaned = cleaned.replace(/\(Pause\)/g, ". ");
  }

  return cleaned.trim();
}

function chunkBySentences(text, maxChunkSize = 300) {
  if (!text || !text.trim()) return [];
  const chunks = [];
  // Match full sentences including terminal punctuation, OR trailing text without punctuation
  const sentences = text.match(/[^.!?]+(?:[.!?]+|\s*$)/g) || [text];
  let currentChunk = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (
      currentChunk &&
      currentChunk.length + trimmed.length + 1 > maxChunkSize
    ) {
      chunks.push(currentChunk.trim());
      currentChunk = trimmed;
    } else {
      currentChunk += (currentChunk ? " " : "") + trimmed;
    }
  }

  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks.length > 0 ? chunks : [text.trim()];
}

// ─── Per-provider TTS chunk functions ─────────────────────────────────────────

const ELEVENLABS_PRESETS = new Set([
  "CwhRBWXzGAHq8TQ4Fs17", "EXAVITQu4vr4xnSDxMaL", "FGY2WhTYpPnrIDTdsKH5", "IKne3meq5aSn9XLyUdCD", "JBFqnCBsd6RMkjVDRZzb", "N2lVS1w4EtoT3dr4eOWO", "SAz9YHcvj6GT2YYXdXww", "SOYHLrjzK2X1ezoPC6cr", "TX3LPaxmHKxFdv7VOQHJ", "Xb7hH8MSUJpSbSDYk0k2", "XrExE9yKIg1WjnnlVkGX", "bIHbv24MWmeRgasZH58o", "cgSgspJ2msm6clMCkdW9", "cjVigY5qzO86Huf0OWal", "hpp4J3VqNfWAUOO0d1Us", "iP95p4xoKVk53GoZ742B", "nPczCjzI2devNBz1zQrb", "onwK4e9ZLuTAKqWW03F9", "pFZP5JQG7iQjIQuC4Bku", "pNInz6obpgDQGcFmaJgB", "pqHfZKP75CvOlQylNhV4", "21m00Tcm4TlvDq8ikWAM"
]);

async function ttsElevenLabs(text, voiceId) {
  try {
    logger.info(`[ElevenLabs] Converting text with voice ID: ${voiceId}`);
    const audioStream = await elevenlabs.textToSpeech.convert(voiceId, {
      text,
      model_id: "eleven_multilingual_v2",
    });

    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    logger.error(
      `[ElevenLabs] TTS Error payload: text="${text}", voiceId="${voiceId}"`,
    );
    throw new Error(`ElevenLabs TTS failed: ${error.message}`);
  }
}

async function sfxElevenLabs(text) {
  try {
    const slug = (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .substring(0, 50);

    const cacheDir = path.join(process.cwd(), "public", "sfx_cache");
    fs.mkdirSync(cacheDir, { recursive: true });

    const cachePath = path.join(cacheDir, `${slug || "sfx"}.mp3`);

    if (fs.existsSync(cachePath)) {
      logger.info(`[SFX Cache Hit] Using cached SFX for "${text}" -> ${cachePath}`);
      return fs.readFileSync(cachePath);
    }

    // Dynamic duration depending on SFX type
    let durationSeconds = 3;
    const lower = (text || "").toLowerCase();
    if (lower.includes("gunshot") || lower.includes("shot") || lower.includes("buzz") || lower.includes("click") || lower.includes("beep") || lower.includes("slam")) {
      durationSeconds = 2;
    } else if (lower.includes("footstep") || lower.includes("steps") || lower.includes("door") || lower.includes("creak") || lower.includes("whisper")) {
      durationSeconds = 3.5;
    } else if (lower.includes("thunder") || lower.includes("explosion") || lower.includes("storm") || lower.includes("wind")) {
      durationSeconds = 4;
    }

    logger.info(`[ElevenLabs SFX] Generating from API: "${text}" (${durationSeconds}s)`);
    const audioStream = await elevenlabs.textToSoundEffects.convert({
      text,
      duration_seconds: durationSeconds,
    });

    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer && buffer.length > 0) {
      fs.writeFileSync(cachePath, buffer);
      logger.info(`[SFX Cached] Saved to cache: ${cachePath}`);
    }
    return buffer;
  } catch (error) {
    logger.error(`[ElevenLabs SFX Error] payload: text="${text}" — ${error.message}`);
    return Buffer.alloc(0);
  }
}

async function ttsFishAudio(text, referenceId) {
  try {
    logger.info(
      `[Fish Audio] Converting text with reference ID: ${referenceId}`,
    );
    const audio = await fishAudio.textToSpeech.convert(
      { text, reference_id: referenceId, format: "mp3" },
      "s2.1-pro-free",
    );
    return Buffer.from(await new Response(audio).arrayBuffer());
  } catch (error) {
    throw new Error(`Fish Audio TTS failed: ${error.message}`);
  }
}

async function ttsOpenAI(text, voice) {
  let validVoice = typeof voice === "string" ? voice : voice?.id || "onyx";

  if (!OPENAI_VALID_VOICES.has(validVoice)) {
    logger.warn(`[OpenAI TTS] Invalid voice "${validVoice}". Falling back to 'onyx'.`);
    validVoice = "onyx";
  }

  logger.info(`[OpenAI] Converting text with voice: ${validVoice}`);
  const res = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: validVoice,
    input: text,
  });
  return Buffer.from(await res.arrayBuffer());
}

// ─── Main TTS Generator ───────────────────────────────────────────────────────

export async function generateVoiceover(script, filename, voiceObj, tempDir) {
  const localPath = path.join(tempDir, filename);
  fs.mkdirSync(tempDir, { recursive: true });

  logger.info(
    `[generateVoiceover] Raw voiceObj received: ${JSON.stringify(voiceObj)}`,
  );

  if (
    !voiceObj ||
    (typeof voiceObj !== "object" && typeof voiceObj !== "string")
  ) {
    logger.warn(
      `[generateVoiceover] voiceObj is null/undefined — defaulting to OpenAI 'nova'`,
    );
    voiceObj = { id: "nova", provider: "openai", label: "Nova (default)" };
  }

  let rawProvider = voiceObj?.provider ?? "";
  let voiceId = voiceObj?.id ?? voiceObj;

  if (!rawProvider && typeof voiceId === "string") {
    if (OPENAI_VALID_VOICES.has(voiceId.toLowerCase())) {
      rawProvider = "openai";
    } else if (voiceId.length === 32 && /^[0-9a-f]+$/.test(voiceId)) {
      rawProvider = "fish";
    } else if (voiceId.length >= 20) {
      rawProvider = "elevenlabs";
    } else {
      rawProvider = "openai";
    }
    logger.warn(
      `[generateVoiceover] provider was missing — auto-detected as "${rawProvider}" for voiceId="${voiceId}"`,
    );
  }

  const provider = String(rawProvider).toLowerCase().trim();
  const finalVoiceId =
    typeof voiceObj === "object" && voiceObj !== null
      ? voiceObj.id || voiceId
      : voiceId;

  const isElevenLabs = provider === "elevenlabs";
  const isFish = provider === "fish";
  const isOpenAI = !isElevenLabs && !isFish;

  const providerLabel = isElevenLabs
    ? "ElevenLabs"
    : isFish
      ? "Fish Audio S1"
      : "OpenAI";

  logger.info(
    `🎙️ [generateVoiceover] provider="${providerLabel}" | ` +
    `raw="${rawProvider}" | finalVoiceId="${finalVoiceId}" | label="${voiceObj?.label}"`,
  );

  const segments = [];

  const regex = /\[(.*?)\]|\((.*?)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(script)) !== null) {
    if (match.index > lastIndex) {
      let textPart = script.substring(lastIndex, match.index).trim();
      if (textPart) {
        textPart = textPart.replace(/\*\*/g, "").replace(/\*/g, ""); // Clean markdown
        chunkBySentences(textPart, 300).forEach((c) => {
          if (c.trim()) segments.push({ type: "text", content: c });
        });
      }
    }
    const sfxText = (match[1] || match[2])?.trim();
    if (sfxText) {
      const sfxLower = sfxText.toLowerCase();
      if (sfxLower === "pause" || sfxLower === "break") {
        segments.push({ type: "text", content: "..." });
      } else {
        segments.push({ type: "sfx", content: sfxText });
      }
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < script.length) {
    let textPart = script.substring(lastIndex).trim();
    if (textPart) {
      textPart = textPart.replace(/\*\*/g, "").replace(/\*/g, ""); // Clean markdown
      chunkBySentences(textPart, 300).forEach((c) => {
        if (c.trim()) segments.push({ type: "text", content: c });
      });
    }
  }

  logger.info(`📋 Segments to process: ${segments.length}`);

  // ── Process segments ─────────────────────────────────────────────────────────
  const chunkFiles = [];
  const sfxLayers = [];

  // currentDelayMs: total duration of narration chunks processed so far (ms)
  let currentDelayMs = 0;

  try {
    // Dependency-free concurrency pool
    async function mapConcurrent(items, limit, asyncFn) {
      const results = new Array(items.length);
      let index = 0;
      const workers = new Array(limit).fill(0).map(async () => {
        while (index < items.length) {
          const currentIndex = index++;
          results[currentIndex] = await asyncFn(items[currentIndex], currentIndex);
        }
      });
      await Promise.all(workers);
      return results;
    }

    logger.info(`🚀 Starting concurrent TTS generation (limit: 5)...`);
    const resolvedSegments = await mapConcurrent(segments, 5, async (segment, i) => {
      if (!segment.content || !segment.content.trim()) return null; // Safety check

      logger.info(`  [${i + 1}/${segments.length}] type=${segment.type} (Dispatched)`);

      try {
        // ── SFX segment ────────────────────────────────────────────────────────
        if (segment.type === "sfx") {
          const sfxBuf = await sfxElevenLabs(segment.content);
          if (sfxBuf && sfxBuf.length > 0) {
            const sfxPath = path.join(tempDir, `sfx_${Date.now()}_part_${i}.mp3`);
            fs.writeFileSync(sfxPath, sfxBuf);
            return { type: "sfx", path: sfxPath, content: segment.content };
          }
          return null;
        }

        // ── Text segment ────────────────────────────────────────────────────────
        let buffer;
        if (isElevenLabs) {
          buffer = await ttsElevenLabs(segment.content, finalVoiceId);
        } else if (isFish) {
          buffer = await ttsFishAudio(segment.content, finalVoiceId);
        } else {
          buffer = await ttsOpenAI(segment.content, finalVoiceId);
        }

        const chunkPath = path.join(
          tempDir,
          `${path.parse(filename).name}_part_${i}.mp3`
        );
        fs.writeFileSync(chunkPath, buffer);

        // Always compute exact audio duration for precise SFX timeline alignment & sync across all providers
        const dur = await getAudioDuration(chunkPath);
        const durationMs = dur * 1000;

        return { type: "text", path: chunkPath, durationMs };
      } catch (err) {
        logger.error(`❌ Error generating chunk ${i + 1}: ${err.message}`);
        throw err;
      }
    });

    // ── Sequential timeline calculation for precise SFX layering ─────────────
    for (const res of resolvedSegments) {
      if (!res) continue;

      if (res.type === "sfx") {
        sfxLayers.push({ file: res.path, delayMs: currentDelayMs });
        logger.info(`  🎵 SFX queued at ${(currentDelayMs / 1000).toFixed(2)}s: "${res.content}"`);
      } else if (res.type === "text") {
        chunkFiles.push(res.path);
        currentDelayMs += res.durationMs;
        logger.info(`  📏 Chunk duration: ${(res.durationMs / 1000).toFixed(2)}s → timeline at ${(currentDelayMs / 1000).toFixed(2)}s`);
      }
    }

    // ── Merge narration chunks ────────────────────────────────────────────────
    const mainNarrationPath = sfxLayers.length > 0
      ? path.join(tempDir, `main_narration_${Date.now()}.mp3`)
      : localPath;

    await mergeAudioFiles(chunkFiles, mainNarrationPath);

    // ── Mix SFX layers into narration if SFX exist ───────────────────────────
    if (sfxLayers.length > 0) {
      logger.info(`🔊 Mixing ${sfxLayers.length} SFX layers into narration track...`);
      await mixAudioFiles(mainNarrationPath, sfxLayers, localPath);

      if (fs.existsSync(mainNarrationPath)) fs.unlinkSync(mainNarrationPath);
      sfxLayers.forEach((l) => {
        if (fs.existsSync(l.file)) fs.unlinkSync(l.file);
      });
    }

    // ── Cleanup chunk files ───────────────────────────────────────────────────
    chunkFiles.forEach((f) => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    // ── Upload to Cloudinary ──────────────────────────────────────────────────
    const uploadRes = await cloudinary.uploader.upload(localPath, {
      folder: "voiceovers",
      resource_type: "video",
      public_id: path.parse(filename).name,
      overwrite: true,
    });

    logger.info(`✅ Voiceover uploaded: ${uploadRes.secure_url}`);
    return { url: uploadRes.secure_url, localPath };
  } catch (err) {
    logger.error(`❌ Voiceover generation failed: ${err.message}`);
    throw err;
  }
}
