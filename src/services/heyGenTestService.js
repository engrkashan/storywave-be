import fs from "fs";
import path from "path";
import axios from "axios";
import { execSync } from "child_process";
import cloudinary from "../config/cloudinary.config.js";
import { generateVoiceover } from "./generateVoiceoverService.js"; // Assuming this is available for generating a test voiceover

const log = (msg, color = "\x1b[36m") => {
  const time = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`${color}[${time}] ${msg}\x1b[0m`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEYGEN_API_URL = "https://api.heygen.com";
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;

// Helper to get a free avatar ID (call once or cache)
async function getFreeAvatarId() {
  const response = await axios.get(`${HEYGEN_API_URL}/v2/avatars`, {
    headers: { Authorization: `Bearer ${HEYGEN_API_KEY}` },
  });
  const freeAvatars = response.data.data.avatars.filter((a) => !a.premium);
  return freeAvatars[0]?.avatar_id; 
}

console.log(HEYGEN_API_KEY,HEYGEN_API_URL)

// Standalone function to test HeyGen video generation
export async function testHeyGenVideo() {
  const tempDir = path.join(process.cwd(), "temp");
  fs.mkdirSync(tempDir, { recursive: true });

  let voiceLocalPath, introVideoPath, lastFramePath;

  try {
    // Generate a short test voiceover (skipping story generation)
    log("Generating short test voiceover...");
    const testScript = "Hello, this is a short test script for HeyGen video generation. It should create an avatar speaking this text.";
    const voiceFilename = `test-heygen-${Date.now()}.mp3`;
    const { url: voiceURL, localPath: generatedVoicePath } = await generateVoiceover(testScript, voiceFilename);
    voiceLocalPath = generatedVoicePath;

    // Upload the audio to Cloudinary to get a public URL
    log("Uploading test audio to Cloudinary...");
    const audioUpload = await cloudinary.uploader.upload(voiceLocalPath, {
      resource_type: "video", // Treat as audio
      folder: "audios",
    });
    const audioUrl = audioUpload.secure_url;

    // Generate intro video with HeyGen
    log("Generating video with HeyGen...");
    const avatarId = await getFreeAvatarId();
    const heygenPayload = {
      video_inputs: [
        {
          character: { type: "avatar", avatar_id: avatarId },
          voice: { type: "audio", audio_url: audioUrl },
          background: { type: "color", value: "#f6f6fc" }, // Simple background
        },
      ],
      dimension: { width: 1280, height: 720 },
      aspect_ratio: "16:9",
      test: true, // For cheaper testing
    };
    const heygenResponse = await axios.post(
      `${HEYGEN_API_URL}/v2/video/generate`,
      heygenPayload,
      {
        headers: { Authorization: `Bearer ${HEYGEN_API_KEY}` },
      }
    );


    const videoId = heygenResponse.data.data.video_id;
console.log(videoId)
    // Poll for status (every 10s, up to 5min)
    let status = "pending";
    let introVideoUrl;
    const startTime = Date.now();
    while (status !== "completed" && Date.now() - startTime < 300000) {
      await sleep(10000);
      const statusRes = await axios.get(
        `${HEYGEN_API_URL}/v1/video_status.get?video_id=${videoId}`,
        {
          headers: { Authorization: `Bearer ${HEYGEN_API_KEY}` },
        }
      );
      console.log(videoId);
      status = statusRes.data.data.status;
      console.log(`HeyGen video status: ${status}`);
      if (status === "completed") {
        introVideoUrl = statusRes.data.data.video_url;
      }
    }
    if (!introVideoUrl) throw new Error("HeyGen video generation failed");

    // Download intro video
    log("Downloading generated video...");
    introVideoPath = path.join(tempDir, `test-intro-video-${Date.now()}.mp4`);
    const writer = fs.createWriteStream(introVideoPath);
    const downloadRes = await axios.get(introVideoUrl, {
      responseType: "stream",
    });
    downloadRes.data.pipe(writer);
    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    // Optionally extract last frame (as in original code)
    lastFramePath = path.join(tempDir, `test-last-frame-${Date.now()}.jpg`);
    execSync(
      `ffmpeg -sseof -1 -i ${introVideoPath} -update 1 -q:v 1 ${lastFramePath}`
    );

    log(`✅ Test video downloaded to: ${introVideoPath}`);
    log(`✅ Last frame extracted to: ${lastFramePath}`);

    // Cleanup voice file
    if (voiceLocalPath && fs.existsSync(voiceLocalPath)) fs.unlinkSync(voiceLocalPath);

    return { success: true, videoPath: introVideoPath, lastFramePath };
  } catch (err) {
  if (err.response) {
    console.log('Error details:', err.response.data);  // Log the full error object
  }
  log(`Test failed: ${err.message}`, "\x1b[31m");

    // Cleanup on failure
    if (voiceLocalPath && fs.existsSync(voiceLocalPath)) fs.unlinkSync(voiceLocalPath);
    if (introVideoPath && fs.existsSync(introVideoPath)) fs.unlinkSync(introVideoPath);
    if (lastFramePath && fs.existsSync(lastFramePath)) fs.unlinkSync(lastFramePath);

    throw err;
  }
}