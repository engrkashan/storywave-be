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

    // 1. Fetch the image and convert to Base64 safely
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

    // 2. Call the Gemini SDK with structured parts
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview", // Note: fallback to 'gemini-2.5-flash' if preview isn't live in your project
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: base64,
                mimeType: mimeType.split(";")[0] // Strip charsets or extras if present
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    // 3. Extract text. NOTE: in the Gemini SDK `response.text` is a GETTER (a string),
    //    not a function — calling response.text() throws "response.text is not a function".
    //    Read it as a property and fall back to the raw candidate parts safely.
    const text =
      (typeof response.text === "string" && response.text.length > 0)
        ? response.text
        : (response.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text || "{}");

    // Clean potential markdown wrappers just in case
    const cleanedJson = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

    return JSON.parse(cleanedJson);
  } catch (err) {
    logger.error("❌ Failed to analyze reference image:", err);
    return null;
  }
}

/**
 * Phase 2: Story Bible Generation — v6.3 (Universal Motion Graphic Engine)
 *
 * Analyzes story text and reference traits to extract a full MATERIALIZED STORY BIBLE
 * using Schema A CHARACTER_CAPSULEs and Schema B LOCATION_RECORDs.
 *
 * MATERIALIZATION RULE: A racial/ethnic/national label is identity only — it must
 * always be paired with a full physical/behavioral CHARACTER_CAPSULE.
 * A location name alone is never sufficient — pair with a full LOCATION_RECORD.
 *
 * Returns a storyMetadata object whose shape is BACKWARD COMPATIBLE with the
 * existing workflowService.js (characters[], locations[], artStyle, colorPalette,
 * cinematicSpecs, synopsis) while adding the full v6.3 bible fields.
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
1. MATERIALIZATION: A racial/ethnic/national label (e.g., "Japanese man", "Nigerian woman") is IDENTITY ONLY.
   It MUST be paired with a full physical CHARACTER_CAPSULE. A location name alone is NEVER sufficient.
2. STANDARD: a label + age + build FAILS. Every field below must be physically defined so an image generator CANNOT invent the face.
3. UNIVERSAL WORLD: detect world details from the actual source; never hard-code an unrelated country/culture/climate.
4. No-Shorthand: never use "same," "unchanged," "as before" etc. Always write current values in full.

CONDITIONAL CULTURAL MODULE:
- Accurately identify and preserve the specific cultural, regional, and ethnic identities of the characters and locations as described in the story.
- Do not generalize specific cultures into broad categories (e.g., do not turn a specific African nation into "generic African").
- Strictly forbid cultural drift into unrelated or dominant global archetypes (e.g., do not substitute U.S. or European aesthetics for other global locations unless explicitly set there).
- Match location details to the specific real-world or described region, city, or district.

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
      "identity_culture": {
        "race": "string",
        "ethnicity_cultural_identity": "string",
        "nationality": "string",
        "regional_community_identity": "string"
      },
      "sketch_artist_appearance": {
        "age_range": "string",
        "gender_presentation": "string",
        "height": "string",
        "body_type": "string (shoulders/torso/waist/limbs proportions)",
        "canonical_skin_tone": "string (never rewritten by lighting)",
        "canonical_undertone": "string",
        "complexion_texture_marks": "string",
        "face_structure": "string (shape/forehead/brows)",
        "eyes": "string (color/shape/spacing)",
        "nose": "string",
        "cheeks": "string",
        "mouth_lips": "string",
        "jaw_chin": "string",
        "ears": "string",
        "hair": "string (texture/density/style/length/hairline/allowed drift/forbidden drift)",
        "facial_hair": "string (beard type/length/density/grooming)",
        "permanent_identifiers": "string (scars/tattoos/birthmarks/moles)"
      },
      "body_language": {
        "posture": "string",
        "resting_tension": "string",
        "resting_emotional_face": "string",
        "social_energy": "string"
      },
      "base_wardrobe": {
        "upper_garment": "string",
        "lower_garment": "string",
        "outerwear": "string",
        "exact_color_family": "string",
        "footwear": "string",
        "accessories": "string",
        "class_occupation_cues": "string"
      },
      "identity_restrictions": {
        "may_not_change": ["list of Level 1 Hard Identity fields that are locked"],
        "forbidden_substitutions": ["foreign/generic archetype substitutions that are forbidden"],
        "forbidden_drift": ["specific drift patterns to prevent"]
      },
      "appearance": "FULL physical description paragraph (backward-compatible field) — combine all sketch_artist_appearance fields into one detailed string",
      "base_clothing": "FULL clothing description paragraph (backward-compatible field)",
      "personality": "Key personality traits influencing body language and micro-expressions"
    }
  ],
  "locations": [
    {
      "id": "loc_1",
      "name": "string",
      "geographic_cultural_id": {
        "country": "string",
        "region": "string",
        "city_parish_district": "string",
        "urban_rural_category": "string",
        "social_class": "string",
        "cultural_identity": "string",
        "period": "string"
      },
      "construction": {
        "wall_roof_floor_ceiling_material": "string",
        "paint_condition": "string",
        "structural_wear": "string"
      },
      "lighting_atmosphere": {
        "light_source": "string",
        "color_temp": "string",
        "emotional_effect": "string",
        "time_of_day": "string"
      },
      "forbidden_drift": ["list of foreign visual archetypes explicitly prohibited"],
      "description": "FULL production-design-level description paragraph (backward-compatible field) — detailed enough that a production designer can physically rebuild the space"
    }
  ],
  "objects": [
    {
      "id": "obj_1",
      "name": "string",
      "description": "Detailed visual description of the recurring object or vehicle"
    }
  ],
  "world": {
    "country": "string",
    "cultural_social_economic_environment": "string",
    "climate_weather_logic": "string",
    "period": "string",
    "forbidden_foreign_archetypes": ["list"]
  },
  "artStyle": "Specific cinematic photographic style (backward-compatible)",
  "colorPalette": "Dominant tones, contrast ratios, and accent colors (backward-compatible)",
  "cinematicSpecs": "Professional camera and lighting setup (backward-compatible)",
  "synopsis": "A visual-narrative blueprint (50-100 words) describing scale, lighting atmosphere, and emotional arc (backward-compatible)"
}`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      }
    });

    const raw = response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(text);

    // Validate minimum Schema A materialization for each character
    for (const char of (parsed.characters || [])) {
      if (!char.sketch_artist_appearance?.canonical_skin_tone) {
        logger.warn(`[promptService] extractStoryMetadata: ${char.name} missing canonical_skin_tone — bible may be under-materialized`);
      }
      if (!char.appearance) {
        // Synthesize backward-compatible appearance string from sketch_artist_appearance
        const sa = char.sketch_artist_appearance || {};
        char.appearance = [sa.age_range, sa.gender_presentation, sa.height, sa.body_type, sa.canonical_skin_tone, sa.face_structure, sa.eyes, sa.nose, sa.hair, sa.facial_hair, sa.permanent_identifiers].filter(Boolean).join(". ");
      }
      if (!char.base_clothing) {
        const bw = char.base_wardrobe || {};
        char.base_clothing = [bw.upper_garment, bw.lower_garment, bw.outerwear, bw.exact_color_family, bw.footwear, bw.accessories].filter(Boolean).join(", ");
      }
    }

    return parsed;
  } catch (err) {
    logger.error("❌ Failed to extract story metadata:", err);
    return {
      characters: [],
      locations: [],
      objects: [],
      world: {},
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
 * Scene Prompt Instructions - v6.3 (Module 7 — Standalone Production Prompt Template)
 *
 * ZERO-ASSUMPTION FRAME: each final prompt must work standalone.
 * Assume the image generator has NO memory of anything prior:
 * no prompts, bibles, scenes, wardrobe, props, injuries, lighting, weather, blocking, or context.
 *
 * NO-SHORTHAND RULE: NEVER use "same," "unchanged," "identical," "as before,"
 * "continues unchanged," "all six men retain appearance," etc.
 * If something carries forward, write its CURRENT VALUES in full.
 *
 * PRODUCTION PROMPT PRIORITY ORDER (always follow within the prompt string):
 *   1. Main subject/action
 *   2. Character identity/appearance (full Level 1 physical detail)
 *   3. Clothing/physical state (exact current wardrobe, Level 2)
 *   4. Relationships/blocking (how characters relate spatially)
 *   5. Camera composition (shot size, angle, distance, lens feel, depth of field)
 *   6. Location/cultural identity (full standalone production-design-level detail)
 *   7. Foreground/midground/background layers
 *   8. Lighting/weather/atmosphere
 *   9. Visual style/technical quality
 *  10. Prohibited drift (inline, specific to this frame)
 *
 * MATERIALIZATION RULE: A racial/ethnic/national label is NOT sufficient.
 * Always include full physical/behavioral description inline in the prompt.
 *
 * IDENTITY CONTINUITY (Level 1 — never changes without story justification):
 *   race, ethnicity, nationality, canonical skin tone/undertone, face/body structure,
 *   eye/nose/mouth/jaw shape, hair texture/style/hairline, facial hair, age range, permanent marks.
 *
 * OUTPUT FORMAT: One standalone paragraph that reads like a professional storyboard
 * artist's instruction, self-contained, with all identity/wardrobe/location/camera/lighting details.
 * STRICTLY NO text, captions, subtitles, or letters in the image.
 */
export const SCENE_PROMPT_VERSION_TWO = `
*UNIVERSAL STORY-TO-MOTION-GRAPHIC IMAGE WORKFLOW — v6.3 Frame Instruction*

For each image, produce ONE STANDALONE paragraph in the following PRIORITY ORDER:

1. MAIN SUBJECT & ACTION: Exactly who or what is visible; the specific physical action at this precise moment.
2. CHARACTER IDENTITY & APPEARANCE (Level 1 — never changes): Full physical description inline — race, ethnicity, nationality, canonical skin tone with undertone, face structure, eye color/shape/spacing, nose, mouth/lips, jaw/chin, hair texture/style/length/hairline, facial hair, age range, permanent marks (scars/tattoos). Never use a racial label alone.
3. CLOTHING & PHYSICAL STATE (Level 2): Exact current wardrobe — upper garment, lower garment, outerwear, exact color family, fabric/cut/wear state, footwear, accessories, injuries/dirt/sweat if present.
4. RELATIONSHIPS & BLOCKING: How characters relate spatially to each other and the environment; eyelines; who is foreground/background.
5. CAMERA COMPOSITION: Shot size (ECU/CU/MCU/MS/MLS/LS/ELS), angle, height, lens feel, depth of field, primary focus, aspect ratio framing.
6. LOCATION & CULTURAL IDENTITY: Full standalone production-design-level description — country, region, city/district, architecture materials, surface condition, signage, vegetation, period markers. Enough to physically rebuild the space without inventing anything.
7. FOREGROUND / MIDGROUND / BACKGROUND: Layered environmental detail.
8. LIGHTING & ATMOSPHERE: Natural/practical light source, color temperature, shadow direction, weather, atmospheric density, time-of-day logic.
9. VISUAL STYLE & TECHNICAL QUALITY: Cinematic photorealistic still, 8k detail, hyper-realistic skin rendering, volumetric lighting.
10. PROHIBITED DRIFT (inline): Specifically state what must NOT appear in this frame.

*MANDATORY EXCLUSIONS:*
- NO shorthand: never write "same," "unchanged," "as before," "identical to," "as described," "continues unchanged."
- NO generic filler: no "cinematic," "epic," "masterpiece," "breathtaking" without specific detail.
- NO camera movements — describe freeze-frame stills only.
- NO audio, dialogue, or non-visual metadata.
- STRICTLY NO text, captions, subtitles, watermarks, or logos in the image.
`.trim();
