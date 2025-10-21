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
 * Generates TTS audio and uploads to Cloudinary.
 * Handles long text by chunking automatically.
 */
export async function generateVoiceover(script, filename, voice = "onyx") {
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

  const uploadRes = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "podcasts",
        resource_type: "video",
        public_id: filename.replace(".mp3", ""),
        format: "mp3",
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(fullBuffer);
  });

  return uploadRes.secure_url;
}
