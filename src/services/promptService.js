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
 * Extraction Logic (Identity & Environment Focus)
 * Analyzes story text to identify specific visual constraints.
 */
export async function extractStoryMetadata(storyText) {
  const prompt = `
Analyze the following story text and extract metadata for visual consistency in image generation.

STRICT INSTRUCTIONS FOR THE 'synopsis' KEY:
The synopsis must be a visual-narrative blueprint (50-100 words). It should not just tell the plot, but describe:
1. The Scale: Is it an intimate character study or a grand epic?
2. The Lighting/Atmosphere: (e.g., "drenched in Golden Hour warmth" or "suffocated by noir shadows").
3. The Emotional Arc: How the character's physical state changes from the beginning to the end.
4. Visual Theme: Mention the specific "nature" of the story (e.g., Cyberpunk, Pastoral, Mythic).

Pay special attention to demographic accuracy:
- If the story is about a specific culture (e.g., Caribbean, Viking, Ancient Rome), the characters MUST reflect that regional demographic/tribe accurately.

Return STRICT valid JSON:
{
  "artStyle": "Specific photographic style (e.g., 35mm film, anamorphic, oil painting)",
  "colorPalette": "Dominant tones and accent colors",
  "demographic": "Specific ethnic/regional identity based on setting",
  "personality": "Traits influencing facial expressions/posture",
  "environment": "Setting details accurate to the narrative",
  "physicality": "A pose or reaction reflecting the character's state",
  "anchor": "A recurring object for visual consistency",
  "texture": "Tactile details (e.g., weathered skin, coarse wool)",
  "synopsis": "The visual-narrative blueprint described above."
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

    const raw =
      response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    // Strip markdown code fences if Gemini wraps JSON in ```json ... ```
    const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

    return JSON.parse(text);
  } catch (err) {
    logger.error("❌ Failed to extract story metadata:", err);

    return {
      artStyle: "Cinematic Realistic Film",
      colorPalette: "Natural Cinematic Colors",
      demographic: "A person matching the story's ethnic and regional context",
      personality: "Determined and focused",
      environment: "A setting accurate to the narrative",
      physicality: "A natural reaction",
      anchor: "An object from the story",
      texture: "Realistic textures",
      synopsis: "A cinematic story with deep emotional resonance.",
    };
  }
}

/**
 * Generates the Universal Story-to-Cover Master Prompts (v5.0)
 */
export function generateMasterPrompts(metadata, title, aspectRatio = "16:9") {
  const { artStyle, colorPalette, demographic, personality, environment, physicality, anchor, texture } = metadata;

  const commonVisuals = generateCommonVisualPrompt(metadata);

  // [PROMPT 1: THE 9:16 ICONIC POSTER]
  const prompt1 = `
    A high-impact 9:16 iconic poster featuring an extreme close-up (ECU) of the central character, focusing on the raw emotional peak of the story. 
    ${commonVisuals}
    Physical Action: ${physicality}.
    Shot Detail: 85mm lens compression, making the subject feel intimate and physically close. Every pore, bead of sweat, and individual hair is crisp and tactile.
    Background: ${environment}.
    Lighting: Intense cinematic "Key Lighting" that casts deep, dramatic shadows, highlighting the contours of the face.
    Typography: Bold, stylized 3D typography for the title "${title}" is placed with a "shallow depth of field," allowing it to sit naturally within the scene's atmosphere. STRICT RULE: Use the title exactly as provided. No subtitles or creative additions allowed.
  `.trim();

  // [PROMPT 2: THE 16:9 CINEMATIC WIDE-CLOSE]
  const prompt2 = `
    A breathtaking 16:9 cinematic "Medium-Close" shot prioritizing immersive detail over wide landscapes.
    The frame is tightly packed with environmental storytelling, showing the protagonist react to the story's climax with ${physicality}.
    ${commonVisuals}
    Story Anchor: ${anchor} must be in the immediate foreground.
    Technical: Anamorphic lens flares and heavy Bokeh. Hyper-realistic, high-budget film still.
    Constraint: STRICTLY NO TEXT, words, or letters.
  `.trim();

  return { poster: prompt1, cinematic: prompt2 };
}

/**
 * Generates a common visual prompt to sync the whole story theme, characters, style, tone.
 * This should be concatenated with unique scene-specific prompts.
 */
export function generateCommonVisualPrompt(metadata) {
  const { artStyle, colorPalette, demographic, personality, environment, texture, synopsis } = metadata;
  const synopsisPart = synopsis ? ` Narrative Context: ${synopsis}` : "";
  return `Art Style: ${artStyle}.${synopsisPart} Visual Identity: ${demographic} with a ${personality} personality. Setting: ${environment}. Color Palette: ${colorPalette}. Texture Detail: ${texture}. Consistent visual tone: High quality cinematic story illustration, 8k resolution, photorealistic.`.trim();
}

/**
 * Generates 3 anchor prompts for the Character Bible
 */
export function generateCharacterBiblePrompts(demographic) {
  const views = [
    { name: "front", description: "Full front view, neutral expression, looking directly at camera." },
    { name: "profile", description: "Profile view (side), looking away from camera." },
    { name: "three_quarter", description: "3/4 view, cinematic lighting, looking slightly off-camera." }
  ];

  return views.map(view => {
    return `
      A professional studio character reference sheet: ${view.name} view.
      Character Identity: ${demographic}.
      Composition: ${view.description}.
      Lighting: Balanced studio lighting, high contrast, every detail of features and skin texture clearly visible.
      Aesthetic: Hyper-realistic, 8k, cinematic, ultra-detailed.
      Constraint: No text, white or solid background for clean reference.
    `.trim();
  });
}
