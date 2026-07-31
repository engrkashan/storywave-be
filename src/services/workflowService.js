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
import { getAudioDuration, convertToWav, mixAudioFiles, mixCinematicSoundscape } from "./audioService.js";
import { analyzeNarrativeAndPlanSoundscape, buildSoundscapeAssets } from "./soundDirectorService.js";
import { buildMasterTimeline, saveMasterTimeline, buildNarrationSegments } from "./timelineService.js";
import {
  createVideo,
  createVideoWithTimeline,
  generateVideoClips,
  concatSegments,
  renderMediaSegment,
  convertTranscriptToAss
} from "./videoService.js";
import { generateThumbnailPrompt } from "../utils/thumbnailPrompt.js";
import {
  extractStoryMetadata,
  generateMasterPrompts,
  generateCommonVisualPrompt,
  analyzeReferenceImage,
  buildSceneObjects,
  planVideoPrompts,
} from "./promptService.js";
import {
  runModule1_InputNormalization,
  runModule2_StoryWorldAnalysis,
  runModule3_MaterializedCastBible,
  runModule4_VisualWorldBible,
  generateSceneGraph
} from "./motionGraphicEngine.js";
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
      storyGuidelines: meta.storyGuidelines || null,
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
      backgroundMusicStyle: meta.backgroundMusicStyle || null,
      soundEffects: meta.soundEffects ?? false,
      aspectRatio: meta.aspectRatio || "16:9",
      dualPlatform: meta.dualPlatform || false,
      characterTalk: meta.characterTalk ?? false,
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
    storyGuidelines: meta.storyGuidelines || null,
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
    chunk_size: 20000000, // 20 MB chunks for faster large uploads
    timeout: 3600000, // 1 hour timeout to prevent aborting huge videos
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
  storyGuidelines = null,
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
  backgroundMusicStyle = null,
  soundEffects = false,
  aspectRatio = "16:9",
  dualPlatform = false,
  characterTalk = false,
  series = null,
  coverArtPrompt = null,
  seoContent = null,
  visualSuggestions = null,
  uploadedMediaUrl = null,
  characterReferenceBase64: userCharacterReferenceBase64 = null,
  // New: multi-character reference array [{ name, base64 }]
  characterReferences: userMultiCharacterReferences = null,
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
          backgroundMusicStyle,
          aspectRatio,
          dualPlatform,
          series,
          coverArtPrompt,
          seoContent,
          visualSuggestions,
          uploadedMediaUrl,
          characterReferenceBase64: userCharacterReferenceBase64,
          characterReferences: userMultiCharacterReferences,
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

  let transcriptPath = null;

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
        storyGuidelines,
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
    let uploadedMultiRefs = []; // { name, url } after Cloudinary upload
    let referenceTraits = null;  // ← hoisted so generateScenePrompts can access it after transcription

    if (shouldGenerateImage) {
      logger.info("Step 2.1: Extracting story metadata and master prompts...");
      const stopMetaTimer = perf?.start("metadata", "Extract metadata & master prompts");

      // ── Upload user-supplied character reference images ────────────────────
      //
      // Two code paths (backward compatible):
      //   A) New: userMultiCharacterReferences = [{ name, base64 }, ...]
      //      → upload each, fuzzy-match to story character, populate characterReferences[]
      //   B) Legacy: userCharacterReferenceBase64 = single base64 string
      //      → upload once, assign to main character (unchanged behaviour)

      if (Array.isArray(userMultiCharacterReferences) && userMultiCharacterReferences.length > 0) {
        logger.info(`User provided ${userMultiCharacterReferences.length} multi-character reference image(s). Processing...`);
        for (const entry of userMultiCharacterReferences) {
          const imgData = entry.url || entry.base64;
          if (!imgData) continue;

          if (typeof imgData === "string" && imgData.startsWith("http")) {
            uploadedMultiRefs.push({ name: entry.name || "", url: imgData });
            logger.info(`✅ Multi-char ref URL preserved: "${entry.name}" → ${imgData}`);
          } else {
            try {
              const upload = await cloudinary.uploader.upload(imgData, {
                folder: "character-references",
                resource_type: "image",
                public_id: `user-char-ref-${workflow.id}-${(entry.name || "char").replace(/\s+/g, "-").toLowerCase()}-${Date.now()}`,
                overwrite: true,
              });
              uploadedMultiRefs.push({ name: entry.name || "", url: upload.secure_url });
              logger.info(`✅ Multi-char ref uploaded: "${entry.name}" → ${upload.secure_url}`);
            } catch (err) {
              logger.error(`⚠️ Failed to upload character ref for "${entry.name}": ${err.message}`);
              // Fallback: use inline base64/url so this character still has a reference
              uploadedMultiRefs.push({ name: entry.name || "", url: imgData });
            }
          }
        }
      } else if (userCharacterReferenceBase64) {
        // Legacy single-character path
        logger.info("User provided a character reference image (legacy). Uploading to Cloudinary...");
        try {
          const upload = await cloudinary.uploader.upload(userCharacterReferenceBase64, {
            folder: "character-references",
            resource_type: "image",
            public_id: `user-char-ref-${workflow.id}-${Date.now()}`,
            overwrite: true,
          });
          characterReferenceUrl = upload.secure_url;
          logger.info(`✅ User Character Reference URL: ${characterReferenceUrl}`);
        } catch (err) {
          logger.error(`⚠️ Failed to upload user character reference: ${err.message}`);
          characterReferenceUrl = userCharacterReferenceBase64;
        }
      }

      // Extract reference traits for extractStoryMetadata from uploaded references
      let localRefTraits = [];

      if (uploadedMultiRefs.length > 0) {
        logger.info(`Extracting physical traits from ${uploadedMultiRefs.length} reference images...`);
        const traitPromises = uploadedMultiRefs.map(async (ref) => {
          if (ref.url && ref.url.startsWith("http")) {
            const traits = await analyzeReferenceImage(ref.url);
            if (traits) {
              return { characterName: ref.name || "Main Character", ...traits };
            }
          }
          return null;
        });
        const resolvedTraits = await Promise.all(traitPromises);
        localRefTraits = resolvedTraits.filter(Boolean);
      } else if (characterReferenceUrl && characterReferenceUrl.startsWith("http")) {
        logger.info("Extracting physical traits from main reference image...");
        const traits = await analyzeReferenceImage(characterReferenceUrl);
        if (traits) {
          localRefTraits.push({ characterName: "Main Character", ...traits });
        }
      }

      referenceTraits = localRefTraits.length > 0 ? localRefTraits : null;

      const PROJECT_SPEC = await runModule1_InputNormalization({
        title, sourceType: storyType || "script", storyScript: script, imageCount,
        aspectRatio, visualSuggestions, storyGuidelines
      });
      const STORY_WORLD_MAP = await runModule2_StoryWorldAnalysis(script, PROJECT_SPEC);
      const MATERIALIZED_CAST_BIBLE = await runModule3_MaterializedCastBible(STORY_WORLD_MAP, referenceTraits);
      const MATERIALIZED_VISUAL_WORLD_BIBLE = await runModule4_VisualWorldBible(STORY_WORLD_MAP, PROJECT_SPEC);

      const { graph: SCENE_GRAPH } = await generateSceneGraph(script, MATERIALIZED_CAST_BIBLE, MATERIALIZED_VISUAL_WORLD_BIBLE, referenceTraits);

      storyMetadata = {
        characters: MATERIALIZED_CAST_BIBLE.characters || [],
        locations: MATERIALIZED_VISUAL_WORLD_BIBLE.locations || [],
        synopsis: STORY_WORLD_MAP.core_synopsis || "",
        artStyle: STORY_WORLD_MAP.visual_style_record?.art_style || "",
        colorPalette: STORY_WORLD_MAP.visual_style_record?.color_palette || [],
        cinematicSpecs: STORY_WORLD_MAP.visual_style_record?.cinematic_treatment || "",
        _preGeneratedBibles: { PROJECT_SPEC, STORY_WORLD_MAP, MATERIALIZED_CAST_BIBLE, MATERIALIZED_VISUAL_WORLD_BIBLE },
        targetSceneCount: SCENE_GRAPH.length
      };
      masterPrompts = generateMasterPrompts(storyMetadata, title, aspectRatio);
      commonPrompt = generateCommonVisualPrompt(storyMetadata);

      if (imagePrompt && (mediaType === "multi_image" || mediaType === "video")) {
        commonPrompt = `${commonPrompt}. Visual Reference: ${imagePrompt}`;
      }
      stopMetaTimer?.();
    }

    // Auto-enhance script with sound effects cues if the user enabled the toggle.
    if (soundEffects === true) {
      logger.info(
        "Step 2.5: Enhancing script with sound-effect cues (soundEffects toggle is ON)...",
      );
      const stopSfxScriptTimer = perf?.start("sfx", "Enhance script with sound effects");
      script = await enhanceScriptWithSoundEffects(script);
      stopSfxScriptTimer?.();
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
          "Skipping Style Reference generation since character reference is provided.",
        );
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
            // v6.3 Engine: globalNegativePrompt stored here for image generation steps
            globalNegativePrompt: null, // Populated after generateScenePrompts resolves
          },
        },
      });

      // 2.2 Match uploaded multi-char refs to story characters by fuzzy name,
      //     OR assign legacy single ref to main character
      logger.info("Step 2.2: Processing Multi-Character References...");
      const charactersList = storyMetadata.characters || [];

      /**
       * Fuzzy name match: returns true if charName contains refName or vice versa
       * (case-insensitive, trimmed). Handles "Marcus" matching "Marcus Johnson", etc.
       */
      const nameMatch = (charName = "", refName = "") => {
        const a = charName.trim().toLowerCase();
        const b = refName.trim().toLowerCase();
        return a && b && (a.includes(b) || b.includes(a));
      };

      // Identify the main character for legacy compat
      const mainCharacter =
        charactersList.find((c) => c.isMainCharacter) || charactersList[0];

      if (uploadedMultiRefs.length > 0) {
        // New multi-character path
        for (const ref of uploadedMultiRefs) {
          // Find best-matching story character
          const matchedChar = charactersList.find(c => nameMatch(c.name, ref.name))
            || (ref === uploadedMultiRefs[0] ? mainCharacter : null); // first ref → main char if no name match

          if (matchedChar) {
            characterReferences.push({ id: matchedChar.id, name: matchedChar.name, url: ref.url });
            logger.info(`✅ Matched "${ref.name}" → character "${matchedChar.name || matchedChar.id}"`);
            // Keep legacy characterReferenceUrl pointing to main character's URL
            if (matchedChar.id === mainCharacter?.id) {
              characterReferenceUrl = ref.url;
            }
          } else {
            logger.warn(`⚠️ No story character matched ref name "${ref.name}" — reference not assigned`);
          }
        }
      } else if (characterReferenceUrl && mainCharacter) {
        // Legacy single-reference path
        characterReferences.push({
          id: mainCharacter.id,
          name: mainCharacter.name,
          url: characterReferenceUrl,
        });
        logger.info(
          `✅ Assigned user-uploaded character reference to ${mainCharacter.name || mainCharacter.id}`,
        );
      }

      // 2.2 Generate Character Portraits for all story characters not yet covered
      // SKIP portrait generation when:
      //   a) User uploaded direct media (uploadedMediaUrl) — AI bypassed entirely
      //   b) Individual character already has a user-supplied reference in characterReferences[]
      const shouldGeneratePortraits = !uploadedMediaUrl;

      if (shouldGeneratePortraits && (
        mediaType === "video" ||
        mediaType === "multi_image" ||
        mediaType === "single_image"
      )) {
        logger.info("Step 2.2: Generating AI character portraits for characters without reference images...");
        for (const char of charactersList) {
          if (characterReferences.find((c) => c.id === char.id || nameMatch(c.name, char.name))) continue; // Skip if already assigned

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
                name: char.name,
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
              : `${characterReferences.length} user character reference(s) provided (likeness already anchored)`
            }.`,
        );
      }

      // Store uploaded multi-char refs and music style in metadata for audit/debug and regeneration
      const savedCharRefs = uploadedMultiRefs.length > 0 ? uploadedMultiRefs : characterReferences;
      await prisma.workflow.update({
        where: { id: workflow.id },
        data: {
          metadata: {
            ...(workflow.metadata || {}),
            characterReferences: savedCharRefs,
            uploadedCharacterReferences: uploadedMultiRefs,
            userCharacterRefNames: uploadedMultiRefs.map(r => r.name).filter(Boolean),
            backgroundMusicStyle: backgroundMusicStyle || (workflow.metadata && workflow.metadata.backgroundMusicStyle) || null,
            storyMetadata: {
              ...(storyMetadata || {}),
              characterReferences: savedCharRefs,
              backgroundMusicStyle: backgroundMusicStyle || null,
            },
          },
        },
      });
    }

    const hasVoiceSelected = voice && ((typeof voice === "object" && voice.id && String(voice.id).trim()) || (typeof voice === "string" && voice.trim()));
    const isCharacterTalkActive = characterTalk === true;

    let pureVoiceURL = null;
    let voiceLocalPath = null;
    let timelineWords = [];

    if (isCharacterTalkActive) {
      logger.info("🎙️ [Character Talk] Enabled — skipping external TTS generation. Gemini Omni Flash will generate video clips with native character dialogue & real voice.");
      const scriptWords = script.split(/\s+/).filter(Boolean);
      const secPerWord = 0.35;
      timelineWords = scriptWords.map((w, idx) => ({
        word: w,
        start: idx * secPerWord,
        end: (idx + 1) * secPerWord,
      }));
      transcriptPath = path.join(workflowTempDir, `subtitles-${workflow.id}.json`);
      fs.writeFileSync(transcriptPath, JSON.stringify({ text: script, words: timelineWords }));
    } else {
      logger.info("Step 3: Generating continuous voiceover narration...");
      logger.info(
        `[WorkflowService] voice payload dispatched to generateVoiceover: ${JSON.stringify(voice)}`,
      );
      await checkCancelled(workflow.id); // ✔️ Cancellation check
      const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
      const stopVoiceTimer = perf?.start("audio", "Generate Voiceover TTS");
      const voiceRes = await generateVoiceover(script, voiceFilename, voice, workflowTempDir);
      pureVoiceURL = voiceRes.url;
      voiceLocalPath = voiceRes.localPath;
      stopVoiceTimer?.();

      logger.info("Step 3.1: Transcribing voiceover narration with Whisper for word-level audio sync...");
      const stopSubTimer = perf?.start("subtitle", "Transcribe Audio with Whisper");
      const narrationWavPath = path.join(workflowTempDir, `narration-${workflow.id}.wav`);
      await convertToWav(voiceLocalPath, narrationWavPath);

      const transcriptContent = await transcribeWithTimestamps(narrationWavPath);
      transcriptPath = path.join(workflowTempDir, `subtitles-${workflow.id}.json`);
      fs.writeFileSync(transcriptPath, transcriptContent);
      stopSubTimer?.();

      const parsedSub = JSON.parse(transcriptContent);
      timelineWords = parsedSub.words || [];
    }

    // ── Step 3.2: AI Cinematic Sound Director Pipeline ────────────────────────────
    let soundscapeAssets = [];
    let soundscapePlan = null;

    if (soundEffects === true) {
      logger.info("Step 3.2: [AI Sound Director] Planning cinematic soundscape & multi-layer audio...");
      const stopSoundscapeTimer = perf?.start("soundscape", "AI Sound Director Analysis & Asset Building");
      soundscapePlan = await analyzeNarrativeAndPlanSoundscape({
        script,
        words: timelineWords,
        storyMetadata: storyMetadata || { genre: storyType, voiceTone },
      });

      soundscapeAssets = await buildSoundscapeAssets({
        soundscapePlan,
        words: timelineWords,
        tempDir: workflowTempDir,
      });
      stopSoundscapeTimer?.();
    }

    // ── Step 3.5: Background Music Generation ──────────────────────────────────────
    let musicPath = null;
    if (backgroundMusic === true) {
      logger.info("Step 3.5: Generating background music...");
      const stopMusicTimer = perf?.start("audio", "Generate Background Music (Suno)");
      musicPath = await generateBackgroundMusic({
        title,
        storyType,
        musicStyle: backgroundMusicStyle,
        tempDir: workflowTempDir,
      });
      stopMusicTimer?.();
    }

    // ── Step 3.6: Multi-Track Soundscape Mixing ───────────────────────────────────
    let finalAudioLocalPath = voiceLocalPath;
    const mixedFilename = `cinematic_master_${workflow.id}_${Date.now()}.mp3`;
    const mixedLocalPath = path.join(workflowTempDir, mixedFilename);

    if ((soundscapeAssets.length > 0 || musicPath) && voiceLocalPath) {
      logger.info("Step 3.6: Mixing cinematic soundscape (Narration + Ambience + Foley SFX + Tension + Music)...");
      const stopMixTimer = perf?.start("audio", "Mix Cinematic Soundscape");
      await mixCinematicSoundscape({
        narrationFile: voiceLocalPath,
        backgroundMusicFile: musicPath,
        soundscapeAssets,
        outputFile: mixedLocalPath,
      });
      stopMixTimer?.();
      finalAudioLocalPath = mixedLocalPath;
    } else if (musicPath && !voiceLocalPath) {
      finalAudioLocalPath = musicPath;
    }

    let mixedVoiceURL = null;
    let actualAudioDuration = 0;

    if (finalAudioLocalPath && fs.existsSync(finalAudioLocalPath)) {
      logger.info("Uploading final audio track to Cloudinary...");
      const stopAudioUploadTimer = perf?.start("upload", "Upload Final Audio to Cloudinary");
      const uploadRes = await cloudinary.uploader.upload(finalAudioLocalPath, {
        folder: "voiceovers",
        resource_type: "video",
        public_id: path.parse(finalAudioLocalPath).name,
        overwrite: true,
      });
      stopAudioUploadTimer?.();

      mixedVoiceURL = uploadRes.secure_url;
      actualAudioDuration = await getAudioDuration(finalAudioLocalPath);
      logger.info(`📊 Actual audio duration: ${actualAudioDuration.toFixed(2)}s`);

      await prisma.voiceover.create({
        data: {
          script,
          audioURL: mixedVoiceURL,
          workflowId: workflow.id,
          userId,
        },
      });
    } else {
      actualAudioDuration = Math.max(5, Math.ceil(script.split(/\s+/).length * 0.35));
    }

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: {
        metadata: {
          ...(workflow.metadata || {}),
          characterTalk,
          soundscapePlan: soundscapePlan || null,
          soundscapeAssetsCount: soundscapeAssets.length,
        },
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

      logger.info("Step 5: Preparing subtitles & Master Timeline...");
      const stopSubTimer = perf?.start("subtitle", "Prepare Subtitles (Whisper)");

      const narrationWavPath = path.join(workflowTempDir, `narration-${workflow.id}.wav`);
      if (!fs.existsSync(narrationWavPath)) {
        await convertToWav(voiceLocalPath, narrationWavPath);
      }

      let transcriptContent;
      const cachedSubPath = path.join(workflowTempDir, `subtitles-${workflow.id}.json`);
      if (fs.existsSync(cachedSubPath)) {
        transcriptContent = fs.readFileSync(cachedSubPath, "utf-8");
      } else {
        transcriptContent = await transcribeWithTimestamps(narrationWavPath);
        fs.writeFileSync(cachedSubPath, transcriptContent);
      }
      transcriptPath = cachedSubPath;
      stopSubTimer?.();

      // Use dynamic count from audio duration for video (Veo max clip length = 5s), or imageCount/dynamic for multi_image.
      const narrationDuration = await getAudioDuration(narrationWavPath);
      const { words: timelineWords } = JSON.parse(transcriptContent);
      const dynamicCount = Math.max(1, Math.ceil(narrationDuration / 5));
      const targetSceneCount = (mediaType === "video")
        ? dynamicCount
        : (imageCount || Math.max(5, dynamicCount));

      // script variable holds the original text at this point. 
      const masterTimeline = buildMasterTimeline(timelineWords, narrationDuration, targetSceneCount, script);
      const timelinePath = path.join(workflowTempDir, "timeline.json");
      saveMasterTimeline(masterTimeline, timelinePath);
      logger.info(`🗺️  Master Timeline: ${masterTimeline.actualSceneCount} scenes, ${masterTimeline.subtitleGroups.length} subtitle groups`);


      // Pre-generate scenePrompts here (outside ratio loop) so both
      // dualPlatform ratios share the same timeline and scene count.
      //
      // SYNC FIX: generateScenePrompts now runs AFTER Whisper transcription.
      // narrationSegments maps Whisper words → per-scene text so each prompt's
      // narration matches the exact audio slot it will be rendered over.
      let preGeneratedScenePrompts = null;
      let narrationSegments = [];
      let mgeToStoryIdMap = {};  // bridges MGE char_N IDs → storyMetadata char IDs

      if ((mediaType === "multi_image" || mediaType === "video") && !uploadedMediaUrl) {
        const count = masterTimeline.actualSceneCount;

        // Build narration segments aligned to Master Timeline audio boundaries
        narrationSegments = buildNarrationSegments(timelineWords, masterTimeline.scenes);
        logger.info(`🎙️  Narration segments built: ${narrationSegments.length} segments from Whisper timestamps`);

        // SFX post-transcription: enhance each narration segment's text with SFX cues
        if (soundEffects === true) {
          logger.info("Step 5.1: Enhancing Whisper narration segments with sound-effect cues...");
          const stopSfxTimer = perf?.start("sfx", "Enhance narration segments with SFX");
          for (const seg of narrationSegments) {
            if (seg.text) {
              seg.text = await enhanceSceneWithSoundEffects("", seg.text);
            }
          }
          stopSfxTimer?.();
          // Also update the script for voiceover DB record consistency
          script = narrationSegments.map(s => s.text).join(" ");
        }

        const stopPromptTimer = perf?.start("story", `Generate ${count} Scene Prompts (post-transcription)`);
        const promptResult = await generateScenePrompts(
          script,
          count,
          storyMetadata,
          visualSuggestions,
          narrationSegments,       // ← Whisper-aligned narration segments
          referenceTraits,         // ← Analyzed reference image traits for MGE character locking
          characterReferences,     // ← [{ id, name, url }] for v7 per-frame Reference Selector
        );
        stopPromptTimer?.();

        preGeneratedScenePrompts = promptResult.scenePrompts;
        const mgeCastBible = promptResult.castBible;

        // ── Character ID bridge ──────────────────────────────────────────────
        // MGE generates its own char_1/char_2 IDs. Map them to storyMetadata
        // character IDs so portrait lookup in imageService succeeds.
        if (mgeCastBible?.characters?.length > 0) {
          const nameMatchFn = (a = "", b = "") => {
            const la = a.trim().toLowerCase();
            const lb = b.trim().toLowerCase();
            return la && lb && (la.includes(lb) || lb.includes(la));
          };
          for (const mgeChar of mgeCastBible.characters) {
            const matched = characterReferences.find((ref) => nameMatchFn(ref.name, mgeChar.name));
            if (matched) {
              mgeToStoryIdMap[mgeChar.id] = matched.id;
              logger.info(`🔗 ID bridge: MGE "${mgeChar.id}" (${mgeChar.name}) → storyRef "${matched.id}"`);
            } else {
              // IDENTITY FIX (B2): do NOT leave an unmapped MGE id in charactersInScene.
              // An unmapped id (e.g. "char_1") reaches imageService, fails the exact-id
              // match, and used to trigger the inject-ALL fallback (identity blending).
              // Map it to the MGE character NAME as a last resort so downstream matching
              // can still resolve by name; the scene's name will be used for ref lookup.
              mgeToStoryIdMap[mgeChar.id] = mgeChar.name;
              logger.warn(`⚠️ ID bridge: No characterReference matched MGE character "${mgeChar.name}" (${mgeChar.id}) — falling back to name "${mgeChar.name}" for ref lookup.`);
            }
          }
          // Remap charactersInScene arrays using the bridge map
          preGeneratedScenePrompts.forEach((sp) => {
            sp.charactersInScene = (sp.charactersInScene || [])
              .map((mgeId) => mgeToStoryIdMap[mgeId] || mgeId)
              // Drop any id that still resolves to an MGE-style id with no ref
              // (imageService now treats missing-name matches as text-only, no blending)
              .filter((id) => {
                const stillMgeId = /^char_\d+$/i.test(String(id)) && !characterReferences.some((r) => r.id === id);
                if (stillMgeId) logger.warn(`⚠️ Dropping unmappable character id "${id}" from scene to avoid inject-all.`);
                return !stillMgeId;
              });
          });
          logger.info(`🔗 Character ID bridge complete. Mapped: ${Object.keys(mgeToStoryIdMap).length}/${mgeCastBible.characters.length} characters`);
        }

        // v6.3 Engine: extract globalNegativePrompt and FINAL_AUDIT from first scene prompt
        const _globalNeg = preGeneratedScenePrompts?.[0]?._globalNegativePrompt || null;
        const _finalAudit = {
          passed: !preGeneratedScenePrompts?.some(sp => sp._negativePrompt?.includes("REJECTED")),
          total_frames: preGeneratedScenePrompts?.length,
        };
        if (_globalNeg) {
          logger.info(`[v6.3 Engine] Global Negative Prompt captured (${_globalNeg.length} chars)`);
          try {
            await prisma.workflow.update({
              where: { id: workflow.id },
              data: {
                metadata: {
                  ...(workflow.metadata || {}),
                  globalNegativePrompt: _globalNeg,
                  finalAudit: _finalAudit,
                },
              },
            });
          } catch (dbErr) {
            logger.warn(`[v6.3 Engine] Failed to store audit in metadata: ${dbErr.message}`);
          }
        }
      }

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
          if (mediaType === "single_image") {
            // Build a rich single-image prompt using story metadata when available
            const mainChar = storyMetadata?.characters?.[0];
            const mainLoc = storyMetadata?.locations?.[0];
            const singleImagePrompt = imagePrompt ||
              [
                mainChar ? `CHARACTER: ${mainChar.name}. ${mainChar.appearance || ""}` : "",
                mainLoc ? `LOCATION: ${mainLoc.name}. ${mainLoc.description || ""}` : "",
                storyMetadata?.synopsis ? `STORY CONTEXT: ${storyMetadata.synopsis}` : "",
                "Cinematic photorealistic film still, 8K, hyper-realistic, volumetric lighting. NO TEXT in image.",
              ].filter(Boolean).join(" ").trim() ||
              "Cinematic storytelling scene, photorealistic, 8K detail";
            scenePrompts = [
              {
                prompt: singleImagePrompt,
                charactersInScene: mainChar?.id ? [mainChar.id] : [],
              },
            ];
          } else if (mediaType === "video") {
            // Video mode: generate specialized motion prompts for Gemini Omni Flash (gemini-omni-flash-preview)
            const sharedSceneObjects = buildSceneObjects(preGeneratedScenePrompts || [], storyMetadata, narrationSegments);
            scenePrompts = planVideoPrompts(sharedSceneObjects, storyMetadata, { aspectRatio: currentRatio, characterTalk });
            logger.info(`🎬 Using ${scenePrompts.length} Video-Planned motion prompts for Gemini Omni Flash (Character Talk: ${characterTalk})`);
          } else {
            // multi_image: use pre-generated prompts built alongside Master Timeline (100% untouched)
            scenePrompts = preGeneratedScenePrompts || [];
            logger.info(`Using ${scenePrompts.length} Whisper-aligned scene prompts`);
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
              const checkpointManager = new CheckpointManager(workflowTempDir);

              const isVertical = currentRatio === "9:16";
              const width = isVertical ? 1080 : 1920;
              const height = isVertical ? 1920 : 1080;

              const getSegmentRange = (index) => {
                const scene = masterTimeline.scenes[index];
                if (scene) return { startTime: scene.startSec, duration: scene.durationSec };
                const approxDuration = masterTimeline.totalDuration / scenePrompts.length;
                return { startTime: index * approxDuration, duration: approxDuration };
              };

              const segmentFiles = new Array(mediaItems.length).fill(null);
              for (let i = 0; i < mediaItems.length; i++) {
                const clipPath = mediaItems[i];
                const sceneId = `scene_${String(i + 1).padStart(3, "0")}`;
                const segmentPath = path.join(ratioDir, `${sceneId}_seg.mp4`);
                segmentFiles[i] = segmentPath;

                if (checkpointManager.isRenderCompleted(sceneId) && fs.existsSync(segmentPath)) {
                  logger.info(`⏩ [Segment ${i + 1}/${mediaItems.length}] Skipping render (Checkpoint)`);
                  continue;
                }

                const { duration } = getSegmentRange(i);
                const segmentAssPath = path.join(workflowTempDir, `subs-${sceneId}-${Date.now()}.ass`);
                convertTranscriptToAss(masterTimeline, segmentAssPath, currentRatio, i);
                const escapedSegmentAssPath = segmentAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");

                checkpointManager.markRenderRunning(sceneId);
                try {
                  await renderMediaSegment(clipPath, segmentPath, duration, width, height, escapedSegmentAssPath);
                  checkpointManager.markRenderCompleted(sceneId);
                } catch (err) {
                  checkpointManager.markRenderFailed(sceneId);
                  throw err;
                } finally {
                  if (fs.existsSync(segmentAssPath)) {
                    fs.unlinkSync(segmentAssPath);
                  }
                }
              }

              const validSegmentFiles = segmentFiles.filter(Boolean);
              const useSegmentAudioOnly = characterTalk === true && !musicPath;
              const mixSegmentAudio = characterTalk === true && !!musicPath;
              await concatSegments(validSegmentFiles, finalAudioLocalPath, videoPath, actualAudioDuration, null, {
                useSegmentAudioOnly,
                mixSegmentAudio,
              });
              stopStitchTimer?.();
            }
          } else if (mediaType === "multi_image") {
            // scenePrompts already set to preGeneratedScenePrompts in the block above
            const stopMultiImagesTimer = perf?.start("image", `Generate Multi Images (${scenePrompts.length} images)`);
            const checkpointManager = new CheckpointManager(workflowTempDir);

            const isVertical = currentRatio === "9:16";
            const width = isVertical ? 1080 : 1920;
            const height = isVertical ? 1920 : 1080;

            // Scene boundary lookup from Master Timeline (replaces equal-division arithmetic)
            const getSegmentRange = (index) => {
              const scene = masterTimeline.scenes[index];
              if (scene) return { startTime: scene.startSec, duration: scene.durationSec };
              // Fallback for out-of-bounds (should not happen with clamped scenes)
              const approxDuration = masterTimeline.totalDuration / scenePrompts.length;
              return { startTime: index * approxDuration, duration: approxDuration };
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

                // Pass masterTimeline + sceneIndex → zero-drift subtitle generation
                const segmentAssPath = path.join(workflowTempDir, `subs-${sceneId}-${Date.now()}.ass`);
                convertTranscriptToAss(masterTimeline, segmentAssPath, currentRatio, i);
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

            // Fallback for failed image segments to keep audio/video sync
            const fallbackPromises = [];
            for (let i = 0; i < scenePrompts.length; i++) {
              if (!segmentFiles[i]) {
                logger.warn(`⚠️ Segment ${i + 1} was not generated. Attempting to regenerate the image...`);

                const fallbackPromise = (async () => {
                  try {
                    // Try to regenerate the single image that failed
                    const imageResult = await generateImage(
                      scenePrompts[i],
                      i + 1,
                      ratioDir,
                      currentRatio,
                      commonPrompt,
                      characterReferences,
                      styleReferenceUrl
                    );

                    // If the regenerated image is available, render the segment
                    if (imageResult.imageUrl) {
                      const sceneId = `scene_${String(i + 1).padStart(3, "0")}`;
                      const segmentPath = path.join(ratioDir, `${sceneId}_seg.mp4`);
                      segmentFiles[i] = segmentPath;

                      const { startTime, duration } = getSegmentRange(i);
                      const segmentAssPath = path.join(workflowTempDir, `subs-${sceneId}-${Date.now()}.ass`);
                      convertTranscriptToAss(masterTimeline, segmentAssPath, currentRatio, i);
                      const escapedSegmentAssPath = segmentAssPath.replace(/\\/g, "/").replace(/:/g, "\\:");

                      try {
                        await renderMediaSegment(imageResult.imageUrl, segmentPath, duration, width, height, escapedSegmentAssPath);
                        logger.info(`✅ Regenerated segment ${i + 1} rendered successfully.`);
                      } catch (err) {
                        logger.error(`❌ Failed to render regenerated segment for scene ${i + 1}`, err);
                        segmentFiles[i] = null;
                      } finally {
                        if (fs.existsSync(segmentAssPath)) fs.unlinkSync(segmentAssPath);
                      }
                    } else {
                      // Regeneration also failed — leave segment null. Never reuse another image.
                      logger.error(`❌ Scene ${i + 1} image generation permanently failed. Segment will be skipped from final video. No adjacent image will be substituted.`);
                      segmentFiles[i] = null;
                    }
                  } catch (err) {
                    logger.error(`❌ Error during regeneration for scene ${i + 1}:`, err);
                    segmentFiles[i] = null;
                  }
                })();
                fallbackPromises.push(fallbackPromise);
              }
            }

            if (fallbackPromises.length > 0) {
              await Promise.all(fallbackPromises);
            }

            stopMultiImagesTimer?.();
            mediaItems = images.filter((img) => img.imageUrl).map((img) => img.imageUrl);

            // Step 5: Final Concat
            if (mediaItems.length > 0) {
              logger.info(`Step 5: Stitching video for ${currentRatio}...`);

              const validSegmentFiles = segmentFiles.filter(Boolean);
              const stopStitchTimer = perf?.start("video", `Stitch Multi-media Video (${validSegmentFiles.length} items)`);
              await concatSegments(validSegmentFiles, finalAudioLocalPath, videoPath, actualAudioDuration, null);
              stopStitchTimer?.();
            }

          } else {
            // single_image: use timeline for full subtitle track (sceneIndex = null)
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
              // For single image, pass the timeline with sceneIndex=null to use all subtitle groups
              await createVideoWithTimeline(mediaItems[0], finalAudioLocalPath, videoPath, masterTimeline, currentRatio, actualAudioDuration);
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

    if (transcriptPath && fs.existsSync(transcriptPath)) fs.unlinkSync(transcriptPath);
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
