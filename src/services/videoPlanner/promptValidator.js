/**
 * promptValidator.js — Prompt & Continuity Validator for Video Planner
 *
 * Checks continuity between consecutive beats before prompt synthesis.
 * Detects missing intermediate physical transitions (e.g., Jump -> Run missing Landing)
 * and automatically inserts missing transition beats to prevent abrupt visual jumps.
 */

import { createLogger } from "../../utils/logger.js";

const logger = createLogger("PromptValidator");

/**
 * Validates beat list for physical action gaps and auto-inserts missing transition beats.
 *
 * @param {Array<object>} beats - List of atomic beats
 * @returns {Array<object>} Validated beat list with missing transition beats inserted
 */
export function validateBeatContinuity(beats = [], targetSceneCount = null) {
  logger.info(`🔍 [Prompt Validator] Checking continuity across ${beats.length} beats (Target Scenes: ${targetSceneCount || "Auto"})...`);

  const validatedBeats = [];

  for (let i = 0; i < beats.length; i++) {
    const currentBeat = beats[i];
    const nextBeat = beats[i + 1] || null;

    validatedBeats.push(currentBeat);

    const allowAutoInsert = !targetSceneCount || targetSceneCount <= 0 || (validatedBeats.length + (beats.length - 1 - i) < targetSceneCount);

    if (nextBeat && allowAutoInsert) {
      const missingTransition = detectMissingTransition(currentBeat, nextBeat);
      if (missingTransition) {
        logger.info(`⚠️ [Prompt Validator] Missing transition detected between beat ${i + 1} ("${currentBeat.action}") and beat ${i + 2} ("${nextBeat.action}"). Auto-inserting transition beat: "${missingTransition.action}"`);
        validatedBeats.push(missingTransition);
      }
    }
  }

  // Re-index beats sequentially
  const finalBeats = validatedBeats.map((b, idx) => ({
    ...b,
    beatIndex: idx,
    sceneId: `scene_${String(idx + 1).padStart(3, "0")}`,
  }));

  logger.info(`✅ [Prompt Validator] Validation complete. Total beats after transition insertion: ${finalBeats.length}`);
  return finalBeats;
}

/**
 * Detects missing physical transitions between consecutive beats.
 */
function detectMissingTransition(currentBeat, nextBeat) {
  const curr = (currentBeat.action || "").toLowerCase();
  const next = (nextBeat.action || "").toLowerCase();

  // Pattern 1: Jump/Leap -> Run/Walk (Missing Landing beat)
  if ((curr.includes("jump") || curr.includes("leap")) && (next.includes("run") || next.includes("walk") || next.includes("sprint")) && !curr.includes("land") && !next.includes("land")) {
    return {
      beatIndex: -1,
      narrative: `Land firmly on ground after jumping, absorbing impact`,
      action: `Land firmly on ground after jumping, absorbing impact`,
      spokenText: "",
      characterName: currentBeat.characterName,
      characterId: currentBeat.characterId,
      location: currentBeat.location,
      emotion: currentBeat.emotion,
      isAutoInsertedTransition: true,
      timing: {
        durationSec: 3.0,
      },
    };
  }

  // Pattern 2: Stand/Walk -> Seated/Sitting (Missing Sitting Down transition)
  if ((curr.includes("walk") || curr.includes("stand")) && next.includes("seated") && !curr.includes("sit") && !next.includes("sit")) {
    return {
      beatIndex: -1,
      narrative: `Bend knees and sit down into chair`,
      action: `Bend knees and sit down into chair`,
      spokenText: "",
      characterName: currentBeat.characterName,
      characterId: currentBeat.characterId,
      location: currentBeat.location,
      emotion: currentBeat.emotion,
      isAutoInsertedTransition: true,
      timing: {
        durationSec: 3.0,
      },
    };
  }

  // Pattern 3: Walk to door -> Inside new room (Missing Opening Door transition)
  if (curr.includes("door") && next.includes("inside") && !curr.includes("open") && !next.includes("open")) {
    return {
      beatIndex: -1,
      narrative: `Turn door handle and push door open`,
      action: `Turn door handle and push door open`,
      spokenText: "",
      characterName: currentBeat.characterName,
      characterId: currentBeat.characterId,
      location: currentBeat.location,
      emotion: currentBeat.emotion,
      isAutoInsertedTransition: true,
      timing: {
        durationSec: 3.0,
      },
    };
  }

  return null;
}

/**
 * Validates scene timing mathematically.
 *
 * @param {object} scene - Scene or beat object
 * @returns {{ valid: boolean, errors: Array<string> }}
 */
export function validateSceneTiming(scene = {}) {
  const errors = [];
  const timing = scene.timing || {};
  const startSec = timing.startSec ?? scene.startSec;
  const endSec = timing.endSec ?? scene.endSec;
  const durationSec = timing.durationSec ?? scene.durationSec;

  if (startSec === undefined || endSec === undefined || durationSec === undefined) {
    errors.push("Scene timing metadata missing startSec, endSec, or durationSec.");
    return { valid: false, errors };
  }

  if (startSec < 0) {
    errors.push(`Scene startSec (${startSec}) cannot be negative.`);
  }

  if (endSec <= startSec) {
    errors.push(`Scene endSec (${endSec}) must be strictly greater than startSec (${startSec}).`);
  }

  const calculatedDuration = Number((endSec - startSec).toFixed(3));
  if (Math.abs(calculatedDuration - durationSec) > 0.05) {
    errors.push(`Scene durationSec (${durationSec}s) does not match endSec - startSec (${calculatedDuration}s).`);
  }

  // Validate speech allocation fit inside scene window
  const speechAlloc = scene.speechAllocation || {};
  if (speechAlloc.hasSpeech) {
    const speechStart = speechAlloc.speechStartSec ?? startSec;
    const speechEnd = speechAlloc.speechEndSec ?? endSec;

    if (speechStart < startSec - 0.1 || speechEnd > endSec + 0.1) {
      errors.push(`Speech window [${speechStart}s - ${speechEnd}s] exceeds scene window [${startSec}s - ${endSec}s].`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates contiguity across an ordered list of scenes.
 *
 * @param {Array<object>} scenes - List of scenes or beats
 * @returns {{ valid: boolean, errors: Array<string>, gaps: Array<object> }}
 */
export function validateTimelineContinuity(scenes = []) {
  const errors = [];
  const gaps = [];

  for (let i = 0; i < scenes.length - 1; i++) {
    const current = scenes[i];
    const next = scenes[i + 1];

    const currentEnd = current.timing?.endSec ?? current.endSec ?? 0;
    const nextStart = next.timing?.startSec ?? next.startSec ?? 0;

    const diff = Math.abs(nextStart - currentEnd);
    if (diff > 0.1) {
      const isGap = nextStart > currentEnd;
      const msg = isGap
        ? `Timeline gap of ${(nextStart - currentEnd).toFixed(2)}s detected between Scene ${i + 1} (${currentEnd}s) and Scene ${i + 2} (${nextStart}s).`
        : `Timeline overlap of ${(currentEnd - nextStart).toFixed(2)}s detected between Scene ${i + 1} (${currentEnd}s) and Scene ${i + 2} (${nextStart}s).`;

      errors.push(msg);
      gaps.push({ sceneIndex: i, currentEnd, nextStart, diff: nextStart - currentEnd });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    gaps,
  };
}

/**
 * Validates alignment between speech allocation and narrative beat.
 *
 * @param {object} beat - Beat object with speechAllocation
 * @returns {{ valid: boolean, errors: Array<string> }}
 */
export function validateSpeechNarrativeAlignment(beat = {}) {
  const errors = [];
  const spokenText = beat.spokenText || beat.speechAllocation?.spokenText || "";
  const physicalAction = beat.physicalAction || beat.action || "";

  // Check if raw dialogue sentence fragment is incorrectly used as physical visual action
  if (physicalAction && (physicalAction.startsWith('"') || (spokenText && physicalAction.toLowerCase().includes(spokenText.toLowerCase()) && spokenText.split(" ").length > 3))) {
    errors.push(`Physical visual action ("${physicalAction.slice(0, 40)}...") is raw dialogue text instead of a physical movement.`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

