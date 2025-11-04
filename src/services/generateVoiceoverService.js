import fs from "fs";
import OpenAI from "openai";
import path from "path";
import cloudinary from "../config/cloudinary.config.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ All temporary files stored in ./temp (works on Windows & VPS)
const TEMP_DIR = path.join(process.cwd(), "temp");
fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Clean unwanted characters from the script
 */
function cleanScript(script) {
  return script
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/\(Pause\)/g, ". ")
    .trim();
}

/**
 * Generates TTS audio from the given script.
 * Saves a local MP3 file AND uploads it to Cloudinary.
 *
 * Returns: { url, localPath }
 */
export async function generateVoiceover(script, filename, voice = "onyx") {
  const localPath = path.join(TEMP_DIR, filename);
  const text = cleanScript(script);

  console.log(`🔊 Generating voiceover for: ${text.length} characters`);

  const CHUNK_SIZE = 1000;
  const chunks = text.match(new RegExp(`.{1,${CHUNK_SIZE}}(\\s|$)`, "g")) || [];
  const buffers = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`🔊 TTS chunk ${i + 1}/${chunks.length}`);
    const res = await openai.audio.speech.create({
      model: "tts-1",
      voice,
      input: chunks[i],
    });
    buffers.push(Buffer.from(await res.arrayBuffer()));
  }

  // ✅ Combine and save final audio file
  const fullBuffer = Buffer.concat(buffers);
  fs.writeFileSync(localPath, fullBuffer);

  // ✅ Upload to Cloudinary
  const uploadRes = await cloudinary.uploader.upload_chunked(localPath, {
    folder: "voiceovers",
    resource_type: "video",
    public_id: path.parse(filename).name,
    overwrite: true,
  });

  console.log(`✅ Voiceover uploaded to Cloudinary: ${uploadRes.secure_url}`);

  return { url: uploadRes.secure_url, localPath };
}
