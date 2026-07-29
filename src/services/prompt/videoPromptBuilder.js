/**
 * videoPromptBuilder.js — Storywave Cinematic Scene Director for Google Veo
 *
 * Implements the Cinematic Scene Director Engine tailored specifically for Google Veo 3.1.
 * Thinks like a Film Director, Cinematographer, Storyboard Artist, Actor Director,
 * Motion Director, and Editor to generate continuous kinetic motion prompts.
 */

/**
 * Generates a full structured Cinematic Scene Director Object matching the production specification.
 *
 * @param {object} scene          - Shared Scene Object or beat object
 * @param {object} storyMetadata - Full Story Bible / metadata
 * @param {string} commonPrompt  - Pre-computed common visual style string
 * @param {object} options       - Additional flags (e.g. aspectRatio)
 * @returns {object} Full Cinematic Scene Director JSON Object
 */
export function buildCinematicSceneDirectorObject(scene, storyMetadata = {}, commonPrompt = "", options = {}) {
  const sceneIdx = typeof scene.sceneIndex === "number" ? scene.sceneIndex : 0;
  const narrative = scene.narrative || {};
  const characters = scene.characters || [];
  const environment = scene.environment || {};
  const camera = scene.camera || {};
  const timing = scene.timing || {};
  const continuity = scene.continuity || {};

  // 1. Camera & Cinematography Plan
  const cameraPlan = {
    shotSize: camera.shotSize || "Medium Tracking Shot",
    angle: camera.angle || "Eye Level",
    rig: camera.movement || "Steadicam",
    lens: camera.lens || "35mm Anamorphic T1.9",
    movement: camera.movement || "Smooth backward tracking movement matching subject speed",
    depthOfField: camera.depthOfField || "Shallow, sharp focus on subject, soft blurred background",
  };

  // 2. Continuity Context
  const continuityPlan = {
    previousEndingState: continuity.previousSceneId ? `Transition from ${continuity.previousSceneId}` : "Opening scene state",
    carriedProps: characters.flatMap((c) => c.carriedProps || []),
    clothingState: characters.map((c) => `${c.name || "Subject"}: ${c.costumeState || "standard wardrobe"}`).join("; "),
    emotionalBaseline: narrative.emotionalTone || "tense cinematic momentum",
  };

  // 3. Scene Performance & Environmental Physics Object
  let characterPerformance = "";
  if (characters.length > 0) {
    characterPerformance = characters
      .map((c) => {
        const name = c.name || "Subject";
        const idLock = c.identityLock || c.appearance || "character";
        const costume = c.costumeState || c.base_clothing || "costume";
        const action = c.currentAction || "walking continuously forward at 1.5 mph";
        const bodyLang = c.bodyLanguage || "natural physical weight distribution, realistic stride, posture reacting to terrain";
        const expr = c.facialExpression || "eyes blinking naturally, scanning environment, chest heaving with steady breathing";
        return `${name} (${idLock}, wearing ${costume}) is ${action}. ${bodyLang}. Micro-performance: ${expr}.`;
      })
      .join(" ");
  } else {
    characterPerformance = narrative.beatSummary || "Fluid natural motion in frame.";
  }

  const locName = environment.name || "Location";
  const locDetails = environment.details || "";
  const lightingStr = environment.lighting || "volumetric key light, soft natural fill, ray-traced shadows";
  const particleStr = environment.particles || "dust motes floating in light beams, ambient air currents";
  const weatherStr = environment.weather || "gentle breeze rustling clothing and hair";

  const sceneObject = {
    narrative: narrative.beatSummary || narrative.narrationText || "Cinematic scene execution",
    characterPerformance,
    environmentPhysics: `LOCATION (${locName}): ${locDetails}. Particles: ${particleStr}. Weather dynamics: ${weatherStr}.`,
    lighting: lightingStr,
  };

  // 4. Veo Motion Prompt Synthesis (Continuous Kinetic Motion)
  const veoPromptParts = [
    `[CINEMATOGRAPHY: ${cameraPlan.shotSize}, ${cameraPlan.angle}, ${cameraPlan.lens}, ${cameraPlan.rig}. ${cameraPlan.movement}]`,
    `ACTING & KINETICS: ${characterPerformance}`,
    `ENVIRONMENT & PHYSICS: ${sceneObject.environmentPhysics} Lighting: ${sceneObject.lighting}`,
    `SCENE OBJECTIVE: ${narrative.sceneObjective || narrative.beatSummary || "Advance story beat"}. Duration: ${timing.durationSec || 5}s.`,
    commonPrompt ? `VISUAL ENVELOPE: ${commonPrompt}` : "Style: Photorealistic 8k cinematic motion, organic physics, fluid continuous movement.",
    "DIRECTOR INSTRUCTION: Every subject, camera, and environmental element must remain continuously alive in motion. Zero frozen poses. Zero static still frames.",
  ];

  const veoPrompt = veoPromptParts.join("\n\n").trim();

  const negativePrompt = "static image, frozen pose, motionless background, robotic movement, cartoon, anime, video game graphic, low quality, morphing limbs, distorted face, jitter, flicker";

  return {
    sceneNumber: sceneIdx + 1,
    title: scene.title || `Scene ${sceneIdx + 1}`,
    duration: `${timing.durationSec || 5}s`,
    cameraPlan,
    continuity: continuityPlan,
    sceneObject,
    veoPrompt,
    negativePrompt,
  };
}

/**
 * Builds a motion-first prompt string for Google Veo from a Shared Scene Object.
 *
 * @param {object} scene          - Shared Scene Object or beat object
 * @param {object} storyMetadata - Full Story Bible / metadata
 * @param {string} commonPrompt  - Pre-computed common visual style string
 * @param {object} options       - Additional flags (e.g. aspectRatio)
 * @returns {string} Fully materialized motion prompt for Google Veo
 */
export function buildVideoPrompt(scene, storyMetadata = {}, commonPrompt = "", options = {}) {
  const directorObj = buildCinematicSceneDirectorObject(scene, storyMetadata, commonPrompt, options);
  return directorObj.veoPrompt;
}
