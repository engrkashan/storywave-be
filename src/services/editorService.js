/**
 * editorService.js
 * Storywave Editor: Core business logic for Storywave Editor APIs.
 */

import prisma from "../config/prisma.client.js";
import { cloudinary } from "../config/cloudinary.config.js";
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

  // ADMIN sees all USER_CONFIRMATION_REQUIRED workflows; CREATOR sees only their own.
  const where = {
    status: "USER_CONFIRMATION_REQUIRED",
    ...(role !== "ADMIN" && userId ? { userId } : {}),
  };

  // ── Phase 1: List + count (no metadata, no scene documents) ──────────────────
  // _count.scenes counts rows in the Scene collection via a fast index lookup
  // (@@index([workflowId, index])) without loading any scene document bodies.
  // This avoids loading 100s of Scene docs that contain large MGE JSON blobs
  // (compiledState, directorDecision, selectedRefs) which caused the 46s timeout.
  const [total, workflows] = await Promise.all([
    prisma.workflow.count({ where }),
    prisma.workflow.findMany({
      where,
      skip,
      take: parsedLimit,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        status: true,
        type: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { scenes: true } }, // scene count — no doc I/O
        story: {
          select: {
            coverArtURL: true,
            coverArtURL_16_9: true,
            coverArtURL_9_16: true,
          },
        },
      },
    }),
  ]);

  if (workflows.length === 0) {
    return { items: [], total, page: parsedPage, limit: parsedLimit, totalPages: 0 };
  }

  const workflowIds = workflows.map((w) => w.id);

  // ── Phase 2: targeted metadata projection + first-scene thumbnail (parallel) ──
  // CRITICAL: metadata: true would transfer the full 2-5MB blob (masterPrompts for
  // 170 scenes, soundscapePlan, finalAudit, characterBible, etc.) just to read 3 fields.
  // $runCommandRaw with dot-notation projection evaluates server-side on Atlas —
  // only ~100 bytes transferred instead of the full document.
  const [metaCommand, firstScenes] = await Promise.all([
    prisma.$runCommandRaw({
      find: "Workflow",
      filter: {
        _id: { $in: workflowIds.map((id) => ({ $oid: id })) },
      },
      projection: {
        "metadata.mediaType": 1,
        "metadata.aspectRatio": 1,
        "metadata.dualPlatform": 1,
      },
    }),
    // index=0 = first visual moment. 1 doc per workflow (2 for dual-platform). Tiny I/O.
    prisma.scene.findMany({
      where: { workflowId: { in: workflowIds }, index: 0 },
      select: { workflowId: true, assetUrl: true, ratio: true },
      orderBy: { workflowId: "asc" },
    }),
  ]);

  // Build O(1) lookup maps
  // $runCommandRaw returns ObjectId as { $oid: "hexstring" }
  const metaById = {};
  for (const doc of metaCommand?.cursor?.firstBatch ?? []) {
    const id = doc._id?.$oid ?? String(doc._id);
    metaById[id] = doc.metadata || {};
  }

  const firstSceneByWorkflow = {};
  for (const s of firstScenes) {
    // Prefer 16:9 thumbnail; only store first occurrence per workflow
    if (!firstSceneByWorkflow[s.workflowId] || s.ratio === "16:9") {
      firstSceneByWorkflow[s.workflowId] = s.assetUrl;
    }
  }


  const items = workflows.map((wf) => {
    const meta = metaById[wf.id] || {};
    const dualPlatform = meta.dualPlatform ?? false;
    // _count.scenes = total scene rows. For dual-platform each visual index
    // produces 2 Scene records (16:9 + 9:16), so divide to get visual scene count.
    const rawCount = wf._count.scenes;
    const sceneCount = dualPlatform ? Math.ceil(rawCount / 2) : rawCount;

    return {
      id: wf.id,
      title: wf.title,
      status: wf.status,
      type: wf.type,
      mediaType: meta.mediaType || "multi_image",
      aspectRatio: meta.aspectRatio || "16:9",
      dualPlatform,
      sceneCount,
      coverArtUrl:
        wf.story?.coverArtURL_16_9 ||
        wf.story?.coverArtURL_9_16 ||
        wf.story?.coverArtURL ||
        null,
      createdAt: wf.createdAt,
      updatedAt: wf.updatedAt,
      firstSceneAsset: firstSceneByWorkflow[wf.id] || null,
    };
  });

  return {
    items,
    total,
    page: parsedPage,
    limit: parsedLimit,
    totalPages: Math.ceil(total / parsedLimit),
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

  const ALLOWED_EDIT_STATUSES = ["USER_CONFIRMATION_REQUIRED", "COMPLETED", "FAILED"];
  if (!ALLOWED_EDIT_STATUSES.includes(scene.workflow.status)) {
    throw new Error(`Workflow is in '${scene.workflow.status}' state — editing not permitted while actively processing`);
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
 * Directly replace a scene frame with a custom uploaded image.
 * Creates a new SceneVersion record and sets status to GENERATED.
 */
export async function replaceSceneFrame({ workflowId, sceneId, file, imageUrl, imageBase64, userId }) {
  const scene = await prisma.scene.findFirst({
    where: { id: sceneId, workflowId },
    include: { workflow: true, versions: true },
  });

  if (!scene || scene.workflow.userId !== userId) {
    throw new Error("Scene not found or unauthorized");
  }

  const ALLOWED_EDIT_STATUSES = ["USER_CONFIRMATION_REQUIRED", "COMPLETED", "FAILED"];
  if (!ALLOWED_EDIT_STATUSES.includes(scene.workflow.status)) {
    throw new Error(`Workflow is in '${scene.workflow.status}' state — frame replacement not permitted while actively processing`);
  }

  let finalImageUrl = imageUrl;
  let finalPublicId = null;

  // 1. If file uploaded via Multer Cloudinary storage
  if (file && (file.path || file.secure_url)) {
    finalImageUrl = file.path || file.secure_url;
    finalPublicId = file.filename || file.public_id || null;
  } else if (file && file.buffer) {
    // In-memory buffer upload
    const base64Data = `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`;
    const uploadRes = await cloudinary.uploader.upload(base64Data, {
      folder: `scenes/${workflowId}/scene_${String(scene.index).padStart(3, "0")}`,
      resource_type: "image",
      overwrite: true,
    });
    finalImageUrl = uploadRes.secure_url;
    finalPublicId = uploadRes.public_id;
  } else if (imageBase64) {
    // Base64 direct upload
    const uploadRes = await cloudinary.uploader.upload(imageBase64, {
      folder: `scenes/${workflowId}/scene_${String(scene.index).padStart(3, "0")}`,
      resource_type: "image",
      overwrite: true,
    });
    finalImageUrl = uploadRes.secure_url;
    finalPublicId = uploadRes.public_id;
  } else if (imageUrl && !imageUrl.includes("res.cloudinary.com")) {
    // Remote non-cloudinary URL -> mirror to Cloudinary
    const uploadRes = await cloudinary.uploader.upload(imageUrl, {
      folder: `scenes/${workflowId}/scene_${String(scene.index).padStart(3, "0")}`,
      resource_type: "image",
      overwrite: true,
    });
    finalImageUrl = uploadRes.secure_url;
    finalPublicId = uploadRes.public_id;
  }

  if (!finalImageUrl) {
    throw new Error("No valid image file or URL provided for frame replacement");
  }

  const nextVersion = (scene.activeVersion || 1) + 1;

  // Create new SceneVersion
  const newVersionRecord = await prisma.sceneVersion.create({
    data: {
      sceneId: scene.id,
      version: nextVersion,
      assetUrl: finalImageUrl,
      assetPublicId: finalPublicId,
      assetType: "image",
      prompt: scene.activePrompt || scene.originalPrompt || "Manual frame replacement",
      ratio: scene.ratio,
      generationType: "user_upload",
      metadata: {
        source: "user_upload",
        originalFilename: file?.originalname || null,
        durationSec: scene.durationSec,
        startSec: scene.startSec,
        endSec: scene.endSec,
      },
    },
  });

  // Atomically update Scene record
  const updatedScene = await prisma.scene.update({
    where: { id: scene.id },
    data: {
      activeVersion: nextVersion,
      assetUrl: finalImageUrl,
      assetPublicId: finalPublicId,
      assetType: "image",
      mediaType: "multi_image",
      status: "GENERATED",
    },
  });

  logger.info(`EDITOR_SCENE_FRAME_REPLACED workflowId=${workflowId} sceneId=${sceneId} version=${nextVersion} url=${finalImageUrl}`);

  return {
    success: true,
    sceneId,
    activeVersion: nextVersion,
    assetUrl: finalImageUrl,
    assetPublicId: finalPublicId,
    assetType: "image",
    version: newVersionRecord,
  };
}

/**
 * Upload a character reference image to Cloudinary.
 */
export async function uploadCharacterReferenceAsset({ workflowId, sceneId, file, imageBase64, imageUrl, name, userId }) {
  const scene = await prisma.scene.findFirst({
    where: { id: sceneId, workflowId },
    include: { workflow: true },
  });

  if (!scene || scene.workflow.userId !== userId) {
    throw new Error("Scene not found or unauthorized");
  }

  let finalUrl = imageUrl;
  let finalPublicId = null;

  if (file && (file.path || file.secure_url)) {
    finalUrl = file.path || file.secure_url;
    finalPublicId = file.filename || file.public_id || null;
  } else if (file && file.buffer) {
    const base64Data = `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`;
    const uploadRes = await cloudinary.uploader.upload(base64Data, {
      folder: `characters/${workflowId}`,
      resource_type: "image",
    });
    finalUrl = uploadRes.secure_url;
    finalPublicId = uploadRes.public_id;
  } else if (imageBase64) {
    const uploadRes = await cloudinary.uploader.upload(imageBase64, {
      folder: `characters/${workflowId}`,
      resource_type: "image",
    });
    finalUrl = uploadRes.secure_url;
    finalPublicId = uploadRes.public_id;
  } else if (imageUrl) {
    const uploadRes = await cloudinary.uploader.upload(imageUrl, {
      folder: `characters/${workflowId}`,
      resource_type: "image",
    });
    finalUrl = uploadRes.secure_url;
    finalPublicId = uploadRes.public_id;
  }

  if (!finalUrl) {
    throw new Error("No valid character image provided");
  }

  const charRef = {
    id: `char_ref_${Date.now()}`,
    name: name || "Character",
    url: finalUrl,
    publicId: finalPublicId,
  };

  logger.info(`EDITOR_CHAR_REF_UPLOADED workflowId=${workflowId} sceneId=${sceneId} url=${finalUrl}`);

  return {
    success: true,
    characterReference: charRef,
  };
}

/**
 * Dispatch scene regeneration job.
 * Supports custom prompt, character reference image, and generateAsVideo (Veo 3).
 */
export async function requestSceneRegen({ workflowId, sceneId, prompt, characterReference, generateAsVideo, userId }) {
  const scene = await prisma.scene.findFirst({
    where: { id: sceneId, workflowId },
    include: { workflow: true },
  });

  if (!scene || scene.workflow.userId !== userId) {
    throw new Error("Scene not found or unauthorized");
  }

  const ALLOWED_EDIT_STATUSES = ["USER_CONFIRMATION_REQUIRED", "COMPLETED", "FAILED"];
  if (!ALLOWED_EDIT_STATUSES.includes(scene.workflow.status)) {
    throw new Error(`Workflow is in '${scene.workflow.status}' state — regeneration not permitted while actively processing`);
  }

  if (scene.status === "REGENERATING") {
    throw new Error("Scene is already regenerating");
  }

  // If a new prompt is supplied, update scene prompt immediately
  if (prompt && typeof prompt === "string" && prompt.trim()) {
    await prisma.scene.update({
      where: { id: sceneId },
      data: {
        userEditedPrompt: prompt.trim(),
        activePrompt: prompt.trim(),
      },
    });
  }

  // If custom character reference is attached, save it into scene's selectedRefs
  if (characterReference) {
    const existingRefs = Array.isArray(scene.selectedRefs) ? scene.selectedRefs : [];
    const updatedRefs = [characterReference, ...existingRefs.filter(r => r.url !== characterReference.url)];
    await prisma.scene.update({
      where: { id: sceneId },
      data: {
        selectedRefs: updatedRefs,
      },
    });
  }

  // Add BullMQ job with custom params
  const job = await addSceneRegenJob({
    workflowId,
    sceneId,
    prompt: prompt || scene.activePrompt || scene.originalPrompt,
    characterReference,
    generateAsVideo: Boolean(generateAsVideo),
  });

  // Update scene status to REGENERATING
  await prisma.scene.update({
    where: { id: sceneId },
    data: {
      status: "REGENERATING",
      ...(generateAsVideo ? { mediaType: "video" } : {}),
    },
  });

  logger.info(`EDITOR_SCENE_REGEN_REQUESTED workflowId=${workflowId} sceneId=${sceneId} jobId=${job.id} generateAsVideo=${Boolean(generateAsVideo)}`);

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

  const ALLOWED_MERGE_STATUSES = ["USER_CONFIRMATION_REQUIRED", "COMPLETED", "FAILED"];
  if (!ALLOWED_MERGE_STATUSES.includes(workflow.status)) {
    return { eligible: false, reason: `Workflow status is '${workflow.status}', expected one of: ${ALLOWED_MERGE_STATUSES.join(", ")}` };
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
