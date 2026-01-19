import fs from "fs";
import path from "path";
import { fork } from "child_process";
import { cloudinary } from "../config/cloudinary.config.js";
import prisma from "../config/prisma.client.js";
import { deleteTempFiles } from "../utils/deleteTemp.js";
import { generateVoiceover } from "./generateVoiceoverService.js";
import { generateImage } from "./imageService.js"; // ← this is the function
import { extractContentFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory } from "./storyService.js";
import { transcribeWithTimestamps } from "./transcribeService.js";
import { createVideo } from "./videoService.js";
import { generateThumbnailPrompt } from "../utils/thumbnailPrompt.js";

const TEMP_ROOT = path.resolve(process.cwd(), "temp");
fs.mkdirSync(TEMP_ROOT, { recursive: true });

const log = (msg, color = "\x1b[36m") => {
  const time = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`${color}[${time}] ${msg}\x1b[0m`);
};

async function recordWorkflowWarning(workflowId, step, error) {
  await prisma.workflow.update({
    where: { id: workflowId },
    data: {
      metadata: {
        ...(prisma.workflow.findUnique({ where: { id: workflowId } })
          .metadata || {}),
        warnings: [
          ...(prisma.workflow.findUnique({ where: { id: workflowId } }).metadata
            ?.warnings || []),
          {
            step,
            message: error.message,
            timestamp: new Date().toISOString(),
          },
        ],
      },
    },
  });
}

export async function runScheduledWorkflows() {
  try {
    const now = new Date();

    const workflow = await prisma.workflow.findFirst({
      where: {
        status: "SCHEDULED",
        scheduledAt: { lte: now },
      },
      orderBy: { scheduledAt: "asc" },
    });

    if (!workflow) {
      console.log("⏳ No scheduled workflows to process.");
      return;
    }

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "PROCESSING" },
    });

    const workerPath = path.resolve("src/workers/workflow.worker.js");
    const worker = fork(workerPath);

    const meta = workflow.metadata || {};
    const payload = {
      adminId: workflow.adminId,
      title: workflow.title,
      url: meta.url || null,
      videoFile: meta.videoFile || null,
      textIdea: meta.textIdea || null,
      imagePrompt: meta.imagePrompt || null,
      shouldGenerateImage: meta.shouldGenerateImage ?? true, // ← renamed
      storyType: meta.storyType || null,
      voice: meta.voice || null,
      voiceTone: meta.voiceTone || null,
      storyLength: meta.storyLength || null,
      scheduledAt: null,
      existingWorkflow: workflow,
    };

    worker.send(payload);

    worker.on("message", (msg) => {
      console.log(`Worker message for workflow ${workflow.id}:`, msg);
    });

    worker.on("exit", (code) => {
      console.log(
        `Worker for workflow ${workflow.id} exited with code ${code}`,
      );
    });
  } catch (err) {
    console.error("Scheduler error:", err);
  }
}

export async function processExistingWorkflow(workflow) {
  const meta = workflow.metadata || {};

  return await runWorkflow({
    adminId: workflow.adminId,
    title: workflow.title,
    url: meta.url || null,
    videoFile: meta.videoFile || null,
    textIdea: meta.textIdea || null,
    imagePrompt: meta.imagePrompt || null,
    shouldGenerateImage: meta.shouldGenerateImage ?? true, // ← renamed
    storyType: meta.storyType || null,
    voice: meta.voice || null,
    voiceTone: meta.voiceTone || null,
    storyLength: meta.storyLength || null,
    scheduledAt: null,
    existingWorkflow: workflow,
  });
}

function uploadLargePromise(filePath, options) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_large(filePath, options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

async function uploadVideoToCloud(videoPath, filename) {
  const stats = fs.statSync(videoPath);
  console.log("📦 Video size:", (stats.size / 1024 / 1024).toFixed(2), "MB");

  const uploaded = await uploadLargePromise(videoPath, {
    resource_type: "video",
    folder: "videos",
    public_id: path.parse(filename).name,
    chunk_size: 6000000,
    overwrite: true,
  });

  log(`Video uploaded: ${uploaded.secure_url}`);
  return uploaded.secure_url;
}

/**
 * Main workflow execution function
 * Supports podcast-only mode when shouldGenerateImage = false
 */
export async function runWorkflow({
  adminId,
  title,
  url = null,
  videoFile = null,
  textIdea = null,
  imagePrompt = null,
  shouldGenerateImage,
  storyType,
  voice,
  voiceTone,
  storyLength,
  scheduledAt = null,
  existingWorkflow = null,
}) {
  const nowUTC = new Date().toISOString();
  const scheduledUTC = scheduledAt ? new Date(scheduledAt).toISOString() : null;
  const isScheduled = scheduledUTC && new Date(scheduledUTC) > new Date(nowUTC);

  log(
    isScheduled
      ? `🕒 Scheduled workflow: "${title}" for ${scheduledAt}`
      : `🚀 Starting workflow: "${title}"`,
  );

  let workflow = existingWorkflow;

  if (!workflow) {
    workflow = await prisma.workflow.create({
      data: {
        title,
        type: "STORY",
        status: isScheduled ? "SCHEDULED" : "PENDING",
        scheduledAt: isScheduled ? new Date(scheduledUTC) : null,
        adminId,
        metadata: {
          url,
          videoFile,
          textIdea,
          imagePrompt,
          shouldGenerateImage,
          storyType,
          voice,
          voiceTone,
          storyLength,
        },
      },
    });
  } else {
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "PROCESSING" },
    });
  }

  log(`Workflow ID: ${workflow.id}`);

  if (isScheduled) {
    return { success: true, workflowId: workflow.id, status: "SCHEDULED" };
  }

  const workflowTempDir = path.join(TEMP_ROOT, workflow.id.toString());
  fs.mkdirSync(workflowTempDir, { recursive: true });

  let srtPath = null;

  try {
    // 1. Prepare input text
    log("Step 1: Preparing input...");
    let inputText = textIdea || "";

    if (url) {
      log("Extracting from URL...");
      inputText = await extractContentFromUrl(url);
    }
    if (videoFile) {
      log("Transcribing video...");
      inputText = await transcribeVideo(videoFile);
    }

    if (!inputText?.trim() || inputText.trim().length < 30) {
      throw new Error("Input text is too short or empty");
    }

    await prisma.input.create({
      data: {
        type: url ? "URL" : videoFile ? "VIDEO" : "TEXT",
        source: url || videoFile || textIdea.substring(0, 100) + "...",
        processed: true,
        workflowId: workflow.id,
      },
    });

    // 2. Generate story outline & script
    let outline, script;
    if (url || videoFile) {
      log("Step 2: Generating story...");
      ({ outline, script } = await generateStory({
        textIdea: inputText,
        storyType,
        voiceTone,
        storyLength,
      }));
    } else {
      script = textIdea;
    }

    const story = await prisma.story.create({
      data: {
        title,
        outline: outline || null,
        content: script,
        adminId,
      },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { storyId: story.id },
    });

    // 3. Generate voiceover (always)
    log("Step 3: Generating voiceover...");
    const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
    const { url: voiceURL, localPath: voiceLocalPath } =
      await generateVoiceover(script, voiceFilename, voice, workflowTempDir);

    await prisma.voiceover.create({
      data: {
        script,
        audioURL: voiceURL,
        workflowId: workflow.id,
        adminId,
      },
    });

    let imageUrl = null;
    let videoURL = null;

    // 4+5+6. Image + Subtitles + Video — only when requested
    if (shouldGenerateImage === true) {
      log("Step 4: Generating image...");

      const finalImagePrompt =
        imagePrompt || generateThumbnailPrompt(title, storyType);
      const imageResult = await generateImage(
        finalImagePrompt,
        1,
        workflowTempDir,
      );

      imageUrl = imageResult.imageUrl;

      if (!imageUrl) {
        log("Image generation failed → continuing without visuals", "\x1b[33m");
        await recordWorkflowWarning(
          workflow.id,
          "IMAGE_GENERATION",
          imageResult.error || {},
        );
      } else {
        // Subtitles
        log("Step 5: Generating subtitles...");
        const srtContent = await transcribeWithTimestamps(voiceLocalPath);
        srtPath = path.join(workflowTempDir, `subtitles-${workflow.id}.srt`);
        fs.writeFileSync(srtPath, srtContent);

        // Video
        log("Step 6: Creating final video...");
        const timestamp = Date.now();
        const videoFilename = `${workflow.id}-${timestamp}.mp4`;
        const videoPath = path.join(workflowTempDir, videoFilename);

        await createVideo(title, imageUrl, voiceLocalPath, videoPath, srtPath);

        videoURL = await uploadVideoToCloud(videoPath, videoFilename);

        const videoRecord = await prisma.video.create({
          data: { title, fileURL: videoURL, adminId },
        });

        await prisma.workflow.update({
          where: { id: workflow.id },
          data: { videoId: videoRecord.id },
        });
      }
    } else {
      log("Podcast-only mode → skipping image, subtitles & video generation");
    }

    // Final update
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: {
        status: "COMPLETED",
        metadata: {
          ...(workflow.metadata || {}),
          result: {
            hasImage: !!imageUrl,
            hasVideo: !!videoURL,
            isPodcastOnly: !shouldGenerateImage,
          },
        },
      },
    });

    log("🎉 Workflow completed successfully", "\x1b[32m");

    deleteTempFiles(workflowTempDir);

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
      image: imageUrl,
      metadata: {
        title,
        storyType,
        imagePrompt,
        voiceTone,
        shouldGenerateImage,
        isPodcastOnly: !shouldGenerateImage,
      },
    };
  } catch (err) {
    log(`Workflow failed: ${err.message}`, "\x1b[31m");

    if (srtPath && fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
    deleteTempFiles(workflowTempDir);

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: {
        status: "FAILED",
        metadata: {
          ...(workflow.metadata || {}),
          error: err.message,
          failedAt: new Date().toISOString(),
        },
      },
    });

    throw err;
  }
}
