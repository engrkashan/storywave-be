import fs from "fs";
import path from "path";
import { fork } from "child_process";
import { cloudinary } from "../config/cloudinary.config.js";
import prisma from "../config/prisma.client.js";
import { deleteTempFiles } from "../utils/deleteTemp.js";
import { generateVoiceover } from "./generateVoiceoverService.js";
import { generateImage, generateMultiImages } from "./imageService.js";
import { extractContentFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory, generateScenePrompts } from "./storyService.js";
import { transcribeWithTimestamps } from "./transcribeService.js";
import { getAudioDuration } from "./audioService.js";
import { createVideo, generateVideoClips, createMultiMediaVideo } from "./videoService.js";
import { generateThumbnailPrompt } from "../utils/thumbnailPrompt.js";
import { extractStoryMetadata, generateMasterPrompts } from "./promptService.js";

import {
  generateBackgroundMusic,
  mixAudioWithBackground,
} from "./generateBackgroundMusicService.js";
import { generateCharacterBible } from "./characterService.js";

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

    console.log(workflow);

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
      userId: req.user || null,
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
      mediaType: meta.mediaType || "single_image",
      imageCount: meta.imageCount || 5,
      backgroundMusic: meta.backgroundMusic ?? true,
      aspectRatio: meta.aspectRatio || "16:9",
      dualPlatform: meta.dualPlatform || false,
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
    userId: workflow.userId || null,
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
  userId,
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
  mediaType = "single_image",
  imageCount = 5,
  backgroundMusic = true,
  aspectRatio = "16:9", // Default to 16:9
  dualPlatform = false,
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
        status: isScheduled ? "SCHEDULED" : "PROCESSING",
        scheduledAt: isScheduled ? new Date(scheduledUTC) : null,
        userId,
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
          mediaType,
          imageCount,
          backgroundMusic,
          aspectRatio,
          dualPlatform,
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
        userId,
        isPodcast: false, // Will be updated later based on image/video generation
        audioURL: null, // Will be set after voiceover generation
      },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { storyId: story.id },
    });

    log("Step 2.1: Extracting story metadata and master prompts...");
    const storyMetadata = await extractStoryMetadata(script);
    const masterPrompts = generateMasterPrompts(storyMetadata, title, aspectRatio);

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: {
        metadata: {
          ...(workflow.metadata || {}),
          storyMetadata,
          masterPrompts,
        }
      },
    });

    // 2.2 Generate Character Bible for consistency (Only if video media and character exists)
    const hasCharacter = script.toLowerCase().includes("character:") || script.toLowerCase().includes("protagonist:") || storyMetadata.demographic?.toLowerCase().includes("person") || storyMetadata.demographic?.toLowerCase().includes("man") || storyMetadata.demographic?.toLowerCase().includes("woman");

    let characterAssets = [];
    if (mediaType === "video" && hasCharacter) {
      log("Step 2.2: Generating Character Bible (Anchor Images)...");
      try {
        characterAssets = await generateCharacterBible(workflow.id.toString(), storyMetadata.demographic, workflowTempDir);
      } catch (err) {
        log(`⚠️ Character Bible failed: ${err.message}`, "\x1b[31m");
        await recordWorkflowWarning(workflow.id, "Character Bible", err);
      }
    } else {
      log("Step 2.2: Skipping Character Bible (Criteria not met).");
    }

    // 3. Generate voiceover (always) - pure voice (used for accurate subtitle timestamps)
    log("Step 3: Generating voiceover...");
    const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
    const { url: pureVoiceURL, localPath: voiceLocalPath } =
      await generateVoiceover(script, voiceFilename, voice, workflowTempDir);

    let finalAudioLocalPath = voiceLocalPath;

    if (backgroundMusic === true) {
      log("Step 3.5: Generating background music...");
      const musicPath = await generateBackgroundMusic({
        title,
        storyType,
        tempDir: workflowTempDir,
      });

      const mixedFilename = `mixed-${voiceFilename}`;
      const mixedLocalPath = path.join(workflowTempDir, mixedFilename);

      await mixAudioWithBackground(voiceLocalPath, musicPath, mixedLocalPath);
      finalAudioLocalPath = mixedLocalPath;
    }

    log("Uploading final audio to Cloudinary...");
    const uploadRes = await cloudinary.uploader.upload(finalAudioLocalPath, {
      folder: "voiceovers",
      resource_type: "video",
      public_id: path.parse(finalAudioLocalPath).name,
      overwrite: true,
    });

    const mixedVoiceURL = uploadRes.secure_url;

    // Detect actual audio duration for synchronization
    const actualAudioDuration = await getAudioDuration(finalAudioLocalPath);
    log(`📊 Actual audio duration: ${actualAudioDuration.toFixed(2)}s`);

    await prisma.voiceover.create({
      data: {
        script,
        audioURL: mixedVoiceURL,
        workflowId: workflow.id,
        userId,
      },
    });

    let mediaUrls = [];
    let videoURL = null;
    let isPodcast = false;

    // 4+5+6. Media + Subtitles + Video
    if (shouldGenerateImage === true) {
      log(`Step 4: Handling ${mediaType} generation...`);

      // const dualPlatform = workflow.metadata?.dualPlatform === true || dualPlatform === true;
      const ratiosToGenerate = dualPlatform ? ["16:9", "9:16"] : [aspectRatio];

      log(`Generating for ratios: ${ratiosToGenerate.join(", ")} (Dual: ${dualPlatform})`);

      const srtContent = await transcribeWithTimestamps(voiceLocalPath);
      const srtPath = path.join(workflowTempDir, `subtitles-${workflow.id}.srt`);
      fs.writeFileSync(srtPath, srtContent);

      const videoResults = {};

      for (const currentRatio of ratiosToGenerate) {
        log(`🎬 Processing ratio: ${currentRatio}`);
        const ratioDir = path.join(workflowTempDir, currentRatio.replace(":", "_"));
        fs.mkdirSync(ratioDir, { recursive: true });

        // 1. Generate Scenic Prompts
        let scenePrompts = [];
        if (mediaType === "single_image") {
          scenePrompts = [imagePrompt || script || "Cinematic storytelling scene"];
        } else {
          const dynamicCount = Math.max(5, Math.ceil(actualAudioDuration / 5));
          const count = mediaType === "multi_image" ? imageCount : dynamicCount;
          scenePrompts = await generateScenePrompts(script, count, storyMetadata);
        }

        // 2. Generate Media Items for this ratio
        let mediaItems = [];
        if (mediaType === "video") {
          const clips = await generateVideoClips(scenePrompts, ratioDir, currentRatio, characterAssets);
          mediaItems = clips.filter(c => c.filePath).map(c => c.filePath);
        } else if (mediaType === "multi_image") {
          const images = await generateMultiImages(scenePrompts, ratioDir, currentRatio);
          mediaItems = images.filter(img => img.imageUrl).map(img => img.imageUrl);
        } else {
          const imageResult = await generateImage(scenePrompts[0], 1, ratioDir, currentRatio);
          if (imageResult.imageUrl) mediaItems = [imageResult.imageUrl];
        }

        // 3. Create Video for this ratio
        if (mediaItems.length > 0) {
          log(`Step 5: Stitching video for ${currentRatio}...`);
          const videoFilename = `${workflow.id}-${currentRatio.replace(":", "_")}-${Date.now()}.mp4`;
          const videoPath = path.join(workflowTempDir, videoFilename);

          if (mediaItems.length === 1 && mediaType === "single_image") {
            await createVideo(mediaItems[0], finalAudioLocalPath, videoPath, srtPath, currentRatio);
          } else {
            await createMultiMediaVideo(mediaItems, finalAudioLocalPath, videoPath, srtPath, currentRatio);
          }

          const currentVideoURL = await uploadVideoToCloud(videoPath, videoFilename);
          videoResults[currentRatio] = { url: currentVideoURL, items: mediaItems };

          if (!videoURL) videoURL = currentVideoURL; // Set primary for backward compatibility
          if (mediaUrls.length === 0) mediaUrls = mediaItems;
        }
      }

      if (Object.keys(videoResults).length > 0) {
        const primaryVideo = videoResults[aspectRatio] || Object.values(videoResults)[0];
        videoURL = primaryVideo.url;
        mediaUrls = primaryVideo.items;

        const videoRecord = await prisma.video.create({
          data: {
            title: dualPlatform ? `${title} (Dual Version)` : title,
            fileURL: videoURL, // Fallback/Main
            video_16_9: videoResults["16:9"]?.url,
            video_9_16: videoResults["9:16"]?.url,
            userId
          },
        });

        await prisma.workflow.update({
          where: { id: workflow.id },
          data: {
            videoId: videoRecord.id,
            metadata: {
              ...(workflow.metadata || {}),
              dualPlatform,
            }
          },
        });

        isPodcast = false;
      } else {
        log("⚠️ Media generation failed → creating as podcast", "\x1b[33m");
        isPodcast = true;
      }
    } else {
      log("🎧 Podcast-only mode", "\x1b[36m");
      isPodcast = true;
    }

    // Update story with isPodcast flag and audioURL
    await prisma.story.update({
      where: { id: story.id },
      data: {
        isPodcast,
        audioURL: mixedVoiceURL,
      },
    });

    // Final update
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: {
        status: "COMPLETED",
        metadata: {
          ...(workflow.metadata || {}),
          result: {
            hasMedia: mediaUrls.length > 0,
            hasVideo: !!videoURL,
            isPodcast,
            mediaType,
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
      voiceover: mixedVoiceURL,
      video: videoURL,
      media: mediaUrls,
      metadata: {
        title,
        storyType,
        imagePrompt,
        voiceTone,
        shouldGenerateImage,
        isPodcastOnly: !shouldGenerateImage,
        mediaType,
        imageCount,
        backgroundMusic,
        aspectRatio,
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
