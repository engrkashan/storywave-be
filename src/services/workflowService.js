import prisma from "../config/prisma.client.js";
import fs from "fs";
import path from "path";
import { extractFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory } from "./storyService.js";
import { generateImage } from "./imageService.js";
import { generateVoiceover } from "./ttsService.js";
import { createVideo } from "./videoService.js";

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
  const workflow = await prisma.workflow.create({
    data: { title, type: "STORY", status: "PENDING", adminId, metadata: {} },
  });

  try {
    // 1️⃣ Input Preparation
    let inputText = textIdea || "";
    if (url) inputText = await extractFromUrl(url);
    if (videoFile) inputText = await transcribeVideo(videoFile);
    if (!inputText || inputText.trim().length < 50)
      throw new Error("Invalid or empty input text.");

    const input = await prisma.input.create({
      data: {
        type: url ? "URL" : videoFile ? "VIDEO" : "TEXT",
        source: url || videoFile || "TEXT",
        processed: true,
        workflowId: workflow.id,
      },
    });

    // 2️⃣ Story Generation
    const { outline, script } = await generateStory({
      textIdea: inputText,
      storyType,
      voiceTone,
      storyLength,
    });

    const story = await prisma.story.create({
      data: {
        title,
        outline,
        content: script,
        adminId,
      },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { storyId: story.id },
    });

    // 3️⃣ Generate Voiceover
    const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
    const voicePath = await generateVoiceover(script, voiceFilename);

    const voiceover = await prisma.voiceover.create({
      data: {
        script,
        audioURL: `/stories/${voiceFilename}`,
        workflowId: workflow.id,
        adminId,
      },
    });

    // 4️⃣ Generate Images
    const scenes = script.split(/\n{2,}/).filter(Boolean);
    const imageResults = [];

    for (let i = 0; i < scenes.length; i++) {
      const imageUrl = await generateImage(`Scene ${i + 1}: ${scenes[i]}`);
      imageResults.push(imageUrl);
      await prisma.media.create({
        data: {
          type: "IMAGE",
          fileUrl: imageUrl,
          fileType: "image/png",
          workflowId: workflow.id,
        },
      });
    }

    // 5️⃣ Merge Video
    const videosDir = path.join(process.cwd(), "public", "videos");
    fs.mkdirSync(videosDir, { recursive: true });
    const videoFilename = `${workflow.id}-${Date.now()}.mp4`;
    const videoPath = path.join(videosDir, videoFilename);

    // Adjust image pattern as per your generator
    await createVideo(
      imageResults.map((url) =>
        path.join(process.cwd(), "public", url.replace(/^\//, ""))
      ),
      path.join(process.cwd(), "public", "stories", voiceFilename),
      videoPath
    );

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

    // 6️⃣ Final response with full URLs
    const publicBase = process.env.BASE_URL || "https://yourdomain.com";

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
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "FAILED", metadata: { error: err.message } },
    });
    throw err;
  }
}
