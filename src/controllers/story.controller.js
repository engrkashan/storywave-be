import prisma from "../config/prisma.client.js";
import { createLogger } from "../utils/logger.js";
import { cloudinary } from "../config/cloudinary.config.js";

const logger = createLogger("StoryController");
import { generateStory } from "../services/storyService.js";
import { addWorkflowJob, cancelWorkflowJob } from "../services/queueService.js";
import { config } from "../config/workflow.config.js";
import crypto from "crypto";

// Helper — consistent random title
function generateRandomTitle(storyType = "Story") {
  const randomId = crypto.randomBytes(3).toString("hex");
  const timestamp = Date.now();
  return `${storyType}_${randomId}_${timestamp}`;
}

function toBool(val, defaultVal = true) {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === "boolean") return val;
  if (typeof val === "number") return val !== 0;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (s === "false" || s === "0" || s === "off" || s === "no") return false;
    if (s === "true" || s === "1" || s === "on" || s === "yes") return true;
  }
  return Boolean(val);
}

// POST Create Workflow (Start background process)
export const createWorkflow = async (req, res) => {
  try {
    const userId = req.user?.userId || req.user?.id || req.user?._id;

    const {
      title,
      url,
      videoFile,
      textIdea,
      storyGuidelines,
      imagePrompt,
      storyType = "Story",
      voiceTone = "neutral",
      storyLength = "30 minutes",
      shouldGenerateImage,
      scheduledAt,
      voice,
      mediaType,
      imageCount,
      backgroundMusic,
      backgroundMusicStyle,
      soundEffects,
      characterTalk,
      subtitles,
      aspectRatio,
      dualPlatform,
      series,
      coverArtPrompt,
      seoContent,
      visualSuggestions,
      uploadedMediaUrl,
      characterReferenceBase64,
      // New: array of { name, url, base64 } — one per character
      characterReferences: userCharacterReferences,
      autoPublish,
      autoPublishDelayMinutes,
      useStoryGuidelinesOnlyForPrompts,
    } = req.body;

    const subtitlesEnabled = toBool(subtitles, true);
    logger.info(`🔤 [StoryController] Subtitles option parsed: ${subtitlesEnabled}`);

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: missing user" });
    }

    if (!textIdea && !url && !videoFile) {
      return res
        .status(400)
        .json({ error: "You must provide textIdea, url, or videoFile." });
    }

    // ✅ Step 0: Upload any incoming base64 character reference images to Cloudinary in parallel
    // This strips multi-megabyte base64 strings BEFORE storing in DB (prevents MongoDB 16MB document limit & 504 timeouts)
    let processedCharRefs = [];
    if (Array.isArray(userCharacterReferences) && userCharacterReferences.length > 0) {
      logger.info(`Processing and uploading ${userCharacterReferences.length} character reference image(s)...`);
      processedCharRefs = await Promise.all(
        userCharacterReferences.map(async (c, idx) => {
          if (!c) return null;
          const charName = (c.name || `Character ${idx + 1}`).trim();
          const imgData = c.url || c.base64;
          if (!imgData) return { id: c.id || `char_${idx + 1}`, name: charName, url: "" };

          // Already a Cloudinary / HTTP URL
          if (typeof imgData === "string" && imgData.startsWith("http")) {
            return { id: c.id || `char_${idx + 1}`, name: charName, url: imgData };
          }

          // Raw base64 data URI: upload to Cloudinary
          if (typeof imgData === "string" && imgData.startsWith("data:")) {
            try {
              const upload = await cloudinary.uploader.upload(imgData, {
                folder: "character-references",
                resource_type: "image",
                public_id: `user-char-ref-${Date.now()}-${idx}-${charName.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}`,
                overwrite: true,
              });
              logger.info(`✅ Uploaded "${charName}" to Cloudinary → ${upload.secure_url}`);
              return { id: c.id || `char_${idx + 1}`, name: charName, url: upload.secure_url };
            } catch (err) {
              logger.error(`⚠️ Cloudinary upload failed for "${charName}": ${err.message}`);
              return null;
            }
          }

          return { id: c.id || `char_${idx + 1}`, name: charName, url: "" };
        })
      );
      processedCharRefs = processedCharRefs.filter(Boolean);
    }

    // Single legacy character reference upload
    let singleCharRefUrl = null;
    if (characterReferenceBase64 && typeof characterReferenceBase64 === "string") {
      if (characterReferenceBase64.startsWith("http")) {
        singleCharRefUrl = characterReferenceBase64;
      } else if (characterReferenceBase64.startsWith("data:")) {
        try {
          const upload = await cloudinary.uploader.upload(characterReferenceBase64, {
            folder: "character-references",
            resource_type: "image",
            public_id: `user-char-ref-${Date.now()}-main`,
            overwrite: true,
          });
          singleCharRefUrl = upload.secure_url;
        } catch (err) {
          logger.error(`⚠️ Cloudinary single char upload failed: ${err.message}`);
        }
      }
    }

    const finalTitle = title || generateRandomTitle(storyType);
    const nowUTC = new Date().toISOString();
    const scheduledUTC = scheduledAt ? new Date(scheduledAt).toISOString() : null;
    const isScheduled = scheduledUTC && new Date(scheduledUTC) > new Date(nowUTC);

    // ✅ Step 1: Create the DB record with clean Cloudinary URLs (ZERO base64 blobs in DB)
    const workflow = await prisma.workflow.create({
      data: {
        title: finalTitle,
        type: "STORY",
        status: isScheduled ? "SCHEDULED" : "PENDING",
        scheduledAt: isScheduled ? new Date(scheduledUTC) : null,
        userId,
        metadata: {
          url,
          videoFile,
          textIdea,
          storyGuidelines,
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
          soundEffects: soundEffects ?? false,
          characterTalk: characterTalk ?? false,
          subtitles: subtitlesEnabled,
          aspectRatio,
          dualPlatform,
          series,
          coverArtPrompt,
          seoContent,
          visualSuggestions,
          uploadedMediaUrl,
          characterReferenceUrl: singleCharRefUrl,
          // Clean multi-character references array with hosted URLs
          characterReferences: processedCharRefs.length > 0 ? processedCharRefs : null,
          uploadedCharacterReferences: processedCharRefs.length > 0 ? processedCharRefs : null,
          autoPublish,
          autoPublishDelayMinutes,
          useStoryGuidelinesOnlyForPrompts: useStoryGuidelinesOnlyForPrompts ?? undefined,
        },
      },
    });

    if (isScheduled) {
      return res.status(200).json({
        message: "Story scheduled successfully",
        title: finalTitle,
        workflowId: workflow.id,
        status: "scheduled",
      });
    }

    // ✅ Step 2: Queue the job with the workflowId and clean URLs embedded in the payload
    const workflowPayload = {
      workflowId: workflow.id, // 🔑 Critical link
      userId,
      title: finalTitle,
      url,
      videoFile,
      textIdea,
      storyGuidelines,
      imagePrompt,
      storyType,
      voice,
      shouldGenerateImage,
      voiceTone,
      storyLength,
      scheduledAt: null,
      mediaType,
      imageCount,
      backgroundMusic,
      backgroundMusicStyle,
      soundEffects: soundEffects ?? false,
      characterTalk: characterTalk ?? false,
      subtitles: subtitlesEnabled,
      aspectRatio,
      dualPlatform,
      series,
      coverArtPrompt,
      seoContent,
      visualSuggestions,
      uploadedMediaUrl,
      characterReferenceUrl: singleCharRefUrl,
      // Multi-character references with Cloudinary URLs
      characterReferences: processedCharRefs.length > 0 ? processedCharRefs : null,
      uploadedCharacterReferences: processedCharRefs.length > 0 ? processedCharRefs : null,
      autoPublish,
      autoPublishDelayMinutes,
      useStoryGuidelinesOnlyForPrompts: useStoryGuidelinesOnlyForPrompts ?? undefined,
    };

    const job = await addWorkflowJob(workflowPayload);

    // ✅ Step 3: Save the bullJobId back to the workflow DB record atomically
    prisma.$runCommandRaw({
      update: "Workflow",
      updates: [
        {
          q: { _id: { $oid: workflow.id } },
          u: { $set: { "metadata.bullJobId": job.id } },
        },
      ],
    }).catch(e => logger.warn(`Failed to set bullJobId asynchronously: ${e.message}`));

    logger.info(`✅ Workflow ${workflow.id} queued as BullMQ job ${job.id}`);

    return res.status(200).json({
      message: "Workflow added to queue",
      title: finalTitle,
      workflowId: workflow.id,
      status: "queued",
      bullJobId: job.id,
    });
  } catch (err) {
    logger.error("Error running workflow:", err);
    return res.status(500).json({ error: err.message || "Workflow failed" });
  }
};


// POST Create Story (No workflow, just logic)
export const createStory = async (req, res) => {
  try {
    const {
      textIdea,
      url,
      videoFile,
      storyType = "Story",
      voiceTone = "neutral",
      storyLength = "30 minutes",
      voice,
    } = req.body;

    if (!textIdea && !url && !videoFile) {
      return res
        .status(400)
        .json({ error: "You must provide textIdea, url, or videoFile." });
    }

    const { outline, script } = await generateStory({
      textIdea,
      url,
      videoFile,
      storyType,
      voiceTone,
      storyLength,
      voice,
    });

    return res.status(200).json({ outline, script });
  } catch (err) {
    logger.error("Error generating story:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to generate story" });
  }
};

// GET Scheduled Stories
export const getScheduledStories = async (req, res) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workflows = await prisma.workflow.findMany({
      where: {
        userId,
        type: "STORY",
        status: "SCHEDULED",
        scheduledAt: {
          gt: new Date(),
        },
      },
      orderBy: { scheduledAt: "asc" },
      include: {
        story: true,
      },
    });

    const formatted = workflows.map((wf) => ({
      workflowId: wf.id,
      title: wf.title,
      scheduledAt: wf.scheduledAt,
      storyId: wf.story?.id || null,
    }));

    return res.status(200).json(formatted);
  } catch (err) {
    logger.error("Error fetching scheduled stories:", err);
    return res.status(500).json({ error: "Failed to fetch scheduled stories" });
  }
};

// GET all Stories (for current admin)
export const getStories = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    const stories = await prisma.story.findMany({
      where: { userId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        Workflow: {
          include: {
            video: true,
            media: {
              where: {
                type: "VIDEO",
                fileType: { contains: "mp4" },
              },
              select: {
                id: true,
                fileUrl: true,
                fileType: true,
                uploadedAt: true,
              },
            },
          },
        },
      },
    });

    // Flatten the workflows and return only relevant story media
    const result = stories.map((story) => ({
      id: story.id,
      title: story.title,
      createdAt: story.createdAt,
      media: story.Workflow.flatMap((wf) => wf.media || []),
      videos: story.Workflow.filter(wf => wf.video).map(wf => ({
        id: wf.video.id,
        url: wf.video.fileURL,
        video_16_9: wf.video.video_16_9,
        video_9_16: wf.video.video_9_16,
      })),
    }));

    return res.status(200).json(result);
  } catch (error) {
    logger.error("Get Stories Error:", error);
    return res.status(500).json({ error: "Failed to fetch stories" });
  }
};

// GET single Story with mp4 media only
export const getStoryById = async (req, res) => {
  try {
    const { id } = req.params;

    const story = await prisma.story.findUnique({
      where: { id },
      include: {
        Workflow: {
          include: {
            video: true,
            media: {
              where: {
                type: "VIDEO",
                fileType: { contains: "mp4" },
              },
              select: {
                id: true,
                fileUrl: true,
                fileType: true,
                uploadedAt: true,
              },
            },
          },
        },
      },
    });

    if (!story) {
      return res.status(404).json({ error: "Story not found" });
    }

    const media = story.Workflow.flatMap((wf) => wf.media || []);

    return res.status(200).json({
      id: story.id,
      title: story.title,
      createdAt: story.createdAt,
      media,
      videos: story.Workflow.filter(wf => wf.video).map(wf => ({
        id: wf.video.id,
        url: wf.video.fileURL,
        video_16_9: wf.video.video_16_9,
        video_9_16: wf.video.video_9_16,
      })),
    });
  } catch (error) {
    logger.error("Get Story Error:", error);
    return res.status(500).json({ error: "Failed to fetch story" });
  }
};

// DELETE Story (Manual Cascade for MongoDB)
export const deleteStory = async (req, res) => {
  try {
    const storyId = req.params.id;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: missing user" });
    }

    // Check story ownership and get workflows with BullMQ job reference
    const story = await prisma.story.findFirst({
      where: { id: storyId, userId },
      include: {
        Workflow: {
          select: { id: true, status: true, metadata: true },
        },
      },
    });

    if (!story) {
      return res.status(404).json({ error: "Story not found or not allowed" });
    }

    // Kill any active BullMQ jobs + mark as cancelled so the worker stops
    if (story.Workflow && story.Workflow.length > 0) {
      for (const wf of story.Workflow) {
        // Mark as CANCELLATION_REQUESTED so the in-flight worker stops at next checkpoint
        try {
          await prisma.workflow.update({
            where: { id: wf.id },
            data: { status: "CANCELLATION_REQUESTED" },
          });
        } catch (_) {} // may already be deleted

        // Also forcefully remove the BullMQ job if it's still queued/waiting
        const bullJobId = wf.bullJobId || wf.metadata?.bullJobId;
        if (bullJobId) {
          try { await cancelWorkflowJob(bullJobId); } catch (_) {}
        }
      }

      // Give the worker a moment to catch the cancellation signal
      await new Promise(r => setTimeout(r, 500));

      await prisma.workflow.deleteMany({
        where: { id: { in: story.Workflow.map((w) => w.id) } },
      });
    }

    // Now delete the story itself
    await prisma.story.delete({
      where: { id: storyId },
    });

    return res.status(200).json({
      message: "✅ Story and all related data deleted successfully",
    });
  } catch (err) {
    logger.error("❌ Error deleting story:", err);
    return res.status(500).json({
      error: err.message || "Failed to delete story and related data",
    });
  }
};

// DELETE Scheduled Story (Cancel)
export const deleteScheduledStory = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    const workflow = await prisma.workflow.findFirst({
      where: { id, userId, status: "SCHEDULED" },
    });

    if (!workflow) {
      return res.status(404).json({ error: "Scheduled story not found" });
    }

    await prisma.workflow.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    return res
      .status(200)
      .json({ message: "Scheduled story cancelled successfully" });
  } catch (error) {
    logger.error("Cancel Scheduled Story Error:", error);
    return res.status(500).json({ error: "Failed to cancel scheduled story" });
  }
};

// CANCEL a workflow (queued or actively processing)
export const cancelWorkflow = async (req, res) => {
  try {
    const { id } = req.params; // workflow DB id
    const userId = req.user?.userId;

    const workflow = await prisma.workflow.findFirst({
      where: { id, userId },
    });

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    const { status } = workflow;

    if (status === "COMPLETED" || status === "CANCELLED" || status === "FAILED") {
      return res.status(400).json({ error: `Cannot cancel a workflow with status '${status}'` });
    }

    // If it is still PENDING / waiting in BullMQ, try to remove the job directly
    if (status === "PENDING") {
      const bullJobId = workflow.metadata?.bullJobId;
      if (bullJobId) {
        await cancelWorkflowJob(bullJobId);
      }
      await prisma.workflow.update({
        where: { id },
        data: { status: "CANCELLED", metadata: { ...(workflow.metadata || {}), cancelledAt: new Date().toISOString() } },
      });
      return res.status(200).json({ message: "Queued workflow cancelled" });
    }

    // If PROCESSING, request cooperative cancellation AND immediately try to evict the BullMQ job
    const bullJobId = workflow.metadata?.bullJobId;
    if (bullJobId) {
      try { await cancelWorkflowJob(bullJobId); } catch (_) {}
    }

    await prisma.workflow.update({
      where: { id },
      data: { status: "CANCELLATION_REQUESTED" },
    });

    logger.info(`🚦 Cancellation requested for workflow ${id}`);
    return res.status(200).json({
      message: "Cancellation requested. The workflow will stop at the next checkpoint.",
      workflowId: id,
    });
  } catch (err) {
    logger.error("Cancel Workflow Error:", err);
    return res.status(500).json({ error: "Failed to cancel workflow" });
  }
};

// PATCH Update Story Cover Art
export const updateStoryCoverArt = async (req, res) => {
  try {
    const { id } = req.params;
    const { coverArtURL_1_1, coverArtURL_16_9, coverArtURL_9_16 } = req.body;
    const userId = req.user?.userId;
    const role = req.user?.role;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const whereClause = role === "CREATOR" ? { id, userId } : { id };

    const story = await prisma.story.findFirst({
      where: whereClause,
    });

    if (!story) {
      return res.status(404).json({ error: "Story not found" });
    }

    const updatedStory = await prisma.story.update({
      where: { id },
      data: {
        ...(coverArtURL_1_1 !== undefined && { coverArtURL_1_1 }),
        ...(coverArtURL_16_9 !== undefined && { coverArtURL_16_9 }),
        ...(coverArtURL_9_16 !== undefined && { coverArtURL_9_16 }),
      },
    });

    return res.status(200).json({ message: "Cover art updated successfully", story: updatedStory });
  } catch (error) {
    logger.error("Update Story Cover Art Error:", error);
    return res.status(500).json({ error: "Failed to update cover art" });
  }
};

