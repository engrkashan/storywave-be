/**
 * imagePromptBuilder.js — Still Image Prompt Generator (Multi-Image & Single-Image)
 *
 * Optimizes specifically for composition, framing, spatial details, lighting, depth of field,
 * color palette, and photographic still realism without kinetic motion fluff.
 */

/**
 * Builds a high-quality prompt for still image generation from a Shared Scene Object or beat data.
 *
 * @param {object} scene          - Shared Scene Object or beat object
 * @param {object} storyMetadata - Full Story Bible / metadata
 * @param {string} commonPrompt  - Pre-computed common visual style string
 * @param {object} options       - Additional flags (e.g. aspectRatio, customNegative)
 * @returns {string} Fully materialized production prompt for image generation
 */
export function buildImagePrompt(scene, storyMetadata = {}, commonPrompt = "", options = {}) {
  const narrative = scene.narrative || {};
  const characters = scene.characters || [];
  const environment = scene.environment || {};
  const camera = scene.camera || {};
  const timing = scene.timing || {};

  // Build Main Subject & Action
  let subjectStr = narrative.beatSummary || scene.prompt || "Cinematic storytelling scene";
  
  // Character Details
  let charDetails = "";
  if (characters.length > 0) {
    charDetails = characters
      .map((c) => {
        const idStr = c.identityLock || c.appearance || c.name || "";
        const costStr = c.costumeState || c.base_clothing || "";
        const posStr = c.screenPosition ? `Position: ${c.screenPosition}.` : "";
        const exprStr = c.facialExpression ? `Expression: ${c.facialExpression}.` : "";
        return `CHARACTER (${c.name || "Subject"}): ${idStr}. WARDROBE: ${costStr}. ${exprStr} ${posStr}`.trim();
      })
      .join(" ");
  }

  // Location & Atmosphere
  let envDetails = "";
  if (environment.name || environment.details) {
    const locName = environment.name || "Environment";
    const locDet = environment.details || "";
    const lightDet = environment.lighting ? `LIGHTING: ${environment.lighting}.` : "";
    const weatherDet = environment.weather ? `ATMOSPHERE: ${environment.weather}.` : "";
    envDetails = `LOCATION: ${locName}. DETAILS: ${locDet}. ${lightDet} ${weatherDet}`.trim();
  }

  // Camera & Framing
  const shotSize = camera.shotSize || "Medium Shot";
  const angle = camera.angle || "Eye Level";
  const lens = camera.lens || "35mm Anamorphic";
  const dof = camera.depthOfField || "Shallow depth of field";
  const cameraStr = `COMPOSITION: ${shotSize}, ${angle}, shot on ${lens}. ${dof}.`;

  // Combine into a single standalone prompt
  const parts = [
    `MAIN SUBJECT & SCENE: ${subjectStr}`,
    charDetails,
    envDetails,
    cameraStr,
    commonPrompt ? `STYLE & ATMOSPHERE: ${commonPrompt}` : "Aesthetic: Hyper-realistic 8k cinematic film still, photorealistic.",
    "STRICT CONSTRAINT: NO TEXT, captions, words, or letters in the image.",
  ].filter(Boolean);

  return parts.join("\n").trim();
}
