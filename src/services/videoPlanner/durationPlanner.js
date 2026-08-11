/**
 * durationPlanner.js — Dynamic Duration Planner for Video Planner
 *
 * Derives beat duration mathematically from authoritative speech timeline and scene boundaries.
 * Enforces durationSec = endSec - startSec strictly without arbitrary conflicting calculations.
 */

import { createLogger } from "../../utils/logger.js";

const logger = createLogger("DurationPlanner");

const OMNI_MIN_CLIP_DURATION = 3.0;
const OMNI_MAX_CLIP_DURATION = 5.0;

/**
 * Plans durations for each beat based on authoritative speech timeline boundaries.
 *
 * @param {Array<object>} atomicBeats - List of atomic beats
 * @param {number} targetSceneCount - Target scene count
 * @param {number} targetTotalDuration - Target total narration duration
 * @returns {Array<object>} Beats with mathematically strict durationSec and timing metadata
 */
export function planBeatDurations(atomicBeats = [], targetSceneCount = null, targetTotalDuration = null) {
  logger.info(`⏱️ [Duration Planner] Deriving timing for ${atomicBeats.length} beats (Target Scenes: ${targetSceneCount || "Auto"})...`);

  const durationPlannedBeats = [];
  let currentStartSec = 0;
  let beatCounter = 0;

  for (let i = 0; i < atomicBeats.length; i++) {
    const beat = atomicBeats[i];
    const speechAlloc = beat.speechAllocation || {};

    let startSec = currentStartSec;
    let endSec = currentStartSec + 5.0;

    if (speechAlloc.speechStartSec !== undefined && speechAlloc.speechEndSec !== undefined && speechAlloc.speechEndSec > speechAlloc.speechStartSec) {
      startSec = speechAlloc.speechStartSec;
      endSec = speechAlloc.speechEndSec;
    } else if (beat.timing?.startSec !== undefined && beat.timing?.endSec !== undefined && beat.timing.endSec > beat.timing.startSec) {
      startSec = beat.timing.startSec;
      endSec = beat.timing.endSec;
    } else {
      const estimated = estimateSingleBeatDuration(beat);
      endSec = startSec + estimated;
    }

    // Ensure contiguity
    if (startSec < currentStartSec) {
      startSec = currentStartSec;
    }
    if (endSec <= startSec) {
      endSec = startSec + 5.0;
    }

    const durationSec = Number((endSec - startSec).toFixed(3));
    currentStartSec = endSec;

    durationPlannedBeats.push({
      ...beat,
      beatIndex: beatCounter++,
      timing: {
        startSec: Number(startSec.toFixed(3)),
        endSec: Number(endSec.toFixed(3)),
        durationSec,
      },
    });
  }

  logger.info(`✅ [Duration Planner] Planned ${durationPlannedBeats.length} beats mathematically (Total Duration: ${currentStartSec.toFixed(1)}s).`);
  return durationPlannedBeats;
}

/**
 * Fallback duration estimation when speech timeline is unallocated.
 */
function estimateSingleBeatDuration(beat) {
  const actionText = beat.action || beat.narrative || "";
  const spokenText = beat.spokenText || "";

  const wordsInSpoken = spokenText.split(/\s+/).filter(Boolean).length;
  const wordsInAction = actionText.split(/\s+/).filter(Boolean).length;

  let duration = wordsInSpoken > 0
    ? Math.max(3.0, wordsInSpoken * 0.35)
    : Math.max(3.0, wordsInAction * 0.4);

  if (/run|jump|sprint|dash|leap|fight|chase/i.test(actionText)) duration += 0.5;
  if (/slowly|turns|scans|hesitates|whispers/i.test(actionText)) duration += 0.5;

  return Math.min(5.0, Math.max(3.0, duration));
}

