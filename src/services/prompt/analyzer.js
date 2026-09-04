/**
 * analyzer.js — Story Analysis, Reference Image Traits & Materialized Story Bible Extraction
 */

import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("PromptAnalyzer");

if (process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
  delete process.env.GOOGLE_API_KEY;
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });

/**
 * Phase 1: Reference Image Analysis
 * Extracts physical traits from a user-uploaded reference image.
 */
export async function analyzeReferenceImage(imageUrl) {
  try {
    logger.info(`Analyzing reference image: ${imageUrl}`);

    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = res.headers.get("content-type") || "image/jpeg";

    const prompt = `Analyze this character reference image. Extract canonical physical facial and body traits to be used in a Story Bible.
NOTE: Do NOT extract wardrobe/clothing from the reference image, as wardrobe will be derived strictly from the story script. Focus ONLY on facial and physical features.
Return STRICT valid JSON:
{
  "face": "detailed facial structure and features",
  "hair": "hairstyle, color, texture",
  "skin": "skin tone and complexion",
  "ethnicity": "perceived ethnicity or cultural background",
  "age": "approximate age",
  "build": "body type and proportions",
  "expression": "default expression or vibe"
}`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: base64,
                mimeType: mimeType.split(";")[0],
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    const text =
      typeof response.text === "string" && response.text.length > 0
        ? response.text
        : response.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || "{}";

    const cleanedJson = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

    return JSON.parse(cleanedJson);
  } catch (err) {
    logger.error("❌ Failed to analyze reference image:", err);
    return null;
  }
}

/**
 * Phase 2: Story Bible Generation
 * Extracts full MATERIALIZED STORY BIBLE using Schema A CHARACTER_CAPSULEs and Schema B LOCATION_RECORDs.
 */
export async function extractStoryMetadata(storyText, referenceTraits = null) {
  let refContext = "";
  if (Array.isArray(referenceTraits) && referenceTraits.length > 0) {
    refContext = `
The following character reference images were provided. Lock these exact traits to their respective CHARACTER_CAPSULEs:
${JSON.stringify(referenceTraits, null, 2)}
`;
  } else if (referenceTraits && !Array.isArray(referenceTraits)) {
    refContext = `
A main character reference image was provided. Lock these exact traits to the main character's CHARACTER_CAPSULE:
${JSON.stringify(referenceTraits, null, 2)}
`;
  }

  const prompt = `You are a casting director, character-identity designer, production designer, and cultural/period researcher.
Analyze the COMPLETE story script below — including the ending — and extract a full MATERIALIZED STORY BIBLE.

NON-NEGOTIABLE RULES:
1. MANDATORY CASTING DIRECTIVE: All characters created or extracted MUST be Black and Jamaican (Afro-Caribbean heritage). Ensure all character descriptions, canonical_skin_tone (rich melanin dark/brown tones), facial features, and hair textures (locs, dreadlocks, braids, fades, natural curls/coils) strictly reflect authentic Black Jamaican identity.
2. MATERIALIZATION: A racial/ethnic/national label is IDENTITY ONLY. Pair with a full physical CHARACTER_CAPSULE.
3. Every field below must be physically defined so an image/video generator CANNOT invent the face.
4. UNIVERSAL WORLD: detect world details from the actual source.
5. No-Shorthand: never use "same," "unchanged," "as before".

${refContext}

STORY:
${storyText}

Return STRICT valid JSON:
{
  "characters": [
    {
      "id": "char_1",
      "name": "Exact character name from story",
      "importance": "main | supporting",
      "isMainCharacter": true,
      "sketch_artist_appearance": {
        "age_range": "string",
        "gender_presentation": "string",
        "height": "string",
        "body_type": "string",
        "canonical_skin_tone": "string",
        "face_structure": "string",
        "eyes": "string",
        "nose": "string",
        "hair": "string",
        "facial_hair": "string"
      },
      "base_wardrobe": {
        "upper_garment": "string",
        "lower_garment": "string",
        "exact_color_family": "string"
      },
      "appearance": "FULL physical description paragraph",
      "base_clothing": "FULL clothing description paragraph"
    }
  ],
  "locations": [
    {
      "id": "loc_1",
      "name": "string",
      "lighting_atmosphere": {
        "light_source": "string",
        "color_temp": "string",
        "time_of_day": "string"
      },
      "description": "FULL production-design-level description paragraph"
    }
  ],
  "artStyle": "Specific cinematic photographic style",
  "colorPalette": "Dominant tones and accent colors",
  "cinematicSpecs": "Professional camera and lighting setup",
  "synopsis": "Visual narrative blueprint"
}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const raw = response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(text);

    for (const char of parsed.characters || []) {
      if (!char.appearance) {
        const sa = char.sketch_artist_appearance || {};
        char.appearance = [sa.age_range, sa.gender_presentation, sa.canonical_skin_tone, sa.face_structure, sa.eyes, sa.hair].filter(Boolean).join(". ");
      }
      if (!char.base_clothing) {
        const bw = char.base_wardrobe || {};
        char.base_clothing = [bw.upper_garment, bw.lower_garment, bw.exact_color_family].filter(Boolean).join(", ");
      }
    }

    return parsed;
  } catch (err) {
    logger.error("❌ Failed to extract story metadata:", err);
    return {
      characters: [],
      locations: [],
      artStyle: "Cinematic Realistic Film",
      colorPalette: "Natural Cinematic Tones",
      cinematicSpecs: "High-end cinematic lighting and camera setup",
      synopsis: "A cinematic story with deep emotional resonance.",
    };
  }
}
