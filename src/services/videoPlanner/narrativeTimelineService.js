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
export async function generateNarrativeTimeline(script, storyBible = {}) {
  logger.info("🎬 [Video Planner] Generating Narrative Timeline for script...");

  const charactersStr = storyBible?.characters?.map(c => `- ${c.name} (ID: ${c.id})`).join("\n") || "None";
  const locationsStr = storyBible?.locations?.map(l => `- ${l.name}`).join("\n") || "None";

  const prompt = `You are a master cinematic director and action continuity editor.
Your objective is to analyze the ENTIRE script below and break it down into an ordered timeline of individual, continuous cinematic action beats.

CRITICAL DIRECTORIAL RULES:
1. ZERO SKIPPED ACTIONS: You MUST extract every physical action, movement, reaction, and transition. Never jump over intermediate physical steps (e.g. if a character walks to a wall, climbs, jumps, lands, looks behind, and runs — EVERY single step MUST be its own distinct beat).
2. NO COMPOUND OVERFLOW: Do NOT compress multiple major physical movements into a single beat. Break them down step by step.
3. DIALOGUE INTEGRATION: Attach the exact spoken dialogue lines to the specific beat where the character speaks them.
4. CHRONOLOGICAL CONTINUITY: Every beat MUST start exactly where the previous beat ended.

CHARACTERS:
${charactersStr}

LOCATIONS:
${locationsStr}

SCRIPT:
${script}

Return STRICT JSON object format:
{
  "beats": [
    {
      "beatIndex": 0,
      "narrative": "Description of the specific visual action",
      "action": "Specific physical movement (e.g., 'character climbs to top of wall')",
      "spokenText": "Dialogue lines spoken during this beat, or empty string",
      "characterName": "Name of primary character active",
      "characterId": "ID or name of primary character",
      "location": "Active location name",
      "emotion": "Dominant emotional tone",
      "isTransition": false
    }
  ]
}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.6",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(res.choices[0].message.content.trim());
    const beats = parsed.beats || [];
    logger.info(`✅ [Narrative Timeline] Successfully generated ${beats.length} cinematic beats.`);
    return beats;
  } catch (err) {
    logger.error("❌ Narrative Timeline generation failed, using fallback parser:", err.message);
    const sentences = script.split(/(?<=[.!?])\s+/).filter(Boolean);
    return sentences.map((s, idx) => ({
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
  }
}
