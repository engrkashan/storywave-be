/**
 * sceneStateEngine.js — Scene State Engine for Video Planner
 *
 * Maintains structured, persistent SceneState across atomic beats.
 * Replaces raw text as the continuity source of truth.
 */

import { createLogger } from "../../utils/logger.js";

const logger = createLogger("SceneStateEngine");

/**
 * Initializes starting SceneState from Story Bible and initial beat metadata.
 *
 * @param {object} storyBible - Story Bible metadata
 * @param {object} initialBeat - First atomic beat
 * @returns {object} Structured SceneState object
 */
export function initializeSceneState(storyBible = {}, initialBeat = {}) {
  const mainChar = storyBible?.characters?.[0] || {};
  const mainLoc = storyBible?.locations?.[0] || {};

  return {
    completedActions: [],
    currentPose: initialBeat.action ? `Beginning action: ${initialBeat.action}` : "Standing in natural posture",
    currentLocation: initialBeat.location || mainLoc.name || "Scene Location",
    locationDetails: mainLoc.description || "Cinematic environment",
    activeCharacter: {
      id: mainChar.id || "char_1",
      name: mainChar.name || initialBeat.characterName || "Subject",
      identityLock: mainChar.appearance || "Cinematic subject",
      costumeState: mainChar.clothing || mainChar.base_clothing || "standard costume",
    },
    camera: {
      shotSize: "Medium Shot",
      angle: "Eye Level",
      movement: "Subtle tracking motion",
    },
    emotion: initialBeat.emotion || "cinematic focus",
    environment: `${mainLoc.name || "Environment"} with natural lighting`,
    nextAction: initialBeat.action || "Advance scene",
  };
}

/**
 * Updates SceneState sequentially after executing a beat.
 *
 * @param {object} currentState - Current SceneState object
 * @param {object} executedBeat - The beat that was just executed
 * @param {object} nextBeat - The upcoming beat (if any)
 * @returns {object} Updated SceneState object for the next beat
 */
export function updateSceneState(currentState = {}, executedBeat = {}, nextBeat = null) {
  const updatedCompleted = [
    ...(currentState.completedActions || []),
    executedBeat.action || executedBeat.narrative || "Beat completed",
  ];

  // Derive ending pose from executed beat action
  const derivedEndingPose = deriveEndingPose(executedBeat.action);

  return {
    ...currentState,
    completedActions: updatedCompleted.slice(-5), // Keep rolling memory of last 5 completed actions
    currentPose: derivedEndingPose,
    currentLocation: executedBeat.location || currentState.currentLocation,
    emotion: executedBeat.emotion || currentState.emotion,
    nextAction: nextBeat ? (nextBeat.action || nextBeat.narrative || "Complete sequence") : "Conclude scene",
  };
}

/**
 * Derives character ending pose from beat action description.
 */
function deriveEndingPose(actionText = "") {
  if (!actionText) return "Standing in natural posture";

  const lower = actionText.toLowerCase();
  if (lower.includes("jump")) return "Just landed on ground, regaining balance";
  if (lower.includes("climb")) return "Standing at top of wall/climbing surface";
  if (lower.includes("run")) return "In full sprinting posture";
  if (lower.includes("walk")) return "Standing at destination point";
  if (lower.includes("sit")) return "Seated in chair/surface";
  if (lower.includes("look")) return "Turned head looking back";

  return `Positioned at completion of: ${actionText}`;
}
