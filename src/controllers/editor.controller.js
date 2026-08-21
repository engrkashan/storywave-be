/**
 * editor.controller.js
 * Storywave Editor Controller
 */

import {
  getEditorWorkflows,
  getEditorWorkflowDetail,
  updateScenePrompt,
  revertSceneVersion,
  requestSceneRegen,
  validateMergeEligibility,
  requestWorkflowMerge,
} from "../services/editorService.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("EditorController");

function extractUser(req) {
  return {
    userId: req.user?.userId || req.user?.id || req.user?._id,
    role: req.user?.role,
  };
}

export async function listEditorWorkflows(req, res) {
  try {
    const { userId, role } = extractUser(req);
    const { page = 1, limit = 20 } = req.query;
    const result = await getEditorWorkflows({ userId, role, page, limit });
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    logger.error(`listEditorWorkflows error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function getEditorWorkflow(req, res) {
  try {
    const { userId, role } = extractUser(req);
    const { workflowId } = req.params;
    const data = await getEditorWorkflowDetail({ workflowId, userId, role });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    logger.error(`getEditorWorkflow error: ${err.message}`);
    const status = err.message.includes("unauthorized") ? 403 : 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

export async function updatePrompt(req, res) {
  try {
    const { userId } = extractUser(req);
    const { workflowId, sceneId } = req.params;
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ success: false, error: "Prompt string is required" });
    }

    const result = await updateScenePrompt({ workflowId, sceneId, prompt, userId });
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    logger.error(`updatePrompt error: ${err.message}`);
    return res.status(400).json({ success: false, error: err.message });
  }
}

export async function regenerateSceneHandler(req, res) {
  try {
    const { userId } = extractUser(req);
    const { workflowId, sceneId } = req.params;

    const result = await requestSceneRegen({ workflowId, sceneId, userId });
    return res.status(200).json({
      success: true,
      message: "Scene regeneration job queued",
      data: result,
    });
  } catch (err) {
    logger.error(`regenerateSceneHandler error: ${err.message}`);
    return res.status(400).json({ success: false, error: err.message });
  }
}

export async function revertVersionHandler(req, res) {
  try {
    const { userId } = extractUser(req);
    const { workflowId, sceneId, version } = req.params;

    const result = await revertSceneVersion({
      workflowId,
      sceneId,
      version: Number(version),
      userId,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    logger.error(`revertVersionHandler error: ${err.message}`);
    return res.status(400).json({ success: false, error: err.message });
  }
}

export async function checkMergeEligibilityHandler(req, res) {
  try {
    const { userId } = extractUser(req);
    const { workflowId } = req.params;

    const result = await validateMergeEligibility({ workflowId, userId });
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    logger.error(`checkMergeEligibilityHandler error: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function mergeWorkflowHandler(req, res) {
  try {
    const { userId } = extractUser(req);
    const { workflowId } = req.params;

    const result = await requestWorkflowMerge({ workflowId, userId });
    return res.status(200).json({
      success: true,
      message: "Merge & final assembly job queued",
      data: result,
    });
  } catch (err) {
    logger.error(`mergeWorkflowHandler error: ${err.message}`);
    return res.status(400).json({ success: false, error: err.message });
  }
}

