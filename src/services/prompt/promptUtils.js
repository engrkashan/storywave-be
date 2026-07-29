/**
 * promptUtils.js — Prompt formatting & cleaning utilities
 */

export function cleanPromptText(text) {
  if (!text) return "";
  return text
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function validateNoShorthand(prompt) {
  const forbiddenPatterns = [
    /same as (previous|before|above)/i,
    /unchanged|identical to/i,
    /continues unchanged/i,
  ];
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(prompt)) {
      return { valid: false, reason: `Contains forbidden shorthand pattern: ${pattern}` };
    }
  }
  return { valid: true };
}
