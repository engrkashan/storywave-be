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
} from "../controllers/story.controller.js";

const router = express.Router();

/**
 * POST /api/story/workflow
 * Start a new workflow (background process)
 */
router.post("/workflow", verifyToken, createWorkflow);

/**
 * POST /api/story
 * Generate story outline & script only (no workflow)
 */
router.post("/", verifyToken, createStory);

/**
 * GET /api/story
 * Get all stories
 */
router.get("/", verifyToken, getStories);

/**
 * GET /api/story/scheduled
 * Get scheduled stories
 */
router.get("/scheduled", verifyToken, getScheduledStories);

/**
 * DELETE /api/story/scheduled/:id
 * Cancel a scheduled story
 */
router.delete("/scheduled/:id", verifyToken, deleteScheduledStory);

/**
 * GET /api/story/:id
 * Get single story details
 */
router.get("/:id", verifyToken, getStoryById);

/**
 * DELETE /api/story/:id
 * Delete a story
 */
router.delete("/:id", verifyToken, deleteStory);

export default router;
