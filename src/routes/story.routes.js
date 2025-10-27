import express from "express";
import crypto from "crypto";
import { generateStory } from "../services/storyService.js";
import { runWorkflow } from "../services/workflowService.js";
import { verifyToken } from "../middlewares/auth.js";

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

export default router;
