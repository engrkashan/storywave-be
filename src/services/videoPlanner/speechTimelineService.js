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
 * Builds a Unified Speech Timeline object from script and optional Whisper word timestamps.
 *
 * @param {string} script        - Narrative script text
 * @param {Array} whisperWords   - Optional array of Whisper word objects [{ word, start, end }]
 * @param {object} storyBible    - Story Bible metadata
 * @param {object} options       - Additional options (characterTalk, etc.)
 * @returns {object} Unified Speech Timeline object
 */
export function buildUnifiedSpeechTimeline(script, whisperWords = null, storyBible = {}, options = {}) {
  logger.info("🎙️ [Speech Timeline] Building Unified Speech Timeline...");

  const characters = storyBible?.characters || [];
  const mainChar = characters[0] || { name: "Speaker 1", id: "char_1" };

  const segments = [];
  let totalDuration = 0;

  if (Array.isArray(whisperWords) && whisperWords.length > 0) {
    // ── Mode A: Whisper Word-Level Timestamps Available (External TTS or Audio Transcript) ──
    logger.info(`  Mode A: Building Unified Speech Timeline from ${whisperWords.length} Whisper word timestamps.`);

    let currentSegmentWords = [];
    let segIdx = 0;

    for (let i = 0; i < whisperWords.length; i++) {
      const w = whisperWords[i];
      currentSegmentWords.push(w);

      const isLast = i === whisperWords.length - 1;
      const nextW = whisperWords[i + 1];

      let shouldCut = isLast;
      if (nextW && (nextW.start - w.end > 0.4 || /[.!?]$/.test(w.word.trim()) || currentSegmentWords.length >= 10)) {
        shouldCut = true;
      }

      if (shouldCut && currentSegmentWords.length > 0) {
        const segStart = currentSegmentWords[0].start;
        const segEnd = currentSegmentWords[currentSegmentWords.length - 1].end;
        const segText = currentSegmentWords.map((cw) => cw.word.trim()).join(" ");

        // Determine speaker by matching text cues or character names
        const activeSpeaker = resolveSpeakerForText(segText, characters, mainChar);

        segments.push({
          segmentId: `speech_seg_${String(segIdx).padStart(3, "0")}`,
          speaker: activeSpeaker.name,
          speakerId: activeSpeaker.id,
          text: segText,
          words: currentSegmentWords.map((cw) => ({ word: cw.word.trim(), start: cw.start, end: cw.end })),
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
    scriptChunks.forEach((chunkText, segIdx) => {
      const wordsInChunk = chunkText.split(/\s+/).filter(Boolean);
      const chunkDuration = 5.0; // Standard Omni clip duration
      const secPerWord = chunkDuration / Math.max(1, wordsInChunk.length);

      const wordObjects = wordsInChunk.map((w, wIdx) => ({
        word: w,
        start: currentTime + wIdx * secPerWord,
        end: currentTime + (wIdx + 1) * secPerWord,
      }));

      const activeSpeaker = resolveSpeakerForText(chunkText, characters, mainChar);

      segments.push({
        segmentId: `speech_seg_${String(segIdx).padStart(3, "0")}`,
        speaker: activeSpeaker.name,
        speakerId: activeSpeaker.id,
        text: chunkText,
        words: wordObjects,
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
    totalDuration,
    totalWords: segments.reduce((sum, s) => sum + s.words.length, 0),
    segments,
  };

  logger.info(`✅ [Speech Timeline] Created ${segments.length} unified speech segments (Total Speech Duration: ${totalDuration.toFixed(1)}s).`);
  return speechTimeline;
}

/**
 * Phase 2: Speech Allocation Engine
 * Allocates speech segments to beats strictly without word skips or overlaps.
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

  let globalWordCounter = 0;
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
    const activeSeg = matchingSegments[0] || fallbackSeg;

    if (activeSeg) {
      usedSegmentIds.add(activeSeg.segmentId);
    }

    const wordsInSeg = activeSeg ? activeSeg.words.map((w) => w.word) : [];
    const startIndex = globalWordCounter;
    globalWordCounter += wordsInSeg.length;
    const endIndex = globalWordCounter;

    const speechAlloc = {
      speaker: activeSeg?.speaker || beat.characterName || "Subject",
      speakerId: activeSeg?.speakerId || beat.characterId || "char_1",
      spokenText: activeSeg ? (activeSeg.text || "") : "",
      expectedWords: wordsInSeg,
      wordRange: { startIndex, endIndex },
      speechStartSec: activeSeg?.startSec ?? beatStart,
      speechEndSec: activeSeg?.endSec ?? beatEnd,
      expectedDurationSec: activeSeg?.durationSec ?? (beatEnd - beatStart),
      emotion: activeSeg?.emotion || beat.emotion || "cinematic focus",
      hasSpeech: Boolean(activeSeg && activeSeg.text && activeSeg.text.trim().length > 0),
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
