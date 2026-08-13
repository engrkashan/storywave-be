/**
 * speechTimelineService.js — Unified Speech Timeline & Speech Allocation Engine
 *
 * Implements Phase 1 (Unified Speech Timeline) & Phase 2 (Speech Allocation Engine) for Video Mode.
 * Unifies timing across both normal mode (external TTS -> Whisper) and Character Talk mode.
 * Serves as the authoritative source of truth for speech timing, dialogue allocation, and validation.
 */

import { intelligentVideoScriptChunker } from "../timelineService.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("SpeechTimelineService");

/**
 * Builds a Global Word Ledger mapping every word in the raw script to a contiguous index [0..N-1].
 *
 * @param {string} script - Full narrative script text
 * @returns {Array<{ index: number, word: string, normalized: string }>} Word ledger array
 */
export function buildGlobalWordLedger(script = "") {
  const rawWords = script.split(/\s+/).filter(Boolean);
  return rawWords.map((w, idx) => ({
    index: idx,
    word: w,
    normalized: w.toLowerCase().replace(/[^a-z0-9]/g, ""),
  }));
}

/**
 * Builds a Unified Speech Timeline object from script and optional Whisper word timestamps.
 *
 * @param {string} script        - Narrative script text
 * @param {Array} whisperWords   - Optional array of Whisper word objects [{ word, start, end }]
 * @param {object} storyBible    - Story Bible metadata
 * @param {object} options       - Additional options (characterTalk, etc.)
 * @returns {object} Unified Speech Timeline object
 */
export function buildUnifiedSpeechTimeline(script, whisperWords = null, storyBible = {}, options = {}) {
  logger.info("🎙️ [Speech Timeline] Building Unified Speech Timeline & Global Word Ledger...");

  const globalLedger = buildGlobalWordLedger(script);
  const characters = storyBible?.characters || [];
  const mainChar = characters[0] || { name: "Speaker 1", id: "char_1" };

  const segments = [];
  let totalDuration = 0;

  if (Array.isArray(whisperWords) && whisperWords.length > 0) {
    // ── Mode A: Whisper Word-Level Timestamps Available (External TTS or Audio Transcript) ──
    logger.info(`  Mode A: Building Unified Speech Timeline from ${whisperWords.length} Whisper word timestamps.`);

    let currentSegmentWords = [];
    let segIdx = 0;
    let ledgerCursor = 0;

    for (let i = 0; i < whisperWords.length; i++) {
      const w = whisperWords[i];
      const normW = w.word.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

      // Match with global ledger
      let matchedLedgerIdx = ledgerCursor;
      for (let l = ledgerCursor; l < Math.min(ledgerCursor + 5, globalLedger.length); l++) {
        if (globalLedger[l].normalized === normW) {
          matchedLedgerIdx = l;
          ledgerCursor = l + 1;
          break;
        }
      }

      currentSegmentWords.push({
        word: w.word.trim(),
        start: w.start,
        end: w.end,
        globalIndex: matchedLedgerIdx,
      });

      const isLast = i === whisperWords.length - 1;
      const nextW = whisperWords[i + 1];

      let shouldCut = isLast;
      if (nextW && (nextW.start - w.end > 0.4 || /[.!?]$/.test(w.word.trim()) || currentSegmentWords.length >= 10)) {
        shouldCut = true;
      }

      if (shouldCut && currentSegmentWords.length > 0) {
        const segStart = currentSegmentWords[0].start;
        const segEnd = currentSegmentWords[currentSegmentWords.length - 1].end;
        const segText = currentSegmentWords.map((cw) => cw.word).join(" ");
        const activeSpeaker = resolveSpeakerForText(segText, characters, mainChar);

        const wordIndices = currentSegmentWords.map((cw) => cw.globalIndex);
        const startIndex = Math.min(...wordIndices);
        const endIndex = Math.max(...wordIndices) + 1;

        segments.push({
          segmentId: `speech_seg_${String(segIdx).padStart(3, "0")}`,
          speaker: activeSpeaker.name,
          speakerId: activeSpeaker.id,
          text: segText,
          words: currentSegmentWords,
          wordRange: { startIndex, endIndex },
          startSec: segStart,
          endSec: segEnd,
          durationSec: Math.max(0.1, segEnd - segStart),
          emotion: "cinematic tone",
          isDialogue: options.characterTalk === true || isDialogueText(segText),
        });

        segIdx++;
        currentSegmentWords = [];
      }
    }

    totalDuration = whisperWords[whisperWords.length - 1]?.end || 0;
  } else {
    // ── Mode B: Native Script Speech Chunker (Native CharacterTalk before video clip generation) ──
    logger.info("  Mode B: Building Unified Speech Timeline from intelligent complete-sentence script chunking...");
    const scriptChunks = intelligentVideoScriptChunker(script);

    let currentTime = 0;
    let globalWordIdx = 0;

    scriptChunks.forEach((chunkText, segIdx) => {
      const wordsInChunk = chunkText.split(/\s+/).filter(Boolean);
      const chunkDuration = 5.0; // Standard Omni clip duration
      const secPerWord = chunkDuration / Math.max(1, wordsInChunk.length);

      const startIndex = globalWordIdx;

      const wordObjects = wordsInChunk.map((w, wIdx) => {
        const item = {
          word: w,
          start: currentTime + wIdx * secPerWord,
          end: currentTime + (wIdx + 1) * secPerWord,
          globalIndex: globalWordIdx,
        };
        globalWordIdx++;
        return item;
      });

      const endIndex = globalWordIdx;
      const activeSpeaker = resolveSpeakerForText(chunkText, characters, mainChar);

      segments.push({
        segmentId: `speech_seg_${String(segIdx).padStart(3, "0")}`,
        speaker: activeSpeaker.name,
        speakerId: activeSpeaker.id,
        text: chunkText,
        words: wordObjects,
        wordRange: { startIndex, endIndex },
        startSec: currentTime,
        endSec: currentTime + chunkDuration,
        durationSec: chunkDuration,
        emotion: "cinematic tone",
        isDialogue: options.characterTalk === true || isDialogueText(chunkText),
      });

      currentTime += chunkDuration;
    });

    totalDuration = currentTime;
  }

  const speechTimeline = {
    version: 1,
    generatedAt: new Date().toISOString(),
    globalWordLedger: globalLedger,
    totalDuration,
    totalWords: globalLedger.length,
    segments,
  };

  logger.info(`✅ [Speech Timeline] Created ${segments.length} unified speech segments across ${globalLedger.length} total words (Duration: ${totalDuration.toFixed(1)}s).`);

  // Run hard validation gate
  const valRes = validateWordLedger(script, speechTimeline);
  if (!valRes.valid) {
    logger.warn(`⚠️ [Speech Timeline Validation Warning]: Missing ${valRes.missingWords.length} words, Duplicate ${valRes.duplicateWords.length} words.`);
  }

  return speechTimeline;
}

/**
 * Phase 2: Speech Allocation Engine
 * Allocates speech segments to beats strictly preserving sentence ownership and global word ranges.
 *
 * @param {Array<object>} beats           - Array of planned beats
 * @param {object} speechTimeline        - Unified Speech Timeline object
 * @returns {Array<object>} Beats with attached `speechAllocation`
 */
export function allocateSpeechToBeats(beats = [], speechTimeline = {}) {
  logger.info(`🎯 [Speech Allocation] Allocating speech segments to ${beats.length} beats...`);

  const segments = speechTimeline?.segments || [];
  if (segments.length === 0) {
    return beats.map((b) => ({
      ...b,
      speechAllocation: {
        speaker: b.characterName || "Subject",
        speakerId: b.characterId || "char_1",
        spokenText: "",
        expectedWords: [],
        wordRange: { startIndex: 0, endIndex: 0 },
        speechStartSec: b.timing?.startSec || 0,
        speechEndSec: b.timing?.endSec || 5,
        expectedDurationSec: b.timing?.durationSec || 5,
        emotion: b.emotion || "neutral",
        hasSpeech: false,
      },
    }));
  }

  const usedSegmentIds = new Set();

  return beats.map((beat, bIdx) => {
    const beatStart = beat.timing?.startSec || bIdx * 5.0;
    const beatEnd = beat.timing?.endSec || (bIdx + 1) * 5.0;

    // Find unused speech segments for this beat's time window
    const unusedSegments = segments.filter((s) => !usedSegmentIds.has(s.segmentId));

    const matchingSegments = unusedSegments.filter(
      (s) => (s.startSec >= beatStart && s.startSec < beatEnd) || (s.endSec > beatStart && s.endSec <= beatEnd) || (s.startSec <= beatStart && s.endSec >= beatEnd)
    );

    // Direct 1-to-1 index mapping for unused segments — never repeat an already used segment!
    const fallbackSeg = unusedSegments.find((s) => segments.indexOf(s) === bIdx) || null;
    const activeSegs = matchingSegments.length > 0 ? matchingSegments : (fallbackSeg ? [fallbackSeg] : []);

    activeSegs.forEach((s) => usedSegmentIds.add(s.segmentId));

    const combinedWords = activeSegs.flatMap((s) => s.words.map((w) => w.word));
    const combinedText = activeSegs.map((s) => s.text).join(" ");

    const minStartIdx = activeSegs.length > 0 ? Math.min(...activeSegs.map((s) => s.wordRange.startIndex)) : 0;
    const maxEndIdx = activeSegs.length > 0 ? Math.max(...activeSegs.map((s) => s.wordRange.endIndex)) : 0;

    const firstSeg = activeSegs[0];
    const lastSeg = activeSegs[activeSegs.length - 1];

    const speechAlloc = {
      speaker: firstSeg?.speaker || beat.characterName || "Subject",
      speakerId: firstSeg?.speakerId || beat.characterId || "char_1",
      spokenText: combinedText,
      expectedWords: combinedWords,
      wordRange: { startIndex: minStartIdx, endIndex: maxEndIdx },
      speechStartSec: firstSeg?.startSec ?? beatStart,
      speechEndSec: lastSeg?.endSec ?? beatEnd,
      expectedDurationSec: lastSeg && firstSeg ? (lastSeg.endSec - firstSeg.startSec) : (beatEnd - beatStart),
      emotion: firstSeg?.emotion || beat.emotion || "cinematic focus",
      hasSpeech: Boolean(combinedText && combinedText.trim().length > 0),
    };

    return {
      ...beat,
      spokenText: speechAlloc.spokenText,
      characterName: speechAlloc.speaker,
      characterId: speechAlloc.speakerId,
      speechAllocation: speechAlloc,
    };
  });
}

/**
 * Validates global word ledger integrity across the speech timeline.
 * Ensures NO missing words, NO duplicate word assignments, and NO out-of-order words.
 *
 * @param {string} script           - Original script text
 * @param {object} speechTimeline   - Generated Speech Timeline
 * @returns {{ valid: boolean, missingWords: Array, duplicateWords: Array, outOfOrderWords: Array }}
 */
export function validateWordLedger(script = "", speechTimeline = {}) {
  const globalLedger = speechTimeline.globalWordLedger || buildGlobalWordLedger(script);
  const segments = speechTimeline.segments || [];

  const assignedIndices = new Map();
  const duplicateWords = [];
  const outOfOrderWords = [];

  let lastIndex = -1;

  segments.forEach((seg) => {
    (seg.words || []).forEach((w) => {
      const idx = w.globalIndex;
      if (idx !== undefined && idx !== null) {
        if (assignedIndices.has(idx)) {
          duplicateWords.push({ index: idx, word: w.word, previousSeg: assignedIndices.get(idx) });
        } else {
          assignedIndices.set(idx, seg.segmentId);
        }

        if (idx < lastIndex) {
          outOfOrderWords.push({ index: idx, word: w.word, lastIndex });
        }
        lastIndex = idx;
      }
    });
  });

  const missingWords = [];
  globalLedger.forEach((item) => {
    if (!assignedIndices.has(item.index)) {
      missingWords.push(item);
    }
  });

  const valid = missingWords.length === 0 && duplicateWords.length === 0 && outOfOrderWords.length === 0;

  return {
    valid,
    missingWords,
    duplicateWords,
    outOfOrderWords,
    totalLedgerWords: globalLedger.length,
    totalAssignedWords: assignedIndices.size,
  };
}

/**
 * Resolves active character speaker from text cues or story Bible characters list.
 */
function resolveSpeakerForText(text = "", characters = [], defaultChar = { name: "Subject", id: "char_1" }) {
  if (!text) return defaultChar;

  const lowerText = text.toLowerCase();
  for (const char of characters) {
    if (char.name && lowerText.includes(char.name.toLowerCase())) {
      return { name: char.name, id: char.id || "char_1" };
    }
  }

  return { name: defaultChar.name || "Subject", id: defaultChar.id || "char_1" };
}

/**
 * Checks if a text line is dialogue vs narration.
 */
function isDialogueText(text = "") {
  return /["'“]/.test(text) || /^(he|she|they|[a-z]+) (said|asked|shouted|whispered|exclaimed)/i.test(text);
}

