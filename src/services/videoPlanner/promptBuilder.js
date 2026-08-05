/**
 * promptBuilder.js — State-Based Prompt Builder for Video Planner
 *
 * Replaces chunk-based prompt generation with state-based prompt synthesis for VIDEO ONLY.
 * Uses persistent SceneState to define exact starting pose, current action, and explicit stopping boundaries.
 */

import { buildCinematicSceneDirectorObject } from "../prompt/videoPromptBuilder.js";
import { buildCommonPrompt } from "../prompt/commonPromptBuilder.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("StateBasedPromptBuilder");

/**
 * Builds a state-based prompt object for Gemini Omni Flash combining Story Director specifications
 * with state-based starting poses and stopping boundaries.
 *
 * @param {object} beat         - Current atomic beat object
 * @param {object} sceneState   - Persistent SceneState object for this beat
 * @param {object} nextBeat     - Upcoming beat object (for stopping boundaries)
 * @param {object} storyBible   - Story Bible metadata
 * @param {object} options      - Formatting options (aspectRatio, characterTalk, etc.)
 * @returns {object} Scene object with state-based motion prompt
 */
export function buildStateBasedPrompt(beat = {}, sceneState = {}, nextBeat = null, storyBible = {}, options = {}) {
  const commonPrompt = buildCommonPrompt(storyBible);
  const isCharacterTalk = options.characterTalk === true || beat.characterTalk === true;
  const spokenText = beat.spokenText || beat.narrationText || "";

  // 1. Construct base scene payload for Story Director Engine
  const baseScene = {
    sceneIndex: beat.beatIndex || 0,
    narrative: {
      beatSummary: beat.narrative || beat.action,
      narrationText: spokenText,
      emotionalTone: beat.emotion || sceneState.emotion || "cinematic",
    },
    characters: [
      {
        id: sceneState.activeCharacter?.id || "char_1",
        name: sceneState.activeCharacter?.name || beat.characterName || "Subject",
        identityLock: sceneState.activeCharacter?.identityLock || "Cinematic subject",
        costumeState: sceneState.activeCharacter?.costumeState || "standard wardrobe",
        currentAction: beat.action || "perform beat action",
      }
    ],
    environment: {
      name: sceneState.currentLocation || beat.location || "Scene Location",
      details: sceneState.locationDetails || "",
      lighting: sceneState.environment || "volumetric cinematic lighting",
    },
    camera: {
      shotSize: isCharacterTalk ? "Medium Close-Up Shot" : (sceneState.camera?.shotSize || "Medium Tracking Shot"),
      angle: isCharacterTalk ? "Eye Level Facing Camera" : (sceneState.camera?.angle || "Eye Level"),
      lens: "35mm Anamorphic T1.9",
      movement: sceneState.camera?.movement || "Smooth steady tracking motion",
    },
    timing: beat.timing || { durationSec: 5.0 },
    characterTalk: isCharacterTalk,
  };

  // 2. Generate Cinematic Scene Director Object
  const directorObj = buildCinematicSceneDirectorObject(baseScene, storyBible, commonPrompt, options);

  const charInfo = sceneState.activeCharacter || {};
  const charName = charInfo.name || beat.characterName || "Subject";
  const identityLock = charInfo.identityLock || "Cinematic subject";
  const costume = charInfo.costumeState || "standard wardrobe";
  const locName = sceneState.currentLocation || beat.location || "Scene Location";
  const locDetails = sceneState.locationDetails || "";
  const lighting = sceneState.environment || "cinematic lighting";

  const startingPose = sceneState.currentPose || "Standing in natural posture";
  const currentAction = beat.action || beat.narrative || "Perform scene action";
  const stoppingBoundary = nextBeat ? (nextBeat.action || nextBeat.narrative || "Stop action") : "Conclude scene";

  // 3. Combine Story Director specs + State boundaries into final Gemini Omni Flash prompt
  const promptParts = [
    `VISUAL SCENE: ${directorObj.cameraPlan.shotSize}, ${directorObj.cameraPlan.angle}. ${charName} (${identityLock}, wearing ${costume}). Location: ${locName} (${locDetails}). Lighting: ${lighting}.`,
    `CINEMATOGRAPHY: Lens ${directorObj.cameraPlan.lens}, Rig: ${directorObj.cameraPlan.rig}. Focus: ${directorObj.cameraPlan.depthOfField}.`,
    `STARTING POSE: ${charName} is initially positioned in this starting pose: ${startingPose}.`,
    `CURRENT ACTION: ${charName} performs this exact action: ${currentAction}.`,
    `STOPPING BOUNDARY: Complete ONLY the current action (${currentAction}). Stop immediately before starting (${stoppingBoundary}). Do NOT perform ${stoppingBoundary}; that action belongs strictly to the next beat.`,
    isCharacterTalk && spokenText
      ? `CHARACTER DIALOGUE: ${charName} speaks out loud reading these exact lines: "${spokenText}"`
      : "",
    commonPrompt ? `STYLE: ${commonPrompt}` : "Style: Photorealistic 8k cinematic video, natural continuous motion.",
  ].filter(Boolean);

  const veoPrompt = promptParts.join("\n\n").trim();

  return {
    sceneId: beat.sceneId || `scene_${String((beat.beatIndex || 0) + 1).padStart(3, "0")}`,
    sceneIndex: beat.beatIndex || 0,
    prompt: veoPrompt,
    charactersInScene: charInfo.id ? [charInfo.id] : [],
    durationSec: beat.timing?.durationSec || 5.0,
    narration: spokenText,
    _sceneState: sceneState,
    _directorObject: directorObj,
  };
}
