/**
 * sceneStateEngine.js — Scene State Engine for Video Planner
 *
 * Maintains structured, persistent SceneState across atomic beats.
 * Replaces raw text as the continuity source of truth.
 *
 * Fix I-2: deriveEndingPose expanded from 6 to 25+ keyword groups.
 * Fix I-3: initializeSceneState now builds a richer identityLock from
 *          sketch_artist_appearance and base_clothing/wardrobe MGE fields.
 * Fix I-4: locationDetails resolved via fallback chain covering all MGE field names.
 */

import { initializeConversationState, updateConversationState } from "./conversationStateEngine.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("SceneStateEngine");

/**
 * Initializes starting SceneState from Story Bible and initial beat metadata.
 *
 * @param {object} storyBible - Story Bible metadata
 * @param {object} initialBeat - First atomic beat
 * @returns {object} Structured SceneState object
 */
export function initializeSceneState(storyBible = {}, initialBeat = {}) {
  const mainChar = storyBible?.characters?.[0] || {};
  const mainLoc = storyBible?.locations?.[0] || {};

  // Fix I-3: Build a richer identityLock from MGE materialized fields when available
  const identityLock = buildIdentityLock(mainChar);

  // Fix I-3: Build costumeState from base_clothing or wardrobe object
  const costumeState = buildCostumeState(mainChar);

  // Fix I-4: Resolve locationDetails through a full fallback chain
  const locationDetails = resolveLocationDetails(mainLoc);

  return {
    completedActions: [],
    currentPose: initialBeat.startingPose || (initialBeat.action ? `Beginning action: ${initialBeat.action}` : "Standing in natural posture"),
    currentLocation: initialBeat.location || mainLoc.name || "Scene Location",
    locationDetails,
    activeCharacter: {
      id: mainChar.id || "char_1",
      name: mainChar.name || initialBeat.characterName || "Subject",
      identityLock,
      costumeState,
    },
    camera: {
      shotSize: "Medium Shot",
      angle: "Eye Level",
      movement: "Subtle tracking motion",
    },
    emotion: initialBeat.emotion || "cinematic focus",
    environment: `${mainLoc.name || "Environment"} with natural lighting`,
    nextAction: initialBeat.action || "Advance scene",
    conversationState: initializeConversationState(storyBible, initialBeat),
  };
}

/**
 * Updates SceneState sequentially after executing a beat.
 *
 * @param {object} currentState - Current SceneState object
 * @param {object} executedBeat - The beat that was just executed
 * @param {object} nextBeat - The upcoming beat (if any)
 * @param {number} beatIndex - Index of executed beat
 * @param {number} totalBeats - Total beats count
 * @returns {object} Updated SceneState object for the next beat
 */
export function updateSceneState(currentState = {}, executedBeat = {}, nextBeat = null, beatIndex = 0, totalBeats = 10) {
  const updatedCompleted = [
    ...(currentState.completedActions || []),
    executedBeat.action || executedBeat.narrative || "Beat completed",
  ];

  // Derive ending pose from executed beat action
  const derivedEndingPose = deriveEndingPose(executedBeat.action);

  return {
    ...currentState,
    completedActions: updatedCompleted.slice(-5), // Keep rolling memory of last 5 completed actions
    currentPose: derivedEndingPose,
    currentLocation: executedBeat.location || currentState.currentLocation,
    emotion: executedBeat.emotion || currentState.emotion,
    nextAction: nextBeat ? (nextBeat.action || nextBeat.narrative || "Complete sequence") : "Conclude scene",
    conversationState: updateConversationState(currentState.conversationState, executedBeat, nextBeat, beatIndex, totalBeats),
  };
}

// ─── Fix I-3: Identity & Costume Builders ─────────────────────────────────────

/**
 * Builds a rich, locked identity description for the character from MGE materialized fields.
 * Falls back gracefully if fields are absent.
 *
 * @param {object} char - Character object from Story Bible / Cast Bible
 * @returns {string} Identity lock string
 */
function buildIdentityLock(char) {
  if (!char || (!char.name && !char.id)) return "Cinematic subject";

  const parts = [];

  // MGE Module 3 fields
  const sa = char.sketch_artist_appearance || {};
  const ic = char.identity_culture || {};

  if (sa.age_range) parts.push(sa.age_range);
  if (sa.gender_presentation) parts.push(sa.gender_presentation);
  if (ic.race || sa.canonical_skin_tone) {
    const raceStr = [ic.race, sa.canonical_skin_tone].filter(Boolean).join(", ");
    if (raceStr) parts.push(raceStr);
  }
  if (sa.face_structure) parts.push(`face: ${sa.face_structure}`);
  if (sa.hair) parts.push(`hair: ${sa.hair}`);
  if (sa.permanent_identifiers) parts.push(sa.permanent_identifiers);

  // Fallback to flat appearance field
  if (parts.length === 0 && char.appearance) return char.appearance;
  if (parts.length === 0) return char.name || "Cinematic subject";

  return `${char.name || "Subject"} — ${parts.join(", ")}`;
}

/**
 * Builds costume state from MGE wardrobe fields.
 *
 * @param {object} char - Character object
 * @returns {string} Costume state string
 */
function buildCostumeState(char) {
  if (!char) return "standard wardrobe";

  // Try base_clothing text field first (MGE materialized text)
  if (char.base_clothing && typeof char.base_clothing === "string") return char.base_clothing;

  // Try wardrobe object (MGE Module 3)
  if (char.wardrobe && typeof char.wardrobe === "object") {
    const w = char.wardrobe;
    const wParts = [
      w.upper_garment,
      w.lower_garment,
      w.outerwear,
      w.footwear,
    ].filter(Boolean);
    if (wParts.length > 0) return wParts.join(", ");
  }

  // Try clothing flat field
  if (char.clothing && typeof char.clothing === "string") return char.clothing;

  return "standard wardrobe";
}

// ─── Fix I-4: Location Details Resolver ──────────────────────────────────────

/**
 * Resolves location details text from multiple MGE/Story Bible field names.
 *
 * @param {object} loc - Location object
 * @returns {string} Location details string
 */
function resolveLocationDetails(loc) {
  if (!loc) return "Cinematic environment";

  return (
    loc.description ||
    loc.full_description ||
    loc.full_standalone_description ||
    loc.visual_description ||
    loc.geographic_cultural_id?.city_district ||
    loc.construction?.wall_roof_floor_ceiling_material ||
    (loc.name ? `${loc.name} environment` : null) ||
    "Cinematic environment"
  );
}

// ─── Fix I-2: Expanded deriveEndingPose ──────────────────────────────────────

/**
 * Fix I-2: Derives a precise character ending pose from beat action description.
 * Expanded from 6 to 25+ keyword groups covering common story actions.
 *
 * @param {string} actionText
 * @returns {string} Ending pose description
 */
function deriveEndingPose(actionText = "") {
  if (!actionText) return "Standing in natural posture";

  const lower = actionText.toLowerCase();

  // ── Locomotion ────────────────────────────────────────────────────────────
  if (lower.includes("jump") || lower.includes("leap"))
    return "Just landed on ground, absorbing impact, knees slightly bent";
  if (lower.includes("climb") || lower.includes("scale"))
    return "Standing at top of climbing surface, hands releasing grip";
  if (lower.includes("run") || lower.includes("sprint") || lower.includes("dash"))
    return "In mid-sprint, weight forward, arms pumping";
  if (lower.includes("walk") || lower.includes("stride") || lower.includes("march"))
    return "Arrived at destination, weight settling, feet together";
  if (lower.includes("crawl") || lower.includes("crouch"))
    return "Low to ground in crouching posture, hands forward";
  if (lower.includes("kneel") || lower.includes("knelt"))
    return "Kneeling on one or both knees, upright torso";
  if (lower.includes("stop") || lower.includes("halt") || lower.includes("freeze"))
    return "Stopped mid-motion, feet planted, body tense";

  // ── Posture changes ───────────────────────────────────────────────────────
  if (lower.includes("sit") || lower.includes("seated") || lower.includes("sat"))
    return "Seated, back upright, hands resting on lap or armrests";
  if (lower.includes("lie") || lower.includes("lay") || lower.includes("lying"))
    return "Lying flat on surface, face upward or to the side";
  if (lower.includes("stand") || lower.includes("rise") || lower.includes("stood"))
    return "Standing upright, feet shoulder-width apart, weight balanced";
  if (lower.includes("lean") || lower.includes("slouch"))
    return "Leaning against surface, weight shifted to one side";

  // ── Upper body / head ─────────────────────────────────────────────────────
  if (lower.includes("look") || lower.includes("gaze") || lower.includes("stare"))
    return "Head turned, eyes fixed on subject of gaze";
  if (lower.includes("turn") || lower.includes("spin") || lower.includes("pivot"))
    return "Facing new direction, weight transferred, one foot leading";
  if (lower.includes("nod") || lower.includes("bow"))
    return "Head slightly lowered, returning to level position";
  if (lower.includes("shake") || lower.includes("shrug"))
    return "Head or shoulders returned to neutral after shaking motion";
  if (lower.includes("smile") || lower.includes("laugh") || lower.includes("grin"))
    return "Relaxed expression, slight upward curve at mouth corners";
  if (lower.includes("cry") || lower.includes("sob") || lower.includes("weep"))
    return "Head slightly bowed, shoulders rounded, emotional posture";
  if (lower.includes("yell") || lower.includes("shout") || lower.includes("scream"))
    return "Chin slightly raised, mouth returning to rest, tension easing";

  // ── Navigation / entry / exit ─────────────────────────────────────────────
  // NOTE: These must come BEFORE the generic push/shove check below because
  // "push door open" contains both "push" and "door" — we want the specific door match.
  if (lower.includes("open") && (lower.includes("door") || lower.includes("gate")))
    return "Hand on door handle, door partially open, ready to pass through";
  if (lower.includes("enter") || lower.includes("step into") || lower.includes("walk in"))
    return "Just inside the space, pausing to orient, one foot forward";
  if (lower.includes("exit") || lower.includes("leave") || lower.includes("walk out"))
    return "Just outside the previous space, back to it, moving away";

  // ── Hand / arm actions ────────────────────────────────────────────────────
  if (lower.includes("reach") || lower.includes("grab") || lower.includes("grasp"))
    return "Hand extended, fingers closed around target object or surface";
  if (lower.includes("pick up") || lower.includes("picks up") || lower.includes("picked up") || lower.includes("lift"))
    return "Item held at mid-body level, arms slightly bent";
  if (lower.includes("put down") || lower.includes("place") || lower.includes("set"))
    return "Hands releasing object, arms returning to sides";
  if (lower.includes("point") || lower.includes("gesture"))
    return "Arm partially extended in direction of gesture";
  if (lower.includes("push") || lower.includes("shove"))
    return "Arms extended forward, palms forward, body leaning in";
  if (lower.includes("pull") || lower.includes("drag"))
    return "Weight shifted backward, arms pulling toward body";
  if (lower.includes("throw") || lower.includes("toss") || lower.includes("hurl"))
    return "Follow-through posture: throwing arm extended, body twisted toward target";
  if (lower.includes("hit") || lower.includes("punch") || lower.includes("strike"))
    return "Fist or hand at point of impact extension, body aligned";

  // ── Speech / social ───────────────────────────────────────────────────────
  if (lower.includes("talk") || lower.includes("speak") || lower.includes("say") || lower.includes("tell"))
    return "Mouth returning to rest after speaking, maintaining eye contact";
  if (lower.includes("listen") || lower.includes("hear"))
    return "Body oriented toward speaker, attentive posture, slight forward lean";
  if (lower.includes("hand") && (lower.includes("give") || lower.includes("pass") || lower.includes("offer")))
    return "Arm extended, object being transferred between hands";

  // ── Combat / tension ──────────────────────────────────────────────────────
  if (lower.includes("fight") || lower.includes("attack") || lower.includes("defend"))
    return "Guard posture: weight low, arms raised, feet wide for stability";
  if (lower.includes("duck") || lower.includes("dodge") || lower.includes("evade"))
    return "Low, offset posture after evasion, body turned away from threat";
  if (lower.includes("fall") || lower.includes("drop") || lower.includes("collapse"))
    return "Fallen or falling posture, contact with ground surface";

  // Generic fallback
  return `Positioned at completion of: ${actionText}`;
}
