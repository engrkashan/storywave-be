/**
 * conversationStateEngine.js — Conversation State Engine for Video Planner
 *
 * Extends SceneStateEngine by maintaining structured, persistent ConversationState across dialogue beats.
 * Manages speaker turns, dialogue history, conversational context, and emotion flow.
 */

import { createLogger } from "../../utils/logger.js";

const logger = createLogger("ConversationStateEngine");

/**
 * Initializes starting ConversationState from Story Bible and initial beat metadata.
 *
 * @param {object} storyBible  - Story Bible metadata (characters, synopsis, etc.)
 * @param {object} initialBeat - First atomic beat
 * @returns {object} Structured ConversationState object
 */
export function initializeConversationState(storyBible = {}, initialBeat = {}) {
  const characters = storyBible?.characters || [];
  const mainChar = characters[0]?.name || initialBeat.characterName || "Subject";
  const hasMultipleCharacters = characters.length > 1;
  const secondaryChar = hasMultipleCharacters ? characters[1].name : null;

  const initialText = initialBeat.spokenText || initialBeat.narrationText || "";
  const initialSpeaker = initialBeat.characterName || mainChar;

  const conversationType = hasMultipleCharacters ? "dialogue" : "monologue";

  return {
    conversationType,
    currentSpeaker: initialSpeaker,
    previousSpeaker: null,
    conversationPhase: determineConversationPhase(0, 10, initialBeat.emotion),
    pendingReply: false,
    currentEmotion: initialBeat.emotion || "cinematic focus",
    dialogueContext: storyBible.synopsis || "Story dialogue",
    lastSpokenWords: initialText || "",
    nextExpectedSpeaker: (hasMultipleCharacters && secondaryChar !== initialSpeaker) ? secondaryChar : null,
    conversationHistory: initialText
      ? [{ speaker: initialSpeaker, text: initialText, timestamp: 0.0 }]
      : [],
  };
}

/**
 * Updates ConversationState sequentially after executing a beat.
 *
 * @param {object} currentState - Current ConversationState object
 * @param {object} executedBeat - Beat just executed
 * @param {object} nextBeat     - Upcoming beat (if any)
 * @param {number} beatIndex    - Index of executed beat
 * @param {number} totalBeats   - Total planned beats count
 * @returns {object} Updated ConversationState object
 */
export function updateConversationState(currentState = {}, executedBeat = {}, nextBeat = null, beatIndex = 0, totalBeats = 10) {
  const isMonologue = currentState.conversationType === "monologue";
  const speaker = executedBeat.characterName || currentState.currentSpeaker || "Subject";
  const spokenText = executedBeat.spokenText || executedBeat.speechAllocation?.spokenText || "";

  const prevSpeaker = currentState.currentSpeaker !== speaker ? currentState.currentSpeaker : currentState.previousSpeaker;
  const rawNextSpeaker = nextBeat?.characterName || null;
  const nextSpeaker = (!isMonologue && rawNextSpeaker && rawNextSpeaker !== speaker) ? rawNextSpeaker : null;

  const updatedHistory = [...(currentState.conversationHistory || [])];
  if (spokenText) {
    updatedHistory.push({
      speaker,
      text: spokenText,
      timestamp: executedBeat.timing?.startSec || 0.0,
    });
  }

  const pendingReply = Boolean(!isMonologue && nextBeat && nextBeat.spokenText && nextSpeaker && nextSpeaker !== speaker);

  return {
    ...currentState,
    currentSpeaker: speaker,
    previousSpeaker: isMonologue ? null : prevSpeaker,
    conversationPhase: determineConversationPhase(beatIndex + 1, totalBeats, executedBeat.emotion),
    pendingReply,
    currentEmotion: executedBeat.emotion || currentState.currentEmotion || "cinematic focus",
    dialogueContext: executedBeat.narrative || currentState.dialogueContext,
    lastSpokenWords: spokenText || currentState.lastSpokenWords,
    nextExpectedSpeaker: nextSpeaker,
    conversationHistory: updatedHistory.slice(-5),
  };
}

/**
 * Determines conversation phase based on narrative progression and emotional tone.
 */
function determineConversationPhase(beatIndex, totalBeats, emotion = "") {
  const progress = totalBeats > 0 ? beatIndex / totalBeats : 0;
  const lowerEmotion = (emotion || "").toLowerCase();

  if (lowerEmotion.includes("fight") || lowerEmotion.includes("yell") || lowerEmotion.includes("confront")) {
    return "confrontation";
  }
  if (lowerEmotion.includes("whisper") || lowerEmotion.includes("secret") || lowerEmotion.includes("suspense")) {
    return "suspenseful disclosure";
  }

  if (progress < 0.25) return "opening exchange";
  if (progress < 0.60) return "exposition & dialogue build";
  if (progress < 0.85) return "climax dialogue";
  return "resolution exchange";
}
