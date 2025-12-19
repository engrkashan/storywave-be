import fs from "fs";
import path from "path";
import { fork } from "child_process";
import { cloudinary } from "../config/cloudinary.config.js";
import prisma from "../config/prisma.client.js";
import { deleteTempFiles } from "../utils/deleteTemp.js";
import { generateVoiceover } from "./generateVoiceoverService.js";
import { generateImage } from "./imageService.js";
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
        warnings: {
          step,
          message: error.message,
          timestamp: new Date().toISOString(),
        },
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

    // await processExistingWorkflow(workflow);

    // 👉 Offload to worker process
    const workerPath = path.resolve("src/workers/workflow.worker.js");
    const worker = fork(workerPath);

    // Prepare payload similar to what processExistingWorkflow does
    const meta = workflow.metadata || {};
    const payload = {
      adminId: workflow.adminId,
      title: workflow.title,
      url: meta.url || null,
      videoFile: meta.videoFile || null,
      textIdea: meta.textIdea || null,
      imagePrompt: meta.imagePrompt || null,
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
        `Worker for workflow ${workflow.id} exited with code ${code}`
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
    storyType: meta.storyType || null,
    voice: meta.voice || null,
    voiceTone: meta.voiceTone || null,
    storyLength: meta.storyLength || null,
    scheduledAt: null,
    existingWorkflow: workflow, // ADD THIS
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
  console.log(
    "📦 Video size before upload:",
    (stats.size / 1024 / 1024).toFixed(2),
    "MB"
  );

  const uploaded = await uploadLargePromise(videoPath, {
    resource_type: "video",
    folder: "videos",
    public_id: path.parse(filename).name,
    chunk_size: 6000000,
    overwrite: true,
  });
  log(`Video uploaded to Cloudinary: ${uploaded}`);
  return uploaded.secure_url;
}

export async function runWorkflow({
  adminId,
  title,
  url,
  videoFile,
  textIdea,
  imagePrompt,
  storyType,
  voice,
  voiceTone,
  storyLength,
  scheduledAt,
  existingWorkflow,
}) {
  const nowUTC = new Date().toISOString();
  const scheduledUTC = scheduledAt ? new Date(scheduledAt).toISOString() : null;

  const isScheduled = scheduledUTC && new Date(scheduledUTC) > new Date(nowUTC);
  log(
    isScheduled
      ? `🕒 Workflow "${title}" scheduled for ${scheduledAt}`
      : `🚀 Starting workflow: "${title}"`
  );

  let workflow = existingWorkflow;

  if (existingWorkflow) {
    await prisma.workflow.update({
      where: { id: existingWorkflow.id },
      data: { status: "PROCESSING" },
    });
  }

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
          storyType,
          voice,
          voiceTone,
          storyLength,
        },
      },
    });
  }

  log(`Workflow record created (ID: ${workflow.id})`);

  if (isScheduled) {
    return {
      success: true,
      workflowId: workflow.id,
      status: "SCHEDULED",
    };
  }

  // Create workflow-specific temp dir
  const workflowTempDir = path.join(TEMP_ROOT, workflow.id.toString());
  fs.mkdirSync(workflowTempDir, { recursive: true });
  let srtPath;

  try {
    // isProcessing = true;
    log("Step 1: Preparing input text...");
    let inputText = textIdea || "";
    if (url) {
      log("Extracting text from URL...");
      inputText = await extractContentFromUrl(url);
    }

    if (videoFile) {
      log("Transcribing video to text...");
      inputText = await transcribeVideo(videoFile);
    }

    log(`Input text: ${inputText}`);
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

    let outline, script;

    if (url || videoFile) {
      log("Step 2: Generating story...");
      try {
        ({ outline, script } = await generateStory({
          textIdea: inputText,
          storyType,
          voiceTone,
          storyLength,
        }));
      } catch (error) {
        throw new Error(`Story Generation Failed: ${error.message}`);
      }
    }

    if (textIdea) script = textIdea;

    const story = await prisma.story.create({
      data: { title, outline, content: script, adminId },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { storyId: story.id },
    });

    log("Step 3: Generating voiceover...");
    const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
    let voiceURL, voiceLocalPath;
    try {
      ({ url: voiceURL, localPath: voiceLocalPath } = await generateVoiceover(
        script,
        voiceFilename,
        voice,
        workflowTempDir
      ));
    } catch (error) {
      throw new Error(`Voiceover Generation Failed: ${error.message}`);
    }

    await prisma.voiceover.create({
      data: { script, audioURL: voiceURL, workflowId: workflow.id, adminId },
    });

    // log("Step 4: Generating a single image for the entire story...");
    // let storyPrompt = imagePrompt || generateThumbnailPrompt(title, storyType);
    // let imageUrl = null;
    // let imageRetryCount = 0;
    // const MAX_IMAGE_RETRIES = 3;

    // try {
    //   while (!imageUrl && imageRetryCount < MAX_IMAGE_RETRIES) {
    //     try {
    //       imageUrl = await generateImage(storyPrompt, 1, workflowTempDir);

    //       if (
    //         !imageUrl ||
    //         !fs.existsSync(imageUrl) ||
    //         fs.statSync(imageUrl).size < 5000
    //       ) {
    //         throw new Error("Generated image file is invalid or too small");
    //       }
    //     } catch (err) {
    //       imageRetryCount++;
    //       log(
    //         `Image generation attempt ${imageRetryCount} failed: ${err.message}`,
    //         "\x1b[31m"
    //       );

    //       if (imageRetryCount >= MAX_IMAGE_RETRIES) {
    //         throw new Error(
    //           `Failed to generate image after ${MAX_IMAGE_RETRIES} attempts. Last error: ${err.message}`
    //         );
    //       }

    //       // Handle Prompt Length Error
    //       if (
    //         err.message.toLowerCase().includes("prompt length") ||
    //         err.message.toLowerCase().includes("too long")
    //       ) {
    //         log("⚠️ Prompt too long, shortening it for next attempt...");
    //         // Truncate prompt to safe limit (e.g., 1000 chars) to ensure it passes
    //         storyPrompt = storyPrompt.substring(0, 1000) + "...";
    //       } else {
    //         // For other errors, wait a bit before retrying
    //         await new Promise((r) => setTimeout(r, 5000));
    //       }
    //     }
    //   }
    // } catch (error) {
    //   // Show exact error message for better debugging/transparency as requested
    //   throw new Error(`Image Generation Failed: ${error.message}`);
    // }

    log("Step 4: Generating a single image for the entire story...");

    let storyPrompt = imagePrompt || generateThumbnailPrompt(title, storyType);
    let imageUrl = null;
    let imageError = null;

    const MAX_IMAGE_RETRIES = 3;
    let imageRetryCount = 0;

    while (!imageUrl && imageRetryCount < MAX_IMAGE_RETRIES) {
      try {
        imageUrl = await generateImage(storyPrompt, 1, workflowTempDir);

        if (
          !imageUrl ||
          !fs.existsSync(imageUrl) ||
          fs.statSync(imageUrl).size < 5000
        ) {
          throw new Error("Generated image file is invalid or too small");
        }
      } catch (err) {
        imageRetryCount++;
        log(
          `⚠️ Image generation attempt ${imageRetryCount} failed: ${err.message}`,
          "\x1b[33m"
        );

        imageError = err;

        if (
          err.message.toLowerCase().includes("prompt length") ||
          err.message.toLowerCase().includes("too long")
        ) {
          storyPrompt = storyPrompt.substring(0, 800) + "...";
        } else {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }

    // 🚨 DO NOT THROW — record & continue
    if (!imageUrl) {
      log("🚧 Image generation failed — continuing workflow without image.", "\x1b[33m");

      await recordWorkflowWarning(workflow.id, "IMAGE_GENERATION", imageError);
    }

    let videoURL = null;

    if (imageUrl) {
      log("Step 5: Generating timed subtitles...");
      try {
        const srtContent = await transcribeWithTimestamps(voiceLocalPath);
        srtPath = path.join(workflowTempDir, `subtitles-${workflow.id}.srt`);
        fs.writeFileSync(srtPath, srtContent);
      } catch (error) {
        throw new Error(`Subtitle Generation Failed: ${error.message}`);
      }

      log("Step 6: Creating video...");
      const timestamp = Date.now();
      const videoFilename = `${workflow.id}-${timestamp}.mp4`;
      const videoPath = path.join(workflowTempDir, videoFilename);

      try {
        await createVideo(title, imageUrl, voiceLocalPath, videoPath, srtPath);
        videoURL = await uploadVideoToCloud(videoPath, videoFilename);
      } catch (error) {
        throw new Error(`Video Creation Failed: ${error.message}`);
      }

      const video = await prisma.video.create({
        data: { title, fileURL: videoURL, adminId },
      });

      await prisma.workflow.update({
        where: { id: workflow.id },
        data: { videoId: video.id, status: "COMPLETED" },
      });
    }
    else {
      log("Image generation failed — workflow completed without image.", "\x1b[33m");
    }

    log("🎉 Workflow completed successfully.");
    deleteTempFiles(workflowTempDir); // Delete only this workflow's dir
    // isProcessing = false;
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
        voice,
      },
    };
  } catch (err) {
    log(`Workflow failed: ${err.message}`, "\x1b[31m");
    if (srtPath && fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
    deleteTempFiles(workflowTempDir); // Delete only this workflow's dir

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "FAILED", metadata: { title, storyType, imagePrompt, voiceTone, voice, error: err.message } },
    });
    // isProcessing = false;
    throw err;
  }
}

