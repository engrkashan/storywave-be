/**
 * editor.routes.js
 * Storywave Editor Routes
 */

import express from "express";
import { verifyToken } from "../middlewares/auth.js";
import { mediaUpload } from "../utils/upload.mw.js";
import {
  listEditorWorkflows,
  getEditorWorkflow,
  streamEditorWorkflow,
  updatePrompt,
  regenerateSceneHandler,
  revertVersionHandler,
  replaceFrameHandler,
  uploadRefHandler,
  checkMergeEligibilityHandler,
  mergeWorkflowHandler,
} from "../controllers/editor.controller.js";

const router = express.Router();

// List stories in review state
router.get("/workflows", verifyToken, listEditorWorkflows);

// Stream single workflow + scenes for review (progressive SSE)
router.get("/workflows/:workflowId/stream", verifyToken, streamEditorWorkflow);

// Get single workflow + scenes for review (standard JSON or ?stream=true)
router.get("/workflows/:workflowId", verifyToken, getEditorWorkflow);

// Update prompt for a scene
router.patch("/workflows/:workflowId/scenes/:sceneId/prompt", verifyToken, updatePrompt);

// Regenerate single scene (Image or Veo 3 Video, with optional custom char ref)
router.post("/workflows/:workflowId/scenes/:sceneId/regenerate", verifyToken, regenerateSceneHandler);

// Directly replace scene frame with uploaded custom image
router.post("/workflows/:workflowId/scenes/:sceneId/replace-frame", verifyToken, mediaUpload.single("image"), replaceFrameHandler);

// Upload character reference image for scene regeneration
router.post("/workflows/:workflowId/scenes/:sceneId/upload-ref", verifyToken, mediaUpload.single("image"), uploadRefHandler);

// Revert scene to previous version
router.post("/workflows/:workflowId/scenes/:sceneId/revert/:version", verifyToken, revertVersionHandler);

// Check if ready to merge
router.get("/workflows/:workflowId/merge/eligibility", verifyToken, checkMergeEligibilityHandler);

// Trigger merge & continue
router.post("/workflows/:workflowId/merge", verifyToken, mergeWorkflowHandler);

export default router;
