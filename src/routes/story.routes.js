import express from "express";
import { verifyToken } from "../middlewares/auth.js";
import {
  createWorkflow,
  createStory,
  getStories,
  getStoryById,
  deleteStory,
  getScheduledStories,
  deleteScheduledStory,
  cancelWorkflow,
  updateStoryCoverArt,
} from "../controllers/story.controller.js";

const router = express.Router();

/**
 * POST /api/story/workflow
 * Start a new workflow (background process)
 */
router.post("/workflow", verifyToken, createWorkflow);
router.delete("/workflow/:id", verifyToken, cancelWorkflow); // Cancel queued or processing workflow
router.post("/", verifyToken, createStory);
router.get("/", verifyToken, getStories);
router.get("/scheduled", verifyToken, getScheduledStories);
router.delete("/scheduled/:id", verifyToken, deleteScheduledStory)
router.get("/:id", verifyToken, getStoryById);
router.patch("/:id/cover-art", verifyToken, updateStoryCoverArt);
router.delete("/:id", verifyToken, deleteStory);

export default router;
