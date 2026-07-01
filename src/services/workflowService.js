import fs from "fs";
import path from "path";
import { cloudinary } from "../config/cloudinary.config.js";
import { addWorkflowJob } from "./queueService.js";
import { config } from "../config/workflow.config.js";
import prisma from "../config/prisma.client.js";
import { deleteTempFiles } from "../utils/deleteTemp.js";
import { generateVoiceover } from "./generateVoiceoverService.js";
import { generateImage, generateMultiImages } from "./imageService.js";
import { extractContentFromUrl, transcribeVideo } from "./inputService.js";
import {
  generateStory,
  generateScenePrompts,
  enhanceScriptWithSoundEffects,
  enhanceSceneWithSoundEffects,
} from "./storyService.js";
import { transcribeWithTimestamps } from "./transcribeService.js";
import { getAudioDuration } from "./audioService.js";
import {
  createVideo,
  generateVideoClips,
  concatSegments,
  renderMediaSegment,
  convertSrtToAss
} from "./videoService.js";
import { generateThumbnailPrompt } from "../utils/thumbnailPrompt.js";
import {
  extractStoryMetadata,
  generateMasterPrompts,
  generateCommonVisualPrompt,
} from "./promptService.js";
import { createLogger, loggingStorage } from "../utils/logger.js";

const logger = createLogger("WorkflowService");

// Sentinel error class so we can distinguish a user cancel from a real failure
class CancelledError extends Error {
  constructor() {
    super("Workflow cancelled by user");
    this.isCancelled = true;
  }
}

// Check DB and throw if the user has requested cancellation
async function checkCancelled(workflowId) {
  const wf = await prisma.workflow.findUnique({
    where: { id: workflowId },
    select: { status: true },
  });
  if (wf?.status === "CANCELLATION_REQUESTED") {
    throw new CancelledError();
  }
}

import {
  generateBackgroundMusic,
  mixAudioWithBackground,
} from "./generateBackgroundMusicService.js";
import { generateCharacterBible } from "./characterService.js";
import { perfStorage, createPerfSession, getPerfSession } from "../utils/perfLogger.js";
import { startCpuMonitor, stopCpuMonitor } from "../utils/cpuMonitor.js";
import { CheckpointManager } from "../utils/checkpointManager.js";
const TEMP_ROOT = path.resolve(process.cwd(), "temp");
fs.mkdirSync(TEMP_ROOT, { recursive: true });

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
      return;
    }

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "PROCESSING" },
    });

    const meta = workflow.metadata || {};
    const payload = {
      userId: workflow.userId || null,
      title: workflow.title,
      url: meta.url || null,
      videoFile: meta.videoFile || null,
      textIdea: meta.textIdea || null,
      imagePrompt: meta.imagePrompt || null,
      shouldGenerateImage: meta.shouldGenerateImage ?? true,
      storyType: meta.storyType || null,
      voice: meta.voice || null,
      voiceTone: meta.voiceTone || null,
      storyLength: meta.storyLength || null,
      scheduledAt: null,
      mediaType: meta.mediaType || "single_image",
      imageCount: meta.imageCount || 5,
      backgroundMusic: meta.backgroundMusic ?? true,
      soundEffects: meta.soundEffects ?? false,
      aspectRatio: meta.aspectRatio || "16:9",
      dualPlatform: meta.dualPlatform || false,
      uploadedMediaUrl: meta.uploadedMediaUrl || null,
      existingWorkflow: workflow,
    };

    if (config.workflow.enableQueue) {
      await addWorkflowJob(payload);
    } else {
      logger.warn(
        "Queue is disabled, but falling back to queue anyway as fork is removed. Please enableQueue in config.",
      );
      await addWorkflowJob(payload);
    }
  } catch (err) {
    logger.error(`Scheduler error: ${err.message}`, err);
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
    shouldGenerateImage: meta.shouldGenerateImage ?? true,
    storyType: meta.storyType || null,
    voice: meta.voice || null,
    voiceTone: meta.voiceTone || null,
    storyLength: meta.storyLength || null,
    scheduledAt: null,
    soundEffects: meta.soundEffects ?? false,
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
  logger.info("📦 Video size:", (stats.size / 1024 / 1024).toFixed(2), "MB");

  const uploaded = await uploadLargePromise(videoPath, {
    resource_type: "video",
    folder: "videos",
    public_id: path.parse(filename).name,
    chunk_size: 6000000,
    overwrite: true,
  });

  logger.info(`Video uploaded: ${uploaded.secure_url}`);
  return uploaded.secure_url;
}

/**
 * Main workflow execution function
 * Supports podcast-only mode when shouldGenerateImage = false
 */
export async function runWorkflow(args) {
  return await loggingStorage.run({ title: args.title }, async () => {
    // Generate an ID for transient tracking if one is missing, to ensure we can create a PerfSession
    const trackingId = args.workflowId || `transient-${Date.now()}`;
    const session = createPerfSession(trackingId);
    return await perfStorage.run(session, async () => {
      const monitor = startCpuMonitor(trackingId, 2000);
      try {
        const result = await _runWorkflow(args);
        return result;
      } finally {
        stopCpuMonitor(monitor);
      }
    });
  });
}

/**
 * Internal workflow execution function
 */
async function _runWorkflow({
  workflowId = null,
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
  soundEffects = false,
  aspectRatio = "16:9",
  dualPlatform = false,
  series = null,
  coverArtPrompt = null,
  seoContent = null,
  visualSuggestions = null,
  uploadedMediaUrl = null,
  characterReferenceBase64: userCharacterReferenceBase64 = null,
}) {
  const nowUTC = new Date().toISOString();
  const scheduledUTC = scheduledAt ? new Date(scheduledAt).toISOString() : null;
  const isScheduled = scheduledUTC && new Date(scheduledUTC) > new Date(nowUTC);
  logger.info(
    isScheduled
      ? `🕒 Scheduled workflow: "${title}" for ${scheduledAt}`
      : `🚀 Starting workflow: "${title}"`,
  );

  let workflow = existingWorkflow;

  // If a workflowId was pre-created by the controller, load it directly — don't create a duplicate
  if (!workflow && workflowId) {
    workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found in DB`);
    }
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "PROCESSING" },
    });
    logger.info(`Attached to pre-created workflow: ${workflow.id}`);
  }

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
          series,
          coverArtPrompt,
          seoContent,
          visualSuggestions,
          uploadedMediaUrl,
          characterReferenceBase64: userCharacterReferenceBase64,
        },
      },
    });
  } else if (!workflowId) {
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "PROCESSING" },
    });
  }

  logger.info(`Workflow ID: ${workflow.id}`);

  if (isScheduled) {
    return { success: true, workflowId: workflow.id, status: "SCHEDULED" };
  }

  // Early cancellation guard: if this is a stalled-job retry and the user already cancelled, abort immediately
  const freshWf = await prisma.workflow.findUnique({
    where: { id: workflow.id },
    select: { status: true },
  });
  if (
    freshWf?.status === "CANCELLATION_REQUESTED" ||
    freshWf?.status === "CANCELLED"
  ) {
    logger.info(
      `🚫 Workflow ${workflow.id} is already cancelled — aborting restart.`,
    );
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "CANCELLED" },
    });
    return { success: false, cancelled: true, workflowId: workflow.id };
  }

  const workflowTempDir = path.join(TEMP_ROOT, workflow.id.toString());
  fs.mkdirSync(workflowTempDir, { recursive: true });

  const perf = getPerfSession();
  // Keep the session ID synced with the DB workflow ID
  perf.workflowId = workflow.id;

  let srtPath = null;

  try {
    // 1. Prepare input text
    logger.info("Step 1: Preparing input...");
    let inputText = textIdea || "";

    const stopInputTimer = perf?.start("input", "Prepare input text");
    if (url) {
      logger.info("Extracting from URL...");
      inputText = await extractContentFromUrl(url);
    }
    if (videoFile) {
      logger.info("Transcribing video...");
      inputText = await transcribeVideo(videoFile);
    }
    stopInputTimer?.();

    if (!inputText?.trim() || inputText.trim().length < 30) {
      throw new Error("Input text is too short or empty");
    }

    await checkCancelled(workflow.id); // Cancellation check

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
      logger.info("Step 2: Generating story...");
      const stopStoryTimer = perf?.start("story", "Generate story script & outline");
      ({ outline, script } = await generateStory({
        textIdea: inputText,
        storyType,
        voiceTone,
        storyLength,
      }));
      stopStoryTimer?.();
    } else {
      script = textIdea;
    }

    let storyMetadata = null;
    let masterPrompts = null;
    let commonPrompt = null;
    let characterReferenceUrl = null;
    let styleReferenceUrl = null;
    let characterReferences = [];
    let earlyScenePrompts = null; // Cache for later

    if (shouldGenerateImage) {
      logger.info("Step 2.1: Extracting story metadata and master prompts...");
      const stopMetaTimer = perf?.start("metadata", "Extract metadata & master prompts");
      storyMetadata = await extractStoryMetadata(script);
      masterPrompts = generateMasterPrompts(storyMetadata, title, aspectRatio);
      commonPrompt = generateCommonVisualPrompt(storyMetadata);

      if (imagePrompt && (mediaType === "multi_image" || mediaType === "video")) {
        commonPrompt = `${commonPrompt}. Visual Reference: ${imagePrompt}`;
      }
      stopMetaTimer?.();
    }

    // Auto-enhance script with sound effects cues if the user enabled the toggle
    if (soundEffects === true) {
      if (mediaType === "video") {
        logger.info("Step 2.5: Skipping sound effects because mediaType is video (SFX not needed).");
      } else if (shouldGenerateImage && mediaType === "multi_image" && !uploadedMediaUrl) {
        logger.info("Step 2.5: Estimating audio duration to pre-generate scenes for contextual SFX...");
        const estimatedDuration = (script.split(/\s+/).length / 2.5); // ~150 wpm
        const dynamicCount = Math.max(5, Math.ceil(estimatedDuration / 5));
        const count = imageCount || dynamicCount;

        logger.info(`Pre-generating ${count} scenes for context-aware SFX...`);
        const stopSfxPreTimer = perf?.start("sfx", "Pre-generate scenes for SFX");
        earlyScenePrompts = await generateScenePrompts(
          script,
          count,
          storyMetadata,
          visualSuggestions
        );
        stopSfxPreTimer?.();

        logger.info("Enhancing individual scenes with sound effects...");
        const stopSfxEnhanceTimer = perf?.start("sfx", "Enhance individual scenes with SFX");
        for (let i = 0; i < earlyScenePrompts.length; i++) {
          const scene = earlyScenePrompts[i];
          scene.narration = await enhanceSceneWithSoundEffects(scene.prompt, scene.narration);
        }
        stopSfxEnhanceTimer?.();

        // Re-stitch script from the enhanced narrations
        script = earlyScenePrompts.map(s => s.narration).join(" ");
      } else {
        logger.info(
          "Step 2.5: Enhancing script with sound-effect cues (soundEffects toggle is ON)...",
        );
        const stopSfxScriptTimer = perf?.start("sfx", "Enhance script with sound effects");
        script = await enhanceScriptWithSoundEffects(script);
        stopSfxScriptTimer?.();
      }
    }

    const story = await prisma.story.create({
      data: {
        title,
        outline: outline || null,
        content: script,
        userId,
        isPodcast: false,
        audioURL: null,
        series,
        coverArtPrompt,
        seoContent,
        visualSuggestions,
      },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { storyId: story.id },
    });

    if (shouldGenerateImage) {
      await checkCancelled(workflow.id); // ✔️ Cancellation check

      if (userCharacterReferenceBase64) {
        logger.info(
          "User provided a character reference image. Uploading to Cloudinary...",
        );
        try {
          const upload = await cloudinary.uploader.upload(
            userCharacterReferenceBase64,
            {
              folder: "character-references",
              resource_type: "image",
              public_id: `user-char-ref-${workflow.id}-${Date.now()}`,
              overwrite: true,
            },
          );
          characterReferenceUrl = upload.secure_url;
          logger.info(
            `✅ User Character Reference URL: ${characterReferenceUrl}`,
          );
        } catch (err) {
          logger.error(
            `⚠️ Failed to upload user character reference: ${err.message}`,
          );
          characterReferenceUrl = userCharacterReferenceBase64; // Fallback to inline base64 if Cloudinary fails
        }
        logger.info(
          "Skipping Style Reference generation since character reference is provided.",
        );
      } else {
        // 2.2 Generate Style Reference Image (MANDATORY for consistency if no character provided)
        logger.info(
          "Step 2.1.5: Generating Style Reference Image (Visual Baseline)...",
        );
        try {
          const styleRefDir = path.join(workflowTempDir, "style_ref");
          fs.mkdirSync(styleRefDir, { recursive: true });
          // Generate a master cinematic shot to serve as style reference
          const stopStyleRefTimer = perf?.start("image", "Generate Style Reference Image");
          const styleRefResult = await generateImage(
            masterPrompts.cinematic,
            0,
            styleRefDir,
            aspectRatio,
            commonPrompt,
          );
          stopStyleRefTimer?.();
          if (styleRefResult.imageUrl) {
            // Upload to Cloudinary to get a permanent URL for Midjourney
            const stopStyleUploadTimer = perf?.start("upload", "Upload Style Ref Image to Cloudinary");
            const upload = await cloudinary.uploader.upload(
              styleRefResult.imageUrl,
              {
                folder: "style-references",
                resource_type: "image",
                public_id: `style-ref-${workflow.id}-${Date.now()}`,
                overwrite: true,
              },
            );
            stopStyleUploadTimer?.();
            styleReferenceUrl = upload.secure_url;
            logger.info(`✅ Style Reference URL: ${styleReferenceUrl}`);
          }
        } catch (err) {
          logger.error(`⚠️ Style reference generation failed: ${err.message}`);
        }
      }

      // 2.2 Generate Cover Art if coverArtPrompt is provided
      if (coverArtPrompt) {
        logger.info(
          `🎨 Generating dual cover arts (9:16 & 16:9): ${coverArtPrompt}`,
        );
        try {
          const coverArtDir = path.join(workflowTempDir, "cover_art");
          fs.mkdirSync(coverArtDir, { recursive: true });

          // Helper to generate and upload a single ratio
          const processRatio = async (ratio) => {
            const stopCoverTimer = perf?.start("image", `Generate Cover Art: ${ratio}`);
            const result = await generateImage(
              coverArtPrompt,
              1,
              coverArtDir,
              ratio,
            );
            stopCoverTimer?.();
            if (result.imageUrl) {
              const stopCoverUploadTimer = perf?.start("upload", `Upload Cover Art to Cloudinary: ${ratio}`);
              const upload = await cloudinary.uploader.upload(result.imageUrl, {
                folder: "cover-arts",
                resource_type: "image",
                public_id: `cover-${ratio.replace(":", "_")}-${workflow.id}-${Date.now()}`,
                overwrite: true,
              });
              stopCoverUploadTimer?.();
              logger.info(
                `🚀 [${ratio}] Uploaded to Cloudinary at: ${upload.width}x${upload.height}px`,
              );
              logger.info(
                `🚀 [${ratio}] Uploaded to Cloudinary at: ${upload.secure_url}`,
              );
              return upload.secure_url;
            }
            return null;
          };

          // Generate both in parallel
          const [url16_9, url9_16] = await Promise.all([
            processRatio("16:9"),
            processRatio("9:16"),
          ]);

          if (url16_9 || url9_16) {
            await prisma.story.update({
              where: { id: story.id },
              data: {
                coverArtURL: url16_9 || url9_16, // Legacy compatibility
                coverArtURL_16_9: url16_9,
                coverArtURL_9_16: url9_16,
              },
            });
            logger.info(
              `✅ Dual cover arts generated: 16:9(${url16_9}) | 9:16(${url9_16})`,
            );
          }
        } catch (err) {
          logger.error(`⚠️ Cover art generation failed: ${err.message}`);
          await recordWorkflowWarning(workflow.id, "Cover Art", err);
        }
      }

      await prisma.workflow.update({
        where: { id: workflow.id },
        data: {
          metadata: {
            ...(workflow.metadata || {}),
            storyMetadata,
            masterPrompts,
            commonPrompt,
            characterReferenceUrl,
            styleReferenceUrl,
          },
        },
      });

      // 2.2 Generate Character References for all characters
      logger.info("Step 2.2: Processing Multi-Character References...");
      const charactersList = storyMetadata.characters || [];

      // Assign user-uploaded image to the main character
      const mainCharacter =
        charactersList.find((c) => c.isMainCharacter) || charactersList[0];
      if (characterReferenceUrl && mainCharacter) {
        characterReferences.push({
          id: mainCharacter.id,
          url: characterReferenceUrl, // The Cloudinary URL we generated earlier
        });
        logger.info(
          `✅ Assigned user-uploaded character reference to ${mainCharacter.name || mainCharacter.id}`,
        );
      }

      // 2.2 Generate Character Portraits for all story characters
      // SKIP portrait generation when:
      //   a) User uploaded a direct media file (uploadedMediaUrl) — AI generation is bypassed entirely
      //   b) User provided a character reference image — we already have the likeness anchor
      const shouldGeneratePortraits =
        !uploadedMediaUrl && !userCharacterReferenceBase64;

      if (shouldGeneratePortraits && (
        mediaType === "video" ||
        mediaType === "multi_image" ||
        mediaType === "single_image"
      )) {
        logger.info("Step 2.2: Generating AI character portraits for consistency...");
        for (const char of charactersList) {
          if (characterReferences.find((c) => c.id === char.id)) continue; // Skip if already assigned

          await checkCancelled(workflow.id); // ✅ Check between each character portrait

          logger.info(
            `🎨 Generating character portrait for: ${char.name || char.id}...`,
          );
          const demographicInfo = [char.sex, char.age, char.color]
            .filter(Boolean)
            .join(", ");
          const charPrompt = `A clinical, neutral character design sheet. Character Identity: ${char.name || char.id}. Demographic: ${demographicInfo}. Description: ${char.appearance}.

  CRITICAL REQUIREMENT: This is a STRICT physical reference image ONLY. The character MUST be standing perfectly still in a neutral A-pose or T-pose, facing the camera directly. NO ACTION. NO EXPRESSION. NO PROPS. Neutral, blank facial expression. Plain studio background.
  Lighting: Flat, even, clinical studio lighting so all facial features and skin tones are clearly visible. Aesthetic: Hyper-realistic, 8k, cinematic details. No text.`;

          try {
            const charRefDir = path.join(workflowTempDir, "char_refs");
            if (!fs.existsSync(charRefDir))
              fs.mkdirSync(charRefDir, { recursive: true });

            // Use standard generateImage function
            const stopCharTimer = perf?.start("image", `Generate Character Portrait: ${char.name || char.id}`);
            const charResult = await generateImage(
              charPrompt,
              0,
              charRefDir,
              "1:1",
              commonPrompt,
            );
            stopCharTimer?.();

            if (charResult.imageUrl) {
              const stopCharUploadTimer = perf?.start("upload", `Upload Character Portrait to Cloudinary: ${char.name || char.id}`);
              const upload = await cloudinary.uploader.upload(
                charResult.imageUrl,
                {
                  folder: "character-references",
                  resource_type: "image",
                  public_id: `char-ref-${workflow.id}-${char.id}-${Date.now()}`,
                  overwrite: true,
                },
              );
              stopCharUploadTimer?.();
              characterReferences.push({
                id: char.id,
                url: upload.secure_url,
              });
              logger.info(
                `✅ Generated portrait for ${char.name || char.id}: ${upload.secure_url}`,
              );

              // If this is the main character and we didn't have one before, set it for legacy compatibility
              if (char.id === mainCharacter?.id) {
                characterReferenceUrl = upload.secure_url;
              }
            }
          } catch (err) {
            if (err.isCancelled) throw err; // Re-throw cancellation errors immediately
            logger.error(
              `⚠️ Failed to generate portrait for ${char.name || char.id}: ${err.message}`,
            );
          }
        }
      } else {
        logger.info(
          shouldGeneratePortraits
            ? "Step 2.2: Skipping portrait generation (no characters in story metadata)."
            : `Step 2.2: Skipping portrait generation — ${uploadedMediaUrl
              ? "direct media upload provided (AI generation bypassed)"
              : "user character reference image provided (likeness already anchored)"
            }.`,
        );
      }

      // Update the database with the new character references array
      await prisma.workflow.update({
        where: { id: workflow.id },
        data: {
          metadata: {
            ...(workflow.metadata || {}),
            characterReferences,
          },
        },
      });
    }

    logger.info("Step 3: Generating voiceover...");
    logger.info(
      `[WorkflowService] voice payload dispatched to generateVoiceover: ${JSON.stringify(voice)}`,
    );
    await checkCancelled(workflow.id); // ✔️ Cancellation check
    const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
    const stopVoiceTimer = perf?.start("audio", "Generate Voiceover TTS");
    const { url: pureVoiceURL, localPath: voiceLocalPath } =
      await generateVoiceover(script, voiceFilename, voice, workflowTempDir);
    stopVoiceTimer?.();

    let finalAudioLocalPath = voiceLocalPath;

    if (backgroundMusic === true) {
      logger.info("Step 3.5: Generating background music...");
      const stopMusicTimer = perf?.start("audio", "Generate Background Music (Suno)");
      const musicPath = await generateBackgroundMusic({
        title,
        storyType,
        tempDir: workflowTempDir,
      });
      stopMusicTimer?.();

      const mixedFilename = `mixed-${voiceFilename}`;
      const mixedLocalPath = path.join(workflowTempDir, mixedFilename);

      const stopMixTimer = perf?.start("audio", "Mix Voice and Background Music");
      await mixAudioWithBackground(voiceLocalPath, musicPath, mixedLocalPath);
      stopMixTimer?.();
      finalAudioLocalPath = mixedLocalPath;
    }

    logger.info("Uploading final audio to Cloudinary...");
    const stopAudioUploadTimer = perf?.start("upload", "Upload Final Audio to Cloudinary");
    const uploadRes = await cloudinary.uploader.upload(finalAudioLocalPath, {
      folder: "voiceovers",
      resource_type: "video",
      public_id: path.parse(finalAudioLocalPath).name,
      overwrite: true,
    });
    stopAudioUploadTimer?.();

    const mixedVoiceURL = uploadRes.secure_url;

    // Detect actual audio duration for synchronization
    const actualAudioDuration = await getAudioDuration(finalAudioLocalPath);
    logger.info(`📊 Actual audio duration: ${actualAudioDuration.toFixed(2)}s`);

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
      await checkCancelled(workflow.id); // ✔️ Cancellation check
      logger.info(`Step 4: Handling ${mediaType} generation...`);

      // const dualPlatform = workflow.metadata?.dualPlatform === true || dualPlatform === true;
      const ratiosToGenerate = dualPlatform ? ["16:9", "9:16"] : [aspectRatio];

      logger.info(
        `Generating for ratios: ${ratiosToGenerate.join(", ")} (Dual: ${dualPlatform})`,
      );

      logger.info("Step 5: Generating subtitles...");
      const stopSubTimer = perf?.start("subtitle", "Transcribe Audio to Subtitles (Whisper)");
      const srtContent = await transcribeWithTimestamps(voiceLocalPath);
      srtPath = path.join(workflowTempDir, `subtitles-${workflow.id}.srt`);
      fs.writeFileSync(srtPath, srtContent);
      stopSubTimer?.();

      const videoResults = {};

      for (const currentRatio of ratiosToGenerate) {
        logger.info(`🎬 Processing ratio: ${currentRatio}`);
        const ratioDir = path.join(
          workflowTempDir,
          currentRatio.replace(":", "_"),
        );
        fs.mkdirSync(ratioDir, { recursive: true });

        // 1. Determine media items — use direct upload or AI generation
        let mediaItems = [];
        const videoFilename = `${workflow.id}-${currentRatio.replace(":", "_")}-${Date.now()}.mp4`;
        const videoPath = path.join(workflowTempDir, videoFilename);

        if (uploadedMediaUrl) {
          // ✅ Direct media path: skip AI generation entirely
          logger.info(`⬆️ Using directly uploaded media: ${uploadedMediaUrl}`);
          mediaItems = [uploadedMediaUrl];
        } else {
          // AI generation path
          let scenePrompts = [];
          if (earlyScenePrompts) {
            logger.info("Using pre-generated scene prompts from Step 2.5...");
            scenePrompts = earlyScenePrompts;
          } else if (mediaType === "single_image") {
            scenePrompts = [
              {
                prompt: imagePrompt || script || "Cinematic storytelling scene",
                charactersInScene: [],
              },
            ];
          } else {
            const dynamicCount = Math.max(
              5,
              Math.ceil(actualAudioDuration / 5),
            );
            const count =
              mediaType === "multi_image" ? imageCount : dynamicCount;
            const stopPromptTimer = perf?.start("story", `Generate ${count} Scene Prompts`);
            scenePrompts = await generateScenePrompts(
              script,
              count,
              storyMetadata,
              visualSuggestions,
            );
            stopPromptTimer?.();
          }
          logger.info("Scene Prompts:", scenePrompts);

          if (mediaType === "video") {
            const stopVideoClipsTimer = perf?.start("video", `Generate AI Video Clips (${scenePrompts.length} clips)`);
            const clips = await generateVideoClips(
              scenePrompts,
              ratioDir,
              currentRatio,
              characterReferences,
              commonPrompt,
              () => checkCancelled(workflow.id),
            );
            stopVideoClipsTimer?.();
            mediaItems = clips.filter((c) => c.filePath).map((c) => c.filePath);

            if (mediaItems.length > 0) {
              const stopStitchTimer = perf?.start("video", `Stitch Multi-media Video (${mediaItems.length} items)`);
              // Legacy non-streaming fallback for video/clips
              const dummySegmentFiles = []; // Not fully refactored for video clips yet
              // We would need a createMultiMediaVideo for video clips or use the same streaming logic
              stopStitchTimer?.();
            }
          } else if (mediaType === "multi_image") {
            const stopMultiImagesTimer = perf?.start("image", `Generate Multi Images (${scenePrompts.length} images)`);
            const checkpointManager = new CheckpointManager(workflowTempDir);

            const isVertical = currentRatio === "9:16";
            const width = isVertical ? 1080 : 1920;
            const height = isVertical ? 1920 : 1080;
            const getSegmentRange = (index) => {
              const startFrame = Math.round(index * (actualAudioDuration / scenePrompts.length) * 30);
              const endFrame = Math.round((index + 1) * (actualAudioDuration / scenePrompts.length) * 30);
              const frames = endFrame - startFrame;
              return { startTime: startFrame / 30, duration: frames / 30 };
            };

            const segmentFiles = new Array(scenePrompts.length).fill(null);
            const segmentPromises = [];

            const onImageReady = async (imagePath, i) => {
              const segmentPromise = (async () => {
                const sceneId = `scene_${String(i + 1).padStart(3, "0")}`;
                const segmentPath = path.join(ratioDir, `${sceneId}_seg.mp4`);
                segmentFiles[i] = segmentPath;

                if (checkpointManager.isRenderCompleted(sceneId) && fs.existsSync(segmentPath)) {
                  logger.info(`⏩ [Segment ${i + 1}/${scenePrompts.length}] Skipping render (Checkpoint)`);
                  return;
                }

                const { startTime, duration } = getSegmentRange(i);
                
                const segmentAssPath = path.join(workflowTempDir, `subs-${sceneId}-${Date.now()}.ass`);
                convertSrtToAss(srtPath, segmentAssPath, currentRatio, startTime, duration);
                const escapedSegmentAssPath = segmentAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");

                checkpointManager.markRenderRunning(sceneId);
                try {
                  await renderMediaSegment(imagePath, segmentPath, duration, width, height, escapedSegmentAssPath);
                  checkpointManager.markRenderCompleted(sceneId);
                } catch (err) {
                  checkpointManager.markRenderFailed(sceneId);
                  throw err;
                } finally {
                  if (fs.existsSync(segmentAssPath)) {
                    fs.unlinkSync(segmentAssPath);
                  }
                }
              })();

              segmentPromises.push(segmentPromise);
            };

            const images = await generateMultiImages(
              scenePrompts,
              ratioDir,
              currentRatio,
              commonPrompt,
              characterReferences,
              styleReferenceUrl,
              () => checkCancelled(workflow.id),
              onImageReady,
              checkpointManager
            );

            // Wait for all async segment renders to complete
            await Promise.all(segmentPromises);
            stopMultiImagesTimer?.();
            mediaItems = images.filter((img) => img.imageUrl).map((img) => img.imageUrl);

            // Step 5: Final Concat
            if (mediaItems.length > 0) {
              logger.info(`Step 5: Stitching video for ${currentRatio}...`);
              
              const stopStitchTimer = perf?.start("video", `Stitch Multi-media Video (${mediaItems.length} items)`);
              await concatSegments(segmentFiles, finalAudioLocalPath, videoPath, actualAudioDuration, null);
              stopStitchTimer?.();
            }

          } else {
            const stopImageTimer = perf?.start("image", "Generate Single Image");
            const imageResult = await generateImage(
              scenePrompts[0],
              1,
              ratioDir,
              currentRatio,
              commonPrompt,
              characterReferences,
              styleReferenceUrl,
            );
            stopImageTimer?.();
            if (imageResult.imageUrl) {
              mediaItems = [imageResult.imageUrl];
              const stopStitchTimer = perf?.start("video", "Stitch Single Image Video");
              await createVideo(mediaItems[0], finalAudioLocalPath, videoPath, srtPath, currentRatio);
              stopStitchTimer?.();
            }
          }
        }

        if (mediaItems.length > 0) {
          const stopVideoUploadTimer = perf?.start("upload", `Upload Final Video to Cloudinary: ${currentRatio}`);
          const currentVideoURL = await uploadVideoToCloud(
            videoPath,
            videoFilename,
          );
          stopVideoUploadTimer?.();
          videoResults[currentRatio] = {
            url: currentVideoURL,
            items: mediaItems,
          };

          if (!videoURL) videoURL = currentVideoURL; // Set primary for backward compatibility
          if (mediaUrls.length === 0) mediaUrls = mediaItems;
        }
      }

      if (Object.keys(videoResults).length > 0) {
        const primaryVideo =
          videoResults[aspectRatio] || Object.values(videoResults)[0];
        videoURL = primaryVideo.url;
        mediaUrls = primaryVideo.items;

        const videoRecord = await prisma.video.create({
          data: {
            title: dualPlatform ? `${title} (Dual Version)` : title,
            fileURL: videoURL, // Fallback/Main
            video_16_9: videoResults["16:9"]?.url,
            video_9_16: videoResults["9:16"]?.url,
            userId,
          },
        });

        await prisma.workflow.update({
          where: { id: workflow.id },
          data: {
            videoId: videoRecord.id,
            metadata: {
              ...(workflow.metadata || {}),
              dualPlatform,
            },
          },
        });

        isPodcast = false;
      } else {
        logger.info(
          "⚠️ Media generation failed → creating as podcast",
          "\x1b[33m",
        );
        isPodcast = true;
      }
    } else {
      logger.info("🎧 Podcast-only mode", "\x1b[36m");
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

    logger.info("🎉 Workflow completed successfully", "\x1b[32m");

    // 🚀 Auto-publish to social media via Mallary.ai
    try {
      const autoPublishEnabled = process.env.MALLARY_AUTO_PUBLISH === "true" || workflow.metadata?.autoPublish === true;
      if (autoPublishEnabled && videoURL && workflow.metadata?.autoPublish !== false) {
        const freshStory = await prisma.story.findUnique({ where: { id: story.id } });
        const { autoPublishStory } = await import("./socialPublishService.js");
        await autoPublishStory(workflow.id, {
          videoUrl: videoURL,
          audioUrl: mixedVoiceURL,
          story: freshStory,
          aspectRatio: workflow.metadata?.aspectRatio,
          delayMinutes: workflow.metadata?.autoPublishDelayMinutes,
        });
        logger.info("📡 Auto-publish to Mallary triggered successfully");
      }
    } catch (publishErr) {
      logger.error(`⚠️ Auto-publish to Mallary failed (non-fatal): ${publishErr.message}`);
    }


    perf?.generateReport(workflowTempDir);

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
    logger.info(`Workflow failed: ${err.message}`, "\x1b[31m");

    if (srtPath && fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
    deleteTempFiles(workflowTempDir);

    perf?.generateReport(workflowTempDir);

    // If cancelled by user → mark CANCELLED, do NOT let BullMQ retry
    if (err.isCancelled) {
      await prisma.workflow.update({
        where: { id: workflow.id },
        data: {
          status: "CANCELLED",
          metadata: {
            ...(workflow.metadata || {}),
            cancelledAt: new Date().toISOString(),
          },
        },
      });
      logger.info("🚫 Workflow cancelled by user", "\x1b[33m");
      return { success: false, cancelled: true, workflowId: workflow.id };
    }

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
