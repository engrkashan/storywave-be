/**
 * speechValidator.js — Speech Validation & Per-Beat Audit Logger for Video Planner
 *
 * Implements Phase 5 (Speech Validation) & Phase 8 (Logging) for Video Mode.
 * Transcribes generated video clips, compares spoken audio against SpeechAllocation,
 * detects missing/extra/skipped/repeated words, and generates detailed validation logs.
 * Enables selective clip regeneration (only failed clips are regenerated).
 */

import fs from "fs";
import { extractAudioFromClip } from "../videoService.js";
import { transcribeWithTimestamps } from "../transcribeService.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("SpeechValidator");

/**
 * Validates spoken dialogue in a generated video clip against expected SpeechAllocation.
 *
 * @param {string} clipPath          - Path to rendered MP4 video clip
 * @param {object} expectedSpeech    - `speechAllocation` object for this beat
 * @param {object} beatOptions       - Beat metadata (beatId, durationSec, action, conversationState, etc.)
 * @returns {Promise<{ passed: boolean, accuracyPct: number, report: object }>} Validation result and report
 */
export async function validateClipSpeech(clipPath = "", expectedSpeech = {}, beatOptions = {}) {
  const sceneId = beatOptions.sceneId || `scene_${String((beatOptions.beatIndex || 0) + 1).padStart(3, "0")}`;
  const durationSec = beatOptions.durationSec || 5.0;
  const action = beatOptions.action || "Visual beat action";
  const speaker = expectedSpeech.speaker || beatOptions.characterName || "Subject";
  const conversationState = beatOptions.conversationState || {};

  // If no speech is expected for this beat, mark as PASSED
  if (!expectedSpeech || !expectedSpeech.spokenText || !expectedSpeech.spokenText.trim()) {
    const report = {
      beatId: sceneId,
      durationSec,
      action,
      speaker,
      expectedWords: [],
      actualWords: [],
      speechAccuracyPct: 100,
      validationResult: "PASSED (No Speech Expected)",
      conversationState,
      regenerated: false,
      finalStatus: "SUCCESS",
    };
    logBeatValidation(report);
    return { passed: true, accuracyPct: 100, report };
  }

  const expectedText = expectedSpeech.spokenText.trim();
  const expectedWords = expectedSpeech.expectedWords || expectedText.split(/\s+/).filter(Boolean);
  const expectedClean = expectedWords.map(cleanWord).filter(Boolean);

  let actualWords = [];
  let actualClean = [];
  let actualText = "";
  let tempWav = null;

  try {
    tempWav = clipPath.replace(/\.mp4$/i, `_val_${Date.now()}.wav`);
    await extractAudioFromClip(clipPath, tempWav);

    if (fs.existsSync(tempWav) && fs.statSync(tempWav).size > 100) {
      const transcriptJsonStr = await transcribeWithTimestamps(tempWav);
      const parsed = JSON.parse(transcriptJsonStr);
      actualWords = (parsed.words || []).map((w) => w.word.trim());
      actualClean = actualWords.map(cleanWord).filter(Boolean);
      actualText = actualWords.join(" ");
    }
  } catch (err) {
    logger.warn(`⚠️ [Speech Validation] Could not transcribe native audio for ${sceneId}: ${err.message}`);
  } finally {
    if (tempWav && fs.existsSync(tempWav)) {
      try { fs.unlinkSync(tempWav); } catch (_) {}
    }
  }

  // Calculate Speech Validation Metrics
  const missingWords = [];
  const extraWords = [];
  const repeatedWords = [];

  let matchedCount = 0;
  const actualSet = new Set(actualClean);
  const expectedSet = new Set(expectedClean);

  expectedClean.forEach((ew) => {
    if (actualSet.has(ew)) matchedCount++;
    else missingWords.push(ew);
  });

  actualClean.forEach((aw, idx) => {
    if (!expectedSet.has(aw)) extraWords.push(aw);
    if (idx > 0 && aw === actualClean[idx - 1]) repeatedWords.push(aw);
  });

  const accuracyPct = expectedClean.length > 0 ? Math.round((matchedCount / expectedClean.length) * 100) : 100;
  const skippedDialogue = missingWords.length === expectedClean.length && expectedClean.length > 0;
  const unexpectedSilence = actualClean.length === 0 && expectedClean.length > 0;

  // Pass threshold: >= 65% accuracy OR (short dialogue <=3 words with at least 1 match)
  const passed = !skippedDialogue && !unexpectedSilence && (accuracyPct >= 65 || (expectedClean.length <= 3 && matchedCount >= 1));

  const report = {
    beatId: sceneId,
    durationSec,
    action,
    speaker,
    expectedWords,
    actualWords,
    expectedText,
    actualText,
    speechAccuracyPct: accuracyPct,
    missingWords,
    extraWords,
    repeatedWords,
    skippedDialogue,
    unexpectedSilence,
    validationResult: passed ? "PASSED" : "FAILED",
    conversationState,
    regenerated: beatOptions.attempt > 1,
    finalStatus: passed ? "SUCCESS" : "RETRY_REQUIRED",
  };

  logBeatValidation(report);

  return {
    passed,
    accuracyPct,
    report,
  };
}

/**
 * Cleans word string for robust accuracy comparison.
 */
function cleanWord(w = "") {
  return String(w).toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

/**
 * Phase 8: Formats and logs comprehensive per-beat audit validation log.
 */
function logBeatValidation(report) {
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`📊 [BEAT AUDIT LOG] Beat ID: ${report.beatId} | Status: ${report.validationResult}`);
  logger.info(`   - Duration:           ${report.durationSec}s`);
  logger.info(`   - Speaker:            ${report.speaker}`);
  logger.info(`   - Action:             ${report.action}`);
  logger.info(`   - Expected Words:     "${report.expectedText || "(None)"}"`);
  logger.info(`   - Actual Spoken:      "${report.actualText || "(Silence / Unclear)"}"`);
  logger.info(`   - Accuracy:           ${report.speechAccuracyPct}%`);
  if (report.missingWords?.length > 0) logger.info(`   - Missing Words:      [${report.missingWords.join(", ")}]`);
  if (report.extraWords?.length > 0)   logger.info(`   - Extra/Leaked Words: [${report.extraWords.join(", ")}]`);
  if (report.conversationState?.currentSpeaker) {
    logger.info(`   - Conv State:         Speaker=${report.conversationState.currentSpeaker} | Next=${report.conversationState.nextExpectedSpeaker || "None"} | Phase=${report.conversationState.conversationPhase || "ongoing"}`);
  }
  logger.info(`   - Regenerated:        ${report.regenerated ? "YES" : "NO"}`);
  logger.info(`   - Final Status:       ${report.finalStatus}`);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}
