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
export function validateBeatContinuity(beats = []) {
  logger.info(`🔍 [Prompt Validator] Checking continuity across ${beats.length} beats...`);

  const validatedBeats = [];

  for (let i = 0; i < beats.length; i++) {
    const currentBeat = beats[i];
    const nextBeat = beats[i + 1] || null;

    validatedBeats.push(currentBeat);

    if (nextBeat) {
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
