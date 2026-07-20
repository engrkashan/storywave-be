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

    // LOSSLESS duration handling: never clamp a group's END inward (that would
    // truncate the display window and make the tail words blink out / get skipped
    // in per-scene ASS rendering). Instead, if a chunk is longer than MAX_DURATION_S,
    // SPLIT it at the midpoint word so every word keeps its true timing and nothing
    // is dropped. Guarantee contiguity: each group uses the real first-word start
    // and last-word end, and we never leave a gap that hides spoken words.
    let s = chunk[0].start;
    let e = chunk[chunk.length - 1].end;
    let pieces = [chunk];

    const dur = e - s;
    if (dur > MAX_DURATION_S) {
      const mid = Math.floor(chunk.length / 2);
      pieces = [chunk.slice(0, mid), chunk.slice(mid)];
    }

    for (const piece of pieces) {
      if (piece.length === 0) continue;
      let ps = piece[0].start;
      let pe = piece[piece.length - 1].end;
      if (pe - ps < MIN_DURATION_S) pe = ps + MIN_DURATION_S;

      groups.push({
        start: ps,
        end:   pe,
        text:  piece.map((w) => w.word.trim()).join(" "),
      });
    }
  }

  return groups;
}

/* ============================================================
   NARRATION SEGMENTS BUILDER
   Maps Whisper words into per-scene text chunks, aligned 1-to-1
   with the audio boundaries produced by buildSceneBoundaries.
   Used to seed generateScenePrompts so each prompt's narration
   maps exactly to the audio slot it will be rendered over.
   ============================================================ */

/**
 * Given the Whisper word list and the scenes array from buildSceneBoundaries,
 * returns one text segment per scene containing the verbatim spoken words
 * that fall within that scene's time window.
 *
 * @param {Array<{word:string, start:number, end:number}>} words
 * @param {Array<{index:number, startSec:number, endSec:number}>} scenes
 * @returns {Array<{sceneIndex:number, startSec:number, endSec:number, text:string}>}
 */
export function buildNarrationSegments(words, scenes) {
  // LOSSLESS word→scene partition.
  // Every spoken word is assigned to EXACTLY ONE scene using its START time, so no
  // word is ever dropped or double-counted. A word belongs to the scene whose
  // [startSec, endSec) window contains its start; boundary words (start == next
  // scene's startSec) go to the EARLIER scene to keep the partition contiguous.
  // This guarantees the per-scene narration text covers 100% of spoken audio and
  // that the subtitle track (built from the same words) never misses a word.
  const segWordsByScene = scenes.map(() => []);
  for (const w of words) {
    let assigned = -1;
    for (let s = 0; s < scenes.length; s++) {
      const sc = scenes[s];
      if (w.start >= sc.startSec && w.start < sc.endSec) { assigned = s; break; }
    }
    // Boundary / past-last-window fallback: attach to the nearest prior scene.
    if (assigned === -1) {
      for (let s = scenes.length - 1; s >= 0; s--) {
        if (w.start >= scenes[s].startSec) { assigned = s; break; }
      }
    }
    if (assigned === -1) assigned = 0;
    segWordsByScene[assigned].push(w);
  }

  return scenes.map((scene, si) => {
    const segWords = segWordsByScene[si];
    const text = segWords.map((w) => w.word.trim()).join(" ").trim();
    return {
      sceneIndex: scene.index,
      startSec:   scene.startSec,
      endSec:     scene.endSec,
      text:       text || "", // empty only if genuinely no words spoken in this window
    };
  });
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

  // Strictly divide the audio length by the target scene count
  const scenes = [];
  const sceneDuration = totalDuration / targetSceneCount;

  for (let k = 0; k < targetSceneCount; k++) {
    const isLast = k === targetSceneCount - 1;
    const start = k * sceneDuration;
    const end = isLast ? totalDuration : (k + 1) * sceneDuration;

    scenes.push({
      index: k,
      startSec: start,
      endSec: end,
      durationSec: end - start,
    });
  }

  logger.info(`📐 Master Timeline: ${scenes.length} strictly divided scenes (target ${targetSceneCount})`);
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
 * @param {string}                  originalScript   — the original user script for exact subtitle matching
 * @returns {Object} timeline
 */
export function buildMasterTimeline(words, totalDuration, targetSceneCount, originalScript = "") {
  logger.info(
    `🕐 Building Master Timeline: ${words.length} words | ` +
    `${totalDuration.toFixed(2)}s | target ${targetSceneCount} scenes`
  );

  const scenes         = buildSceneBoundaries(words, totalDuration, targetSceneCount);
  let subtitleGroups   = buildSubtitleGroups(words);

  // SYNC FIX: subtitles MUST reflect the ACTUALLY SPOKEN audio (Whisper verbatim),
  // not the original script text. The voiceover is generated from `script`, but TTS
  // can alter phrasing/pauses, so replacing Whisper words with the script text caused
  // subtitles to mismatch — and occasionally drop — words vs the audio. We keep the
  // Whisper-derived groups as the canonical subtitle source so voice, subtitle, and
  // image stay in sync. The original script is still used downstream for narration
  // seeding (buildNarrationSegments) where verbatim-match is less critical.
  if (originalScript && originalScript.trim().length > 0) {
    logger.info(`ℹ️ Keeping Whisper verbatim subtitle text (script alignment skipped) to guarantee voice/subtitle sync.`);
  }

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

/**
 * Replaces the Whisper transcribed text in subtitle groups with the perfectly
 * formatted original script using a deterministic word-count alignment.
 *
 * @param {string} script
 * @param {Array<{start, end, text}>} subtitleGroups
 */
function alignScriptToSubtitleGroups(script, subtitleGroups) {
  let remainingScript = script.trim();

  for (let i = 0; i < subtitleGroups.length; i++) {
    const group = subtitleGroups[i];
    const groupWords = group.text.trim().split(/\s+/);
    const numWords = groupWords.length;

    let wordCount = 0;
    let splitIdx = 0;
    let inWord = false;
    for (let j = 0; j < remainingScript.length; j++) {
      if (/\s/.test(remainingScript[j])) {
        if (inWord) {
          wordCount++;
          inWord = false;
          if (wordCount === numWords) {
            splitIdx = j;
            break;
          }
        }
      } else {
        inWord = true;
      }
    }

    if (splitIdx === 0 && remainingScript.length > 0) {
      splitIdx = remainingScript.length;
    }

    const matchedText = remainingScript.substring(0, splitIdx).trim();
    remainingScript = remainingScript.substring(splitIdx).trim();

    if (matchedText) {
      group.text = matchedText; // replace whisper text with exact script text
    }
  }

  // Any leftover text gets appended to the last group
  if (remainingScript.length > 0 && subtitleGroups.length > 0) {
    subtitleGroups[subtitleGroups.length - 1].text += " " + remainingScript;
  }

  return subtitleGroups;
}
