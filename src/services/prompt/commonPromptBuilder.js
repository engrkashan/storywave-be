/**
 * commonPromptBuilder.js — Global story style, atmosphere & master poster prompts
 */

/**
 * Generates a common visual prompt to sync story theme, visual style, and cinematic technical specs.
 */
export function generateCommonVisualPrompt(metadata = {}) {
  const { artStyle, colorPalette, cinematicSpecs, synopsis } = metadata;
  const styleStr = artStyle || "Cinematic Realistic Film";
  const paletteStr = Array.isArray(colorPalette) ? colorPalette.join(", ") : (colorPalette || "Natural Cinematic Tones");
  const specsStr = cinematicSpecs || "High-end cinematic lighting and camera setup";
  const synopsisPart = synopsis ? ` Narrative Context: ${synopsis}` : "";

  return `Art Style: ${styleStr}.${synopsisPart} Color Palette: ${paletteStr}. Technical Specs: ${specsStr}. Consistent visual tone: High-end cinematic movie still, shot on professional lenses, 8k resolution, hyper-realistic, volumetric lighting, ray-traced reflections, masterwork quality, IMAX aesthetic.`.trim();
}

export const buildCommonPrompt = generateCommonVisualPrompt;

/**
 * Generates Master Cover / Poster Prompts
 */
export function generateMasterPrompts(metadata = {}, title = "", aspectRatio = "16:9") {
  const commonVisuals = generateCommonVisualPrompt(metadata);
  const mainCharacter = metadata.characters?.[0] || { appearance: "A detailed cinematic character" };
  const mainLocation = metadata.locations?.[0] || { description: "A detailed cinematic environment" };

  const charApp = mainCharacter.appearance || mainCharacter.name || "central character";
  const locDesc = mainLocation.description || mainLocation.name || "cinematic environment";

  const poster = `
    A high-impact 9:16 iconic poster featuring an extreme close-up (ECU) of the central character (${charApp}), focusing on raw emotion. 
    ${commonVisuals}
    Background: ${locDesc}.
    Lighting: Intense cinematic "Key Lighting" that casts deep, dramatic shadows.
    Typography: Bold, stylized 3D typography for the title "${title}" is placed with a "shallow depth of field". STRICT RULE: Use the title exactly as provided. No subtitles.
  `.trim();

  const cinematic = `
    A breathtaking 16:9 cinematic "Medium-Close" shot prioritizing immersive detail.
    The frame is tightly packed with environmental storytelling. Character: ${charApp}.
    ${commonVisuals}
    Location: ${locDesc}.
    Technical: Anamorphic lens flares and heavy Bokeh. Hyper-realistic, high-budget film still.
    Constraint: STRICTLY NO TEXT, words, or letters.
  `.trim();

  return { poster, cinematic };
}

/**
 * Generates anchor prompts for character bible reference sheets
 */
export function generateCharacterBiblePrompts(characterDescription) {
  const views = [
    { name: "front", description: "Full front view, neutral expression, looking directly at camera." },
    { name: "profile", description: "Profile view (side), looking away from camera." },
    { name: "three_quarter", description: "3/4 view, cinematic lighting, looking slightly off-camera." },
  ];

  return views.map((view) => {
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
