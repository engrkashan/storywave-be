/**
 * promptQualityValidator.js — Prompt Validator for PQA Pipeline
 *
 * Performs post-optimization structural validation checks to verify that
 * all required scene, dialogue, character, action, camera, and boundary
 * specifications are intact.
 */

import { createLogger } from "../../../utils/logger.js";

const logger = createLogger("PromptQualityValidator");

/**
 * Validates an optimized video prompt object.
 *
 * @param {object} promptObj - Optimized video prompt object
 * @returns {{ valid: boolean, errors: Array<string> }} Validation result
 */
export function validatePromptStructure(promptObj = {}) {
  const promptText = promptObj.prompt || "";
  const beat = promptObj._beat || {};
  const spokenText = promptObj.narration || promptObj.speechAllocation?.spokenText || beat.spokenText || "";
  const errors = [];

  // 1. Dialogue verification (if beat has active character talk dialogue)
  const isCharacterTalk = beat.characterTalk === true || promptObj.speechAllocation?.isCharacterTalk === true || promptText.includes("CHARACTER SPOKEN DIALOGUE:");
  if (isCharacterTalk && spokenText) {
    if (!promptText.includes("CHARACTER SPOKEN DIALOGUE:") && !promptText.includes(spokenText)) {
      errors.push("Missing required dialogue text in prompt.");
    }
  }

  // 2. Character existence check
  if (!promptText.includes("SCENE VISUALS:") && !promptObj.charactersInScene) {
    errors.push("Missing character identity specifications.");
  }

  // 3. Action existence check
  if (!promptText.includes("COMPLETE ACTION VISUALS:") && !beat.action) {
    errors.push("Missing character action visual instructions.");
  }

  // 4. Camera existence check
  if (!promptText.includes("CINEMATOGRAPHY:")) {
    errors.push("Missing cinematography/camera specifications.");
  }

  // 5. Scene/Location existence check
  if (!promptText.includes("Location:")) {
    errors.push("Missing scene location environment specification.");
  }

  // 6. Stopping boundary check
  if (!promptText.includes("ACTION CONTINUITY & BOUNDARY:") && !promptText.includes("Conclude clip smoothly")) {
    errors.push("Missing stopping boundary specification.");
  }

  // 7. Conversation state check (if active)
  const convState = promptObj.conversationState || beat.conversationState || {};
  if (convState.nextExpectedSpeaker && !promptText.includes("CONVERSATION FLOW:")) {
    errors.push("Missing required conversation flow eyeline boundary.");
  }

  // 8. Required cinematic instructions check
  if (!promptText.includes("VISUAL STYLE:")) {
    errors.push("Missing required visual style cinematic instructions.");
  }

  const isValid = errors.length === 0;

  if (!isValid) {
    logger.warn(`⚠️ [PQA Validator] Prompt validation failed with ${errors.length} errors: ${errors.join(" | ")}`);
  }

  return {
    valid: isValid,
    errors,
  };
}
