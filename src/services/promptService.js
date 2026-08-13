/**
 * promptService.js — Facade & Compatibility Layer for Storywave Prompt Engine
 *
 * Re-exports functions from `src/services/prompt/` while preserving 100% backward
 * compatibility for all existing callers and multi_image functions.
 */

export { analyzeReferenceImage, extractStoryMetadata } from "./prompt/analyzer.js";
export {
  generateMasterPrompts,
  generateCommonVisualPrompt,
  generateCharacterBiblePrompts,
  buildCommonPrompt,
} from "./prompt/commonPromptBuilder.js";
export { buildVideoPrompt, buildCinematicSceneDirectorObject } from "./prompt/videoPromptBuilder.js";
export { buildSceneObjects, planVideoPrompts } from "./prompt/planner.js";
export { cleanPromptText, validateNoShorthand } from "./prompt/promptUtils.js";

/**
 * Legacy Scene Prompt Instructions — Version 1
 */
export const SCENE_PROMPT_VERSION_ONE = `
Scene Rules:
- Focus on Action: Describe the specific movement, reaction, or interaction in this scene.
- Narrative Beat: Each prompt must reflect a unique part of the story timeline.
- Synergy: Assume these unique details will be combined with a "Common Visual Prompt".
- Cinematic Essence: Capture the exact physical intensity of the moment.
`.trim();

/**
 * Legacy Scene Prompt Instructions — Version 2 (Backward Compatible)
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
8. LIGHTING / WEATHER / ATMOSPHERE: Source, direction, color temperature, intensity, weather particles, fog/haze/smoke.
9. VISUAL STYLE & TECHNICAL QUALITY: Cinematic film still, hyper-realistic, 8k resolution, professional lens feel.
10. PROHIBITED DRIFT: Explicitly prohibit incorrect visual archetypes inline.
`.trim();
