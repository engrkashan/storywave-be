/**
 * promptOptimizer.js — Prompt Optimizer & Diff Generator for PQA Pipeline
 *
 * Improves video prompts based on Auditor Reports without altering story events,
 * dialogue text, clip durations, or character identities.
 */

import { createLogger } from "../../../utils/logger.js";

const logger = createLogger("PromptOptimizer");

/**
 * Optimizes a video prompt object using the auditor report and history context.
 *
 * @param {object} promptObj      - Original video prompt object
 * @param {object} auditorReport  - Output from Prompt Auditor
 * @param {object} historyContext - Context from PromptHistoryTracker
 * @returns {object} Optimized prompt object with attached _pqaDiff
 */
export function optimizePrompt(promptObj = {}, auditorReport = {}, historyContext = {}) {
  let promptText = promptObj.prompt || "";
  const initialPromptText = promptText;
  const issues = auditorReport.issues || [];
  const changes = [];

  const beat = promptObj._beat || {};
  const sceneState = promptObj._sceneState || {};
  const spokenText = promptObj.narration || promptObj.speechAllocation?.spokenText || beat.spokenText || "";
  const clipDurationSec = promptObj.durationSec || beat.timing?.durationSec || 5.0;

  // 1. Remove Intra-Prompt & Cross-Beat Duplicated Dialogue
  if (spokenText) {
    // Check A: Intra-prompt duplicated speech header
    const speechHeaderCount = (promptText.match(/CHARACTER SPOKEN DIALOGUE:/g) || []).length;
    if (speechHeaderCount > 1) {
      const parts = promptText.split("\n\n");
      const filteredParts = [];
      let foundSpeech = false;

      for (const part of parts) {
        if (part.includes("CHARACTER SPOKEN DIALOGUE:")) {
          if (!foundSpeech) {
            filteredParts.push(part);
            foundSpeech = true;
          } else {
            changes.push(`Removed duplicate CHARACTER SPOKEN DIALOGUE section.`);
          }
        } else {
          filteredParts.push(part);
        }
      }
      promptText = filteredParts.join("\n\n");
    }

    // Check B: Cross-Beat Repetition Detector — Remove Dialogue duplicated from previous beats
    const isRepeatedDialogueIssue = issues.some(i => i.type === "Repeated Dialogue");
    const normSpoken = spokenText.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    const isPrevDuplicate = historyContext.previousDialogues && historyContext.previousDialogues.some((prevText) => {
      const normPrev = prevText.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
      return normPrev && (normPrev === normSpoken || (normPrev.length > 10 && normSpoken.includes(normPrev)));
    });

    if (isRepeatedDialogueIssue || isPrevDuplicate) {
      const parts = promptText.split("\n\n");
      const filteredParts = parts.filter((p) => !p.includes("CHARACTER SPOKEN DIALOGUE:"));
      promptText = filteredParts.join("\n\n");

      // Also clean up any inline quote of the spoken text
      if (spokenText && spokenText.length > 5) {
        const escapedSpoken = escapeRegExp(spokenText);
        promptText = promptText.replace(new RegExp(`"${escapedSpoken}"`, "gi"), "");
      }

      // Clear spoken text from prompt object so downstream clip generator won't attempt to render it again
      promptObj.narration = "";
      if (promptObj.speechAllocation) {
        promptObj.speechAllocation.spokenText = "";
        promptObj.speechAllocation.hasSpeech = false;
      }
      if (promptObj._beat) {
        promptObj._beat.spokenText = "";
      }

      changes.push(`Removed cross-beat duplicate dialogue "${spokenText}" (already spoken in previous beat).`);
    }
  }

  // 2. Cross-Beat Repetition Fix: Remove Repeated Actions already completed in previous beat
  if (historyContext.previousAction && issues.some(i => i.type === "Repeated Action")) {
    const prevActionNorm = historyContext.previousAction.trim().toLowerCase();
    // E.g., "Character smiles confidently." or "Character smooths hair."
    if (prevActionNorm && prevActionNorm.length > 5) {
      const actionSentences = promptText.split(/\.\s+/);
      const remainingSentences = [];

      for (const sentence of actionSentences) {
        const sentenceNorm = sentence.trim().toLowerCase();
        if (sentenceNorm.includes(prevActionNorm) && !sentence.includes("STARTING POSE:")) {
          changes.push(`Removed repeated action phrase "${sentence.trim()}" already completed in previous beat.`);
        } else {
          remainingSentences.push(sentence);
        }
      }
      promptText = remainingSentences.join(". ");
    }
  }

  // 3. Remove Redundant Cinematic Words & Duplicate Adjectives
  const buzzwordCleanups = [
    { word: "cinematic", max: 2 },
    { word: "photorealistic", max: 1 },
    { word: "hyper-realistic", max: 1 },
    { word: "8k ultra-detailed", max: 1 },
    { word: "8k", max: 1 },
    { word: "volumetric lighting", max: 1 },
  ];

  for (const item of buzzwordCleanups) {
    let count = 0;
    const isComplex = item.word.includes("-") || item.word.includes(" ");

    if (isComplex) {
      // Fix J-5: \b word-boundary doesn't work across hyphens or spaces in JS regex.
      // Use a case-insensitive split/rejoin to count and trim excess occurrences.
      const lowerPrompt = promptText.toLowerCase();
      let searchFrom = 0;
      const positions = [];
      while (true) {
        const idx = lowerPrompt.indexOf(item.word, searchFrom);
        if (idx === -1) break;
        positions.push(idx);
        searchFrom = idx + item.word.length;
      }
      // Remove occurrences beyond item.max (from last to first to preserve indices)
      const toRemove = positions.slice(item.max);
      for (let pi = toRemove.length - 1; pi >= 0; pi--) {
        const pos = toRemove[pi];
        promptText = promptText.slice(0, pos) + promptText.slice(pos + item.word.length);
        changes.push(`Removed redundant word "${item.word}" (exceeded ${item.max} instance limit).`);
      }
    } else {
      const regex = new RegExp(`\\b${escapeRegExp(item.word)}\\b`, "gi");
      promptText = promptText.replace(regex, (match) => {
        count++;
        if (count > item.max) {
          changes.push(`Removed redundant word "${item.word}" (exceeded ${item.max} instance limit).`);
          return "";
        }
        return match;
      });
    }
  }

  // Clean up double spaces or double commas left by word removal
  promptText = promptText
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/\.\s*\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 4. Inject Missing Pose Continuity if flagged
  if (issues.some(i => i.type === "Missing Pose Continuity")) {
    const charName = beat.characterName || sceneState.activeCharacter?.name || "Subject";
    const startingPose = sceneState.currentPose || "Standing in natural pose";
    const poseSection = `STARTING POSE: ${charName} begins in starting pose: ${startingPose}.`;

    if (!promptText.includes("STARTING POSE:")) {
      const lines = promptText.split("\n\n");
      // Insert after SCENE VISUALS or CINEMATOGRAPHY if available
      let insertIdx = 1;
      if (lines.length > 2 && lines[1].includes("CINEMATOGRAPHY:")) insertIdx = 2;
      lines.splice(insertIdx, 0, poseSection);
      promptText = lines.join("\n\n");
      changes.push(`Added missing STARTING POSE section.`);
    }
  }

  // 5. Inject Missing Stopping Boundary if flagged
  if (issues.some(i => i.type === "Missing Stopping Boundary")) {
    const currentAction = beat.action || beat.narrative || "Perform scene action";
    const startingPose = sceneState.currentPose || "natural posture";
    const nextActionText = historyContext.nextBeatSummary || "natural conclusion";
    const boundaryText = `ACTION CONTINUITY & BOUNDARY: Perform ONLY current action (${currentAction}) starting from initial pose (${startingPose}). Conclude clip smoothly at t=${clipDurationSec.toFixed(1)}s in a natural posture ready for ${nextActionText}. Do NOT repeat past actions.`;

    if (!promptText.includes("ACTION CONTINUITY & BOUNDARY:")) {
      promptText += `\n\n${boundaryText}`;
      changes.push(`Added missing ACTION CONTINUITY & BOUNDARY section.`);
    }
  }

  // 6. Inject Conversation State Boundary if missing and conversation active
  if (issues.some(i => i.type === "Ignored Conversation State")) {
    const convState = promptObj.conversationState || sceneState.conversationState || {};
    const charName = beat.characterName || sceneState.activeCharacter?.name || "Subject";
    if (convState.nextExpectedSpeaker && !promptText.includes("CONVERSATION FLOW:")) {
      const convBoundary = `CONVERSATION FLOW: ${charName} is actively engaging with ${convState.nextExpectedSpeaker}. Maintain direct eyeline and body orientation.`;
      promptText += `\n\n${convBoundary}`;
      changes.push(`Added missing CONVERSATION FLOW boundary.`);
    }
  }

  const diff = {
    before: initialPromptText,
    after: promptText,
    changes: changes.length > 0 ? changes : ["Prompt cleaned and formatted."],
  };

  return {
    ...promptObj,
    prompt: promptText,
    _pqaDiff: diff,
  };
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
