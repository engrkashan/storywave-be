import fs from "fs";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("TimelineService");

/* ============================================================
   SUBTITLE GROUP BUILDER
   Extracts chunking logic from parseJsonToAss into a pure
   data-level function that produces absolute-time groups.
   Groups are stored in timeline.json and reused by every
   segment — no re-computation, no per-segment drift.
   ============================================================ */

const MAX_WORDS_PER_CHUNK = 3;
const MAX_PAUSE_GAP_S     = 0.35;
const MIN_DURATION_S      = 0.15;
const MAX_DURATION_S      = 2.5;

const CONJUNCTIONS = new Set(["and", "but", "or"]);
const PREPOSITIONS = new Set(["to", "of", "in", "at", "for", "with", "into", "onto", "from"]);
const ARTICLES     = new Set(["the", "a", "an"]);

/**
 * Groups Whisper word-level timestamps into subtitle display chunks.
 * Returns ABSOLUTE timestamps (from t=0 of the narration file).
 * No startTime/duration offset applied here — that is done in
 * videoService when building per-segment ASS from these groups.
 *
 * @param {Array<{word:string, start:number, end:number}>} words
 * @returns {Array<{start:number, end:number, text:string}>}
 */
export function buildSubtitleGroups(words) {
  const rawChunks  = [];
  let currentChunk = [];

  for (let i = 0; i < words.length; i++) {
    const wordObj  = words[i];
    const text     = wordObj.word.trim();

    currentChunk.push(wordObj);

    const nextWordObj = i + 1 < words.length ? words[i + 1] : null;
    const nextClean   = nextWordObj
      ? nextWordObj.word.trim().replace(/[.,!?;:]/g, "").toLowerCase()
      : "";

    let shouldBreak = false;

    if (currentChunk.length >= MAX_WORDS_PER_CHUNK) {
      shouldBreak = true;
    } else if (nextWordObj) {
      if (nextWordObj.start - wordObj.end > MAX_PAUSE_GAP_S)   shouldBreak = true;
      else if (/[.?!]$/.test(text))                            shouldBreak = true;
      else if (/[,;:]$/.test(text))                            shouldBreak = true;
      else if (currentChunk.length >= 2) {
        const nc = nextClean;
        if (CONJUNCTIONS.has(nc) || PREPOSITIONS.has(nc) || ARTICLES.has(nc)) {
          shouldBreak = true;
        }
      }
    } else {
      shouldBreak = true; // last word
    }

    if (shouldBreak && currentChunk.length > 0) {
      rawChunks.push([...currentChunk]);
      currentChunk = [];
    }
  }

  const groups = [];
  for (const chunk of rawChunks) {
    if (chunk.length === 0) continue;

    let s = chunk[0].start;
    let e = chunk[chunk.length - 1].end;

    // Clamp duration
    const dur = e - s;
    if (dur < MIN_DURATION_S) e = s + MIN_DURATION_S;
    if (dur > MAX_DURATION_S) e = s + MAX_DURATION_S;

    groups.push({
      start: s,
      end:   e,
      text:  chunk.map((w) => w.word.trim()).join(" "),
    });
  }

  return groups;
}

/* ============================================================
   SCENE BOUNDARY DETECTION
   Replaces the equal-division getSegmentRange() math.
   Boundaries come from natural speech pauses, not arithmetic.
   ============================================================ */

/**
 * Detects scene cut points from natural speech pauses in the word timeline.
 *
 * Algorithm:
 *   1. Collect all inter-word gaps > 100ms as candidate pause points.
 *   2. For each of the N-1 ideal cut positions (evenly spaced by duration),
 *      find the best natural pause within a ±50% scene-width search window.
 *   3. Fall back to the ideal mathematical point when no pause is nearby.
 *   4. Build scenes from the selected cut times.
 *   5. Clamp result to targetSceneCount ± 3 via merge/bisect.
 *
 * @param {Array<{word,start,end}>} words
 * @param {number} totalDuration       — narration duration from ffprobe (seconds)
 * @param {number} targetSceneCount    — user-requested scene count (imageCount)
 * @returns {Array<{index, startSec, endSec, durationSec}>}
 */
export function buildSceneBoundaries(words, totalDuration, targetSceneCount) {
  if (!words || words.length === 0 || targetSceneCount <= 1) {
    return [{ index: 0, startSec: 0, endSec: totalDuration, durationSec: totalDuration }];
  }

  // 1. Collect candidate pause points
  const pauses = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end;
    if (gap > 0.1) pauses.push({ time: words[i].end, gap });
  }

  // 2. Find best pause for each ideal cut
  const sceneDuration = totalDuration / targetSceneCount;
  const searchWindow  = sceneDuration * 0.5;
  const cuts          = new Set();

  for (let k = 1; k < targetSceneCount; k++) {
    const idealTime = sceneDuration * k;

    let best      = null;
    let bestScore = -Infinity;

    for (const pause of pauses) {
      const dist = Math.abs(pause.time - idealTime);
      if (dist > searchWindow) continue;
      const score = pause.gap * 2 - dist;
      if (score > bestScore) { bestScore = score; best = pause; }
    }

    // Round to 3dp to avoid float collision in the Set
    const cutTime = best
      ? Math.round(best.time  * 1000) / 1000
      : Math.round(idealTime  * 1000) / 1000;
    cuts.add(cutTime);
  }

  // 3. Sort
  const sortedCuts = [...cuts].sort((a, b) => a - b);

  // 4. Build scene objects
  let scenes = [];
  let start  = 0;
  for (const cut of sortedCuts) {
    if (cut > start + 0.1 && cut < totalDuration - 0.1) {
      scenes.push({
        index:       scenes.length,
        startSec:    start,
        endSec:      cut,
        durationSec: cut - start,
      });
      start = cut;
    }
  }
  scenes.push({
    index:       scenes.length,
    startSec:    start,
    endSec:      totalDuration,
    durationSec: totalDuration - start,
  });

  // 5. Clamp to targetSceneCount ± 3
  const MARGIN   = 3;
  const minCount = Math.max(1, targetSceneCount - MARGIN);
  const maxCount = targetSceneCount + MARGIN;

  if (scenes.length > maxCount) {
    logger.warn(`Scene count ${scenes.length} exceeds max (${maxCount}). Merging smallest scenes.`);
    scenes = _mergeToCount(scenes, maxCount);
  } else if (scenes.length < minCount) {
    logger.warn(`Scene count ${scenes.length} below min (${minCount}). Bisecting longest scenes.`);
    scenes = _splitToCount(scenes, minCount);
  }

  logger.info(`📐 Master Timeline: ${scenes.length} scenes from speech (target ${targetSceneCount} ±${MARGIN})`);
  return scenes;
}

/** Merge adjacent pairs until scenes.length === target (smallest combined duration first). */
function _mergeToCount(scenes, target) {
  while (scenes.length > target) {
    let minIdx = 0, minDur = Infinity;
    for (let i = 0; i < scenes.length - 1; i++) {
      const combined = scenes[i].durationSec + scenes[i + 1].durationSec;
      if (combined < minDur) { minDur = combined; minIdx = i; }
    }
    const merged = {
      index:       minIdx,
      startSec:    scenes[minIdx].startSec,
      endSec:      scenes[minIdx + 1].endSec,
      durationSec: scenes[minIdx + 1].endSec - scenes[minIdx].startSec,
    };
    scenes.splice(minIdx, 2, merged);
    scenes = scenes.map((s, i) => ({ ...s, index: i }));
  }
  return scenes;
}

/** Bisect the longest scene until scenes.length === target. */
function _splitToCount(scenes, target) {
  while (scenes.length < target) {
    let maxIdx = 0, maxDur = 0;
    for (let i = 0; i < scenes.length; i++) {
      if (scenes[i].durationSec > maxDur) { maxDur = scenes[i].durationSec; maxIdx = i; }
    }
    const s   = scenes[maxIdx];
    const mid = (s.startSec + s.endSec) / 2;
    const s1  = { index: maxIdx,     startSec: s.startSec, endSec: mid,       durationSec: mid - s.startSec };
    const s2  = { index: maxIdx + 1, startSec: mid,        endSec: s.endSec,  durationSec: s.endSec - mid };
    scenes.splice(maxIdx, 1, s1, s2);
    scenes = scenes.map((s, i) => ({ ...s, index: i }));
  }
  return scenes;
}

/* ============================================================
   MASTER TIMELINE ORCHESTRATOR
   ============================================================ */

/**
 * Builds the immutable Master Timeline from Whisper word data.
 * This object is the single source of truth for ALL downstream timing —
 * scene rendering, subtitle generation, audio muxing.
 *
 * @param {Array<{word,start,end}>} words          — from Whisper (absolute timestamps)
 * @param {number}                  totalDuration  — measured from narration WAV via ffprobe
 * @param {number}                  targetSceneCount — user-requested count (imageCount)
 * @returns {Object} timeline
 */
export function buildMasterTimeline(words, totalDuration, targetSceneCount) {
  logger.info(
    `🕐 Building Master Timeline: ${words.length} words | ` +
    `${totalDuration.toFixed(2)}s | target ${targetSceneCount} scenes`
  );

  const scenes         = buildSceneBoundaries(words, totalDuration, targetSceneCount);
  const subtitleGroups = buildSubtitleGroups(words);

  const timeline = {
    version:          1,
    generatedAt:      new Date().toISOString(),
    totalDuration,
    targetSceneCount,
    actualSceneCount: scenes.length,
    words,            // kept for debugging / re-processing
    scenes,
    subtitleGroups,
  };

  logger.info(
    `✅ Master Timeline ready: ${scenes.length} scenes, ` +
    `${subtitleGroups.length} subtitle groups`
  );
  return timeline;
}

/**
 * Persist timeline to disk as JSON.
 * @param {Object} timeline
 * @param {string} filePath
 */
export function saveMasterTimeline(timeline, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(timeline, null, 2), "utf8");
  logger.info(`💾 Master Timeline saved → ${filePath}`);
}

/**
 * Load and validate a timeline.json from disk.
 * @param {string} filePath
 * @returns {Object} timeline
 */
export function loadMasterTimeline(filePath) {
  const raw      = fs.readFileSync(filePath, "utf8");
  const timeline = JSON.parse(raw);
  if (!timeline.version || !Array.isArray(timeline.scenes) || !Array.isArray(timeline.subtitleGroups)) {
    throw new Error(`Invalid or corrupt timeline.json at ${filePath}`);
  }
  return timeline;
}
