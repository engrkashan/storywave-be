/**
 * editorService.js
 * Storywave Editor: Core business logic for Storywave Editor APIs.
 */

import prisma from "../config/prisma.client.js";
import { addSceneRegenJob, addMergeJob } from "./queueService.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("EditorService");

/**
 * List workflows awaiting review (USER_CONFIRMATION_REQUIRED).
 */
export async function getEditorWorkflows({ userId, role, page = 1, limit = 20 }) {
  const parsedLimit = parseInt(limit, 10) || 20;
  const parsedPage = Math.max(1, parseInt(page, 10) || 1);
  const skip = (parsedPage - 1) * parsedLimit;

  const where = {
    status: "USER_CONFIRMATION_REQUIRED",
    ...(role === "CREATOR" && userId ? { userId } : userId ? { userId } : {}),
  };

  const [total, workflows] = await Promise.all([
    prisma.workflow.count({ where }),
    prisma.workflow.findMany({
      where,
      skip,
      take: parsedLimit,
      orderBy: { updatedAt: "desc" },
      include: {
        story: {
          select: {
            id: true,
            title: true,
            coverArtURL: true,
            coverArtURL_16_9: true,
            coverArtURL_9_16: true,
          },
        },
        scenes: {
          select: {
            id: true,
            index: true,
            status: true,
            ratio: true,
            assetUrl: true,
            assetType: true,
          },
          orderBy: { index: "asc" },
        },
      },
    }),
  ]);

  const items = workflows.map((wf) => {
    const meta = wf.metadata || {};
    // Scene count: deduplicate indices
    const uniqueIndices = new Set(wf.scenes.map((s) => s.index));
    return {
      id: wf.id,
      title: wf.title,
      status: wf.status,
      type: wf.type,
      mediaType: meta.mediaType || "multi_image",
      aspectRatio: meta.aspectRatio || "16:9",
      dualPlatform: meta.dualPlatform ?? false,
      sceneCount: uniqueIndices.size,
      coverArtUrl: wf.story?.coverArtURL || wf.story?.coverArtURL_16_9 || wf.story?.coverArtURL_9_16 || null,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
      firstSceneAsset: wf.scenes?.[0]?.assetUrl || null,
    };
  });

  return {
    items,
    total,
    page: Number(page),
    limit: Number(limit),
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get full detail of a workflow and its scenes for the Editor.
 */
export async function getEditorWorkflowDetail({ workflowId, userId, role }) {
  const where = role === "CREATOR" && userId
    ? { id: workflowId, userId }
    : userId
    ? { id: workflowId, userId }
    : { id: workflowId };

  const workflow = await prisma.workflow.findFirst({
    where,
    include: {
      story: true,
      scenes: {
        include: {
          versions: {
            orderBy: { version: "desc" },
          },
        },
        orderBy: [{ index: "asc" }, { ratio: "asc" }],
      },
    },
  });

  if (!workflow) {
    throw new Error("Workflow not found or unauthorized");
  }

  const meta = workflow.metadata || {};

  return {
    id: workflow.id,
    title: workflow.title,
    status: workflow.status,
    storyId: workflow.storyId,
    storyTitle: workflow.story?.title || workflow.title,
    script: workflow.story?.content || "",
    isPodcast: workflow.story?.isPodcast ?? false,
    audioUrl: workflow.story?.audioURL || meta._editorFinalAudioUrl || null,
    mediaType: meta.mediaType || "multi_image",
    aspectRatio: meta.aspectRatio || "16:9",
    dualPlatform: meta.dualPlatform ?? false,
    characterTalk: meta._editorCharacterTalk ?? meta.characterTalk ?? false,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    scenes: workflow.scenes.map((s) => ({
      id: s.id,
      workflowId: s.workflowId,
      index: s.index,
      ratio: s.ratio,
      status: s.status,
      startSec: s.startSec,
      endSec: s.endSec,
      durationSec: s.durationSec,
      narration: s.narration,
      mediaType: s.mediaType,
      originalPrompt: s.originalPrompt,
      activePrompt: s.activePrompt,
      userEditedPrompt: s.userEditedPrompt,
      activeVersion: s.activeVersion,
      generationAttempts: s.generationAttempts,
      assetUrl: s.assetUrl,
      assetPublicId: s.assetPublicId,
      assetType: s.assetType,
      charactersInScene: s.charactersInScene || [],
      versions: s.versions.map((v) => ({
        id: v.id,
        version: v.version,
        prompt: v.prompt,
        assetUrl: v.assetUrl,
        assetType: v.assetType,
        ratio: v.ratio,
        createdAt: v.createdAt,
      })),
    })),
  };
}

/**
 * Update prompt for a scene.
 */
export async function updateScenePrompt({ workflowId, sceneId, prompt, userId }) {
  const scene = await prisma.scene.findFirst({
    where: { id: sceneId, workflowId },
    include: { workflow: true },
  });

  if (!scene || scene.workflow.userId !== userId) {
    throw new Error("Scene not found or unauthorized");
  }

  if (scene.workflow.status !== "USER_CONFIRMATION_REQUIRED") {
    throw new Error("Workflow is not currently in review state");
  }

  // Update this scene and its paired dual ratio scene if applicable
  const meta = scene.workflow.metadata || {};
  const dualPlatform = meta.dualPlatform ?? false;

  const scenesToUpdate = dualPlatform
    ? await prisma.scene.findMany({ where: { workflowId, index: scene.index } })
    : [scene];

  for (const sc of scenesToUpdate) {
    await prisma.scene.update({
      where: { id: sc.id },
      data: {
        userEditedPrompt: prompt?.trim() || null,
        activePrompt: prompt?.trim() || sc.originalPrompt,
      },
    });
  }

  logger.info(`EDITOR_SCENE_PROMPT_UPDATED workflowId=${workflowId} sceneId=${sceneId}`);
  return { success: true, updatedCount: scenesToUpdate.length };
}

/**
 * Revert a scene to a previous version without AI generation.
 */
export async function revertSceneVersion({ workflowId, sceneId, version, userId }) {
  const scene = await prisma.scene.findFirst({
    where: { id: sceneId, workflowId },
    include: { workflow: true, versions: true },
  });

  if (!scene || scene.workflow.userId !== userId) {
    throw new Error("Scene not found or unauthorized");
  }

  const targetVersionNumber = Number(version);
  const targetVersionRecord = scene.versions.find((v) => v.version === targetVersionNumber);

  if (!targetVersionRecord) {
    throw new Error(`Version ${targetVersionNumber} not found for scene ${sceneId}`);
  }

  await prisma.scene.update({
    where: { id: sceneId },
    data: {
      activeVersion: targetVersionNumber,
      assetUrl: targetVersionRecord.assetUrl,
      assetPublicId: targetVersionRecord.assetPublicId,
      assetType: targetVersionRecord.assetType,
      activePrompt: targetVersionRecord.prompt,
      status: "GENERATED",
    },
  });

  logger.info(`EDITOR_SCENE_REVERTED workflowId=${workflowId} sceneId=${sceneId} targetVersion=${targetVersionNumber}`);

  return {
    success: true,
    sceneId,
    activeVersion: targetVersionNumber,
    assetUrl: targetVersionRecord.assetUrl,
  };
}

/**
 * Dispatch scene regeneration job.
 */
export async function requestSceneRegen({ workflowId, sceneId, userId }) {
  const scene = await prisma.scene.findFirst({
    where: { id: sceneId, workflowId },
    include: { workflow: true },
  });

  if (!scene || scene.workflow.userId !== userId) {
    throw new Error("Scene not found or unauthorized");
  }

  if (scene.workflow.status !== "USER_CONFIRMATION_REQUIRED") {
    throw new Error("Workflow is not currently in review state");
  }

  if (scene.status === "REGENERATING") {
    throw new Error("Scene is already regenerating");
  }

  // Add BullMQ job
  const job = await addSceneRegenJob({ workflowId, sceneId });

  // Update scene status to REGENERATING
  await prisma.scene.update({
    where: { id: sceneId },
    data: { status: "REGENERATING" },
  });

  return { success: true, jobId: job.id, sceneId };
}

/**
 * Validate if a workflow is ready to merge.
 */
export async function validateMergeEligibility({ workflowId, userId }) {
  const workflow = await prisma.workflow.findFirst({
    where: { id: workflowId, userId },
    include: { scenes: true },
  });

  if (!workflow) {
    return { eligible: false, reason: "Workflow not found or unauthorized" };
  }

  if (workflow.status !== "USER_CONFIRMATION_REQUIRED") {
    return { eligible: false, reason: `Workflow status is '${workflow.status}', expected 'USER_CONFIRMATION_REQUIRED'` };
  }

  if (!workflow.scenes || workflow.scenes.length === 0) {
    return { eligible: false, reason: "No scenes found for workflow" };
  }

  const regenerating = workflow.scenes.filter((s) => s.status === "REGENERATING");
  if (regenerating.length > 0) {
    return { eligible: false, reason: `${regenerating.length} scene(s) are currently regenerating` };
  }

  const unready = workflow.scenes.filter((s) => s.status !== "GENERATED");
  if (unready.length > 0) {
    return { eligible: false, reason: `${unready.length} scene(s) do not have valid generated assets` };
  }

  const missingAssets = workflow.scenes.filter((s) => !s.assetUrl);
  if (missingAssets.length > 0) {
    return { eligible: false, reason: `${missingAssets.length} scene(s) have missing asset URLs` };
  }

  return { eligible: true };
}

/**
 * Dispatch merge & continue job.
 */
export async function requestWorkflowMerge({ workflowId, userId }) {
  const check = await validateMergeEligibility({ workflowId, userId });
  if (!check.eligible) {
    throw new Error(`Cannot merge: ${check.reason}`);
  }

  const job = await addMergeJob({ workflowId });
  return { success: true, jobId: job.id, workflowId };
}
