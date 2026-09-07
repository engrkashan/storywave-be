/**
 * storyGuidelineParser.js — Story Guidelines Frame Parser & Matcher
 *
 * Extracts pre-written frame blocks from user-supplied story guidelines.
 * Each frame block begins with `# FRAME ...` / `FRAME ID:` and extends up to
 * the next frame heading. The entire verbatim block is preserved and copied
 * directly as the scene prompt without LLM re-synthesis.
 */

import { createLogger } from "./logger.js";
import { config } from "../config/workflow.config.js";

const logger = createLogger("StoryGuidelineParser");

/**
 * Checks if the USE_STORY_GUIDELINES_ONLY_FOR_PROMPTS feature gate is active.
 * Environment variable takes absolute precedence.
 */
export function isStoryGuidelinesOnlyForPromptsEnabled(options = {}) {
  // If environment variable is enabled, it strictly takes precedence over frontend/options
  if (process.env.USE_STORY_GUIDELINES_ONLY_FOR_PROMPTS === "true" || config?.workflow?.useStoryGuidelinesOnlyForPrompts === true) {
    return true;
  }
  if (options?.useStoryGuidelinesOnlyForPrompts !== undefined && options?.useStoryGuidelinesOnlyForPrompts !== null) {
    return options.useStoryGuidelinesOnlyForPrompts === true || String(options.useStoryGuidelinesOnlyForPrompts).toLowerCase() === "true";
  }
  return false;
}

/**
 * Parses timestamp string like "00:24:40–00:24:50" or "01:15-01:25" into startSec and endSec.
 */
export function parseTimeRange(str) {
  if (!str) return { startSec: null, endSec: null };
  const m = str.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*[–\-~to]+\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
  if (!m) return { startSec: null, endSec: null };
  const toSec = (t) => {
    const p = t.split(":").map(Number);
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return null;
  };
  return { startSec: toSec(m[1]), endSec: toSec(m[2]) };
}

/**
 * Normalizes text for keyword / similarity comparison.
 */
export function normalizeText(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Computes Jaccard word similarity between two texts.
 */
export function wordSimilarity(textA, textB) {
  const wordsA = new Set(normalizeText(textA).split(" ").filter(w => w.length > 3));
  const wordsB = new Set(normalizeText(textB).split(" ").filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

/**
 * Parses storyGuidelines into an array of structured frame objects.
 * Strict implementation: locates all Frame ID delimiters (case-insensitive), starting from
 * each Frame ID and ending right before the next Frame ID.
 *
 * @param {string} text - Raw story guidelines string
 * @returns {Array<object>} Parsed frame objects with full verbatim content
 */
export function parseStoryGuidelineFrames(text) {
  if (!text || typeof text !== "string" || !text.trim()) return [];

  // Match all occurrences of Frame ID headers/delimiters (case-insensitive)
  // Matches "Frame ID: 001", "FRAME ID: 001", "frame id: 001", "# Frame ID: 001", "## FRAME ID: 002", etc.
  const frameHeaderRegex = /(?:^|\r?\n)\s*(?:#+\s*)?FRAME\s*ID\b(?:\s*[:\-]?\s*)?[^\r\n]*/gi;

  const matches = [];
  let m;
  while ((m = frameHeaderRegex.exec(text)) !== null) {
    const matchStr = m[0];
    const leadingWhitespaceMatch = matchStr.match(/^[\r\n\s]+/);
    const leadingOffset = leadingWhitespaceMatch ? leadingWhitespaceMatch[0].length : 0;
    const actualStart = m.index + leadingOffset;

    matches.push({
      start: actualStart,
      headerLine: text.slice(actualStart, m.index + matchStr.length).trim(),
    });
  }

  if (matches.length === 0) {
    return [];
  }

  const parsed = [];

  for (let idx = 0; idx < matches.length; idx++) {
    const currentStart = matches[idx].start;
    const nextStart = idx + 1 < matches.length ? matches[idx + 1].start : text.length;

    // Strict slicing: Starting exactly from current Frame ID header, ending right before the next Frame ID header
    const block = text.slice(currentStart, nextStart).trim();
    if (!block) continue;

    // Extract frame number & identifier
    const header = matches[idx].headerLine;
    const numMatch = header.match(/\d+/) || block.match(/FRAME\s*ID\s*[:\-]?\s*(\d+)/i);
    let frameNumber = numMatch ? parseInt(numMatch[0] || numMatch[1], 10) : (idx + 1);

    const fIdMatch = header.match(/FRAME\s*ID\s*[:\-]?\s*([^\r\n]+)/i) ||
                     block.match(/FRAME\s*ID\s*[:\-]?\s*([^\r\n]+)/i);
    let frameId = fIdMatch ? fIdMatch[1].trim() : `Frame ${String(frameNumber).padStart(3, "0")}`;
    const frameIdFormatted = `Frame ${String(frameNumber).padStart(3, "0")}`;

    // Negative constraints if present
    const negMatch = block.match(/NEGATIVE\s+CONSTRAINTS\s*:\s*([^\r\n]+(?:\n(?!(?:[A-Z0-9\s\/_\-]+:)|##)[^\r\n]+)*)/i);
    const negativePrompt = negMatch ? negMatch[1].trim() : "";

    // The FULL frame content block starts strictly from Frame ID up to next Frame ID
    const fullFramePrompt = block;

    parsed.push({
      index: idx,
      frameNumber,
      totalFrames: matches.length,
      frameId,
      frameIdFormatted,
      negativePrompt,
      fullFramePrompt,
      imagePrompt: fullFramePrompt,
      motionPrompt: fullFramePrompt,
      hasPrompts: true,
    });
  }

  logger.info(`📋 [StoryGuidelineParser] Parsed ${parsed.length} pre-defined frame block(s) strictly delimited by Frame ID.`);
  return parsed;
}

/**
 * Finds the best matching guideline frame for a given scene or audio segment.
 *
 * Matching priorities:
 *   1. Strict Frame Number match (Frame 001 strictly for first image/scene, Frame 002 for second, etc.)
 *   2. Explicit Scene ID / Segment ID number match
 *   3. Sequential 1-to-1 index fallback
 *   4. Timestamp range overlap
 *   5. Narration Beat text substring or word similarity
 *
 * @param {object} segmentOrScene - Scene or narration segment
 * @param {number} sceneIndex     - 0-based scene index (0 = 1st image/scene)
 * @param {number} totalScenes    - Total scene count
 * @param {Array<object>} parsedFrames - Output from parseStoryGuidelineFrames
 * @param {Set<number>} claimedIndices - Set of claimed frame indices to avoid duplicates
 * @returns {object|null} Matched frame object or null
 */
export function findMatchingGuidelineFrame(segmentOrScene, sceneIndex, totalScenes, parsedFrames, claimedIndices = new Set()) {
  if (!parsedFrames || parsedFrames.length === 0) return null;

  const targetFrameNum = sceneIndex + 1; // 1 for first image, 2 for second image, etc.
  const targetFormattedTag = `Frame ${String(targetFrameNum).padStart(3, "0")}`;

  // 1. Strict Frame Number match (Frame 001 for first image, Frame 002 for second, etc.)
  for (let i = 0; i < parsedFrames.length; i++) {
    if (claimedIndices.has(i)) continue;
    const f = parsedFrames[i];
    if (
      f.frameNumber === targetFrameNum ||
      f.frameIdFormatted === targetFormattedTag
    ) {
      claimedIndices.add(i);
      return f;
    }
  }

  // 2. Sequential 1-to-1 index fallback (e.g., sceneIndex 0 -> parsedFrames[0])
  if (sceneIndex < parsedFrames.length && !claimedIndices.has(sceneIndex)) {
    claimedIndices.add(sceneIndex);
    return parsedFrames[sceneIndex];
  }

  // 3. Fallback to any unclaimed frame or modulo wrapping
  for (let i = 0; i < parsedFrames.length; i++) {
    if (!claimedIndices.has(i)) {
      claimedIndices.add(i);
      return parsedFrames[i];
    }
  }

  return parsedFrames[sceneIndex % parsedFrames.length];
}
