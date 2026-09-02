/**
 * editor.controller.js
 * Storywave Editor Controller
 */

import {
  getEditorWorkflows,
  getEditorWorkflowDetail,
  streamEditorWorkflowDetail,
  updateScenePrompt,
  revertSceneVersion,
  requestSceneRegen,
  replaceSceneFrame,
  uploadCharacterReferenceAsset,
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

    // Check if client requested SSE stream
    if (req.query.stream === "true" || req.headers.accept?.includes("text/event-stream")) {
      return streamEditorWorkflow(req, res);
    }

    const data = await getEditorWorkflowDetail({ workflowId, userId, role });
    return res.status(200).json({ success: true, data });
  } catch (err) {
    logger.error(`getEditorWorkflow error: ${err.message}`);
    const status = err.message.includes("unauthorized") ? 403 : 500;
    return res.status(status).json({ success: false, error: err.message });
  }
}

export async function streamEditorWorkflow(req, res) {
  try {
    const { userId, role } = extractUser(req);
    const { workflowId } = req.params;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (res.flushHeaders) res.flushHeaders();

    await streamEditorWorkflowDetail({
      workflowId,
      userId,
      role,
      onHeader: (headerData) => {
        res.write(`event: workflow\ndata: ${JSON.stringify(headerData)}\n\n`);
      },
      onScenesChunk: (chunk) => {
        res.write(`event: scenes\ndata: ${JSON.stringify(chunk)}\n\n`);
      },
      onComplete: () => {
        res.write(`event: done\ndata: {}\n\n`);
        res.end();
      },
    });
  } catch (err) {
    logger.error(`streamEditorWorkflow error: ${err.message}`);
    if (!res.headersSent) {
      const status = err.message.includes("unauthorized") ? 403 : 500;
      return res.status(status).json({ success: false, error: err.message });
    }
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
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

export async function replaceFrameHandler(req, res) {
  try {
    const { userId } = extractUser(req);
    const { workflowId, sceneId } = req.params;
    const { imageUrl, imageBase64 } = req.body;
    const file = req.file;

    const result = await replaceSceneFrame({
      workflowId,
      sceneId,
      file,
      imageUrl,
      imageBase64,
      userId,
    });

    return res.status(200).json({
      success: true,
      message: "Scene frame replaced successfully",
      data: result,
    });
  } catch (err) {
    logger.error(`replaceFrameHandler error: ${err.message}`);
    return res.status(400).json({ success: false, error: err.message });
  }
}

export async function uploadRefHandler(req, res) {
  try {
    const { userId } = extractUser(req);
    const { workflowId, sceneId } = req.params;
    const { imageUrl, imageBase64, name } = req.body;
    const file = req.file;

    const result = await uploadCharacterReferenceAsset({
      workflowId,
      sceneId,
      file,
      imageUrl,
      imageBase64,
      name,
      userId,
    });

    return res.status(200).json({
      success: true,
      message: "Character reference uploaded successfully",
      data: result,
    });
  } catch (err) {
    logger.error(`uploadRefHandler error: ${err.message}`);
    return res.status(400).json({ success: false, error: err.message });
  }
}

export async function regenerateSceneHandler(req, res) {
  try {
    const { userId } = extractUser(req);
    const { workflowId, sceneId } = req.params;
    const { prompt, characterReference, generateAsVideo, mediaType } = req.body;

    const shouldGenerateAsVideo = Boolean(generateAsVideo) || mediaType === "video";

    const result = await requestSceneRegen({
      workflowId,
      sceneId,
      prompt,
      characterReference,
      generateAsVideo: shouldGenerateAsVideo,
      userId,
    });

    return res.status(200).json({
      success: true,
      message: shouldGenerateAsVideo
        ? "Veo 3 video scene generation queued"
        : "Scene regeneration job queued",
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

