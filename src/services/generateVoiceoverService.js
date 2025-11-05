import fs from "fs";
import OpenAI from "openai";
import path from "path";
import cloudinary from "../config/cloudinary.config.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Ensure temp directory exists
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
 * Generate a long TTS voiceover and upload to Cloudinary safely
 */
export async function generateVoiceover(script, filename, voice = "onyx") {
  const localPath = path.join(TEMP_DIR, filename);
  const text = cleanScript(script);

  console.log(`🔊 Generating voiceover for: ${text.length} characters`);

  const CHUNK_SIZE = 1000;
  const chunks = text.match(new RegExp(`.{1,${CHUNK_SIZE}}(\\s|$)`, "g")) || [];
  const buffers = [];

  try {
    // ✅ Generate audio chunks
    for (let i = 0; i < chunks.length; i++) {
      console.log(`🎙️  Generating TTS chunk ${i + 1}/${chunks.length}`);
      const res = await openai.audio.speech.create({
        model: "tts-1",
        voice,
        input: chunks[i],
      });

      const arrayBuffer = await res.arrayBuffer();
      buffers.push(Buffer.from(arrayBuffer));
    }

    // ✅ Combine all chunks into one audio buffer
    const fullBuffer = Buffer.concat(buffers);
    fs.writeFileSync(localPath, fullBuffer);

    console.log(
      `📦 Final audio size: ${(fullBuffer.length / 1024 / 1024).toFixed(2)} MB`
    );
    console.log("LOCAL PATH:",localPath)
    // ✅ Upload to Cloudinary (official upload_large method)
    let uploadRes;
    try {
      uploadRes = await cloudinary.uploader.upload(localPath, {
        folder: "voiceovers",
        resource_type: "video",
        public_id: path.parse(filename).name,
        overwrite: true,
      });

      console.log(
        `✅ Voiceover uploaded to Cloudinary: ${uploadRes.secure_url}`
      );
    } catch (cloudErr) {
      console.error("❌ Cloudinary upload failed:");
      console.error(cloudErr);
      throw new Error("Cloudinary upload failed. See logs for details.");
    }

    return { url: uploadRes.secure_url, localPath };
  } catch (err) {
    console.error("❌ Voiceover generation failed:");
    console.error(err);
    throw err;
  } finally {
    // // Optional: Clean up temp file to free disk space
    // if (fs.existsSync(localPath)) {
    //   try {
    //     fs.unlinkSync(localPath);
    //     console.log("🧹 Temp file deleted:", localPath);
    //   } catch (cleanupErr) {
    //     console.warn("⚠️ Failed to delete temp file:", cleanupErr.message);
    //   }
    // }
  }
}
