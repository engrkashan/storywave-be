import axios from "axios";
import fs from "fs";
import OpenAI from "openai";
import path from "path";
import { FishAudioClient } from "fish-audio";
import { cloudinary } from "../config/cloudinary.config.js";
import { mergeAudioFiles } from "./audioService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const fishAudio = new FishAudioClient({ apiKey: process.env.FISH_API_KEY });

/**
 * Clean script but preserve emotion tags for Fish Audio
 */
function cleanScript(script, preserveEmotions = false) {
  let cleaned = script
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/\[.*?\]/g, "");

  // For Fish Audio, preserve emotion tags and add pauses
  if (preserveEmotions) {
    cleaned = cleaned.replace(/\(Pause\)/g, "(break)");
  } else {
    cleaned = cleaned.replace(/\(Pause\)/g, ". ");
  }

  return cleaned.trim();
}

/**
 * 🔊 FISH AUDIO TTS API CALL with S1 Model & Emotions
 */
async function generateFishChunk(text, fishVoiceId) {
  try {

    // Use Fish Audio SDK with S1 model
    const audio = await fishAudio.textToSpeech.convert(
      {
        text, // Text with emotion tags like (happy), (narrator), etc.
        reference_id: fishVoiceId,
        format: "mp3",
      },
      "s1" // Use S1 model for better emotion support
    );

    // Convert ReadableStream to Buffer
    const buffer = Buffer.from(await new Response(audio).arrayBuffer());
    return buffer;
  } catch (error) {
    throw new Error(`Fish Audio generation failed: ${error.message}`);
  }
}


/**
 * 🔊 OPENAI TTS CHUNK (your existing version)
 */
async function generateOpenAIChunk(text, voice) {
  const res = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice,
    input: text,
  });

  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

/**
 * 🎙️ Main TTS Generator (auto selects OPENAI or FISH AUDIO)
 */
export async function generateVoiceover(script, filename, voiceObj, tempDir) {
  const localPath = path.join(tempDir, filename);
  fs.mkdirSync(tempDir, { recursive: true });

  // Detect provider based on frontend payload
  const isFish = voiceObj?.provider === "fish";
  const fishVoiceId = isFish ? voiceObj.id : null;
  const openAiVoice = !isFish ? voiceObj.id : null;

  console.log(
    `🔊 Generating voiceover using: ${isFish ? "FISH AUDIO S1" : "OPENAI"} (${voiceObj.label})`,
  );

  // Process text differently for Fish Audio vs OpenAI
  let text;

  text = cleanScript(script, false);


  const CHUNK_SIZE = 300;
  const chunks = text.match(new RegExp(`.{1,${CHUNK_SIZE}}(\\s|$)`, "g")) || [];

  const chunkFiles = [];

  try {
    for (let i = 0; i < chunks.length; i++) {
      console.log(
        `🎙️ TTS chunk ${i + 1}/${chunks.length} (${isFish ? "FISH AUDIO S1" : "OPENAI"})`,
      );

      let buffer;

      if (isFish) {
        buffer = await generateFishChunk(chunks[i], fishVoiceId);
      } else {
        buffer = await generateOpenAIChunk(chunks[i], openAiVoice);
      }

      const chunkPath = path.join(tempDir, `${path.parse(filename).name}_part_${i}.mp3`);
      fs.writeFileSync(chunkPath, buffer);
      chunkFiles.push(chunkPath);
    }

    // Merge chunks using ffmpeg to ensure smooth transitions
    await mergeAudioFiles(chunkFiles, localPath);

    // Cleanup temporary chunk files
    chunkFiles.forEach((file) => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });

    // Upload to Cloudinary
    const uploadRes = await cloudinary.uploader.upload(localPath, {
      folder: "voiceovers",
      resource_type: "video",
      public_id: path.parse(filename).name,
      overwrite: true,
    });

    return { url: uploadRes.secure_url, localPath };
  } catch (err) {
    console.error("❌ Voiceover generation failed:", err);
    throw err;
  }
}