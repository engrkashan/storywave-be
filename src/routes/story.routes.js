import express from "express";
import { generateStory } from "../services/storyService.js";

const router = express.Router();

/**
 * POST /api/story
 * Generate story only (no workflow, no TTS).
 */
router.post("/", async (req, res) => {
  try {
    const { textIdea, url, videoFile, storyType, voiceTone, storyLength } = req.body;

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
    });

    res.json({ outline, script });
  } catch (err) {
    console.error("Error generating story:", err);
    res.status(500).json({ error: "Failed to generate story" });
  }
});

export default router;
