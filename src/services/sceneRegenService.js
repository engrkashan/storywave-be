/**
 * sceneRegenService.js
 * Storywave Editor: Scene Regeneration Service.
 *
 * Regenerates an individual scene (or both ratios in dualPlatform mode)
 * preserving:
 *   - Exact timeline (startSec, endSec, durationSec are immutable)
 *   - Character references and identities
 *   - Visual continuity from Scene N-1
 *   - Version history (creates new SceneVersion, increments activeVersion)
 */

import fs from "fs";
import path from "path";
import { cloudinary } from "../config/cloudinary.config.js";
import prisma from "../config/prisma.client.js";
import { deleteTempFiles } from "../utils/deleteTemp.js";
import { createLogger } from "../utils/logger.js";
import { generateImage } from "./imageService.js";
import { generateVideoClips } from "./videoService.js";

const logger = createLogger("SceneRegenService");
const TEMP_ROOT = path.resolve(process.cwd(), "temp");
fs.mkdirSync(TEMP_ROOT, { recursive: true });

function uploadLargePromise(filePath, options) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_large(filePath, options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

async function uploadRegenAsset(localPath, workflowId, sceneIndex, ratio, version, assetType) {
  const ratioSlug = ratio.replace(":", "_");
  const publicId = `scenes/${workflowId}/scene_${String(sceneIndex).padStart(3, "0")}/${ratioSlug}/v${version}_${Date.now()}`;
  const resourceType = assetType === "video" ? "video" : "image";

  let uploaded;
  if (assetType === "video") {
    uploaded = await uploadLargePromise(localPath, {
      resource_type: resourceType,
      public_id: publicId,
      chunk_size: 10000000,
      timeout: 600000,
      overwrite: true,
    });
  } else {
    uploaded = await cloudinary.uploader.upload(localPath, {
      resource_type: resourceType,
      public_id: publicId,
      overwrite: true,
    });
  }

  logger.info(`📸 [Regen] Scene ${sceneIndex} [${ratio}] v${version} uploaded: ${uploaded.secure_url}`);
  return { secureUrl: uploaded.secure_url, publicId: uploaded.public_id };
}

/**
 * Regenerates an individual scene (or dual-platform pair) by sceneId.
 * Supports:
 *   - Character reference image injection for identity adherence
 *   - Converting image frame to motion graphic video clip via Google Veo 3
 *   - Custom prompt overriding
 * @param {{ workflowId: string, sceneId: string, prompt?: string, characterReference?: any, generateAsVideo?: boolean }} param0
 */
export async function regenerateScene({ workflowId, sceneId, prompt, characterReference, generateAsVideo }) {
  logger.info(`EDITOR_SCENE_GENERATION_STARTED workflowId=${workflowId} sceneId=${sceneId} generateAsVideo=${Boolean(generateAsVideo)} hasCharRef=${Boolean(characterReference)}`);

  const targetScene = await prisma.scene.findUnique({
    where: { id: sceneId },
    include: { workflow: true, versions: true },
  });

  if (!targetScene) {
    throw new Error(`Scene ${sceneId} not found`);
  }

  const workflow = targetScene.workflow;
  if (!workflow) {
    throw new Error(`Workflow ${workflowId} not found for scene ${sceneId}`);
  }

  const meta = workflow.metadata || {};
  const dualPlatform = meta.dualPlatform ?? false;

  // If prompt was passed explicitly in job data, update active prompt
  const activePrompt = (prompt && typeof prompt === "string" && prompt.trim())
    ? prompt.trim()
    : (targetScene.activePrompt || targetScene.originalPrompt || "");

  // Determine if this generation run produces a video clip (Veo 3)
  const isVideoGeneration = Boolean(generateAsVideo) || targetScene.mediaType === "video";

  // Find all scene records for this scene index (e.g. both 16:9 and 9:16 in dual platform)
  const scenesToRegen = dualPlatform
    ? await prisma.scene.findMany({ where: { workflowId, index: targetScene.index } })
    : [targetScene];

  // Set all target scenes to REGENERATING and increment attempts
  for (const sc of scenesToRegen) {
    await prisma.scene.update({
      where: { id: sc.id },
      data: {
        status: "REGENERATING",
        activePrompt,
        userEditedPrompt: prompt ? activePrompt : sc.userEditedPrompt,
        mediaType: isVideoGeneration ? "video" : sc.mediaType,
        generationAttempts: { increment: 1 },
      },
    });
  }

  const regenTempDir = path.join(TEMP_ROOT, `regen_${workflowId}_${targetScene.index}_${Date.now()}`);
  fs.mkdirSync(regenTempDir, { recursive: true });

  try {
    let characterReferences = meta.characterReferences || meta.uploadedCharacterReferences || meta._characterReferences || [];
    
    // If a custom character reference is attached to this request, merge it into references
    let customRef = null;
    if (characterReference) {
      customRef = typeof characterReference === "string"
        ? { id: `custom_ref_${Date.now()}`, name: "Character Ref", url: characterReference, isCustomOverride: true, isExplicit: true }
        : {
            id: characterReference.id || `custom_ref_${Date.now()}`,
            name: characterReference.name || "Character Ref",
            url: characterReference.url || characterReference.secureUrl || characterReference.imageUrl,
            base64: characterReference.base64,
            mimeType: characterReference.mimeType,
            isCustomOverride: true,
            isExplicit: true,
          };

      if (customRef.url || customRef.base64) {
        // Prepend custom ref so it has highest priority
        characterReferences = [customRef, ...characterReferences.filter(r => r.id !== customRef.id && r.url !== customRef.url)];
        logger.info(`👤 [Regen] Attached custom character reference: ${customRef.name || customRef.id} (${customRef.url ? "URL" : "Base64"})`);
      }
    }

    const commonPrompt = meta.commonPrompt || null;
    const styleReferenceUrl = meta.styleReferenceUrl || meta.styleUrl || null;

    // Iterate over each ratio scene (e.g. 16:9 and 9:16)
    for (const sc of scenesToRegen) {
      const currentRatio = sc.ratio || "16:9";
      const ratioDir = path.join(regenTempDir, currentRatio.replace(":", "_"));
      fs.mkdirSync(ratioDir, { recursive: true });

      const nextVersion = (sc.activeVersion || 1) + 1;
      let generatedFilePath = null;
      const assetType = isVideoGeneration ? "video" : "image";
      const generationType = generateAsVideo ? "veo_video" : (isVideoGeneration ? "video_regen" : "regen");

      // Merge scene characters with custom character reference name if present
      const charactersInScene = customRef
        ? [customRef.name || customRef.id || "Character Ref", ...(sc.charactersInScene || [])]
        : (sc.charactersInScene || []);

      if (isVideoGeneration) {
        // Video regeneration with Google Veo 3
        // If an existing image asset exists on the scene, pass it as sourceImageUrl for image-to-video motion synthesis!
        const existingFrameUrl = sc.assetUrl || targetScene.assetUrl;
        
        const scenePromptObj = {
          prompt: activePrompt,
          charactersInScene,
          sourceImageUrl: existingFrameUrl && sc.assetType !== "video" ? existingFrameUrl : null,
          selectedRefs: characterReferences,
          _compiledState: sc.compiledState || null,
          _directorDecision: sc.directorDecision || null,
        };

        logger.info(`🎬 [Regen] Dispatching Veo 3 Video Clip generation for Scene ${sc.index + 1} [${currentRatio}] (sourceImage: ${scenePromptObj.sourceImageUrl ? "Yes" : "No"}, charRefs: ${characterReferences.length})...`);

        const clips = await generateVideoClips(
          [scenePromptObj],
          ratioDir,
          currentRatio,
          characterReferences,
          commonPrompt,
          () => {},
          "veo"
        );

        if (!clips?.[0]?.filePath || !fs.existsSync(clips[0].filePath)) {
          throw new Error(`Veo 3 video clip generation failed for ratio ${currentRatio}`);
        }
        generatedFilePath = clips[0].filePath;
      } else {
        // Image regeneration (multi_image or single_image)
        const scenePromptObj = {
          prompt: activePrompt,
          charactersInScene,
          selectedRefs: characterReferences,
          _compiledState: sc.compiledState || null,
          _directorDecision: sc.directorDecision || null,
        };

        const result = await generateImage(
          scenePromptObj,
          sc.index + 1,
          ratioDir,
          currentRatio,
          commonPrompt,
          characterReferences,
          styleReferenceUrl
        );

        if (!result.imageUrl || !fs.existsSync(result.imageUrl)) {
          throw new Error(result.error || `Image generation failed for ratio ${currentRatio}`);
        }
        generatedFilePath = result.imageUrl;
      }

      // Upload newly generated asset to Cloudinary
      const { secureUrl, publicId } = await uploadRegenAsset(
        generatedFilePath,
        workflowId,
        sc.index,
        currentRatio,
        nextVersion,
        assetType
      );

      // Create new SceneVersion record
      await prisma.sceneVersion.create({
        data: {
          sceneId: sc.id,
          version: nextVersion,
          assetUrl: secureUrl,
          assetPublicId: publicId,
          assetType,
          prompt: activePrompt,
          ratio: currentRatio,
          generationType,
          metadata: {
            durationSec: sc.durationSec,
            startSec: sc.startSec,
            endSec: sc.endSec,
            hasCharacterRef: Boolean(characterReference),
            provider: isVideoGeneration ? "veo3" : "gemini",
          },
        },
      });

      // Atomically update active Scene pointer
      await prisma.scene.update({
        where: { id: sc.id },
        data: {
          activeVersion: nextVersion,
          assetUrl: secureUrl,
          assetPublicId: publicId,
          assetType,
          mediaType: isVideoGeneration ? "video" : sc.mediaType,
          status: "GENERATED",
          activePrompt,
        },
      });

      logger.info(`EDITOR_SCENE_GENERATION_COMPLETED workflowId=${workflowId} sceneId=${sc.id} ratio=${currentRatio} version=${nextVersion} type=${assetType}`);
    }

    return { success: true, workflowId, index: targetScene.index };
  } catch (err) {
    logger.error(`EDITOR_SCENE_GENERATION_FAILED workflowId=${workflowId} sceneId=${sceneId} error="${err.message}"`);

    // Reset status to REGEN_FAILED; previous assetUrl remains intact!
    for (const sc of scenesToRegen) {
      await prisma.scene.update({
        where: { id: sc.id },
        data: { status: "REGEN_FAILED" },
      }).catch(() => {});
    }

    throw err;
  } finally {
    deleteTempFiles(regenTempDir);
  }
}
