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
import { buildUnifiedSpeechTimeline, allocateSpeechToBeats } from "./speechTimelineService.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("VideoPlannerOrchestrator");

/**
 * Executes the complete state-based video planning pipeline.
 *
 * @param {string} script        - Full narrative script text
 * @param {object} storyBible    - Story Bible metadata
 * @param {object} options       - Additional options (characterTalk, aspectRatio, whisperWords, etc.)
 * @returns {Promise<{ scenePrompts: Array<object>, videoTimeline: object, speechTimeline: object }>} Planned scene prompts and timeline metadata
 */
export async function planDedicatedVideoPipeline(script, storyBible = {}, options = {}) {
  // 1. Unified Speech Timeline Generator (Phase 1)
  const speechTimeline = buildUnifiedSpeechTimeline(script, options.whisperWords || null, storyBible, options);

  const effectiveTargetCount = options.targetSceneCount || (speechTimeline.segments.length > 0 ? speechTimeline.segments.length : Math.max(1, Math.ceil((options.narrationDuration || 15) / 5)));
  const narrationDuration = options.narrationDuration || (effectiveTargetCount * 5.0);

  logger.info(`🚀 [Video Planner] Starting dedicated state-based video planning pipeline (Target Scene Count: ${effectiveTargetCount}, Narration Duration: ${narrationDuration.toFixed(1)}s)...`);

  // 2. Narrative Timeline Generator: Analyze entire script into chronological beats constrained by effectiveTargetCount
  const rawNarrativeBeats = await generateNarrativeTimeline(script, storyBible, effectiveTargetCount);

  // 3. Atomic Beat Planner: Atomize compound beats only if below effectiveTargetCount
  const atomicBeats = planAtomicBeats(rawNarrativeBeats, effectiveTargetCount);

  // 4. Dynamic Duration Planner: Estimate durations & split overlong beats naturally
  const durationPlannedBeats = planBeatDurations(atomicBeats, effectiveTargetCount, narrationDuration);

  // 5. Speech Allocation Engine: Allocate speech segments to beats strictly (Phase 2)
  const speechAllocatedBeats = allocateSpeechToBeats(durationPlannedBeats, speechTimeline);

  // 6. Prompt Validator: Auto-detect missing transitions and insert bridge beats only if below effectiveTargetCount
  let validatedBeats = validateBeatContinuity(speechAllocatedBeats, effectiveTargetCount);

  // Hard Cap Safety: Ensure validatedBeats does not exceed effectiveTargetCount
  if (effectiveTargetCount && effectiveTargetCount > 0 && validatedBeats.length > effectiveTargetCount) {
    logger.info(`✂️ Hard capping final beats from ${validatedBeats.length} to target scene count (${effectiveTargetCount})...`);
    validatedBeats = validatedBeats.slice(0, effectiveTargetCount);
  }

  // 7. Scene State Engine + State-Based Prompt Builder
  let currentState = initializeSceneState(storyBible, validatedBeats[0] || {});
  const stateBasedPrompts = [];
  const totalBeatsCount = validatedBeats.length;

  for (let i = 0; i < validatedBeats.length; i++) {
    const currentBeat = validatedBeats[i];
    const nextBeat = validatedBeats[i + 1] || null;

    const promptObj = buildStateBasedPrompt(currentBeat, currentState, nextBeat, storyBible, options);
    stateBasedPrompts.push(promptObj);

    // Advance SceneState & ConversationState for the next beat (Phase 3)
    currentState = updateSceneState(currentState, currentBeat, nextBeat, i, totalBeatsCount);
  }

  // 8. Build Master Timeline format compatible with videoService concat & timeline structures
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
    speechTimeline,
  };
}
