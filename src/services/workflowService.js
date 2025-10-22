import fs from "fs";
import path from "path";
import prisma from "../config/prisma.client.js";
import { generateImage } from "./imageService.js";
import { extractFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory } from "./storyService.js";
import { createVideo } from "./videoService.js";
import cloudinary from "../config/cloudinary.config.js";
import { generateVoiceover as oldGenerateVoiceover } from "./ttsService.js";

// Simple timestamp + color logger
const log = (msg, color = "\x1b[36m") => {
  const time = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`${color}[${time}] ${msg}\x1b[0m`);
};

// Upload voiceover to Cloudinary
async function generateVoiceover(script, filename) {
  const tempDir = path.join(process.cwd(), "temp");
  fs.mkdirSync(tempDir, { recursive: true });
  const localPath = path.join(tempDir, filename);

  await oldGenerateVoiceover(script, filename); // generates local MP3

  const uploaded = await cloudinary.uploader.upload(localPath, {
    resource_type: "video", // mp3 as video/raw
    folder: "voiceovers",
    public_id: path.parse(filename).name,
    overwrite: true,
  });

  fs.unlinkSync(localPath); // remove temp file
  return uploaded.secure_url;
}

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
    // 1️⃣ Input Preparation
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

    // 2️⃣ Story Generation
    log("📖 Step 2: Generating story from input...");
    const { outline, script } = await generateStory({
      textIdea: inputText,
      storyType,
      voiceTone,
      storyLength,
    });
    log("✅ Story generated successfully.");

    const story = await prisma.story.create({
      data: {
        title,
        outline,
        content: script,
        adminId,
      },
    });
    log(`🧠 Story saved to DB (ID: ${story.id})`);

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { storyId: story.id },
    });

    // 3️⃣ Generate Voiceover
    log("🎙️ Step 3: Generating voiceover...");
    const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
    const voiceURL = await generateVoiceover(script, voiceFilename);
    log(`✅ Voiceover uploaded to Cloudinary: ${voiceURL}`);

    await prisma.voiceover.create({
      data: {
        script,
        audioURL: voiceURL,
        workflowId: workflow.id,
        adminId,
      },
    });

    // 4️⃣ Generate Images
    // log("🖼️ Step 4: Generating scene images...");
    // const scenes = script.split(/\n{2,}/).filter(Boolean);
    // const imageResults = [];

    // for (let i = 0; i < scenes.length; i++) {
    //   log(`🧩 Generating image for scene ${i + 1}/${scenes.length}...`);
    //   const imageUrl = await generateImage(
    //     `An artistic cinematic scene based on this description: ${scenes[i]}`,
    //     i + 1
    //   );
    //   imageResults.push(imageUrl);
    //   log(`✅ Scene ${i + 1} image generated.`);

    //   await prisma.media.create({
    //     data: {
    //       type: "IMAGE",
    //       fileUrl: imageUrl,
    //       fileType: "image/png",
    //       workflowId: workflow.id,
    //     },
    //   });
    // }

    // 4️⃣ Generate a single image for the whole story
    log("🖼️ Step 4: Generating a single image for the entire story...");
    const imagePrompt = `An artistic cinematic scene representing the entire story: ${script}`;
    const singleImageUrl = await generateImage(imagePrompt, 1);
    log(`✅ Single story image generated.`);

    await prisma.media.create({
      data: {
        type: "IMAGE",
        fileUrl: singleImageUrl,
        fileType: "image/png",
        workflowId: workflow.id,
      },
    });

    const imageResults = [singleImageUrl];

    log(`🖼️ All ${imageResults.length} images generated successfully.`);

    // 5️⃣ Merge Video
    log("🎬 Step 5: Combining images + voiceover into final video...");
    const tempDir = path.join(process.cwd(), "temp");
    fs.mkdirSync(tempDir, { recursive: true });
    const videoFilename = `${workflow.id}-${Date.now()}.mp4`;
    const videoPath = path.join(tempDir, videoFilename);

    await createVideo(imageResults, voiceURL, videoPath);

    // Upload video to Cloudinary
    const videoURL = await uploadVideoToCloud(videoPath, videoFilename);
    log(`✅ Video uploaded to Cloudinary: ${videoURL}`);

    const video = await prisma.video.create({
      data: {
        title,
        fileURL: videoURL,
        adminId,
      },
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
