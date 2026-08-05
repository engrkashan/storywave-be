/**
 * index.js — Video Planner Master Orchestrator
 *
 * Dedicated video planning layer isolated EXCLUSIVELY for Video Mode (mediaType === 'video').
 * Leaves all image generation and multi-image pipelines 100% untouched.
 */

import { generateNarrativeTimeline } from "./narrativeTimelineService.js";
import { planAtomicBeats } from "./atomicBeatPlanner.js";
import { planBeatDurations } from "./durationPlanner.js";
import { initializeSceneState, updateSceneState } from "./sceneStateEngine.js";
import { validateBeatContinuity } from "./promptValidator.js";
import { buildStateBasedPrompt } from "./promptBuilder.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("VideoPlannerOrchestrator");

/**
 * Executes the complete state-based video planning pipeline.
 *
 * @param {string} script        - Full narrative script text
 * @param {object} storyBible    - Story Bible metadata
 * @param {object} options       - Additional options (characterTalk, aspectRatio, etc.)
 * @returns {Promise<{ scenePrompts: Array<object>, videoTimeline: object }>} Planned scene prompts and timeline metadata
 */
export async function planDedicatedVideoPipeline(script, storyBible = {}, options = {}) {
  logger.info("🚀 [Video Planner] Starting dedicated state-based video planning pipeline...");

  // 1. Narrative Timeline Generator: Analyze entire script into chronological beats
  const rawNarrativeBeats = await generateNarrativeTimeline(script, storyBible);

  // 2. Atomic Beat Planner: Ensure 1 beat = 1 continuous visual event
  const atomicBeats = planAtomicBeats(rawNarrativeBeats);

  // 3. Dynamic Duration Planner: Estimate durations & split overlong beats naturally
  const durationPlannedBeats = planBeatDurations(atomicBeats);

  // 4. Prompt Validator: Auto-detect missing transitions and insert bridge beats (e.g. Landing)
  const validatedBeats = validateBeatContinuity(durationPlannedBeats);

  // 5. Scene State Engine + State-Based Prompt Builder
  let currentState = initializeSceneState(storyBible, validatedBeats[0] || {});
  const stateBasedPrompts = [];

  for (let i = 0; i < validatedBeats.length; i++) {
    const currentBeat = validatedBeats[i];
    const nextBeat = validatedBeats[i + 1] || null;

    const promptObj = buildStateBasedPrompt(currentBeat, currentState, nextBeat, storyBible, options);
    stateBasedPrompts.push(promptObj);

    // Advance SceneState for the next beat
    currentState = updateSceneState(currentState, currentBeat, nextBeat);
  }

  // 6. Build Master Timeline format compatible with videoService concat & timeline structures
  let totalDuration = 0;
  const scenes = validatedBeats.map((b, idx) => {
    const startSec = totalDuration;
    const durationSec = b.timing?.durationSec || 5.0;
    totalDuration += durationSec;
    return {
      index: idx,
      startSec,
      endSec: totalDuration,
      durationSec,
    };
  });

  logger.info(`✅ [Video Planner] Pipeline complete: ${stateBasedPrompts.length} action-continuous video prompts generated (Total Video Duration: ${totalDuration.toFixed(1)}s).`);

  return {
    scenePrompts: stateBasedPrompts,
    plannedScenes: scenes,
    totalDuration,
  };
}
