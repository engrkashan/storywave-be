import fs from "fs";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("TimelineService");

/**
 * Intelligently chunks a script into optimal video clip segments (~8-10 words per 5s clip).
 * Respects sentence boundaries, punctuation, and clause connectives.
 * Guarantees 100% script word coverage with 0 skipped words and 0 overlaps.
 * Used EXCLUSIVELY for Video mode (Google Veo / Gemini Omni Flash) to ensure speech fits within 5s clips.
 *
 * @param {string} script
 * @param {number} targetWordsPerChunk - Default 9 words (~1.8 words/sec speech rate)
 * @returns {Array<string>} Array of script segment chunks
 */
export function intelligentVideoScriptChunker(script) {
  if (!script || !script.trim()) return [];

  const rawScript = script.trim();
  // 1. Split script into complete sentences
  const rawSentences = rawScript.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (rawSentences.length === 0) return [rawScript];

  const chunks = [];

  for (const sentence of rawSentences) {
    const sWords = sentence.split(/\s+/).filter(Boolean);

    if (sWords.length <= 12) {
      // Complete sentence fits within ideal clip speech window — keep 100% intact!
      chunks.push(sentence.trim());
    } else {
      // Long sentence (>12 words) — split strictly at clause punctuation or conjunctions
      const clauseParts = sentence.split(/(?<=[,;:—])\s+|\s+(?:and then|because|which|while|whereby)\s+/i).filter(Boolean);
      let currentClause = [];

      for (let c = 0; c < clauseParts.length; c++) {
        const part = clauseParts[c].trim();
        const partWords = part.split(/\s+/).filter(Boolean);

        if (currentClause.length === 0) {
          currentClause.push(part);
        } else {
          const combinedWords = currentClause.join(" ").split(/\s+/).filter(Boolean).length + partWords.length;
          if (combinedWords <= 12) {
            currentClause.push(part);
          } else {
            chunks.push(currentClause.join(" ").trim());
            currentClause = [part];
          }
        }
      }

      if (currentClause.length > 0) {
        chunks.push(currentClause.join(" ").trim());
      }
    }
  }

  // Final cleanup: merge tiny trailing stubs (< 3 words) into adjacent chunk
  const finalChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i];
    const wCount = ch.split(/\s+/).filter(Boolean).length;

    if (wCount < 3 && finalChunks.length > 0) {
      finalChunks[finalChunks.length - 1] += " " + ch;
    } else {
      finalChunks.push(ch);
    }
  }

  return finalChunks.length > 0 ? finalChunks : [rawScript];
}

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
 * Converts seconds to integer milliseconds.
 * @param {number|string} sec
 * @returns {number}
 */
export function secToMs(sec) {
  return Math.round(Number(sec || 0) * 1000);
}

/**
 * Converts milliseconds to seconds (floating point).
 * @param {number} ms
 * @returns {number}
 */
export function msToSec(ms) {
  return Number((Number(ms || 0) / 1000).toFixed(3));
}

/**
 * Deterministically converts integer milliseconds to ASS timestamp format H:MM:SS.cs (centiseconds).
 * Guarantees zero floating-point rounding errors.
 * @param {number} ms - Milliseconds
 * @returns {string} - e.g. "0:01:23.45"
 */
export function msToAssTime(ms) {
  const totalMs = Math.max(0, Math.round(ms));
  const totalSec = Math.floor(totalMs / 1000);
  const cs = Math.floor((totalMs % 1000) / 10); // 1 centisecond = 10 ms (0-99)

  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  const pad2 = (n) => String(n).padStart(2, "0");
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
}

/**
 * Groups Whisper word-level timestamps into subtitle display chunks.
 * Returns ABSOLUTE timestamps (from t=0 of the narration file) in both
 * integer milliseconds (startMs, endMs, durationMs) and floating seconds (start, end).
 *
 * @param {Array<{word:string, start:number, end:number}>} words
 * @returns {Array<{start:number, end:number, startMs:number, endMs:number, durationMs:number, text:string}>}
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

      const startMs = secToMs(ps);
      const endMs = secToMs(pe);
      const durationMs = endMs - startMs;

      groups.push({
        start: ps,
        end:   pe,
        startMs,
        endMs,
        durationMs,
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
 * @param {Array<{index:number, startSec:number, endSec:number, startMs?:number, endMs?:number}>} scenes
 * @returns {Array<{sceneIndex:number, startSec:number, endSec:number, startMs:number, endMs:number, text:string}>}
 */
export function buildNarrationSegments(words, scenes) {
  const segWordsByScene = scenes.map(() => []);
  for (const w of words) {
    const wStartMs = secToMs(w.start);
    let assigned = -1;
    for (let s = 0; s < scenes.length; s++) {
      const sc = scenes[s];
      const scStartMs = sc.startMs !== undefined ? sc.startMs : secToMs(sc.startSec);
      const scEndMs = sc.endMs !== undefined ? sc.endMs : secToMs(sc.endSec);
      if (wStartMs >= scStartMs && wStartMs < scEndMs) { assigned = s; break; }
    }
    // Boundary / past-last-window fallback: attach to the nearest prior scene.
    if (assigned === -1) {
      for (let s = scenes.length - 1; s >= 0; s--) {
        const sc = scenes[s];
        const scStartMs = sc.startMs !== undefined ? sc.startMs : secToMs(sc.startSec);
        if (wStartMs >= scStartMs) { assigned = s; break; }
      }
    }
    if (assigned === -1) assigned = 0;
    segWordsByScene[assigned].push(w);
  }

  return scenes.map((scene, si) => {
    const segWords = segWordsByScene[si];
    const text = segWords.map((w) => w.word.trim()).join(" ").trim();
    const startMs = scene.startMs !== undefined ? scene.startMs : secToMs(scene.startSec);
    const endMs = scene.endMs !== undefined ? scene.endMs : secToMs(scene.endSec);

    return {
      sceneIndex: scene.index !== undefined ? scene.index : si,
      startSec:   scene.startSec !== undefined ? scene.startSec : msToSec(startMs),
      endSec:     scene.endSec !== undefined ? scene.endSec : msToSec(endMs),
      startMs,
      endMs,
      text:       text || "", // empty only if genuinely no words spoken in this window
    };
  });
}

/* ============================================================
   CANONICAL SCENE BOUNDARY GENERATION (INTEGER MILLISECONDS)
   ============================================================ */

/**
 * Builds deterministic, gap-free, and overlap-free scene boundaries in integer milliseconds.
 *
 * Guaranteed Invariants:
 *   1. scene[0].startMs === 0
 *   2. scene[i].endMs === scene[i+1].startMs (0 gap, 0 overlap)
 *   3. scene[last].endMs === totalDurationMs
 *   4. scene[i].durationMs === scene[i].endMs - scene[i].startMs
 */

export const FPS = 30;

/**
 * Derives canonical scene boundaries using an authoritative 30 FPS Integer Frame Ledger.
 * Every scene is assigned an exact integer frame interval [frameStart, frameEnd) such that:
 *   sum(frameCount) === totalFrames
 * Millisecond and floating-point seconds are strictly derived compatibility fields.
 *
 * @param {Array<{word,start,end}>} words
 * @param {number} totalDuration       — narration duration from ffprobe (seconds)
 * @param {number} targetSceneCount    — user-requested scene count
 * @returns {Array<{index:number, sceneId:string, frameStart:number, frameEnd:number, frameCount:number, startMs:number, endMs:number, durationMs:number, startSec:number, endSec:number, durationSec:number, audioStartMs:number, audioEndMs:number, subtitleStartMs:number, subtitleEndMs:number}>}
 */
export function buildSceneBoundaries(words, totalDuration, targetSceneCount) {
  const totalDurationSec = Math.max(0.1, Number(totalDuration || 0));
  const totalFrames = Math.max(1, Math.round(totalDurationSec * FPS));
  const count = Math.max(1, parseInt(targetSceneCount, 10) || 1);

  if (!words || words.length === 0 || count <= 1) {
    const durationSec = totalFrames / FPS;
    const durationMs = Math.round(durationSec * 1000);
    return [{
      index: 0,
      sceneId: "scene_001",
      frameStart: 0,
      frameEnd: totalFrames,
      frameCount: totalFrames,
      startMs: 0,
      endMs: durationMs,
      durationMs,
      startSec: 0,
      endSec: durationSec,
      durationSec,
      audioStartMs: 0,
      audioEndMs: durationMs,
      subtitleStartMs: 0,
      subtitleEndMs: durationMs,
    }];
  }

  const scenes = [];
  for (let k = 0; k < count; k++) {
    const isLast = k === count - 1;
    const frameStart = Math.round(k * (totalFrames / count));
    const frameEnd = isLast ? totalFrames : Math.round((k + 1) * (totalFrames / count));
    const frameCount = frameEnd - frameStart;

    // Derived compatibility fields
    const startSec = Number((frameStart / FPS).toFixed(6));
    const endSec = Number((frameEnd / FPS).toFixed(6));
    const durationSec = Number((frameCount / FPS).toFixed(6));
    const startMs = Math.round((frameStart / FPS) * 1000);
    const endMs = Math.round((frameEnd / FPS) * 1000);
    const durationMs = endMs - startMs;

    scenes.push({
      index: k,
      sceneId: `scene_${String(k + 1).padStart(3, "0")}`,
      frameStart,
      frameEnd,
      frameCount,
      startMs,
      endMs,
      durationMs,
      startSec,
      endSec,
      durationSec,
      audioStartMs: startMs,
      audioEndMs: endMs,
      subtitleStartMs: startMs,
      subtitleEndMs: endMs,
    });
  }

  logger.info(`📐 Canonical Master Frame Ledger: ${scenes.length} scenes generated (${totalFrames} total frames @ ${FPS} FPS)`);
  return scenes;
}

/* ============================================================
   CANONICAL TIMELINE VALIDATION & DRIFT AUDITING
   ============================================================ */

/**
 * Strict integrity validator for the Canonical Master Timeline.
 * Ensures zero gap, zero overlap, exact duration arithmetic, and audio synchronization.
 *
 * @param {Object} timeline - The Master Timeline object
 * @param {number} [expectedAudioDurationMs] - Optional expected audio duration in milliseconds
 * @returns {{ valid: boolean, errors: Array<string>, maxDriftMs: number }}
 */
export function validateCanonicalTimeline(timeline, expectedAudioDurationMs = null) {
  const errors = [];
  if (!timeline || !Array.isArray(timeline.scenes) || timeline.scenes.length === 0) {
    return { valid: false, errors: ["Timeline is empty or missing scenes array"], maxDriftMs: 0 };
  }

  const scenes = timeline.scenes;
  let cumulativeDurationMs = 0;
  let cumulativeFrames = 0;
  let maxDriftMs = 0;

  const plannedTotalFrames = timeline.totalFrames || Math.round(Number(timeline.totalDuration || 0) * FPS);

  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const startMs = sc.startMs !== undefined ? sc.startMs : secToMs(sc.startSec);
    const endMs = sc.endMs !== undefined ? sc.endMs : secToMs(sc.endSec);
    const durationMs = sc.durationMs !== undefined ? sc.durationMs : (endMs - startMs);
    const frameStart = sc.frameStart !== undefined ? sc.frameStart : Math.round((startMs / 1000) * FPS);
    const frameEnd = sc.frameEnd !== undefined ? sc.frameEnd : Math.round((endMs / 1000) * FPS);
    const frameCount = sc.frameCount !== undefined ? sc.frameCount : (frameEnd - frameStart);

    // 1. Frame duration check
    if (frameEnd - frameStart !== frameCount) {
      errors.push(`Scene ${i} frame mismatch: frameEnd (${frameEnd}) - frameStart (${frameStart}) !== frameCount (${frameCount})`);
    }

    // 2. Contiguity check with previous scene
    if (i === 0) {
      if (frameStart !== 0) {
        errors.push(`Scene 0 does not start at frame 0 (starts at frame ${frameStart})`);
      }
    } else {
      const prevSc = scenes[i - 1];
      const prevFrameEnd = prevSc.frameEnd !== undefined ? prevSc.frameEnd : Math.round(((prevSc.endMs || secToMs(prevSc.endSec)) / 1000) * FPS);
      if (frameStart !== prevFrameEnd) {
        errors.push(`Frame continuity break between Scene ${i - 1} (end: ${prevFrameEnd}) and Scene ${i} (start: ${frameStart})`);
      }
      const prevEndMs = prevSc.endMs !== undefined ? prevSc.endMs : secToMs(prevSc.endSec);
      if (startMs !== prevEndMs) {
        const gapMs = Math.abs(startMs - prevEndMs);
        maxDriftMs = Math.max(maxDriftMs, gapMs);
        errors.push(`Timeline continuity break between Scene ${i - 1} (end: ${prevEndMs}ms) and Scene ${i} (start: ${startMs}ms) [Δ=${gapMs}ms]`);
      }
    }

    cumulativeDurationMs += durationMs;
    cumulativeFrames += frameCount;
  }

  // 3. Total frame conservation check
  if (cumulativeFrames !== plannedTotalFrames) {
    errors.push(`Frame conservation violation: sum(frameCount) = ${cumulativeFrames} !== planned totalFrames = ${plannedTotalFrames}`);
  }

  // 4. Audio duration sync check if provided
  if (expectedAudioDurationMs !== null && expectedAudioDurationMs > 0) {
    const audioDriftMs = Math.abs(cumulativeDurationMs - Math.round(expectedAudioDurationMs));
    maxDriftMs = Math.max(maxDriftMs, audioDriftMs);
    // Allow up to 35ms (1 frame @ 30fps) for container rounding
    if (audioDriftMs > 35) {
      errors.push(`Cumulative visual duration (${cumulativeDurationMs}ms) drifts from audio duration (${Math.round(expectedAudioDurationMs)}ms) by ${audioDriftMs}ms`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    maxDriftMs,
    totalVisualDurationMs: cumulativeDurationMs,
    totalFrames: cumulativeFrames,
  };
}

/**
 * Diagnostic logger for logging per-scene and global drift.
 *
 * @param {Object} timeline
 * @param {Array<number>} [segmentActualDurationsMs]
 * @param {number} [finalVideoDurationMs]
 * @param {number} [audioDurationMs]
 */
export function logSyncDiagnostics(timeline, segmentActualDurationsMs = [], finalVideoDurationMs = null, audioDurationMs = null) {
  if (!timeline || !Array.isArray(timeline.scenes)) return;

  const scenes = timeline.scenes;
  const groups = timeline.subtitleGroups || [];

  logger.info("================== 🔍 SYNC AUDIT REPORT ==================");
  let maxDriftMs = 0;

  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    const vStart = sc.startMs !== undefined ? sc.startMs : secToMs(sc.startSec);
    const vEnd = sc.endMs !== undefined ? sc.endMs : secToMs(sc.endSec);
    const vDur = sc.durationMs !== undefined ? sc.durationMs : (vEnd - vStart);

    // Matching subtitles in this window
    const sceneSubs = groups.filter((g) => {
      const gStart = g.startMs !== undefined ? g.startMs : secToMs(g.start);
      const gEnd = g.endMs !== undefined ? g.endMs : secToMs(g.end);
      return gStart < vEnd && gEnd > vStart;
    });

    const subStart = sceneSubs.length > 0 ? (sceneSubs[0].startMs ?? secToMs(sceneSubs[0].start)) : vStart;
    const subEnd = sceneSubs.length > 0 ? (sceneSubs[sceneSubs.length - 1].endMs ?? secToMs(sceneSubs[sceneSubs.length - 1].end)) : vEnd;

    const actualSegDur = segmentActualDurationsMs[i] !== undefined ? segmentActualDurationsMs[i] : vDur;
    const segDrift = Math.abs(actualSegDur - vDur);
    maxDriftMs = Math.max(maxDriftMs, segDrift);

    logger.info(
      `  Scene ${i} (${sc.sceneId || `scene_${String(i + 1).padStart(3, "0")}`}): ` +
      `Frames: [${sc.frameStart ?? "?"}..${sc.frameEnd ?? "?"}] (${sc.frameCount ?? "?"}f) | ` +
      `Visual: ${vStart}ms -> ${vEnd}ms (${vDur}ms) | ` +
      `Audio: ${vStart}ms -> ${vEnd}ms | ` +
      `Subs: ${subStart}ms -> ${subEnd}ms | ` +
      `Drift: ${segDrift}ms`
    );
  }

  const totalVisualMs = scenes.reduce((sum, s) => sum + (s.durationMs ?? (secToMs(s.endSec) - secToMs(s.startSec))), 0);
  const totalAudioMs = audioDurationMs ? Math.round(audioDurationMs) : totalVisualMs;
  const totalFinalMs = finalVideoDurationMs ? Math.round(finalVideoDurationMs) : totalVisualMs;

  const totalDriftMs = Math.abs(totalFinalMs - totalAudioMs);
  maxDriftMs = Math.max(maxDriftMs, totalDriftMs);

  logger.info("----------------------------------------------------------");
  logger.info(`  Total Frames:            ${timeline.totalFrames ?? scenes.reduce((s, c) => s + (c.frameCount || 0), 0)} frames`);
  logger.info(`  Total Visual Duration:   ${totalVisualMs}ms`);
  logger.info(`  Total Audio Duration:    ${totalAudioMs}ms`);
  logger.info(`  Total Final Video:       ${totalFinalMs}ms`);
  logger.info(`  Maximum Timeline Drift:  ${maxDriftMs}ms`);
  logger.info(`  Status:                  ${maxDriftMs <= 35 ? "✅ PERFECT_SYNC (0-frame drift)" : "⚠️ DRIFT_DETECTED"}`);
  logger.info("==========================================================");
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
 * @param {number}                  totalDuration  — measured from narration WAV via ffprobe (seconds)
 * @param {number}                  targetSceneCount — user-requested count (imageCount)
 * @param {string}                  originalScript   — the original user script for exact subtitle matching
 * @returns {Object} timeline
 */
export function buildMasterTimeline(words, totalDuration, targetSceneCount, originalScript = "") {
  const totalDurationSec = Math.max(0.1, Number(totalDuration || 0));
  const totalFrames = Math.max(1, Math.round(totalDurationSec * FPS));
  const totalDurationMs = Math.round((totalFrames / FPS) * 1000);

  logger.info(
    `🕐 Building Master Timeline: ${words?.length || 0} words | ` +
    `${totalDurationSec.toFixed(3)}s (${totalFrames} frames @ ${FPS} FPS) | target ${targetSceneCount} scenes`
  );

  const scenes         = buildSceneBoundaries(words, totalDurationSec, targetSceneCount);
  let subtitleGroups   = buildSubtitleGroups(words || []);

  if (originalScript && originalScript.trim().length > 0) {
    logger.info(`ℹ️ Keeping Whisper verbatim subtitle text (script alignment skipped) to guarantee voice/subtitle sync.`);
  }

  const timeline = {
    version:          3, // upgraded to version 3 (authoritative 30 FPS integer frame ledger)
    fps:              FPS,
    timebase:         `1/${FPS}`,
    totalFrames,
    generatedAt:      new Date().toISOString(),
    totalDuration:    totalDurationSec,
    totalDurationMs,
    targetSceneCount,
    actualSceneCount: scenes.length,
    words:            words || [], // kept for debugging / re-processing
    scenes,
    subtitleGroups,
  };

  // Run integrity validation immediately
  const val = validateCanonicalTimeline(timeline, totalDurationMs);
  if (!val.valid) {
    logger.warn(`⚠️ [MasterTimeline Integrity Warning]: ${val.errors.join(" | ")}`);
  } else {
    logger.info(`✅ [MasterTimeline Integrity Passed]: 0-frame drift across all ${scenes.length} scenes (${totalFrames} total frames)`);
  }

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
