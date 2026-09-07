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
 * Only when enabled should pre-written frame blocks be copied directly into prompts.
 */
export function isStoryGuidelinesOnlyForPromptsEnabled(options = {}) {
  if (options?.useStoryGuidelinesOnlyForPrompts !== undefined && options?.useStoryGuidelinesOnlyForPrompts !== null) {
    return options.useStoryGuidelinesOnlyForPrompts === true || String(options.useStoryGuidelinesOnlyForPrompts).toLowerCase() === "true";
  }
  return process.env.USE_STORY_GUIDELINES_ONLY_FOR_PROMPTS === "true" || config?.workflow?.useStoryGuidelinesOnlyForPrompts === true;
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
 * Strict implementation: locates all Frame ID / FRAME delimiters, starting from
 * each Frame ID and ending right before the next Frame ID.
 *
 * @param {string} text - Raw story guidelines string
 * @returns {Array<object>} Parsed frame objects with full verbatim content
 */
export function parseStoryGuidelineFrames(text) {
  if (!text || typeof text !== "string" || !text.trim()) return [];

  // Match all occurrences of Frame headers/delimiters
  // Matches "Frame ID: 001", "FRAME ID: 001", "Frame Id: 001", "# Frame ID: 001", "Frame 001", etc.
  const frameHeaderRegex = /(?:^|\r?\n)\s*(?:#+\s*)?(?:FRAME\s*ID\b(?:\s*[:\-]?\s*)?|FRAME\s+\d+)\b[^\r\n]*/gi;

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
    const numMatch = header.match(/\d+/) || block.match(/FRAME\s*ID\s*[:\-]?\s*(\d+)/i) || block.match(/FRAME\s+(\d+)/i);
    let frameNumber = numMatch ? parseInt(numMatch[0] || numMatch[1], 10) : (idx + 1);

    const fIdMatch = header.match(/FRAME\s*ID\s*[:\-]?\s*([^\r\n]+)/i) ||
                     block.match(/FRAME\s*ID\s*[:\-]?\s*([^\r\n]+)/i) ||
                     header.match(/(?:#+\s*)?(FRAME\s+[^\r\n]+)/i);
    let frameId = fIdMatch ? fIdMatch[1].trim() : `Frame ${String(frameNumber).padStart(3, "0")}`;
    const frameIdFormatted = `Frame ${String(frameNumber).padStart(3, "0")}`;

    // Extract Scene ID & Number if explicitly specified
    const scIdMatch = block.match(/SCENE\s*ID\s*[:\-]?\s*([^\r\n]+)/i) ||
                      block.match(/(?:^|\r?\n)#+\s*(SCENE\s+[^\r\n]+)/i);
    const sceneId = scIdMatch ? scIdMatch[1].trim() : null;
    let sceneNumber = null;
    if (sceneId) {
      const numM = sceneId.match(/\d+/);
      if (numM) sceneNumber = parseInt(numM[0], 10);
    }

    // Timestamp Range (if specified)
    const timeMatch = block.match(/(\d{1,2}:\d{2}(?::\d{2})?\s*[–\-~to]+\s*\d{1,2}:\d{2}(?::\d{2})?)/);
    const timeRange = timeMatch ? timeMatch[1].trim() : null;
    const { startSec, endSec } = parseTimeRange(timeRange);

    // Narration Beat (if specified)
    const narrMatch = block.match(/STORY\s*\/\s*NARRATION\s+BEAT\s*:\s*([^\r\n]+(?:\n(?!(?:[A-Z0-9\s\/_\-]+:)|##)[^\r\n]+)*)/i);
    const narrationBeat = narrMatch ? narrMatch[1].trim().replace(/\s+/g, " ") : null;

    // Visible Humans (if specified)
    const humans = [];
    const humanRegex = /VISIBLE\s+HUMAN\s+\d+\s*:\s*([^\r\n]+)/gi;
    let hm;
    while ((hm = humanRegex.exec(block)) !== null) {
      const name = hm[1].trim().replace(/\s*\(.*?\)/g, "");
      if (name && !humans.includes(name)) humans.push(name);
    }
    if (humans.length === 0) {
      const bulletRegex = /-\s+([A-Za-z0-9\s\-_"']+)\s*\([^)]*\):/g;
      let bm;
      while ((bm = bulletRegex.exec(block)) !== null) {
        const name = bm[1].trim();
        if (name && !humans.includes(name)) humans.push(name);
      }
    }

    // Negative constraints if present
    const negMatch = block.match(/NEGATIVE\s+CONSTRAINTS\s*:\s*([^\r\n]+(?:\n(?!(?:[A-Z0-9\s\/_\-]+:)|##)[^\r\n]+)*)/i);
    const negativePrompt = negMatch ? negMatch[1].trim() : "";

    // The FULL frame content block starts strictly from Frame ID up to next Frame ID
    const fullFramePrompt = block;

    // Sub-prompts as secondary convenience
    let imagePrompt = null;
    const imgPromptMatch = block.match(/##+\s*FINAL\s+IMAGE\s+PROMPT\s*([\s\S]*?)(?=(?:##+\s*FINAL[\s\S]*?MOTION\s+PROMPT|##+\s*MOTION\s+PROMPT|FRAME\s+QA:|FRAME\s+STATUS:|\n#+\s*FRAME|$))/i);
    if (imgPromptMatch) {
      imagePrompt = imgPromptMatch[1].trim();
    }

    let motionPrompt = null;
    const motPromptMatch = block.match(/##+\s*FINAL(?:\s+\d+[\s\-]*(?:SECOND|SEC)[\s\-]*)?\s*MOTION\s+PROMPT\s*([\s\S]*?)(?=(?:FRAME\s+QA:|FRAME\s+STATUS:|##|\n#+\s*FRAME|$))/i);
    if (motPromptMatch) {
      motionPrompt = motPromptMatch[1].trim();
    }

    parsed.push({
      index: idx,
      frameNumber,
      totalFrames: matches.length,
      frameId,
      frameIdFormatted,
      sceneId,
      sceneNumber,
      timeRange,
      startSec,
      endSec,
      narrationBeat,
      visibleHumans: humans,
      negativePrompt,
      fullFramePrompt,
      imagePrompt: imagePrompt || fullFramePrompt,
      motionPrompt: motionPrompt || fullFramePrompt,
      hasPrompts: Boolean(fullFramePrompt && (frameId || frameNumber !== null)),
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

  // 1. Strict Frame Number / Image Number match (Frame 001 strictly for first image, Frame 002 for second, etc.)
  for (let i = 0; i < parsedFrames.length; i++) {
    if (claimedIndices.has(i)) continue;
    const f = parsedFrames[i];
    if (
      f.frameNumber === targetFrameNum ||
      f.sceneNumber === targetFrameNum ||
      f.frameIdFormatted === targetFormattedTag
    ) {
      claimedIndices.add(i);
      return f;
    }
  }

  // 2. Explicit Scene / Segment ID match (e.g. "scene_001", "scene_1", "frame_001")
  const segId = segmentOrScene?.sceneId || segmentOrScene?.frameId || segmentOrScene?.id || "";
  if (segId) {
    const segNumM = String(segId).match(/\d+/);
    const segNum = segNumM ? parseInt(segNumM[0], 10) : null;
    if (segNum !== null) {
      for (let i = 0; i < parsedFrames.length; i++) {
        if (claimedIndices.has(i)) continue;
        const f = parsedFrames[i];
        if (f.frameNumber === segNum || f.sceneNumber === segNum) {
          claimedIndices.add(i);
          return f;
        }
      }
    }

    const cleanId = String(segId).toLowerCase().replace(/[^a-z0-9]/g, "");
    for (let i = 0; i < parsedFrames.length; i++) {
      if (claimedIndices.has(i)) continue;
      const f = parsedFrames[i];
      const fId = String(f.frameId || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const sId = String(f.sceneId || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if ((fId && cleanId === fId) || (sId && cleanId === sId)) {
        claimedIndices.add(i);
        return f;
      }
    }
  }

  // 3. Sequential 1-to-1 index fallback (e.g., sceneIndex 0 -> parsedFrames[0])
  if (sceneIndex < parsedFrames.length && !claimedIndices.has(sceneIndex)) {
    claimedIndices.add(sceneIndex);
    return parsedFrames[sceneIndex];
  }

  // 4. Timestamp overlap match (if timestamps are specified)
  let segStartSec = null;
  if (segmentOrScene?.startSec !== undefined && segmentOrScene?.startSec !== null) {
    segStartSec = Number(segmentOrScene.startSec);
  } else if (segmentOrScene?.startMs !== undefined && segmentOrScene?.startMs !== null) {
    segStartSec = Number(segmentOrScene.startMs) / 1000;
  }

  let segEndSec = null;
  if (segmentOrScene?.endSec !== undefined && segmentOrScene?.endSec !== null) {
    segEndSec = Number(segmentOrScene.endSec);
  } else if (segmentOrScene?.endMs !== undefined && segmentOrScene?.endMs !== null) {
    segEndSec = Number(segmentOrScene.endMs) / 1000;
  }

  if (segStartSec !== null && segEndSec !== null) {
    for (let i = 0; i < parsedFrames.length; i++) {
      if (claimedIndices.has(i)) continue;
      const f = parsedFrames[i];
      if (f.startSec !== null && f.endSec !== null) {
        const overlapStart = Math.max(segStartSec, f.startSec);
        const overlapEnd = Math.min(segEndSec, f.endSec);
        if (overlapEnd > overlapStart) {
          claimedIndices.add(i);
          return f;
        }
      }
    }
  }

  // 5. Narration text match as ultimate fallback
  const segText = segmentOrScene?.text || segmentOrScene?.narration || segmentOrScene?.narrative || "";
  if (segText && segText.length > 10) {
    const normSeg = normalizeText(segText);
    let bestMatchIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < parsedFrames.length; i++) {
      if (claimedIndices.has(i)) continue;
      const f = parsedFrames[i];
      if (!f.narrationBeat) continue;
      const normBeat = normalizeText(f.narrationBeat);

      if (normBeat.includes(normSeg) || normSeg.includes(normBeat)) {
        bestMatchIdx = i;
        bestScore = 1.0;
        break;
      }

      const sim = wordSimilarity(normSeg, normBeat);
      if (sim > 0.25 && sim > bestScore) {
        bestScore = sim;
        bestMatchIdx = i;
      }
    }

    if (bestMatchIdx !== -1 && bestScore >= 0.25) {
      claimedIndices.add(bestMatchIdx);
      return parsedFrames[bestMatchIdx];
    }
  }

  return null;
}
