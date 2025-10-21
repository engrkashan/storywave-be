import fs from "fs";
import path from "path";
import prisma from "../config/prisma.client.js";
import { generateImage } from "./imageService.js";
import { extractFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory } from "./storyService.js";
import { generateVoiceover } from "./ttsService.js";
import { createVideo } from "./videoService.js";

// Simple timestamp + color helper
const log = (msg, color = "\x1b[36m") => {
  const time = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`${color}[${time}] ${msg}\x1b[0m`);
};

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
    const voicePath = await generateVoiceover(script, voiceFilename);
    log(`✅ Voiceover created: ${voiceFilename}`);

    await prisma.voiceover.create({
      data: {
        script,
        audioURL: `/stories/${voiceFilename}`,
        workflowId: workflow.id,
        adminId,
      },
    });

    // 4️⃣ Generate Images
    log("🖼️ Step 4: Generating scene images...");
    const scenes = script.split(/\n{2,}/).filter(Boolean);
    const imageResults = [];

    for (let i = 0; i < scenes.length; i++) {
      log(`🧩 Generating image for scene ${i + 1}/${scenes.length}...`);
      const imageUrl = await generateImage(
        `An artistic cinematic scene based on this description: ${
          scenes[i + 1]
        }`,
        i + 1
      );
      imageResults.push(imageUrl);
      log(`✅ Scene ${i + 1} image generated.`);

      await prisma.media.create({
        data: {
          type: "IMAGE",
          fileUrl: imageUrl,
          fileType: "image/png",
          workflowId: workflow.id,
        },
      });
    }

    log(`🖼️ All ${imageResults.length} images generated successfully.`);

    // 5️⃣ Merge Video
    log("🎬 Step 5: Combining images + voiceover into final video...");
    const videosDir = path.join(process.cwd(), "public", "videos");
    fs.mkdirSync(videosDir, { recursive: true });
    const videoFilename = `${workflow.id}-${Date.now()}.mp4`;
    const videoPath = path.join(videosDir, videoFilename);

    await createVideo(
      imageResults,
      path.join(process.cwd(), "public", "stories", voiceFilename),
      videoPath
    );

    log(`✅ Video created successfully: ${videoFilename}`);

    const video = await prisma.video.create({
      data: {
        title,
        fileURL: `/videos/${videoFilename}`,
        adminId,
      },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { videoId: video.id, status: "COMPLETED" },
    });

    // 6️⃣ Final response
    const publicBase = process.env.BASE_URL || "https://yourdomain.com";
    log("🎉 Workflow completed successfully.");

    return {
      success: true,
      workflowId: workflow.id,
      story: {
        title: story.title,
        outline: story.outline,
        script: story.content,
      },
      voiceover: `${publicBase}/stories/${voiceFilename}`,
      video: `${publicBase}/videos/${videoFilename}`,
      images: imageResults.map((img) => `${publicBase}${img}`),
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
