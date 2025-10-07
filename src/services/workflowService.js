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
}) {
  const workflow = await prisma.workflow.create({
    data: { title, type: "STORY", status: "PENDING", adminId, metadata: {} },
  });

  try {
    // 1️⃣ Input Preparation
    let inputText = textIdea || "";
    if (url) inputText = await extractFromUrl(url);
    if (videoFile) inputText = await transcribeVideo(videoFile);

    if (!inputText || inputText.trim().length < 50) {
      throw new Error("Invalid or empty input text.");
    }

    await prisma.input.create({
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
    });

    const story = await prisma.story.create({
      data: {
        title,
        outline,
        content: script,
        adminId,
        Workflow: { connect: { id: workflow.id } },
      },
    });

    // 3️⃣ Parallel image + voiceover generation
    const scenes = script.split(/\n{2,}/).filter(Boolean);

    const imagePromises = scenes.map((scene, i) =>
      generateImage(`Scene ${i + 1}: ${scene}`)
    );

    const uniqueFilename = `${workflow.id}-${Date.now()}.mp3`;
    const voicePromise = generateVoiceover(script, uniqueFilename);

    const [imagePaths, voiceFile] = await Promise.all([
      Promise.all(imagePromises),
      voicePromise,
    ]);

    // 4️⃣ Save voiceover
    const voiceover = await prisma.voiceover.create({
      data: {
        script,
        audioURL: voiceFile,
        workflowId: workflow.id,
        adminId,
      },
    });

    // 5️⃣ Generate video
    const videosDir = path.join(process.cwd(), "public", "videos");
    fs.mkdirSync(videosDir, { recursive: true });

    const videoFilename = `${workflow.id}-${Date.now()}.mp4`;
    const videoOutputPath = path.join(videosDir, videoFilename);

    await createVideo(
      path.join(process.cwd(), "public", "images", "frame_%03d.png"),
      path.join(process.cwd(), voiceFile),
      videoOutputPath
    );

    const video = await prisma.video.create({
      data: {
        videoURL: `/videos/${videoFilename}`,
        workflowId: workflow.id,
      },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "COMPLETED" },
    });

    return { workflow, story, scenes, images: imagePaths, voiceover, video };
  } catch (err) {
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "FAILED", metadata: { error: err.message } },
    });
    throw err;
  }
}
