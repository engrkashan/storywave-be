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
import { validateBeatContinuity, validateTimelineContinuity, validateSceneTiming, validateSpeechNarrativeAlignment } from "./promptValidator.js";
import { buildStateBasedPrompt } from "./promptBuilder.js";
import { buildUnifiedSpeechTimeline, allocateSpeechToBeats, validateWordLedger } from "./speechTimelineService.js";
import { runPromptQualityPipeline } from "./pqa/promptQualityPipeline.js";
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
  // 1. Unified Speech Timeline Generator & Global Word Ledger (Phase 1)
  const speechTimeline = buildUnifiedSpeechTimeline(script, options.whisperWords || null, storyBible, options);

  const wordLedgerVal = validateWordLedger(script, speechTimeline);
  logger.info(`📖 [Word Ledger Audit] Total Script Words: ${wordLedgerVal.totalLedgerWords}, Assigned: ${wordLedgerVal.totalAssignedWords}, Missing: ${wordLedgerVal.missingWords.length}, Duplicates: ${wordLedgerVal.duplicateWords.length}`);

  const effectiveTargetCount = options.targetSceneCount || (speechTimeline.segments.length > 0 ? speechTimeline.segments.length : Math.max(1, Math.ceil((options.narrationDuration || 15) / 5)));
  const narrationDuration = speechTimeline.totalDuration > 0 ? speechTimeline.totalDuration : (options.narrationDuration || (effectiveTargetCount * 5.0));

  logger.info(`🚀 [Video Planner] Starting dedicated state-based video planning pipeline (Target Scene Count: ${effectiveTargetCount}, Authoritative Speech Duration: ${narrationDuration.toFixed(1)}s)...`);

  // 2. Narrative Timeline Generator: Analyze entire script into chronological beats constrained by effectiveTargetCount
  const rawNarrativeBeats = await generateNarrativeTimeline(script, storyBible, effectiveTargetCount);

  // 3. Atomic Beat Planner: Atomize compound beats only if below effectiveTargetCount
  const atomicBeats = planAtomicBeats(rawNarrativeBeats, effectiveTargetCount);

  // 4. Speech Allocation Engine: Allocate speech segments to beats strictly preserving sentence ownership
  const speechAllocatedBeats = allocateSpeechToBeats(atomicBeats, speechTimeline);

  // 5. Dynamic Duration Planner: Derive timing mathematically from speech bounds
  const durationPlannedBeats = planBeatDurations(speechAllocatedBeats, effectiveTargetCount, narrationDuration);

  // 6. Prompt Validator: Auto-detect missing transitions and validate continuity & timing
  let validatedBeats = validateBeatContinuity(durationPlannedBeats, effectiveTargetCount);

  // Hard Cap Safety: Ensure validatedBeats does not exceed effectiveTargetCount
  if (effectiveTargetCount && effectiveTargetCount > 0 && validatedBeats.length > effectiveTargetCount) {
    logger.info(`✂️ Hard capping final beats from ${validatedBeats.length} to target scene count (${effectiveTargetCount})...`);
    validatedBeats = validatedBeats.slice(0, effectiveTargetCount);
  }

  // Run Hard Timeline Validation
  const contVal = validateTimelineContinuity(validatedBeats);
  if (!contVal.valid) {
    logger.warn(`⚠️ [Timeline Continuity Warning]: ${contVal.errors.join(" | ")}`);
  }

  // 7. Scene State Engine + State-Based Prompt Builder
  let currentState = initializeSceneState(storyBible, validatedBeats[0] || {});
  const stateBasedPrompts = [];
  const totalBeatsCount = validatedBeats.length;

  for (let i = 0; i < validatedBeats.length; i++) {
    const currentBeat = validatedBeats[i];
    const nextBeat = validatedBeats[i + 1] || null;

    // Validate beat timing mathematically
    const timingVal = validateSceneTiming(currentBeat);
    if (!timingVal.valid) {
      logger.warn(`⚠️ Beat ${i + 1} timing validation error: ${timingVal.errors.join(" | ")}`);
    }

    const alignmentVal = validateSpeechNarrativeAlignment(currentBeat);
    if (!alignmentVal.valid) {
      logger.warn(`⚠️ Beat ${i + 1} speech-narrative alignment error: ${alignmentVal.errors.join(" | ")}`);
    }

    const promptObj = buildStateBasedPrompt(currentBeat, currentState, nextBeat, storyBible, { ...options, totalBeatsCount });
    stateBasedPrompts.push(promptObj);

    // Advance SceneState & ConversationState for the next beat
    currentState = updateSceneState(currentState, currentBeat, nextBeat, i, totalBeatsCount);
  }

  // 7.5 Dedicated Prompt Quality Assurance (PQA) Pipeline with Hard Failure Gate
  const auditedAndOptimizedPrompts = runPromptQualityPipeline(stateBasedPrompts, validatedBeats, storyBible, options);

  // 8. Build Master Timeline format compatible with videoService concat & timeline structures
  let totalDuration = 0;
  const scenes = validatedBeats.map((b, idx) => {
    const startSec = b.timing?.startSec !== undefined ? b.timing.startSec : totalDuration;
    const durationSec = b.timing?.durationSec || 5.0;
    const endSec = b.timing?.endSec !== undefined ? b.timing.endSec : startSec + durationSec;
    totalDuration = Math.max(totalDuration, endSec);

    return {
      index: idx,
      startSec,
      endSec,
      durationSec,
    };
  });

  logger.info(`✅ [Video Planner] Pipeline complete: ${auditedAndOptimizedPrompts.length} audited & continuous video prompts generated (Total Master Video Duration: ${totalDuration.toFixed(1)}s vs Speech Duration: ${narrationDuration.toFixed(1)}s).`);

  return {
    scenePrompts: auditedAndOptimizedPrompts,
    plannedScenes: scenes,
    totalDuration,
    speechTimeline,
  };
}
