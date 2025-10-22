import fs from "fs";
import path from "path";
import prisma from "../config/prisma.client.js";
import { generateImage } from "./imageService.js";
import { extractFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory } from "./storyService.js";
import { createVideo } from "./videoService.js";
import cloudinary from "../config/cloudinary.config.js";
import { generateVoiceover } from "./generateVoiceoverService.js";

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

  fs.unlinkSync(videoPath);
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
  log(`Workflow record created (ID: ${workflow.id})`);

  try {
    // 1️⃣ Prepare input
    log("Step 1: Preparing input text...");
    let inputText = textIdea || "";
    if (url) {
      log("Extracting text from URL...");
      inputText = await extractFromUrl(url);
    }
    if (videoFile) {
      log("Transcribing video to text...");
      inputText = await transcribeVideo(videoFile);
    }

    if (!inputText || inputText.trim().length < 50)
      throw new Error("Invalid or empty input text.");

    await prisma.input.create({
      data: {
        type: url ? "URL" : videoFile ? "VIDEO" : "TEXT",
        source: url || videoFile || "TEXT",
        processed: true,
        workflowId: workflow.id,
      },
    });

    // 2️⃣ Generate story
    log("Step 2: Generating story...");
    const { outline, script } = await generateStory({
      textIdea: inputText,
      storyType,
      voiceTone,
      storyLength,
    });

    const story = await prisma.story.create({
      data: { title, outline, content: script, adminId },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { storyId: story.id },
    });

    // 3️⃣ Voiceover
    log("Step 3: Generating voiceover...");
    const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
    const { url: voiceURL, localPath: voiceLocalPath } =
      await generateVoiceover(script, voiceFilename);

    await prisma.voiceover.create({
      data: { script, audioURL: voiceURL, workflowId: workflow.id, adminId },
    });

    // 4️⃣ Image generation for each scene
    log("Step 4: Generating images for all scenes...");

    // Split outline or script into scenes
    const scenes =
      outline && outline.length > 0
        ? outline
        : script.split(/\n\n|\r\n\r\n/).filter((s) => s.trim().length > 0);

    log(`Found ${scenes.length} scenes. Generating one image per scene...`);

    const imageResults = [];
    for (let i = 0; i < scenes.length; i++) {
      const prompt = `Cinematic, detailed digital artwork representing the following scene: "${scenes[i]}". The style should match ${storyType} genre, tone: ${voiceTone}.`;
      try {
        const imageUrl = await generateImage(prompt, 1);
        imageResults.push(imageUrl);

        await prisma.media.create({
          data: {
            type: "IMAGE",
            fileUrl: imageUrl,
            fileType: "image/png",
            workflow: {
              connect: { id: workflow.id },
            },
            metadata: { scene: i + 1, prompt },
          },
        });

        log(`Scene ${i + 1} image ready.`);
      } catch (err) {
        log(
          `Failed to generate image for scene ${i + 1}: ${err.message}`,
          "\x1b[33m"
        );
      }
    }

    if (imageResults.length === 0)
      throw new Error("No images were successfully generated.");

    // 5️⃣ Create video
    log("Step 5: Creating video from scene images + voiceover...");
    const tempDir = path.join(process.cwd(), "temp");
    fs.mkdirSync(tempDir, { recursive: true });

    const videoFilename = `${workflow.id}-${Date.now()}.mp4`;
    const videoPath = path.join(tempDir, videoFilename);

    await createVideo(imageResults, voiceLocalPath, videoPath);

    if (fs.existsSync(voiceLocalPath)) fs.unlinkSync(voiceLocalPath);

    // Upload to Cloudinary
    const videoURL = await uploadVideoToCloud(videoPath, videoFilename);
    log(`Video uploaded successfully: ${videoURL}`);

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
    log(`Workflow failed: ${err.message}`, "\x1b[31m");
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "FAILED", metadata: { error: err.message } },
    });
    throw err;
  }
}
