import fs from "fs";
import path from "path";
import prisma from "../config/prisma.client.js";
import { generateImage } from "./imageService.js";
import { extractFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory } from "./storyService.js";
import { createVideo } from "./videoService.js";
import cloudinary from "../config/cloudinary.config.js";
import { generateVoiceover } from "./generateVoiceoverService.js";

// Simple timestamp + color logger
const log = (msg, color = "\x1b[36m") => {
  const time = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`${color}[${time}] ${msg}\x1b[0m`);
};

// Upload video to Cloudinary
async function uploadVideoToCloud(videoPath, filename) {
  const uploaded = await cloudinary.uploader.upload(videoPath, {
    resource_type: "video",
    folder: "videos",
    public_id: path.parse(filename).name,
    overwrite: true,
  });

  fs.unlinkSync(videoPath); // remove temp file
  return uploaded.secure_url;
}

export async function runWorkflow({
  adminId,
  title,
  url,
  videoFile,
  textIdea,
  storyType,
  voiceTone,
  storyLength,
}) {
  log(`🚀 Starting workflow: "${title}"`);

  const workflow = await prisma.workflow.create({
    data: { title, type: "STORY", status: "PENDING", adminId, metadata: {} },
  });
  log(`✅ Workflow record created (ID: ${workflow.id})`);

  try {
    // 1️⃣ Prepare input
    log("🧩 Step 1: Preparing input text...");
    let inputText = textIdea || "";
    if (url) {
      log("🌐 Extracting text from URL...");
      inputText = await extractFromUrl(url);
    }
    if (videoFile) {
      log("🎥 Transcribing video to text...");
      inputText = await transcribeVideo(videoFile);
    }

    if (!inputText || inputText.trim().length < 50)
      throw new Error("Invalid or empty input text.");

    log(`📝 Input text ready (${inputText.length} chars)`);

    await prisma.input.create({
      data: {
        type: url ? "URL" : videoFile ? "VIDEO" : "TEXT",
        source: url || videoFile || "TEXT",
        processed: true,
        workflowId: workflow.id,
      },
    });

    // 2️⃣ Story generation
    log("📖 Step 2: Generating story...");
    const { outline, script } = await generateStory({
      textIdea: inputText,
      storyType,
      voiceTone,
      storyLength,
    });

    const story = await prisma.story.create({
      data: { title, outline, content: script, adminId },
    });
    log(`🧠 Story saved to DB (ID: ${story.id})`);

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { storyId: story.id },
    });

    // 3️⃣ Voiceover
    log("🎙️ Step 3: Generating voiceover...");
    const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
    const { url: voiceURL, localPath: voiceLocalPath } =
      await generateVoiceover(script, voiceFilename);
    log(`✅ Voiceover ready: ${voiceURL}`);

    await prisma.voiceover.create({
      data: { script, audioURL: voiceURL, workflowId: workflow.id, adminId },
    });

    // 4️⃣ Single Image Generation
    log("🖼️ Step 4: Generating a single image for the story...");
    const imagePrompt = `An artistic cinematic scene representing the entire story: ${script}`;
    const singleImageUrl = await generateImage(imagePrompt, 1);
    log(`✅ Image generated successfully.`);

    await prisma.media.create({
      data: {
        type: "IMAGE",
        fileUrl: singleImageUrl,
        fileType: "image/png",
        workflowId: workflow.id,
      },
    });

    const imageResults = [singleImageUrl];

    // 5️⃣ Create video
    log("🎬 Step 5: Combining image + voiceover into video...");
    const tempDir = path.join(process.cwd(), "temp");
    fs.mkdirSync(tempDir, { recursive: true });

    const videoFilename = `${workflow.id}-${Date.now()}.mp4`;
    const videoPath = path.join(tempDir, videoFilename);

    await createVideo(imageResults, voiceLocalPath, videoPath);

    // Clean up local MP3 after FFmpeg
    if (fs.existsSync(voiceLocalPath)) fs.unlinkSync(voiceLocalPath);

    // Upload to Cloudinary
    const videoURL = await uploadVideoToCloud(videoPath, videoFilename);
    log(`✅ Video uploaded: ${videoURL}`);

    const video = await prisma.video.create({
      data: { title, fileURL: videoURL, adminId },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { videoId: video.id, status: "COMPLETED" },
    });

    log("🎉 Workflow completed successfully.");

    return {
      success: true,
      workflowId: workflow.id,
      story: {
        title: story.title,
        outline: story.outline,
        script: story.content,
      },
      voiceover: voiceURL,
      video: videoURL,
      images: imageResults,
    };
  } catch (err) {
    log(`❌ Workflow failed: ${err.message}`, "\x1b[31m");
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "FAILED", metadata: { error: err.message } },
    });
    throw err;
  }
}
