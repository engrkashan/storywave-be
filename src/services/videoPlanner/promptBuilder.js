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
  const spokenText = beat.spokenText || beat.speechAllocation?.spokenText || beat.narrationText || "";
  const speechAlloc = beat.speechAllocation || {};
  const convState = sceneState.conversationState || {};

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
        id: speechAlloc.speakerId || sceneState.activeCharacter?.id || "char_1",
        name: speechAlloc.speaker || sceneState.activeCharacter?.name || beat.characterName || "Subject",
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
  const charName = speechAlloc.speaker || charInfo.name || beat.characterName || "Subject";
  const identityLock = charInfo.identityLock || "Cinematic subject";
  const costume = charInfo.costumeState || "standard wardrobe";
  const locName = sceneState.currentLocation || beat.location || "Scene Location";
  const locDetails = sceneState.locationDetails || "";
  const lighting = sceneState.environment || "cinematic lighting";

  const startingPose = sceneState.currentPose || "Standing in natural posture";
  const currentAction = beat.action || beat.narrative || "Perform scene action";
  const stoppingBoundary = nextBeat ? (nextBeat.action || nextBeat.narrative || "Stop action") : "Conclude scene";
  const nextDialoguePreview = nextBeat?.speechAllocation?.spokenText || nextBeat?.spokenText || "";

  // 3. Precise Boundaries (Visual, Speech, Conversation, Stopping)
  const clipDurationSec = beat.timing?.durationSec || 5.0;

  const speechBoundary = (isCharacterTalk && spokenText)
    ? `CHARACTER SPOKEN DIALOGUE: ${charName} starts speaking out loud immediately at t=0.0s and reads these exact lines: "${spokenText}" (Local clip speech window: t=0.0s to t=${clipDurationSec.toFixed(1)}s). Synchronize lip movement and facial expression precisely to this speech window.`
    : "";

  const conversationBoundary = (convState.currentSpeaker && convState.nextExpectedSpeaker)
    ? `CONVERSATION FLOW: ${charName} is actively engaging with ${convState.nextExpectedSpeaker}. Maintain direct eyeline and body orientation.`
    : "";

  const nextActionText = nextBeat ? (nextBeat.action || nextBeat.narrative || "next scene movement") : "natural conclusion";
  const stoppingBoundaryText = `ACTION CONTINUITY & BOUNDARY: Perform ONLY current action (${currentAction}) starting from initial pose (${startingPose}). Conclude clip smoothly at t=${clipDurationSec.toFixed(1)}s in a natural posture ready for ${nextActionText}. Do NOT repeat past actions.`;

  // 4. Aspect Ratio & Composition Directives
  const targetRatio = options.aspectRatio || "16:9";
  const isVerticalRatio = targetRatio === "9:16" || targetRatio === "9/16" || targetRatio === "vertical";
  const aspectRatioBoundary = isVerticalRatio
    ? "FRAME ASPECT RATIO & COMPOSITION: Generate natively in VERTICAL 9:16 orientation. Frame all key characters, faces, and main actions strictly centered within vertical 9:16 bounds. Do not place essential subjects at outer horizontal edges."
    : "FRAME ASPECT RATIO & COMPOSITION: Generate natively in HORIZONTAL 16:9 widescreen orientation.";

  // 5. Combine Story Director specs + State boundaries into final Gemini Omni Flash prompt
  const promptParts = [
    `SCENE VISUALS: ${directorObj.cameraPlan.shotSize}, ${directorObj.cameraPlan.angle}. ${charName} (${identityLock}, wearing ${costume}). Location: ${locName}${locDetails ? ` (${locDetails})` : ""}. Lighting: ${lighting}.`,
    `CINEMATOGRAPHY: Lens ${directorObj.cameraPlan.lens}, Movement: ${directorObj.cameraPlan.rig}, Focus: ${directorObj.cameraPlan.depthOfField}.`,
    aspectRatioBoundary,
    `STARTING POSE: ${charName} begins in starting pose: ${startingPose}.`,
    `COMPLETE ACTION VISUALS: ${charName} performs complete continuous action: ${currentAction}.`,
    speechBoundary,
    stoppingBoundaryText,
    conversationBoundary,
    commonPrompt ? `VISUAL STYLE: ${commonPrompt}` : "VISUAL STYLE: Photorealistic 8k ultra-detailed cinematic film quality, natural continuous physics, smooth motion.",
  ].filter(Boolean);

  const veoPrompt = promptParts.join("\n\n").trim();

  return {
    sceneId: beat.sceneId || `scene_${String((beat.beatIndex || 0) + 1).padStart(3, "0")}`,
    sceneIndex: beat.beatIndex || 0,
    prompt: veoPrompt,
    charactersInScene: (speechAlloc.speakerId || charInfo.id) ? [speechAlloc.speakerId || charInfo.id] : [],
    durationSec: beat.timing?.durationSec || 5.0,
    narration: spokenText,
    speechAllocation: speechAlloc,
    conversationState: convState,
    _beat: beat,
    _sceneState: sceneState,
    _directorObject: directorObj,
  };
}
