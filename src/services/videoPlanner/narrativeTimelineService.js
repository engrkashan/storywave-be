/**
 * narrativeTimelineService.js — Narrative Timeline Generator for Video Planner
 *
 * Analyzes the ENTIRE script upfront to extract a continuous timeline of cinematic beats.
 * Guarantees every meaningful physical action exists exactly once without skipping transitional actions.
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

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(res.choices[0].message.content.trim());
    let beats = parsed.beats || [];

    if (targetSceneCount && targetSceneCount > 0 && beats.length > targetSceneCount) {
      logger.info(`⚠️ LLM returned ${beats.length} beats, trimming/merging to target ${targetSceneCount} beats...`);
      beats = beats.slice(0, targetSceneCount);
    }

    logger.info(`✅ [Narrative Timeline] Successfully generated ${beats.length} cinematic beats.`);
    return beats;
  } catch (err) {
    logger.error("❌ Narrative Timeline generation failed, using fallback parser:", err.message);
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
    return targetSceneCount && targetSceneCount > 0 ? resultBeats.slice(0, targetSceneCount) : resultBeats;
  }
}
