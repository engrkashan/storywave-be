import OpenAI from "openai";
import cloudinary from "../config/cloudinary.config.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function cleanScript(rawScript) {
  if (typeof rawScript !== "string") rawScript = String(rawScript || "");
  return rawScript
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/#+\s/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/Target Audience:.*\n?/gi, "")
    .replace(/Length:.*\n?/gi, "")
    .replace(/End of Script/gi, "")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

/**
 * Generate voiceover → upload to Cloudinary → return Cloudinary URL
 */
export async function generateVoiceover(script, filename, voice = "onyx") {
  const cleaned = cleanScript(script);
  const selectedVoice = voice || "onyx";

  try {
    // Generate speech from OpenAI TTS
    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: selectedVoice,
      input: cleaned,
    });

    // Convert response to buffer
    const buffer = Buffer.from(await response.arrayBuffer());

    // Upload buffer directly to Cloudinary as a raw (audio) file
    const uploadRes = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "podcasts",
          resource_type: "video", // Cloudinary treats audio under 'video' type
          public_id: filename.replace(".mp3", ""),
          format: "mp3",
        },
        (err, result) => {
          if (err) reject(err);
          else resolve(result);
        }
      );
      stream.end(buffer);
    });

    console.log(`✅ Uploaded to Cloudinary: ${uploadRes.secure_url}`);
    return uploadRes.secure_url;
  } catch (error) {
    console.error(`❌ TTS Generation/Upload failed for ${filename}:`, error);
    throw new Error(`TTS generation failed: ${error.message}`);
  }
}
