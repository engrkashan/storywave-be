/**
 * editor.routes.js
 * Storywave Editor Routes
 */

import express from "express";
import { verifyToken } from "../middlewares/auth.js";
import {
  listEditorWorkflows,
  getEditorWorkflow,
  updatePrompt,
  regenerateSceneHandler,
  revertVersionHandler,
  checkMergeEligibilityHandler,
  mergeWorkflowHandler,
} from "../controllers/editor.controller.js";

const router = express.Router();

// List stories in review state
router.get("/workflows", verifyToken, listEditorWorkflows);

// Get single workflow + scenes for review
router.get("/workflows/:workflowId", verifyToken, getEditorWorkflow);

// Update prompt for a scene
router.patch("/workflows/:workflowId/scenes/:sceneId/prompt", verifyToken, updatePrompt);

// Regenerate single scene
router.post("/workflows/:workflowId/scenes/:sceneId/regenerate", verifyToken, regenerateSceneHandler);

// Revert scene to previous version
router.post("/workflows/:workflowId/scenes/:sceneId/revert/:version", verifyToken, revertVersionHandler);

// Check if ready to merge
router.get("/workflows/:workflowId/merge/eligibility", verifyToken, checkMergeEligibilityHandler);

// Trigger merge & continue
router.post("/workflows/:workflowId/merge", verifyToken, mergeWorkflowHandler);

export default router;
