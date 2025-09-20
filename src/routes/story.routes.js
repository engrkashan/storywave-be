import express from "express";
import { generateStory } from "../services/storyService.js";
import { runWorkflow } from "../services/workflowService.js";
import crypto from "crypto";

const router = express.Router();

// Helper to generate random title
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
    const { textIdea, url, videoFile, storyType, voiceTone, storyLength, admin } = req.body;

    if (!textIdea && !url && !videoFile) {
      return res.status(400).json({ error: "You must provide textIdea, url, or videoFile." });
    }

    const { outline, script } = await generateStory({
      textIdea,
      url,
      videoFile,
      storyType,
      voiceTone,
      storyLength,
      admin
    });

    res.json({ outline, script });
  } catch (err) {
    console.error("Error generating story:", err);
    res.status(500).json({ error: "Failed to generate story" });
  }
});

/**
 * POST /api/story/workflow
 * Full pipeline: generate story → save DB → voiceover → save → video.
 */
router.post("/workflow", async (req, res) => {
  try {
    const { adminId, title, url, videoFile, textIdea, storyType } = req.body;

    if (!textIdea && !url && !videoFile) {
      return res.status(400).json({ error: "You must provide textIdea, url, or videoFile." });
    }

    // Generate title if not provided
    const finalTitle = title || generateRandomTitle(storyType);

    const result = await runWorkflow({
      adminId,
      title: finalTitle,
      url,
      videoFile,
      textIdea
    });

    res.json(result);
  } catch (err) {
    console.error("Error running workflow:", err);
    res.status(500).json({ error: "Failed to run workflow" });
  }
});

export default router;
