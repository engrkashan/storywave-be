/**
 * atomicBeatPlanner.js — Atomic Beat Planner for Video Planner
 *
 * Ensures each narrative beat represents EXACTLY ONE continuous visual action event.
 * Atomizes any compound or multi-action beat into singular, atomic beats.
 */

import { createLogger } from "../../utils/logger.js";

const logger = createLogger("AtomicBeatPlanner");

/**
 * Validates and atomizes a list of narrative beats into single-action beats.
 *
 * @param {Array<object>} rawBeats - List of narrative beats from narrativeTimelineService
 * @returns {Array<object>} List of strictly atomic beats (one visual event per beat)
 */
export function planAtomicBeats(rawBeats = [], targetSceneCount = null) {
  logger.info(`🔬 [Atomic Beat Planner] Processing ${rawBeats.length} raw beats (Target: ${targetSceneCount || "Auto"})...`);

  // If beat count already meets or exceeds target scene count, do NOT split further
  if (targetSceneCount && targetSceneCount > 0 && rawBeats.length >= targetSceneCount) {
    logger.info(`ℹ️ Raw beat count (${rawBeats.length}) already meets target scene count (${targetSceneCount}) — skipping compound atomization.`);
    return rawBeats.map((b, idx) => ({
      ...b,
      beatIndex: idx,
      originalBeatIndex: idx,
      action: (b.action || b.narrative || "").trim(),
      isAtomized: false,
    }));
  }

  const atomicBeats = [];
  let beatCounter = 0;

  for (let i = 0; i < rawBeats.length; i++) {
    const b = rawBeats[i];
    const actionText = (b.action || b.narrative || "").trim();

    // Check if total beats would exceed target
    const currentTotal = atomicBeats.length + (rawBeats.length - i);
    const allowSplit = !targetSceneCount || targetSceneCount <= 0 || currentTotal < targetSceneCount;

    const compoundParts = allowSplit ? splitCompoundAction(actionText) : [actionText];

    if (compoundParts.length > 1) {
      logger.info(`⚡ Atomizing compound beat ${i + 1} into ${compoundParts.length} distinct atomic beats...`);
      compoundParts.forEach((part, subIdx) => {
        atomicBeats.push({
          ...b,
          beatIndex: beatCounter++,
          originalBeatIndex: i,
          narrative: part,
          action: part,
          spokenText: subIdx === 0 ? (b.spokenText || "") : "",
          isAtomized: true,
        });
      });
    } else {
      atomicBeats.push({
        ...b,
        beatIndex: beatCounter++,
        originalBeatIndex: i,
        action: actionText,
        isAtomized: false,
      });
    }
  }

  logger.info(`✅ [Atomic Beat Planner] Atomized into ${atomicBeats.length} single-action beats.`);
  return atomicBeats;
}

/**
 * Splits a compound action description into singular action clauses.
 */
function splitCompoundAction(actionText) {
  if (!actionText) return ["Continuous action"];

  // Split on clause connectors like ", and ", ", then ", " and then ", ", looking ", ", turning "
  // Pattern matches common action sequences: e.g., "walked to wall, climbed it, and jumped"
  const splitRegex = /,\s+(?:and\s+|then\s+|and\s+then\s+)?|;\s+|\s+and\s+then\s+/i;
  const parts = actionText.split(splitRegex).map(p => p.trim()).filter(Boolean);

  if (parts.length <= 1) return [actionText];

  return parts;
}
