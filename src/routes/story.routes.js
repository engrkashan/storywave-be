import express from "express";
import crypto from "crypto";
import { verifyToken } from "../middlewares/auth.js";
import prisma from "../config/prisma.client.js";
import { fork } from "child_process";
import path from "path";
import { runWorkflow } from "../services/workflowService.js";
import { deleteScheduledStory } from "../controllers/story.controller.js";
const router = express.Router();

// Helper — consistent random title
function generateRandomTitle(storyType = "Story") {
  const randomId = crypto.randomBytes(3).toString("hex");
  const timestamp = Date.now();
  return `${storyType}_${randomId}_${timestamp}`;
}

router.post("/workflow", verifyToken, async (req, res) => {
  try {
    const userId = req.user?.userId;

    const {
      title,
      url,
      videoFile,
      textIdea,
      imagePrompt,
      storyType = "Story",
      voiceTone = "neutral",
      storyLength = "30 minutes",
      shouldGenerateImage,
      scheduledAt,
      voice,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: missing user" });
    }

    if (!textIdea && !url && !videoFile) {
      return res
        .status(400)
        .json({ error: "You must provide textIdea, url, or videoFile." });
    }

    const finalTitle = title || generateRandomTitle(storyType);

    // 👉 Build the payload for worker process
    const workflowPayload = {
      userId,
      title: finalTitle,
      url,
      videoFile,
      textIdea,
      imagePrompt,
      storyType,
      voice,
      shouldGenerateImage,
      voiceTone,
      storyLength,
      scheduledAt,
    };

    // 👉 PATH to worker file
    const workerPath = path.resolve("src/workers/workflow.worker.js");

    // 👉 Start worker
    const worker = fork(workerPath);

    // Send data to worker
    worker.send(workflowPayload);

    // Optional: log worker results (not sent to frontend)
    worker.on("message", (msg) => {
      if (msg.status === "success") {
        console.log("Workflow finished:", msg.result);
      } else {
        console.error("Workflow worker error:", msg.error);
      }
    });

    // Immediate response
    return res.status(200).json({
      message: "Workflow started in background",
      title: finalTitle,
      status: "processing",
    });
  } catch (err) {
    console.error("Error running workflow:", err);
    return res.status(500).json({ error: err.message || "Workflow failed" });
  }
});

/**
 * POST /api/story
 * Generate story only (no workflow, no TTS).
 */
router.post("/", async (req, res) => {
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
    console.error("Error generating story:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to generate story" });
  }
});

/**
 * GET /api/story/scheduled
 * Returns only stories that are scheduled (status = SCHEDULED)
 */
router.get("/scheduled", verifyToken, async (req, res) => {
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
    console.error("Error fetching scheduled stories:", err);
    return res.status(500).json({ error: "Failed to fetch scheduled stories" });
  }
});

/**
 * DELETE /api/story/scheduled/:id
 * Cancel a scheduled story
 */
router.delete("/scheduled/:id", verifyToken, deleteScheduledStory);

/**
 * DELETE /api/story/:id
 * Delete a story by ID (only if it belongs to the logged-in admin)
 */
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const storyId = req.params.id;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: missing user" });
    }

    // 1️⃣ Check story ownership + fetch all related data
    const story = await prisma.story.findFirst({
      where: { id: storyId, userId },
      include: {
        Workflow: {
          include: {
            inputs: true,
            tasks: true,
            media: true,
            voiceover: true,
            video: true,
            podcast: {
              include: { episodes: true },
            },
          },
        },
      },
    });

    if (!story) {
      return res.status(404).json({ error: "Story not found or not allowed" });
    }

    // 2️⃣ Transactional deletion
    await prisma.$transaction(async (tx) => {
      for (const workflow of story.Workflow) {
        const wid = workflow.id;

        // Delete all related sub-entities
        await tx.task.deleteMany({ where: { workflowId: wid } });
        await tx.input.deleteMany({ where: { workflowId: wid } });
        await tx.media.deleteMany({ where: { workflowId: wid } });

        // Delete voiceover if exists
        if (workflow.voiceover) {
          await tx.voiceover.delete({
            where: { id: workflow.voiceover.id },
          });
        }

        // Delete video if exists
        if (workflow.video) {
          await tx.video.delete({
            where: { id: workflow.video.id },
          });
        }

        // Delete podcast + episodes if exist
        if (workflow.podcast) {
          await tx.episode.deleteMany({
            where: { podcastId: workflow.podcast.id },
          });
          await tx.podcast.delete({
            where: { id: workflow.podcast.id },
          });
        }

        // Delete workflow itself
        await tx.workflow.delete({
          where: { id: wid },
        });
      }

      // Finally delete the story itself
      await tx.story.delete({
        where: { id: storyId },
      });
    });

    return res.status(200).json({
      message: "✅ Story and all related data deleted successfully",
    });
  } catch (err) {
    console.error("❌ Error deleting story transactionally:", err);
    return res.status(500).json({
      error: err.message || "Failed to delete story and related data",
    });
  }
});

export default router;
