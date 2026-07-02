import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("PromptService");

if (process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
  // Prevent SDK conflict
  delete process.env.GOOGLE_API_KEY;
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Phase 1: Reference Image Analysis
 * Extracts physical traits from a user-uploaded reference image.
 */
export async function analyzeReferenceImage(imageUrl) {
  try {
    logger.info(`Analyzing reference image: ${imageUrl}`);
    const res = await fetch(imageUrl);
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const mimeType = res.headers.get("content-type") || "image/jpeg";

    const prompt = `Analyze this character reference image. Extract canonical physical traits to be used in a Story Bible.
Return STRICT valid JSON:
{
  "face": "detailed facial structure and features",
  "hair": "hairstyle, color, texture",
  "skin": "skin tone and complexion",
  "age": "approximate age",
  "build": "body type and proportions",
  "expression": "default expression or vibe",
  "clothing": "current clothing (if clearly visible and relevant)"
}`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { data: base64, mimeType } }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    const raw = response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(text);
  } catch (err) {
    logger.error("❌ Failed to analyze reference image:", err);
    return null;
  }
}

/**
 * Phase 2: Story Bible Generation
 * Analyzes story text and reference traits to extract persistent visual metadata.
 */
export async function extractStoryMetadata(storyText, referenceTraits = null) {
  let refContext = "";
  if (referenceTraits) {
    refContext = `
A main character reference image was provided. Include these exact traits in the main character's definition:
${JSON.stringify(referenceTraits, null, 2)}
`;
  }

  const prompt = `
Analyze the following story script and extract metadata to build a comprehensive STORY BIBLE for visual consistency.
${refContext}

Extract every persistent visual entity (characters, locations, objects, vehicles).

Return STRICT valid JSON:
{
  "characters": [
    {
      "id": "char_1",
      "name": "Character Name",
      "importance": "main or supporting",
      "appearance": "Extremely detailed physical description (face, hair, skin, age, build)",
      "base_clothing": "Default clothing worn at the start of the story",
      "personality": "Traits influencing micro-expressions"
    }
  ],
  "locations": [
    {
      "id": "loc_1",
      "name": "Location Name",
      "description": "Specific architectural and layout details. E.g., 'small suburban home with white walls, wooden porch, red mailbox'"
    }
  ],
  "objects": [
    {
      "id": "obj_1",
      "name": "Object Name",
      "description": "Detailed visual description of the recurring object or vehicle"
    }
  ],
  "artStyle": "Specific cinematic photographic style",
  "colorPalette": "Dominant tones, contrast ratios, and accent colors",
  "cinematicSpecs": "Professional camera and lighting setup",
  "synopsis": "A visual-narrative blueprint (50-100 words) describing the scale, lighting atmosphere, and emotional arc."
}

Story:
${storyText}
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    const raw = response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(text);
  } catch (err) {
    logger.error("❌ Failed to extract story metadata:", err);
    return {
      characters: [],
      locations: [],
      objects: [],
      artStyle: "Cinematic Realistic Film",
      colorPalette: "Natural Cinematic Colors",
      cinematicSpecs: "High-end cinematic lighting and camera setup",
      synopsis: "A cinematic story with deep emotional resonance.",
    };
  }
}

/**
 * Generates the Universal Story-to-Cover Master Prompts
 */
export function generateMasterPrompts(metadata, title, aspectRatio = "16:9") {
  const commonVisuals = generateCommonVisualPrompt(metadata);
  const mainCharacter = metadata.characters?.[0] || { appearance: "A detailed cinematic character" };
  const mainLocation = metadata.locations?.[0] || { description: "A detailed cinematic environment" };

  const prompt1 = `
    A high-impact 9:16 iconic poster featuring an extreme close-up (ECU) of the central character (\${mainCharacter.appearance}), focusing on raw emotion. 
    ${commonVisuals}
    Background: ${mainLocation.description}.
    Lighting: Intense cinematic "Key Lighting" that casts deep, dramatic shadows.
    Typography: Bold, stylized 3D typography for the title "${title}" is placed with a "shallow depth of field". STRICT RULE: Use the title exactly as provided. No subtitles.
  `.trim();

  const prompt2 = `
    A breathtaking 16:9 cinematic "Medium-Close" shot prioritizing immersive detail.
    The frame is tightly packed with environmental storytelling. Character: ${mainCharacter.appearance}.
    ${commonVisuals}
    Location: ${mainLocation.description}.
    Technical: Anamorphic lens flares and heavy Bokeh. Hyper-realistic, high-budget film still.
    Constraint: STRICTLY NO TEXT, words, or letters.
  `.trim();

  return { poster: prompt1, cinematic: prompt2 };
}

/**
 * Generates a common visual prompt to sync the whole story theme, style, tone.
 */
export function generateCommonVisualPrompt(metadata) {
  const { artStyle, colorPalette, cinematicSpecs, synopsis } = metadata;
  const synopsisPart = synopsis ? ` Narrative Context: ${synopsis}` : "";
  return `Art Style: ${artStyle}.${synopsisPart} Color Palette: ${colorPalette}. Technical Specs: ${cinematicSpecs}. Consistent visual tone: High-end cinematic movie still, shot on professional lenses, 8k resolution, hyper-realistic, volumetric lighting, ray-traced reflections, masterwork quality, IMAX aesthetic.`.trim();
}

/**
 * Generates anchor prompts for the Character Bible
 */
export function generateCharacterBiblePrompts(characterDescription) {
  const views = [
    { name: "front", description: "Full front view, neutral expression, looking directly at camera." },
    { name: "profile", description: "Profile view (side), looking away from camera." },
    { name: "three_quarter", description: "3/4 view, cinematic lighting, looking slightly off-camera." }
  ];

  return views.map(view => {
    return `
      A professional studio character reference sheet: ${view.name} view.
      Character Identity: ${characterDescription}.
      Composition: ${view.description}.
      Lighting: Balanced studio lighting, high contrast, every detail of features and skin texture clearly visible.
      Aesthetic: Hyper-realistic, 8k, cinematic, ultra-detailed.
      Constraint: No text, white or solid background for clean reference.
    `.trim();
  });
}

/**
 * Scene Prompt Instructions - Version 1 (Legacy)
 */
export const SCENE_PROMPT_VERSION_ONE = `
Scene Rules:
- Focus on Action: Describe the specific movement, reaction, or interaction in this scene.
- Narrative Beat: Each prompt must reflect a unique part of the story timeline.
- Synergy: Assume these unique details will be combined with a "Common Visual Prompt".
- Cinematic Essence: Capture the exact physical intensity of the moment.
`.trim();

/**
 * Scene Prompt Instructions - Version 2 (Story Bible Continuity)
 */
export const SCENE_PROMPT_VERSION_TWO = `
*For each image, incorporate ALL of the following visual elements into one flowing, highly descriptive paragraph:*

- Main Subject (WHO): Exactly who or what is visible. Use the exact physical traits from the Story Bible.
- Current Action (WHAT): Describe ONLY the specific, physical action occurring precisely at this moment.
- Location & Architecture (WHERE): Use the exact location descriptions from the Story Bible.
- Time & Lighting (WHEN): Time of day, weather, and specific lighting based on the Dynamic Scene State.
- Emotion & Body Language (HOW): Facial expressions based on the Tone from the Dynamic Scene State.
- Camera Framing: Decide the best still-image framing. NO camera movements.
- Visual Details: Highly concrete semantic details.

*Critical Continuity Rules (MANDATORY):*
- Maintain identical facial identity, hair, age, and build for characters as defined in the Story Bible.
- Maintain identical clothing as defined in the Dynamic Scene State.
- Maintain identical locations, objects, and vehicles as defined in the Story Bible.
- Preserve cinematic continuity from previous scenes. Never leave consistency to chance.

*Critical Exclusions & Anti-Patterns:*
- NO generic adjectives or filler phrases (do not use: "cinematic", "epic", "masterpiece").
- NO video-centric metadata: NO camera movements, NO audio, NO dialogue.
- NO abstract storytelling. Describe only what is physically visible in the freeze-frame.
- STRICTLY NO text, captions, subtitles, or letters in the image.

*Required Format:*
[A single, highly detailed, visually concrete paragraph describing exactly what is visible in the frame, reading like a professional storyboard artist's instruction.]
`.trim();
