/**
 * planner.js — Dedicated Video Prompt Planner & Shared Scene Object Ledger Builder
 *
 * Constructs Shared Scene Objects and builds kinetic motion prompts EXCLUSIVELY for Video mode (Google Veo).
 * Leaves all multi_image pipelines and functions 100% untouched.
 */

import { buildVideoPrompt } from "./videoPromptBuilder.js";
import { buildCommonPrompt } from "./commonPromptBuilder.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("VideoPlanner");

/**
 * Builds structured Shared Scene Objects from story metadata, scene prompts, and Whisper narration segments.
 *
 * @param {Array} rawScenePrompts    - Prompts / scene beats from scene generation
 * @param {object} storyMetadata     - Story Bible metadata
 * @param {Array} narrationSegments - Whisper narration segments aligned to Master Timeline
 * @returns {Array<object>} List of structured Shared Scene Objects
 */
export function buildSceneObjects(rawScenePrompts = [], storyMetadata = {}, narrationSegments = []) {
  logger.info(`🗺️ Building ${rawScenePrompts.length} Shared Scene Objects...`);

  const charactersList = storyMetadata.characters || [];
  const locationsList = storyMetadata.locations || [];

  return rawScenePrompts.map((sp, idx) => {
    const narrationSeg = narrationSegments[idx] || {};
    const textNarrative = narrationSeg.text || sp.narration || sp.prompt || "";
    
    // Resolve characters present in scene
    const charsInSceneIds = sp.charactersInScene || [];
    const charactersPresent = charsInSceneIds.map((charId) => {
      const found = charactersList.find((c) => c.id === charId || c.name === charId);
      return {
        id: charId,
        name: found?.name || charId,
        identityLock: found?.appearance || found?.sketch_artist_appearance ? JSON.stringify(found.sketch_artist_appearance) : "cinematic character",
        costumeState: found?.base_clothing || "standard costume",
        currentAction: sp.action || "present in scene",
        bodyLanguage: sp.bodyLanguage || "natural posture",
        facialExpression: sp.emotion || "natural expression",
        screenPosition: sp.screenPosition || "center",
      };
    });

    // Resolve location
    const mainLoc = locationsList[0] || {};
    const envObj = {
      locationId: mainLoc.id || "loc_1",
      name: mainLoc.name || "Scene Environment",
      details: mainLoc.description || "",
      lighting: mainLoc.lighting_atmosphere?.light_source || "cinematic lighting",
      weather: "ambient air",
      particles: "subtle dust motes",
    };

    // Camera specs
    const cameraObj = {
      shotSize: sp.shotSize || "Medium Shot",
      angle: sp.angle || "Eye Level",
      lens: sp.lens || "35mm Anamorphic",
      movement: sp.cameraMovement || "Subtle tracking motion",
      depthOfField: "Shallow depth of field",
    };

    return {
      sceneId: `scene_${String(idx + 1).padStart(3, "0")}`,
      sceneIndex: idx,
      timing: {
        startSec: narrationSeg.startSec || idx * 5,
        endSec: narrationSeg.endSec || (idx + 1) * 5,
        durationSec: narrationSeg.durationSec || 5,
      },
      narrative: {
        beatSummary: sp.prompt || textNarrative,
        narrationText: textNarrative,
        emotionalTone: sp.emotion || "cinematic",
        sceneObjective: sp.objective || "Advance visual story",
        shotObjective: "Focus on character and environment key beats",
      },
      characters: charactersPresent,
      environment: envObj,
      camera: cameraObj,
      continuity: {
        previousSceneId: idx > 0 ? `scene_${String(idx).padStart(3, "0")}` : null,
        nextSceneId: idx < rawScenePrompts.length - 1 ? `scene_${String(idx + 2).padStart(3, "0")}` : null,
      },
      _rawPromptData: sp,
    };
  });
}

/**
 * Video Prompt Planner: Generates kinetic motion-first prompts EXCLUSIVELY for Video mode (Google Veo).
 *
 * @param {Array<object>} sceneObjects - List of Shared Scene Objects
 * @param {object} storyMetadata        - Story Bible metadata
 * @param {object} options              - Additional options
 * @returns {Array<object>} Array of scene items with Google Veo motion prompts
 */
export function planVideoPrompts(sceneObjects = [], storyMetadata = {}, options = {}) {
  logger.info(`🎬 Video Planner: constructing ${sceneObjects.length} motion prompts for Google Veo...`);

  const commonPrompt = buildCommonPrompt(storyMetadata);

  return sceneObjects.map((scene) => {
    const videoPromptText = buildVideoPrompt(scene, storyMetadata, commonPrompt, options);

    return {
      sceneId: scene.sceneId,
      sceneIndex: scene.sceneIndex,
      prompt: videoPromptText,
      charactersInScene: scene.characters.map((c) => c.id),
      durationSec: scene.timing.durationSec,
      _sceneObject: scene,
    };
  });
}
