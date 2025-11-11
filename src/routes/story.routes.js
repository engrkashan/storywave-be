import express from "express";
import crypto from "crypto";
import { generateStory } from "../services/storyService.js";
import { runWorkflow } from "../services/workflowService.js";
import { verifyToken } from "../middlewares/auth.js";
import prisma from "../config/prisma.client.js";


const router = express.Router();

// Helper — consistent random title
function generateRandomTitle(storyType = "Story") {
  const randomId = crypto.randomBytes(3).toString("hex");
  const timestamp = Date.now();
  return `${storyType}_${randomId}_${timestamp}`;
}

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
      admin,
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
      admin,
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
 * POST /api/story/workflow
 * Full pipeline: story → DB → voiceover → images → video.
 */
router.post("/workflow", verifyToken, async (req, res) => {
  try {
    const adminId = req.user?.userId;
    const {
      title,
      url,
      videoFile,
      textIdea,
      storyType = "Story",
      voiceTone = "neutral",
      storyLength = "30 minutes",
    } = req.body;

    if (!adminId) {
      return res.status(401).json({ error: "Unauthorized: missing user" });
    }

    if (!textIdea && !url && !videoFile) {
      return res
        .status(400)
        .json({ error: "You must provide textIdea, url, or videoFile." });
    }

    const finalTitle = title || generateRandomTitle(storyType);

    const result = await runWorkflow({
      adminId,
      title: finalTitle,
      url,
      videoFile,
      textIdea,
      storyType,
      voiceTone,
      storyLength,
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error("Error running workflow:", err);
    return res.status(500).json({ error: err.message || "Workflow failed" });
  }
});

/**
 * DELETE /api/story/:id
 * Delete a story by ID (only if it belongs to the logged-in admin)
 */
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const storyId = req.params.id;
    const adminId = req.user?.userId;

    if (!adminId) {
      return res.status(401).json({ error: "Unauthorized: missing user" });
    }

    // Check if story exists and belongs to this admin
    const story = await prisma.story.findFirst({
      where: {
        id: storyId,
        adminId: adminId
      }
    });

    if (!story) {
      return res.status(404).json({ error: "Story not found or not allowed" });
    }

    // Delete the story
    await prisma.story.delete({
      where: { id: storyId }
    });

    return res.status(200).json({ message: "Story deleted successfully" });
  } catch (err) {
    console.error("Error deleting story:", err);
    return res.status(500).json({ error: err.message || "Failed to delete story" });
  }
});


export default router;
