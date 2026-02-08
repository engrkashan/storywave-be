import OpenAI from "openai";
import { cloudinary } from "../config/cloudinary.config.js";

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
 * Splits text into chunks at sentence boundaries.
 * Each chunk ends with a complete sentence (., !, or ?).
 */
function chunkBySentences(text, maxChunkSize = 1000) {
  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];

  let currentChunk = "";

  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();

    // If adding this sentence exceeds the limit and we have content, save current chunk
    if (currentChunk && (currentChunk.length + trimmedSentence.length + 1) > maxChunkSize) {
      chunks.push(currentChunk.trim());
      currentChunk = trimmedSentence;
    } else {
      // Add sentence to current chunk
      currentChunk += (currentChunk ? " " : "") + trimmedSentence;
    }
  }

  // Add the last chunk if it has content
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Generates TTS audio and uploads to Cloudinary.
 * Handles long text by chunking at sentence boundaries.
 */
export async function generateVoiceover(script, filename, voice = "onyx") {
  const text = cleanScript(script);
  const CHUNK_SIZE = 1000;
  const chunks = chunkBySentences(text, CHUNK_SIZE);

  const buffers = [];

  for (let i = 0; i < chunks.length; i++) {
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
