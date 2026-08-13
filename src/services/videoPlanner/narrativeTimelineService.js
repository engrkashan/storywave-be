/**
 * narrativeTimelineService.js — Narrative Timeline Generator for Video Planner
 *
 * Analyzes the ENTIRE script upfront to extract a continuous timeline of cinematic beats.
 * Guarantees every meaningful physical action exists exactly once without skipping transitional actions.
 *
 * Fix I-1: Upgraded to gpt-5.6. Added one retry attempt before falling back to sentence-split.
 * Fix I-5: Over-target beats are now merged (narrative text combined) instead of sliced,
 *          preserving full story coverage.
 */

import OpenAI from "openai";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("NarrativeTimelineService");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Analyzes script and produces a structured array of cinematic beats.
 *
 * @param {string} script        - Full narrative script text
 * @param {object} storyBible    - Story Bible metadata (characters, locations, etc.)
 * @param {number} targetSceneCount - Target number of scenes
 * @returns {Promise<Array<object>>} List of cinematic narrative beats
 */
export async function generateNarrativeTimeline(script, storyBible = {}, targetSceneCount = null) {
  logger.info(`🎬 [Video Planner] Generating Master Director Movie Guide for script (Target Scene Count: ${targetSceneCount || "Auto"})...`);

  const charactersStr = storyBible?.characters?.map(c => `- ${c.name} (ID: ${c.id}): ${c.appearance || c.role || "Main character"}`).join("\n") || "None";
  const locationsStr = storyBible?.locations?.map(l => `- ${l.name}: ${l.description || "Scene location"}`).join("\n") || "None";
  const storySynopsis = storyBible?.synopsis || storyBible?.concept || "Cinematic storytelling sequence";

  const targetConstraintStr = targetSceneCount && targetSceneCount > 0
    ? `6. EXACT BEAT COUNT: Create EXACTLY ${targetSceneCount} beats. Map spoken dialogue and actions into these ${targetSceneCount} sequential beats without skipping any part of the script.`
    : "6. BALANCED BEATS: Create concise, fluid narrative beats matching natural speech flow.";

  const prompt = `You are a master Hollywood cinematic director and action continuity supervisor.
Your objective is to analyze the ENTIRE script and Story Bible below and construct a Master Director Movie Guide — an ordered timeline of continuous visual action beats.

MASTER DIRECTORIAL GUIDELINES:
1. DIALOGUE INTEGRATION: Attach spoken dialogue lines to the exact beat where the character speaks them.
2. CHRONOLOGICAL ACTION CONTINUITY: Every beat MUST start precisely in the physical pose where the previous beat ended. No jump cuts, no teleportation, no repeated actions.
3. COMPLETE VISUAL ACTIONS: Describe rich physical movements, facial expressions, and body language for every beat.
4. PACING & EMOTIONAL ARC: Match camera movement and character posture to the emotional tone of the scene.
5. NO OVERLAPS: Every word of the script belongs to exactly one beat.
${targetConstraintStr}

STORY SYNOPSIS:
${storySynopsis}

CHARACTERS & VISUAL IDENTITY:
${charactersStr}

LOCATIONS & ENVIRONMENT:
${locationsStr}

FULL SCRIPT:
${script}

Return STRICT JSON object format:
{
  "directorNote": "Overall directorial vision and visual flow strategy for the movie",
  "beats": [
    {
      "beatIndex": 0,
      "narrative": "Detailed description of the visual scene and action",
      "action": "Specific physical movement (e.g. 'Character steps forward, turning slightly left')",
      "startingPose": "Exact initial pose character is in at the start of this clip",
      "spokenText": "Dialogue lines spoken during this beat, or empty string",
      "characterName": "Name of primary character active",
      "characterId": "ID or name of primary character",
      "location": "Active location name",
      "emotion": "Dominant emotional tone",
      "cameraMotion": "Cinematic camera movement (e.g. Smooth steady tracking shot)"
    }
  ]
}`;

  // Fix I-1: 2-attempt retry before falling back to sentence split
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      logger.info(`[Narrative Timeline] LLM attempt ${attempt}/2...`);
      const res = await openai.chat.completions.create({
        model: "gpt-5.6", // Fix I-1: upgraded from gpt-5.5
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });

      const parsed = JSON.parse(res.choices[0].message.content.trim());
      let beats = parsed.beats || [];

      if (beats.length === 0) {
        logger.warn(`[Narrative Timeline] Attempt ${attempt}: LLM returned 0 beats.`);
        if (attempt < 2) continue;
      }

      // Fix I-5: Merge over-target beats instead of slicing (preserves narrative coverage)
      if (targetSceneCount && targetSceneCount > 0 && beats.length > targetSceneCount) {
        logger.info(`⚠️ LLM returned ${beats.length} beats, merging to target ${targetSceneCount} (preserving narrative coverage)...`);
        beats = mergeBeatsToTarget(beats, targetSceneCount);
      }

      logger.info(`✅ [Narrative Timeline] Successfully generated ${beats.length} cinematic beats.`);
      return beats;
    } catch (err) {
      logger.warn(`❌ Narrative Timeline LLM attempt ${attempt} failed: ${err.message}`);
      if (attempt === 2) {
        logger.error("❌ Both LLM attempts failed — falling back to sentence-split parser.");
      }
    }
  }

  // Sentence-split fallback (only reached after both LLM attempts fail)
  const sentences = script.split(/(?<=[.!?])\s+/).filter(Boolean);
  const resultBeats = sentences.map((s, idx) => ({
    beatIndex: idx,
    narrative: s,
    action: s,
    spokenText: s,
    characterName: storyBible?.characters?.[0]?.name || "Subject",
    characterId: storyBible?.characters?.[0]?.id || "char_1",
    location: storyBible?.locations?.[0]?.name || "Scene Location",
    emotion: "cinematic",
    isTransition: false,
  }));
  const fallbackBeats = targetSceneCount && targetSceneCount > 0 ? mergeBeatsToTarget(resultBeats, targetSceneCount) : resultBeats;
  logger.info(`⚠️ [Narrative Timeline] Sentence-split fallback: ${fallbackBeats.length} beats.`);
  return fallbackBeats;
}

/**
 * Fix I-5: Merges an over-count beat array down to targetCount by combining
 * the shortest adjacent beats (narrative + action text concatenated).
 * Preserves ALL narrative content — nothing is discarded.
 *
 * @param {Array} beats
 * @param {number} target
 * @returns {Array}
 */
function mergeBeatsToTarget(beats, target) {
  let result = beats.map((b, i) => ({ ...b, beatIndex: i }));

  while (result.length > target) {
    // Find the adjacent pair with the shortest combined narrative length
    let minLen = Infinity;
    let mergeIdx = 0;
    for (let i = 0; i < result.length - 1; i++) {
      const combined = (result[i].narrative || "").length + (result[i + 1].narrative || "").length;
      if (combined < minLen) {
        minLen = combined;
        mergeIdx = i;
      }
    }

    const a = result[mergeIdx];
    const b = result[mergeIdx + 1];

    const merged = {
      ...a,
      beatIndex: mergeIdx,
      narrative: [a.narrative, b.narrative].filter(Boolean).join(" "),
      action: [a.action, b.action].filter(Boolean).join(", then "),
      // Keep the first beat's spoken text; append second if it has unique dialogue
      spokenText: a.spokenText
        ? (b.spokenText && b.spokenText !== a.spokenText
            ? `${a.spokenText} ${b.spokenText}`
            : a.spokenText)
        : (b.spokenText || ""),
      emotion: a.emotion || b.emotion,
      cameraMotion: a.cameraMotion || b.cameraMotion,
    };

    result.splice(mergeIdx, 2, merged);
    // Re-index
    result = result.map((r, i) => ({ ...r, beatIndex: i }));
  }

  return result;
}
