/**
 * promptAuditor.js — Prompt Auditor & Cross-Beat Repetition Detector for PQA Pipeline
 *
 * Analysis ONLY. Inspects state-based video prompts and context to generate
 * a structured quality report detailing dialogue, action, camera, scene, continuity,
 * and length issues.
 */

import { calculatePromptScore } from "./promptScorer.js";

/**
 * Audits a video prompt object against current beat, scene state, and history context.
 *
 * @param {object} promptObj      - Generated video prompt object
 * @param {object} historyContext - Context from PromptHistoryTracker
 * @returns {object} Auditor report with score, categories, and issues
 */
export function auditPrompt(promptObj = {}, historyContext = {}) {
  const promptText = typeof promptObj === "string" ? promptObj : (promptObj.prompt || "");
  const beat = promptObj._beat || {};
  const sceneState = promptObj._sceneState || {};
  const directorObj = promptObj._directorObject || {};
  const speechAlloc = promptObj.speechAllocation || beat.speechAllocation || {};
  const convState = promptObj.conversationState || sceneState.conversationState || {};
  const spokenText = promptObj.narration || speechAlloc.spokenText || beat.spokenText || beat.narrationText || "";
  const clipDuration = promptObj.durationSec || beat.timing?.durationSec || 5.0;

  const issues = [];
  const categories = {
    continuity: 100,
    dialogue: 100,
    camera: 100,
    action: 100,
    scene: 100,
    length: 100,
    readability: 100,
  };

  // ── 1. Dialogue Inspection ──────────────────────────────────────────────────
  if (spokenText) {
    // Check A: Dialogue duplicated inside current prompt (intra-prompt duplication)
    const quoteMatches = promptText.match(new RegExp(`"${escapeRegExp(spokenText)}"`, "gi"));
    if (quoteMatches && quoteMatches.length > 1) {
      issues.push({
        type: "Repeated Dialogue",
        severity: "High",
        description: `Dialogue text "${truncateText(spokenText, 30)}" appears duplicated inside current prompt text.`,
      });
    }

    // Check B: Cross-Beat Repetition Detector — Dialogue duplicated from previous beats
    if (historyContext.previousDialogues && historyContext.previousDialogues.length > 0) {
      const normalizedCurrentSpoken = normalizeText(spokenText);
      const isPrevDuplicate = historyContext.previousDialogues.some((prevText) => {
        const normPrev = normalizeText(prevText);
        return normPrev && (normPrev === normalizedCurrentSpoken || (normPrev.length > 10 && normalizedCurrentSpoken.includes(normPrev)));
      });

      if (isPrevDuplicate) {
        issues.push({
          type: "Repeated Dialogue",
          severity: "High",
          description: `Dialogue "${truncateText(spokenText, 30)}" is identical or duplicated from previous beat.`,
        });
      }
    }

    // Check C: Dialogue longer than allocated duration (speech window vs word count)
    const wordCount = spokenText.trim().split(/\s+/).length;
    const maxWordsForDuration = Math.ceil(clipDuration * 3.2); // ~3.2 words/sec max speak rate
    if (wordCount > maxWordsForDuration) {
      issues.push({
        type: "Dialogue Length Exceeded",
        severity: "Medium",
        description: `Dialogue contains ${wordCount} words for allocated clip duration of ${clipDuration.toFixed(1)}s (max recommended: ${maxWordsForDuration} words).`,
      });
    }

    // Check D: Dialogue leaking into next beat
    if (historyContext.nextBeatSummary) {
      const nextSummaryNorm = normalizeText(historyContext.nextBeatSummary);
      const spokenNorm = normalizeText(spokenText);
      if (spokenNorm && nextSummaryNorm.includes(spokenNorm)) {
        issues.push({
          type: "Dialogue Leaking Into Next Beat",
          severity: "Medium",
          description: `Spoken dialogue appears to leak into or overlap with next beat narrative.`,
        });
      }
    }

    // Check E: Inconsistent with Speech Allocation
    if (speechAlloc.spokenText && speechAlloc.spokenText !== spokenText) {
      issues.push({
        type: "Speech Allocation Mismatch",
        severity: "Low",
        description: `Prompt spoken text differs from Speech Allocation assigned text.`,
      });
    }
  }

  // ── 2. Action Inspection ────────────────────────────────────────────────────
  const currentAction = beat.action || beat.narrative || "";
  const normCurrentAction = normalizeText(currentAction);

  if (normCurrentAction) {
    // Check A: Repeated action within prompt
    const actionOccurrences = countOccurrences(promptText, currentAction);
    if (actionOccurrences > 2) {
      issues.push({
        type: "Repeated Action",
        severity: "Medium",
        description: `Action "${truncateText(currentAction, 30)}" is repeatedly stated ${actionOccurrences} times in the prompt.`,
      });
    }

    // Check B: Cross-Beat Repetition Detector — Action already completed in previous beat
    if (historyContext.previousAction) {
      const normPrevAction = normalizeText(historyContext.previousAction);
      if (normPrevAction && isSubstantialMatch(normCurrentAction, normPrevAction)) {
        issues.push({
          type: "Repeated Action",
          severity: "High",
          description: `Character action "${truncateText(currentAction, 30)}" is identical to completed action in previous beat.`,
        });
      }
    }

    // Check C: Multiple conflicting actions within prompt (e.g. running while sitting)
    if (
      (normCurrentAction.includes("run") || normCurrentAction.includes("sprint")) &&
      (normCurrentAction.includes("sit") || normCurrentAction.includes("seated"))
    ) {
      issues.push({
        type: "Conflicting Actions",
        severity: "High",
        description: `Prompt describes conflicting simultaneous physical actions (e.g. running while seated).`,
      });
    }
  }

  // ── 3. Camera Inspection ────────────────────────────────────────────────────
  const cameraPlan = directorObj.cameraPlan || {};
  const currentCameraMove = cameraPlan.rig || cameraPlan.movement || "";
  const normCameraMove = normalizeText(currentCameraMove);

  if (normCameraMove) {
    // Check A: Cross-Beat Repetition Detector — Repeated identical camera motion across consecutive beats
    if (historyContext.previousCamera) {
      const normPrevCamera = normalizeText(historyContext.previousCamera);
      if (normPrevCamera && normCameraMove === normPrevCamera && historyContext.previousCameras?.length >= 2) {
        const lastTwoMatch = historyContext.previousCameras.slice(-2).every(c => normalizeText(c) === normCameraMove);
        if (lastTwoMatch) {
          issues.push({
            type: "Repeated Camera Motion",
            severity: "Medium",
            description: `Identical camera movement ("${currentCameraMove}") repeated across 3 consecutive beats.`,
          });
        }
      }
    }

    // Check B: Contradictory camera instructions inside prompt
    const hasPanLeft = /pan(ning)?\s+left/i.test(promptText);
    const hasPanRight = /pan(ning)?\s+right/i.test(promptText);
    const hasZoomIn = /zoom(ing)?\s+in/i.test(promptText);
    const hasZoomOut = /zoom(ing)?\s+out/i.test(promptText);

    if ((hasPanLeft && hasPanRight) || (hasZoomIn && hasZoomOut)) {
      issues.push({
        type: "Contradictory Camera Instructions",
        severity: "High",
        description: `Prompt contains contradictory camera movements (e.g. simultaneous pan left & right or zoom in & out).`,
      });
    }
  }

  // ── 4. Scene Inspection ─────────────────────────────────────────────────────
  // Check A: Repeated environment descriptions inside prompt
  const locName = sceneState.currentLocation || beat.location || "";
  if (locName) {
    const locMatches = countOccurrences(promptText, locName);
    if (locMatches > 2) {
      issues.push({
        type: "Repeated Environment Description",
        severity: "Low",
        description: `Environment location "${locName}" is repeated ${locMatches} times in prompt.`,
      });
    }
  }

  // Check B: Redundant lighting & character identity descriptions
  const lightingStr = sceneState.environment || "lighting";
  if (lightingStr && countOccurrences(promptText, lightingStr) > 2) {
    issues.push({
      type: "Repeated Lighting Description",
      severity: "Low",
      description: `Lighting details ("${truncateText(lightingStr, 25)}") repeated multiple times in prompt.`,
    });
  }

  // ── 5. Continuity Inspection ────────────────────────────────────────────────
  // Check A: Starting pose exists and matches SceneState
  if (!promptText.includes("STARTING POSE:")) {
    issues.push({
      type: "Missing Pose Continuity",
      severity: "High",
      description: `Prompt lacks explicit STARTING POSE specification.`,
    });
  }

  // Check B: Stopping boundary exists
  if (!promptText.includes("ACTION CONTINUITY & BOUNDARY:") && !promptText.includes("Conclude clip smoothly")) {
    issues.push({
      type: "Missing Stopping Boundary",
      severity: "High",
      description: `Prompt lacks explicit stopping boundary specification for motion control.`,
    });
  }

  // Check C: Ignored Conversation State when speech allocation active
  if (spokenText && convState.nextExpectedSpeaker && !promptText.includes("CONVERSATION FLOW:")) {
    issues.push({
      type: "Ignored Conversation State",
      severity: "Medium",
      description: `Spoken dialogue beat active but conversation flow eyeline boundary is missing.`,
    });
  }

  // ── 6. Length & Readability Inspection ──────────────────────────────────────
  const len = promptText.length;
  if (len < 100) {
    issues.push({
      type: "Prompt Too Short",
      severity: "High",
      description: `Prompt length (${len} chars) is under minimum recommended detail threshold (100 chars).`,
    });
  } else if (len > 1400) {
    issues.push({
      type: "Prompt Too Long",
      severity: "Medium",
      description: `Prompt length (${len} chars) exceeds recommended max length (1400 chars).`,
    });
  }

  // Check duplicate cinematic buzzwords
  const buzzwords = ["cinematic", "photorealistic", "8k", "hyper-realistic", "volumetric", "ultra-detailed"];
  for (const bw of buzzwords) {
    const bwCount = countOccurrences(promptText, bw);
    if (bwCount > 2) {
      issues.push({
        type: "Repeated Cinematic Language",
        severity: "Low",
        description: `Buzzword "${bw}" is redundantly repeated ${bwCount} times in prompt.`,
      });
    }
  }

  const { score, categories: scoredCategories } = calculatePromptScore(categories, issues);

  return {
    score,
    categories: scoredCategories,
    issues,
    promptLength: len,
  };
}

// ── Helper Utilities ──────────────────────────────────────────────────────────

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(str = "") {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().replace(/\s+/g, " ");
}

function truncateText(str = "", maxLen = 30) {
  if (!str) return "";
  return str.length > maxLen ? str.substring(0, maxLen) + "..." : str;
}

function countOccurrences(text = "", phrase = "") {
  if (!phrase || !text) return 0;
  const escaped = escapeRegExp(phrase);
  const matches = text.match(new RegExp(escaped, "gi"));
  return matches ? matches.length : 0;
}

function isSubstantialMatch(normA, normB) {
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  // Match if >80% phrase overlap for strings > 12 chars
  if (normA.length > 12 && normB.length > 12) {
    return normA.includes(normB) || normB.includes(normA);
  }
  return false;
}
