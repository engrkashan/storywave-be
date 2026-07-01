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
  "characters": [
    {
      "id": "char_1",
      "name": "Character Name (or description if unnamed)",
      "color": "Skin color, race, or ethnicity (e.g. Black, Caucasian, Asian, olive skin, dark skin)",
      "age": "Approximate age in years (e.g. 25) or age range (e.g. mid-30s)",
      "sex": "male or female",
      "appearance": "Extremely detailed physical description (hair texture, eye color, facial features, skin details, and specific outfit). Avoid naming actors.",
      "personality": "Traits influencing micro-expressions, posture, and gaze",
      "isMainCharacter": true
    }
  ],
  "artStyle": "Specific cinematic photographic style (e.g., Anamorphic 35mm film, IMAX digital, Hand-held documentary, Grainy noir)",
  "colorPalette": "Dominant tones, contrast ratios, and accent colors (e.g., Teal and Orange with high-key highlights)",
  "demographic": "Specific ethnic/regional identity, age range, and attire based on setting",
  "environmentSignature": "A visual blueprint of the main setting. Describe architectural style, key furniture/objects, wall textures, and lighting atmosphere (e.g., 'Modernist concrete apartment with floor-to-ceiling glass and soft recessed amber lighting')",
  "physicality": "A specific pose, muscle tension, or visceral reaction reflecting the protagonist's internal state",
  "anchor": "A recurring high-detail object for visual consistency",
  "texture": "Macro tactile details (e.g., weathered skin pores, coarse wool fibers, rain-slicked pavement)",
  "cinematicSpecs": "Professional camera and lighting setup (e.g., 'Shot on 35mm Panavision lenses, deep depth of field, chiaroscuro lighting')",
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
      characterAppearance: "Detailed features consistent with the setting",
      personality: "Determined and focused",
      environmentSignature: "A setting accurate to the narrative",
      physicality: "A natural reaction",
      anchor: "An object from the story",
      texture: "Realistic textures",
      cinematicSpecs: "High-end cinematic lighting and camera setup",
      synopsis: "A cinematic story with deep emotional resonance.",
    };
  }
}

/**
 * Generates the Universal Story-to-Cover Master Prompts (v5.0)
 */
export function generateMasterPrompts(metadata, title, aspectRatio = "16:9") {
  const { artStyle, colorPalette, demographic, characterAppearance, personality, environmentSignature, physicality, anchor, texture, cinematicSpecs } = metadata;

  const commonVisuals = generateCommonVisualPrompt(metadata);

  // [PROMPT 1: THE 9:16 ICONIC POSTER]
  const prompt1 = `
    A high-impact 9:16 iconic poster featuring an extreme close-up (ECU) of the central character, focusing on the raw emotional peak of the story. 
    ${commonVisuals}
    Physical Action: ${physicality}.
    Shot Detail: 85mm lens compression, making the subject feel intimate and physically close. Every pore, bead of sweat, and individual hair is crisp and tactile.
    Background: ${environmentSignature}.
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
  const { artStyle, colorPalette, demographic, characterAppearance, personality, environmentSignature, texture, cinematicSpecs, synopsis } = metadata;
  const synopsisPart = synopsis ? ` Narrative Context: ${synopsis}` : "";
  return `Art Style: ${artStyle}.${synopsisPart} Visual Identity: ${demographic}, ${characterAppearance} with a ${personality} personality. Setting: ${environmentSignature}. Color Palette: ${colorPalette}. Texture Detail: ${texture}. Technical Specs: ${cinematicSpecs}. Consistent visual tone: High-end cinematic movie still, shot on professional lenses, 8k resolution, hyper-realistic, volumetric lighting, ray-traced reflections, masterwork quality, IMAX aesthetic.`.trim();
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

/**
 * Scene Prompt Instructions - Version 1 (Previous)
 */
export const SCENE_PROMPT_VERSION_ONE = `
Scene Rules:
- Focus on Action: Describe the specific movement, reaction, or interaction in this scene.
- Narrative Beat: Each prompt must reflect a unique part of the story timeline.
- Synergy: Assume these unique details will be combined with a "Common Visual Prompt" containing the art style, characters, and color palette.
- Cinematic Essence: Capture the exact physical intensity of the moment.
`.trim();

/**
 * Scene Prompt Instructions - Version 2 (Detailed Freeze-Frame Paragraph)
 */
export const SCENE_PROMPT_VERSION_TWO = `
*For each image, incorporate ALL of the following visual elements into one flowing, highly descriptive paragraph:*

- Main Subject (WHO): Exactly who or what is visible. Be specific (e.g., "a 1920s detective", "a weathered wooden door").
- Current Action (WHAT): Describe ONLY the specific, physical action occurring precisely at this moment (e.g., "pushing open a creaky door", "holding a smoking flare"). Do not describe implied or past/future actions.
- Location & Architecture (WHERE): The specific setting details (e.g., "a dimly lit abandoned hallway", "a neon-lit cyberpunk alleyway").
- Time & Lighting (WHEN): Time of day, weather, and specific lighting (e.g., "golden hour sunlight filtering through dust", "harsh fluorescent overhead lighting").
- Emotion & Body Language (HOW): Facial expressions, posture, and muscle tension (e.g., "eyes wide with terror", "slumped in exhaustion").
- Camera Framing: Decide the best still-image framing (e.g., close-up, medium shot, wide shot, bird's-eye view, low-angle). NO camera movements (no pan, dolly, etc).
- Visual Details: Highly concrete semantic details (e.g., dust particles, rain, fog, fire embers, coarse wool, rain-slicked pavement).

*Critical Exclusions & Anti-Patterns:*
- NO generic adjectives or filler phrases (do not use: "cinematic", "epic", "masterpiece", "award winning", "high quality"). Rely on semantic visual descriptions instead.
- NO video-centric metadata: NO camera movements, NO audio, NO music, NO dialogue, NO durations.
- NO scene/shot numbering prefixes (e.g., do not write "Scene 1, Shot 1:").
- NO abstract storytelling or summaries. Describe only what is physically visible in the freeze-frame.

*Required Format:*
[A single, highly detailed, visually concrete paragraph describing exactly what is visible in the frame, reading like a professional storyboard artist's instruction.]

*Example:*
Low-angle medium shot of a firefighter carrying an unconscious child through thick black smoke. The firefighter's face is obscured by a soot-stained mask, their shoulders hunched against the heat. Embers drift heavily through the air like fireflies, illuminated by the harsh, pulsing orange glow of a collapsing ceiling. Puddles of water on the cracked tile floor reflect the surrounding flames.
`.trim();
