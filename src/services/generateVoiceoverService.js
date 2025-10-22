import fs from "fs";
import path from "path";
import OpenAI from "openai";
import cloudinary from "../config/cloudinary.config.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  const tempDir = path.join(process.cwd(), "temp");
  fs.mkdirSync(tempDir, { recursive: true });

  const localPath = path.join(tempDir, filename);
  const text = cleanScript(script);

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

  const fullBuffer = Buffer.concat(buffers);

  // 1️⃣ Write to local temp file
  fs.writeFileSync(localPath, fullBuffer);

  // 2️⃣ Upload to Cloudinary
  const uploadRes = await cloudinary.uploader.upload(localPath, {
    folder: "voiceovers",
    resource_type: "video",
    public_id: path.parse(filename).name,
    overwrite: true,
  });

  console.log(`✅ Voiceover uploaded to Cloudinary: ${uploadRes.secure_url}`);

  return { url: uploadRes.secure_url, localPath };
}
