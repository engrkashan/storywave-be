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

/**
 * Remove markdown formatting and bracketed/parenthetical tags from a script.
 * Pass preserveEmotions=true for Fish Audio to keep its emotion tags.
 */
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

/**
 * Split text into sentence-boundary chunks of at most maxChunkSize characters.
 */
function chunkBySentences(text, maxChunkSize = 300) {
  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  let currentChunk = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
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
  return chunks.length > 0 ? chunks : [text];
}

// ─── Per-provider TTS chunk functions ─────────────────────────────────────────

/**
 * ElevenLabs TTS — uses the ElevenLabs voice ID directly, no OpenAI validation.
 */
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

/**
 * ElevenLabs Sound Effects — generates background SFX audio.
 */
async function sfxElevenLabs(text) {
  try {
    logger.info(`[ElevenLabs SFX] Generating: "${text}"`);
    const audioStream = await elevenlabs.textToSoundEffects.convert({
      text,
      duration_seconds: 12,
    });

    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    logger.error(`[ElevenLabs] SFX Error payload: text="${text}"`);
    throw new Error(`ElevenLabs SFX failed: ${error.message}`);
  }
}

/**
 * Fish Audio TTS — uses Fish Audio reference_id directly, no OpenAI validation.
 */
async function ttsFishAudio(text, referenceId) {
  try {
    logger.info(
      `[Fish Audio] Converting text with reference ID: ${referenceId}`,
    );
    const audio = await fishAudio.textToSpeech.convert(
      { text, reference_id: referenceId, format: "mp3" },
      "s1",
    );
    return Buffer.from(await new Response(audio).arrayBuffer());
  } catch (error) {
    throw new Error(`Fish Audio TTS failed: ${error.message}`);
  }
}

/**
 * OpenAI TTS — validates voice against allowed enum BEFORE calling the API.
 * Never call this with an ElevenLabs or Fish voice ID.
 */
async function ttsOpenAI(text, voice) {
  // Hard guard: ElevenLabs IDs are 20+ char alphanumeric, Fish IDs are 32-char hex.
  // If either pattern matches, something has gone wrong with provider routing.
  if (voice.length >= 20 && !/^[a-z]+$/.test(voice)) {
    throw new Error(
      `[OpenAI TTS] PROVIDER MISMATCH — voice "${voice}" looks like an ElevenLabs/Fish ID, not an OpenAI voice name. ` +
        `This indicates a provider routing bug. Check voiceObj.provider is set correctly.`,
    );
  }

  if (!OPENAI_VALID_VOICES.has(voice)) {
    throw new Error(
      `[OpenAI TTS] Invalid voice: "${voice}". ` +
        `Allowed values: ${[...OPENAI_VALID_VOICES].join(", ")}. ` +
        `Ensure the voice object has the correct provider field.`,
    );
  }

  logger.info(`[OpenAI] Converting text with voice: ${voice}`);
  const res = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice,
    input: text,
  });
  return Buffer.from(await res.arrayBuffer());
}

// ─── Main TTS Generator ───────────────────────────────────────────────────────

/**
 * Generate a voiceover for the given script using the correct provider.
 *
 * voiceObj shape: { id: string, provider: "elevenlabs" | "fish" | "openai", label: string }
 *
 * Routing rules (strict, no cross-provider leakage):
 *   provider === "elevenlabs" → ttsElevenLabs (+ sfxElevenLabs for [SFX] tags)
 *   provider === "fish"       → ttsFishAudio
 *   anything else             → ttsOpenAI (with voice enum validation)
 */
export async function generateVoiceover(script, filename, voiceObj, tempDir) {
  const localPath = path.join(tempDir, filename);
  fs.mkdirSync(tempDir, { recursive: true });

  // ── Intake validation: log full voiceObj to catch any upstream corruption ──
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

  // ── Determine provider ──────────────────────────────────────────────────────
  let rawProvider = voiceObj?.provider ?? "";
  let voiceId = voiceObj?.id ?? voiceObj;

  // Auto-detect provider if missing or if voiceObj is just a string
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

  // ── Final routing guard: never let a non-OpenAI ID reach OpenAI ────────────
  if (
    isOpenAI &&
    finalVoiceId &&
    finalVoiceId.length >= 20 &&
    !/^[a-z]+$/.test(finalVoiceId)
  ) {
    logger.error(
      `[generateVoiceover] CRITICAL: OpenAI route selected but finalVoiceId="${finalVoiceId}" looks like an ElevenLabs/Fish ID! ` +
        `rawProvider="${rawProvider}", voiceObj=${JSON.stringify(voiceObj)}. Attempting auto-fix to ElevenLabs.`,
    );
    // Safe fallback: treat it as ElevenLabs since the ID matches that pattern
    throw new Error(
      `Provider routing error: voice "${finalVoiceId}" (provider="${rawProvider}") was incorrectly routed to OpenAI. ` +
        `Ensure the voiceObj includes provider="elevenlabs" when using ElevenLabs voice IDs.`,
    );
  }

  logger.info(
    `🎙️ [generateVoiceover] provider="${providerLabel}" | ` +
      `raw="${rawProvider}" | finalVoiceId="${finalVoiceId}" | label="${voiceObj?.label}"`,
  );

  // ── Build segment list ───────────────────────────────────────────────────────
  // ElevenLabs: split script into text + SFX segments (handles [tag] and (tag))
  // Fish / OpenAI: plain text chunks only (tags are stripped by cleanScript)
  const segments = [];

  if (isElevenLabs) {
    const regex = /\[(.*?)\]|\((.*?)\)/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(script)) !== null) {
      if (match.index > lastIndex) {
        const textPart = script.substring(lastIndex, match.index).trim();
        if (textPart) {
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
      const textPart = script.substring(lastIndex).trim();
      if (textPart) {
        chunkBySentences(textPart, 300).forEach((c) => {
          if (c.trim()) segments.push({ type: "text", content: c });
        });
      }
    }
  } else {
    // Fish Audio or OpenAI — strip tags, split into plain text chunks
    const text = cleanScript(script, isFish);
    chunkBySentences(text, 300).forEach((c) => {
      if (c.trim()) segments.push({ type: "text", content: c });
    });
  }

  logger.info(`📋 Segments to process: ${segments.length}`);

  // ── Process segments ─────────────────────────────────────────────────────────
  const chunkFiles = [];
  const sfxLayers = [];

  // currentDelayMs: total duration of narration chunks processed so far (ms)
  let currentDelayMs = 0;

  try {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment.content || !segment.content.trim()) continue; // Safety check

      logger.info(`  [${i + 1}/${segments.length}] type=${segment.type}`);

      // ── SFX segment (ElevenLabs only) ──────────────────────────────────────
      if (segment.type === "sfx") {
        const sfxBuf = await sfxElevenLabs(segment.content);
        const sfxPath = path.join(tempDir, `sfx_${Date.now()}_part_${i}.mp3`);
        fs.writeFileSync(sfxPath, sfxBuf);

        // Start SFX exactly where we are in the narration timeline
        sfxLayers.push({ file: sfxPath, delayMs: currentDelayMs });
        logger.info(
          `  🎵 SFX queued at ${(currentDelayMs / 1000).toFixed(2)}s: "${segment.content}"`,
        );
        continue;
      }

      // ── Text segment ────────────────────────────────────────────────────────

      let buffer;

      if (isElevenLabs) {
        // ✅ ElevenLabs provider → ElevenLabs API only
        logger.info(
          `  [TTS Dispatch] → ElevenLabs | voiceId="${finalVoiceId}"`,
        );
        buffer = await ttsElevenLabs(segment.content, finalVoiceId);
      } else if (isFish) {
        // ✅ Fish Audio provider → Fish Audio API only
        logger.info(
          `  [TTS Dispatch] → Fish Audio | referenceId="${finalVoiceId}"`,
        );
        buffer = await ttsFishAudio(segment.content, finalVoiceId);
      } else {
        // ✅ OpenAI provider → OpenAI API only (voice enum validated inside)
        logger.info(`  [TTS Dispatch] → OpenAI | voice="${finalVoiceId}"`);
        buffer = await ttsOpenAI(segment.content, finalVoiceId);
      }

      const chunkPath = path.join(
        tempDir,
        `${path.parse(filename).name}_part_${i}.mp3`,
      );
      fs.writeFileSync(chunkPath, buffer);
      chunkFiles.push(chunkPath);

      if (isElevenLabs) {
        const dur = await getAudioDuration(chunkPath);
        currentDelayMs += dur * 1000;
        logger.info(
          `  📏 Chunk duration: ${dur.toFixed(2)}s → timeline at ${(currentDelayMs / 1000).toFixed(2)}s`,
        );
      }
    }

    // ── Merge narration chunks ────────────────────────────────────────────────
    const mainNarrationPath = isElevenLabs
      ? path.join(tempDir, `main_narration_${Date.now()}.mp3`)
      : localPath;

    await mergeAudioFiles(chunkFiles, mainNarrationPath);

    // ── Mix SFX layers into narration (ElevenLabs only) ──────────────────────
    if (isElevenLabs) {
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
