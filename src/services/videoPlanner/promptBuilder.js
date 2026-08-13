/**
 * promptBuilder.js — State-Based Prompt Builder for Video Planner
 *
 * Replaces chunk-based prompt generation with state-based prompt synthesis for VIDEO ONLY.
 * Uses persistent SceneState to define exact starting pose, physical visual action, and explicit stopping boundaries.
 */

import { buildCinematicSceneDirectorObject } from "../prompt/videoPromptBuilder.js";
import { buildCommonPrompt } from "../prompt/commonPromptBuilder.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("StateBasedPromptBuilder");

/**
 * Determines the visual purpose for a beat based on narrative content and beat index.
 */
export function determineVisualPurpose(beat = {}, beatIndex = 0, totalBeats = 5) {
  const text = (beat.narrative || beat.action || beat.spokenText || "").toLowerCase();

  if (beatIndex === 0 || text.includes("tired of") || text.includes("ever wonder") || text.includes("stop")) return "HOOK";
  if (text.includes("problem") || text.includes("dry") || text.includes("missing") || text.includes("scalp")) return "PROBLEM / SCALP DIAGNOSIS";
  if (text.includes("oil") || text.includes("formula") || text.includes("rosemary") || text.includes("product")) return "PRODUCT INTRODUCTION";
  if (text.includes("ingredients") || text.includes("jojoba") || text.includes("castor")) return "INGREDIENT REVEAL & DEMONSTRATION";
  if (text.includes("moisture") || text.includes("nourish") || text.includes("spread")) return "BENEFIT DEMONSTRATION";
  if (beatIndex === totalBeats - 1 || text.includes("try") || text.includes("get") || text.includes("order")) return "CALL TO ACTION / HERO PRODUCT";

  return "NARRATIVE PROGRESSION";
}

/**
 * Generates a distinct physical visual action appropriate for the beat, separating dialogue from physical movement.
 */
export function derivePhysicalVisualAction(beat = {}, charName = "Subject", visualPurpose = "NARRATIVE PROGRESSION") {
  const rawAction = beat.action || "";
  const rawNarrative = beat.narrative || "";

  // If rawAction is already a physical visual action (not raw dialogue/narration), use it
  if (rawAction && !rawAction.includes("?") && !rawAction.includes('"') && rawAction.split(" ").length > 3) {
    return rawAction;
  }

  // Derive visual physical action based on purpose
  switch (visualPurpose) {
    case "HOOK":
      return `${charName} examines her scalp closely in a bathroom mirror, noticing dryness, then turns toward the camera with an expressive, engaging look.`;
    case "PROBLEM / SCALP DIAGNOSIS":
      return `${charName} gently touches her scalp near the hairline, inspecting her hair roots with a reflective, authentic expression.`;
    case "PRODUCT INTRODUCTION":
      return `${charName} holds up a sleek glass bottle of hair scalp oil at chest height, rotating it subtly to capture the ambient lighting.`;
    case "INGREDIENT REVEAL & DEMONSTRATION":
      return `${charName} dispenses a drop of golden scalp oil onto her fingertips, demonstrating its smooth, non-greasy texture.`;
    case "BENEFIT DEMONSTRATION":
      return `${charName} applies a small amount of oil onto her scalp part and gently massages it in using soft circular fingertip motions.`;
    case "CALL TO ACTION / HERO PRODUCT":
      return `${charName} presents the scalp oil bottle toward the camera with a confident, radiant smile against warm cinematic lighting.`;
    default:
      return `${charName} performs a natural, fluid gesture while interacting with the scene environment.`;
  }
}

/**
 * Selects camera movement and shot size based on visual purpose.
 */
export function determineCameraIntent(visualPurpose = "NARRATIVE PROGRESSION", isCharacterTalk = false) {
  switch (visualPurpose) {
    case "HOOK":
      return { shotSize: "Medium Close-Up", angle: "Eye Level", movement: "Subtle slow push-in" };
    case "PRODUCT INTRODUCTION":
      return { shotSize: "Medium Shot", angle: "Slight Low Angle", movement: "Smooth tracking arc" };
    case "INGREDIENT REVEAL & DEMONSTRATION":
      return { shotSize: "Close-Up Insert", angle: "High Angle Focus", movement: "Slow macro focus tracking" };
    case "BENEFIT DEMONSTRATION":
      return { shotSize: "Medium Close-Up", angle: "Eye Level", movement: "Handheld organic movement" };
    case "CALL TO ACTION / HERO PRODUCT":
      return { shotSize: "Medium Hero Shot", angle: "Eye Level", movement: "Gentle pedestal camera pull-back" };
    default:
      return { shotSize: isCharacterTalk ? "Medium Close-Up" : "Medium Shot", angle: "Eye Level", movement: "Smooth steady tracking motion" };
  }
}

/**
 * Builds a state-based prompt object combining Story Director specifications
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

  const totalBeatsCount = options.totalBeatsCount || 5;
  const beatIdx = beat.beatIndex || 0;

  const visualPurpose = determineVisualPurpose(beat, beatIdx, totalBeatsCount);
  const charInfo = sceneState.activeCharacter || {};
  const charName = speechAlloc.speaker || charInfo.name || beat.characterName || "Subject";
  const physicalAction = derivePhysicalVisualAction(beat, charName, visualPurpose);
  const cameraIntent = determineCameraIntent(visualPurpose, isCharacterTalk);

  // 1. Base scene payload for Story Director Engine
  const baseScene = {
    sceneIndex: beatIdx,
    narrative: {
      beatSummary: beat.narrative || physicalAction,
      narrationText: spokenText,
      emotionalTone: beat.emotion || sceneState.emotion || "cinematic focus",
    },
    characters: [
      {
        id: speechAlloc.speakerId || charInfo.id || "char_1",
        name: charName,
        identityLock: charInfo.identityLock || "Cinematic subject",
        costumeState: charInfo.costumeState || "standard wardrobe",
        currentAction: physicalAction,
      }
    ],
    environment: {
      name: sceneState.currentLocation || beat.location || "Scene Location",
      details: sceneState.locationDetails || "",
      lighting: sceneState.environment || "volumetric cinematic lighting",
    },
    camera: {
      shotSize: cameraIntent.shotSize,
      angle: cameraIntent.angle,
      lens: "35mm Anamorphic T1.9",
      movement: cameraIntent.movement,
    },
    timing: beat.timing || { durationSec: 5.0 },
    characterTalk: isCharacterTalk,
  };

  const directorObj = buildCinematicSceneDirectorObject(baseScene, storyBible, commonPrompt, options);

  const identityLock = charInfo.identityLock || "Cinematic subject";
  const costume = charInfo.costumeState || "standard wardrobe";
  const locName = sceneState.currentLocation || beat.location || "Scene Location";
  const locDetails = sceneState.locationDetails || "";
  const lighting = sceneState.environment || "cinematic lighting";

  const startingPose = sceneState.currentPose || "Standing in natural posture";
  const clipDurationSec = beat.timing?.durationSec || 5.0;

  const speechBoundary = spokenText
    ? `SPOKEN DIALOGUE: ${charName} speaks out loud: "${spokenText}" (Timing: t=0.0s to t=${clipDurationSec.toFixed(1)}s). Synchronize facial expression and lip movement to dialogue.`
    : "SPOKEN DIALOGUE: Silent action without dialogue.";

  const nextActionText = nextBeat ? derivePhysicalVisualAction(nextBeat, charName, determineVisualPurpose(nextBeat, beatIdx + 1, totalBeatsCount)) : "natural resolution";
  const stoppingBoundaryText = `ACTION CONTINUITY & BOUNDARY: Perform physical action starting from pose (${startingPose}). Conclude clip smoothly at t=${clipDurationSec.toFixed(1)}s in posture ready for (${nextActionText}).`;

  const targetRatio = options.aspectRatio || "16:9";
  const isVerticalRatio = targetRatio === "9:16" || targetRatio === "9/16" || targetRatio === "vertical";
  const aspectRatioBoundary = isVerticalRatio
    ? "FRAME ASPECT RATIO: Native VERTICAL 9:16 orientation. Frame all key subjects centered within 9:16 bounds."
    : "FRAME ASPECT RATIO: Native HORIZONTAL 16:9 widescreen composition.";

  const promptParts = [
    `SCENE PURPOSE: ${visualPurpose}`,
    `VISUAL SCENE: ${cameraIntent.shotSize}, ${cameraIntent.angle}. ${charName} (${identityLock}, wearing ${costume}). Location: ${locName}${locDetails ? ` (${locDetails})` : ""}. Lighting: ${lighting}.`,
    `CINEMATOGRAPHY: Lens 35mm Anamorphic T1.9, Movement: ${cameraIntent.movement}.`,
    aspectRatioBoundary,
    `STARTING POSE: ${charName} begins in pose: ${startingPose}.`,
    `PHYSICAL VISUAL ACTION: ${physicalAction}`,
    speechBoundary,
    stoppingBoundaryText,
    commonPrompt ? `VISUAL STYLE: ${commonPrompt}` : "VISUAL STYLE: Photorealistic 8k ultra-detailed cinematic film quality, natural continuous physics, smooth motion.",
  ].filter(Boolean);

  const veoPrompt = promptParts.join("\n\n").trim();

  return {
    sceneId: beat.sceneId || `scene_${String(beatIdx + 1).padStart(3, "0")}`,
    sceneIndex: beatIdx,
    prompt: veoPrompt,
    charactersInScene: (speechAlloc.speakerId || charInfo.id) ? [speechAlloc.speakerId || charInfo.id] : [],
    durationSec: clipDurationSec,
    narration: spokenText,
    physicalAction,
    visualPurpose,
    speechAllocation: speechAlloc,
    conversationState: convState,
    _beat: beat,
    _sceneState: sceneState,
    _directorObject: directorObj,
  };
}

