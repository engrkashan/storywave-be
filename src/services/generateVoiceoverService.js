// import fs from "fs";
// import OpenAI from "openai";
// import path from "path";
// import {cloudinary} from "../config/cloudinary.config.js";

// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// // ✅ Ensure temp directory exists
// const TEMP_DIR = path.join(process.cwd(), "temp");
// fs.mkdirSync(TEMP_DIR, { recursive: true });

// /**
//  * Clean unwanted characters from the script
//  */
// function cleanScript(script) {
//   return script
//     .replace(/\*\*/g, "")
//     .replace(/\*/g, "")
//     .replace(/\[.*?\]/g, "")
//     .replace(/\(Pause\)/g, ". ")
//     .trim();
// }

// /**
//  * Generate a long TTS voiceover and upload to Cloudinary safely
//  */
// export async function generateVoiceover(script, filename, voice = "onyx") {
//   const localPath = path.join(TEMP_DIR, filename);
//   const text = cleanScript(script);

//   console.log(`🔊 Generating voiceover for: ${text.length} characters`);

//   const CHUNK_SIZE = 1000;
//   const chunks = text.match(new RegExp(`.{1,${CHUNK_SIZE}}(\\s|$)`, "g")) || [];
//   const buffers = [];

//   try {
//     // ✅ Generate audio chunks
//     for (let i = 0; i < chunks.length; i++) {
//       console.log(`🎙️  Generating TTS chunk ${i + 1}/${chunks.length}`);
//       const res = await openai.audio.speech.create({
//         model: "tts-1",
//         voice,
//         input: chunks[i],
//       });

//       const arrayBuffer = await res.arrayBuffer();
//       buffers.push(Buffer.from(arrayBuffer));
//     }

//     // ✅ Combine all chunks into one audio buffer
//     const fullBuffer = Buffer.concat(buffers);
//     fs.writeFileSync(localPath, fullBuffer);

//     console.log(
//       `📦 Final audio size: ${(fullBuffer.length / 1024 / 1024).toFixed(2)} MB`
//     );
//     console.log("LOCAL PATH:",localPath)
//     // ✅ Upload to Cloudinary (official upload_large method)
//     let uploadRes;
//     try {
//       uploadRes = await cloudinary.uploader.upload(localPath, {
//         folder: "voiceovers",
//         resource_type: "video",
//         public_id: path.parse(filename).name,
//         overwrite: true,
//       });

//       console.log(
//         `✅ Voiceover uploaded to Cloudinary: ${uploadRes.secure_url}`
//       );
//     } catch (cloudErr) {
//       console.error("❌ Cloudinary upload failed:");
//       console.error(cloudErr);
//       throw new Error("Cloudinary upload failed. See logs for details.");
//     }

//     return { url: uploadRes.secure_url, localPath };
//   } catch (err) {
//     console.error("❌ Voiceover generation failed:");
//     console.error(err);
//     throw err;
//   } finally {
//     // // Optional: Clean up temp file to free disk space
//     // if (fs.existsSync(localPath)) {
//     //   try {
//     //     fs.unlinkSync(localPath);
//     //     console.log("🧹 Temp file deleted:", localPath);
//     //   } catch (cleanupErr) {
//     //     console.warn("⚠️ Failed to delete temp file:", cleanupErr.message);
//     //   }
//     // }
//   }
// }


import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { cloudinary } from "../config/cloudinary.config.js";
import axios from "axios";
import crypto from "crypto";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TEMP_DIR = path.join(process.cwd(), "temp");
fs.mkdirSync(TEMP_DIR, { recursive: true });

function cleanScript(script) {
  return script
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/\(Pause\)/g, ". ")
    .trim();
}

/**  
 * 🔑 Generate Hume authentication header  
 */
function getHumeAuthHeaders() {
  const appId = process.env.HUME_API_KEY;
  const appSecret = process.env.HUME_SECRET_KEY;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto
    .createHmac("sha256", appSecret)
    .update(timestamp)
    .digest("hex");

  return {
    "X-Hume-App-Id": appId,
    "X-Hume-Time": timestamp,
    "X-Hume-Signature": signature,
  };
}

/**
 * 🔊 HUME TTS API CALL (FULL AUDIO BUFFER)
 */
async function generateHumeChunk(text, humeVoiceId) {
  const url = "https://api.hume.ai/v0/brain/tts";
  const headers = {
    ...getHumeAuthHeaders(),
    "Content-Type": "application/json",
  };

  const body = {
    text,
    voice_id: humeVoiceId,
    format: "mp3",
  };

  const res = await axios.post(url, body, {
    headers,
    responseType: "arraybuffer",
  });

  return Buffer.from(res.data);
}

/**
 * 🔊 OPENAI TTS CHUNK (your existing version)
 */
async function generateOpenAIChunk(text, voice) {
  const res = await openai.audio.speech.create({
    model: "tts-1",
    voice,
    input: text,
  });

  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

/**
 * 🎙️ Main TTS Generator (auto selects OPENAI or HUME)
 */
export async function generateVoiceover(script, filename, voice = "onyx") {
  const localPath = path.join(TEMP_DIR, filename);
  const text = cleanScript(script);

  const isHume = voice.startsWith("hume_"); // e.g. "hume_black_american_male_1"
  const humeVoiceId = isHume ? voice.replace("hume_", "") : null;

  console.log(
    `🔊 Generating voiceover using: ${isHume ? "HUME" : "OPENAI"} (${voice})`
  );

  const CHUNK_SIZE = 800; // Hume prefers smaller chunks too
  const chunks =
    text.match(new RegExp(`.{1,${CHUNK_SIZE}}(\\s|$)`, "g")) || [];

  const buffers = [];

  try {
    for (let i = 0; i < chunks.length; i++) {
      console.log(
        `🎙️ TTS chunk ${i + 1}/${chunks.length} (${isHume ? "HUME" : "OPENAI"})`
      );

      let buffer;

      if (isHume) {
        buffer = await generateHumeChunk(chunks[i], humeVoiceId);
      } else {
        buffer = await generateOpenAIChunk(chunks[i], voice);
      }

      buffers.push(buffer);
    }

    const combined = Buffer.concat(buffers);
    fs.writeFileSync(localPath, combined);

    console.log(
      `📦 Final audio size: ${(combined.length / 1024 / 1024).toFixed(2)} MB`
    );

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
