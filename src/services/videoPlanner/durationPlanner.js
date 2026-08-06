/**
 * durationPlanner.js — Dynamic Duration Planner for Video Planner
 *
 * Estimates beat duration based on action complexity, dialogue length, and movement.
 * Replaces fixed word-chunk duration logic for VIDEO ONLY.
 * Clamps output per beat to valid Gemini Omni Flash clip boundaries (3.0s to 5.0s).
 */

import { createLogger } from "../../utils/logger.js";

const logger = createLogger("DurationPlanner");

const OMNI_MIN_CLIP_DURATION = 3.0;
const OMNI_MAX_CLIP_DURATION = 5.0;

/**
 * Plans durations for each atomic beat and handles natural splits if a complex beat exceeds 5s.
 *
 * @param {Array<object>} atomicBeats - List of atomic beats
 * @returns {Array<object>} Beats with calculated durationSec and timing metadata
 */
export function planBeatDurations(atomicBeats = [], targetSceneCount = null, targetTotalDuration = null) {
  logger.info(`⏱️ [Duration Planner] Estimating durations for ${atomicBeats.length} atomic beats (Target Scenes: ${targetSceneCount || "Auto"})...`);

  const durationPlannedBeats = [];
  let currentStartSec = 0;
  let beatCounter = 0;

  const allowBeatSplitting = !targetSceneCount || targetSceneCount <= 0 || atomicBeats.length < targetSceneCount;

  for (let i = 0; i < atomicBeats.length; i++) {
    const beat = atomicBeats[i];
    const estimatedDuration = estimateSingleBeatDuration(beat);

    if (estimatedDuration > OMNI_MAX_CLIP_DURATION && allowBeatSplitting) {
      // Split beat naturally across micro-movement phases
      logger.info(`✂️ Beat ${i + 1} estimated duration ${estimatedDuration.toFixed(1)}s exceeds 5s max — splitting naturally...`);
      const microBeats = splitOverlongBeat(beat, estimatedDuration);
      
      microBeats.forEach((mb) => {
        const durationSec = OMNI_MAX_CLIP_DURATION;
        const startSec = currentStartSec;
        const endSec = startSec + durationSec;
        currentStartSec = endSec;

        durationPlannedBeats.push({
          ...mb,
          beatIndex: beatCounter++,
          timing: { startSec, endSec, durationSec },
        });
      });
    } else {
      const durationSec = Math.max(OMNI_MIN_CLIP_DURATION, Math.min(OMNI_MAX_CLIP_DURATION, estimatedDuration));
      const startSec = currentStartSec;
      const endSec = startSec + durationSec;
      currentStartSec = endSec;

      durationPlannedBeats.push({
        ...beat,
        beatIndex: beatCounter++,
        timing: { startSec, endSec, durationSec },
      });
    }
  }

  logger.info(`✅ [Duration Planner] Planned ${durationPlannedBeats.length} beats with total estimated duration: ${currentStartSec.toFixed(1)}s.`);
  return durationPlannedBeats;
}

/**
 * Estimates duration in seconds based on action, word count, and movement complexity.
 */
function estimateSingleBeatDuration(beat) {
  const actionText = beat.action || beat.narrative || "";
  const spokenText = beat.spokenText || "";

  const wordsInSpoken = spokenText.split(/\s+/).filter(Boolean).length;
  const wordsInAction = actionText.split(/\s+/).filter(Boolean).length;

  // Base calculation: spoken dialogue (~0.5s per word) or physical action (~0.4s per word)
  let duration = wordsInSpoken > 0
    ? Math.max(3.5, wordsInSpoken * 0.5)
    : Math.max(3.5, wordsInAction * 0.4);

  // Complexity modifiers
  if (/run|jump|sprint|dash|leap|fight|chase/i.test(actionText)) duration += 0.5;
  if (/slowly|turns|scans|hesitates|whispers/i.test(actionText)) duration += 0.5;

  return duration;
}

/**
 * Splits a beat exceeding 5s into natural micro-movement phases.
 * (e.g. "Climb ladder" -> "Hands grab ladder" -> "Reach top")
 */
function splitOverlongBeat(beat, totalEstimatedDuration) {
  const numSplits = Math.ceil(totalEstimatedDuration / OMNI_MAX_CLIP_DURATION);
  const microBeats = [];

  for (let s = 0; s < numSplits; s++) {
    let phaseText = beat.action;
    if (s === 0) phaseText = `${beat.action} (Initial phase & approach)`;
    else if (s === numSplits - 1) phaseText = `${beat.action} (Completion phase & arrival)`;
    else phaseText = `${beat.action} (Mid-action continuation)`;

    microBeats.push({
      ...beat,
      action: phaseText,
      narrative: phaseText,
      spokenText: s === 0 ? beat.spokenText : "", // Keep spoken dialogue on first phase
      isSplitPhase: true,
      phaseIndex: s,
    });
  }

  return microBeats;
}
