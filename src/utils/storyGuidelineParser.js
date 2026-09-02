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
 * Uses key word "FRAME ID" and `# FRAME` to detect and delimit frames.
 *
 * @param {string} text - Raw story guidelines string
 * @returns {Array<object>} Parsed frame objects with full verbatim content
 */
export function parseStoryGuidelineFrames(text) {
  if (!text || typeof text !== "string" || !text.trim()) return [];

  // Check if text contains FRAME ID or # FRAME
  const hasFrameId = /FRAME\s+ID\s*:/i.test(text);
  const hasFrameHeading = /(?:^|\n)#+\s*FRAME\b/i.test(text);

  if (!hasFrameId && !hasFrameHeading) {
    return [];
  }

  let rawBlocks = [];

  if (hasFrameHeading) {
    // Split on `# FRAME` headings
    rawBlocks = text
      .split(/(?:^|\n)(?=#+\s*FRAME\b)/i)
      .map(b => b.trim())
      .filter(Boolean);
  } else {
    // Split on `FRAME ID:` headers
    rawBlocks = text
      .split(/(?:^|\n)(?=FRAME\s+ID\s*:)/i)
      .map(b => b.trim())
      .filter(Boolean);
  }

  const parsed = [];

  for (let idx = 0; idx < rawBlocks.length; idx++) {
    const block = rawBlocks[idx];
    if (!block) continue;

    // 1. Frame ID (primary key word)
    const fIdMatch = block.match(/FRAME\s+ID\s*:\s*([A-Za-z0-9_\-]+)/i);
    const frameId = fIdMatch ? fIdMatch[1].trim() : null;

    // 2. Frame Number & Total Frames
    let frameNumber = null;
    let totalFrames = null;
    const fnMatch = block.match(/(?:#+\s*FRAME\s+|FRAME\s+ID\s*:\s*F?|FRAME\s+)(\d+)(?:\s+OF\s+(\d+))?/i);
    if (fnMatch) {
      frameNumber = parseInt(fnMatch[1], 10);
      if (fnMatch[2]) totalFrames = parseInt(fnMatch[2], 10);
    } else if (frameId) {
      const numM = frameId.match(/\d+/);
      if (numM) frameNumber = parseInt(numM[0], 10);
    }

    // 3. Scene ID & Number
    const scIdMatch = block.match(/SCENE\s+ID\s*:\s*([A-Za-z0-9_\-]+)/i);
    const sceneId = scIdMatch ? scIdMatch[1].trim() : null;
    let sceneNumber = null;
    if (sceneId) {
      const numM = sceneId.match(/\d+/);
      if (numM) sceneNumber = parseInt(numM[0], 10);
    }

    // 4. Timestamp Range
    const timeMatch = block.match(/(\d{1,2}:\d{2}(?::\d{2})?\s*[–\-~to]+\s*\d{1,2}:\d{2}(?::\d{2})?)/);
    const timeRange = timeMatch ? timeMatch[1].trim() : null;
    const { startSec, endSec } = parseTimeRange(timeRange);

    // 5. Narration Beat
    const narrMatch = block.match(/STORY\s*\/\s*NARRATION\s+BEAT\s*:\s*([^\r\n]+(?:\n(?!(?:[A-Z0-9\s\/_\-]+:)|##)[^\r\n]+)*)/i);
    const narrationBeat = narrMatch ? narrMatch[1].trim().replace(/\s+/g, " ") : null;

    // 6. Visible Humans
    const humans = [];
    const humanRegex = /VISIBLE\s+HUMAN\s+\d+\s*:\s*([^\r\n]+)/gi;
    let hm;
    while ((hm = humanRegex.exec(block)) !== null) {
      const name = hm[1].trim().replace(/\s*\(.*?\)/g, "");
      if (name && !humans.includes(name)) humans.push(name);
    }

    // Also parse from VISIBLE HUMANS bullet list if none found above
    if (humans.length === 0) {
      const bulletRegex = /-\s+([A-Za-z0-9\s\-_"']+)\s*\([^)]*\):/g;
      let bm;
      while ((bm = bulletRegex.exec(block)) !== null) {
        const name = bm[1].trim();
        if (name && !humans.includes(name)) humans.push(name);
      }
    }

    // 7. Extract negative constraints if present
    const negMatch = block.match(/NEGATIVE\s+CONSTRAINTS\s*:\s*([^\r\n]+(?:\n(?!(?:[A-Z0-9\s\/_\-]+:)|##)[^\r\n]+)*)/i);
    const negativePrompt = negMatch ? negMatch[1].trim() : "";

    // 8. The FULL frame content block is the prompt (lengthy but perfect)
    const fullFramePrompt = block.trim();

    // 9. Sub-prompts as secondary convenience
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
      totalFrames,
      frameId,
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

  logger.info(`📋 [StoryGuidelineParser] Parsed ${parsed.length} pre-defined frame block(s) using key word "FRAME ID".`);
  return parsed;
}

/**
 * Finds the best matching guideline frame for a given scene or audio segment.
 *
 * Matching priorities:
 *   1. Explicit Frame ID or Scene ID match
 *   2. Narration Beat text substring or word similarity
 *   3. Timestamp range overlap
 *   4. Exact Frame Number / Scene Number match (1-based index)
 *   5. Sequential 1-to-1 index fallback
 *
 * @param {object} segmentOrScene - Scene or narration segment
 * @param {number} sceneIndex     - 0-based scene index
 * @param {number} totalScenes    - Total scene count
 * @param {Array<object>} parsedFrames - Output from parseStoryGuidelineFrames
 * @param {Set<number>} claimedIndices - Set of claimed frame indices to avoid duplicates
 * @returns {object|null} Matched frame object or null
 */
export function findMatchingGuidelineFrame(segmentOrScene, sceneIndex, totalScenes, parsedFrames, claimedIndices = new Set()) {
  if (!parsedFrames || parsedFrames.length === 0) return null;

  const segText = segmentOrScene?.text || segmentOrScene?.narration || segmentOrScene?.narrative || "";

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

  const segId = segmentOrScene?.sceneId || segmentOrScene?.frameId || segmentOrScene?.id || "";

  // 1. Explicit ID match (frameId or sceneId)
  if (segId) {
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

  // 2. Narration text match (substring or word similarity >= 0.25)
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

  // 3. Timestamp overlap match
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

  // 4. Exact Frame Number / Scene Number match (1-based index)
  const targetFrameNum = sceneIndex + 1;
  for (let i = 0; i < parsedFrames.length; i++) {
    if (claimedIndices.has(i)) continue;
    const f = parsedFrames[i];
    if (f.frameNumber === targetFrameNum || f.sceneNumber === targetFrameNum) {
      claimedIndices.add(i);
      return f;
    }
  }

  // 5. 1-to-1 sequential index match (if frame count matches total scenes)
  if (parsedFrames.length === totalScenes && !claimedIndices.has(sceneIndex)) {
    claimedIndices.add(sceneIndex);
    return parsedFrames[sceneIndex];
  }

  // Single frame fallback (1 frame in guidelines for 1 requested scene)
  if (parsedFrames.length === 1 && totalScenes === 1 && !claimedIndices.has(0)) {
    claimedIndices.add(0);
    return parsedFrames[0];
  }

  return null;
}
