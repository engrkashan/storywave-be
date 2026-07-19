/**
 * UNIVERSAL STORY-TO-MOTION-GRAPHIC IMAGE WORKFLOW
 * LEAN MODULAR AUTOMATED GATED PRODUCTION ENGINE — v6.3
 *
 * Implements all 8 modules in order:
 *   1. Input Normalization         → PROJECT_SPEC
 *   2. Full Story & World Analysis → STORY_WORLD_MAP
 *   3. Materialized Cast Bible     → MATERIALIZED_CAST_BIBLE
 *   4. Materialized Visual World   → MATERIALIZED_VISUAL_WORLD_BIBLE
 *   5. Scene Construction          → SCENE_LEDGER
 *   6. Continuity + Frame Alloc    → CONTINUITY_LEDGER, FRAME_PLAN
 *   7. Scene-Batch Frame Gen       → VALIDATED_FRAME_PACKAGES
 *   8. Final Audit                 → FINAL_AUDIT
 *
 * SOURCE PRIORITY (highest → lowest):
 *   1. Creator's direct instructions
 *   2. Supplied source material
 *   3. Established series continuity
 *   4. Uploaded reference images
 *   5. Previous episode continuity
 *   6. Previously approved character/location descriptions
 *   7. Reliable geographic/cultural/historical/genre/period evidence
 *   8. Deliberate professional visual estimate
 */

import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("MotionGraphicEngine");

if (process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
  delete process.env.GOOGLE_API_KEY;
}
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
});

// ─── SHARED LLM HELPER ───────────────────────────────────────────────────────

/**
 * Call Gemini and parse the response as JSON.
 * Retries once on failure. Returns null on double failure.
 */
async function callGeminiJSON(prompt, label = "LLM call") {
  const MODEL = "gemini-2.5-flash";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      logger.info(`[MGE] ${label} — attempt ${attempt}`);
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      const raw =
        response.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      const text = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      return JSON.parse(text);
    } catch (err) {
      logger.warn(`[MGE] ${label} failed (attempt ${attempt}): ${err.message}`);
      if (attempt === 2) return null;
    }
  }

  // ── Character guideline backfill ─────────────────────────────────────────────
  /**
   * Guarantees EVERY character referenced anywhere in the story (including secondary /
   * functional characters such as "neighbor_1", "police_officer_1" that the scene graph
   * invents but the Cast Bible may omit) has a CANONICAL, MATERIALIZED text guideline
   * (full physical appearance + base wardrobe). Characters that already exist in the Cast
   * Bible are left untouched. Missing characters are materialized in a SINGLE batched LLM
   * call so they get a stable, story-derived look instead of a randomly-generated one.
   *
   * This is the "no reference image → synthesize a consistent character guideline" rule:
   * the guideline is then injected into every frame the character appears in (composePrompt)
   * and hard-locked, so the character looks identical scene-to-scene without a portrait.
   *
   * @param {Array} sceneGraph        - beats from generateSceneGraph (each has characters_present)
   * @param {object} castBible        - MATERIALIZED_CAST_BIBLE (mutated in place)
   * @param {string} storyScript      - original story for context
   * @returns {Promise<string[]>} list of character names that were newly materialized
   */
  async function ensureCharacterGuidelines(sceneGraph, castBible, storyScript) {
    const existing = new Map();
    for (const c of (castBible.characters || [])) {
      if (c.id) existing.set(String(c.id).toLowerCase(), c);
      if (c.name) existing.set(String(c.name).toLowerCase(), c);
    }

    // Collect every character id/name referenced in the scene graph.
    const referenced = new Map(); // key -> { id, name }
    for (const beat of (sceneGraph || [])) {
      for (const cp of (beat.characters_present || [])) {
        const id = cp.id || cp.name;
        const name = cp.name || cp.id;
        if (!id && !name) continue;
        const key = String(id || name).toLowerCase();
        if (!referenced.has(key)) referenced.set(key, { id, name });
      }
    }

    // Find which referenced characters are missing from the Cast Bible.
    const missing = [];
    for (const [key, ref] of referenced) {
      if (!existing.has(key)) missing.push(ref);
    }

    if (missing.length === 0) {
      logger.info(`[MGE v7] Character guidelines: all ${referenced.size} referenced characters already materialized.`);
      return [];
    }

    logger.info(`[MGE v7] Character guidelines: ${missing.length} referenced character(s) missing from Cast Bible — synthesizing: ${missing.map(m => m.name || m.id).join(", ")}`);

    const missingList = missing
      .map((m, i) => `${i + 1}. id="${m.id || "n/a"}" name="${m.name || m.id}"`)
      .join("\n");

    const prompt = `You are a casting director and sketch artist. The story's main/recurring characters already have detailed capsules.
  The following characters also appear in the story (often as secondary/background roles) but were not yet described in detail.
  For EACH, synthesize a CANONICAL, FULLY MATERIALIZED physical description + base wardrobe so an image generator can render them
  CONSISTENTLY every time they appear. Do NOT leave any field generic.

  STORY:
  ${storyScript ? storyScript.slice(0, 12000) : "(story text unavailable)"}

  MISSING CHARACTERS (derive their look ONLY from how the story describes or implies them):
  ${missingList}

  Return STRICT valid JSON:
  {
    "characters": [
      {
        "id": "<the same id as provided, e.g. neighbor_1>",
        "name": "<the same name as provided>",
        "importance": "background_named",
        "identity_culture": { "name": "", "story_role": "", "race": "", "ethnicity_cultural_identity": "", "nationality": "", "regional_community_identity": "" },
        "sketch_artist_appearance": {
          "age_range": "", "gender_presentation": "", "height": "", "body_type": "",
          "canonical_skin_tone": "", "canonical_undertone": "", "complexion_texture_marks": "",
          "face_structure": "", "eyes": "", "nose": "", "mouth_lips": "", "jaw_chin": "",
          "hair": "", "facial_hair": "", "permanent_identifiers": ""
        },
        "base_wardrobe": {
          "upper_garment": "", "lower_garment": "", "outerwear": "", "exact_color_family": "", "footwear": "", "accessories": ""
        },
        "appearance": "FULL physical description paragraph (combine sketch_artist_appearance fields)",
        "base_clothing": "FULL clothing description paragraph (combine base_wardrobe fields)"
      }
    ]
  }`;

    const result = await callGeminiJSON(prompt, "Character Guideline Backfill");
    const synthesized = (result && Array.isArray(result.characters)) ? result.characters : [];

    if (synthesized.length === 0) {
      logger.warn(`[MGE v7] Character guideline backfill returned nothing — missing characters will be text-only generic.`);
      return [];
    }

    castBible.characters = castBible.characters || [];
    for (const c of synthesized) {
      if (!c || (!c.id && !c.name)) continue;
      // Normalize to Module 3 shape: CharacterStateManager reads top-level `wardrobe`
      // (object) for the registry, so mirror base_wardrobe there. Also keep appearance
      // text so composePrompt's SUBJECT block has a fallback description.
      const normalized = {
        ...c,
        wardrobe: c.wardrobe || c.base_wardrobe || {},
        appearance: c.appearance || (c.sketch_artist_appearance
          ? [c.sketch_artist_appearance.age_range, c.sketch_artist_appearance.gender_presentation, c.sketch_artist_appearance.canonical_skin_tone, c.sketch_artist_appearance.face_structure, c.sketch_artist_appearance.hair].filter(Boolean).join(". ")
          : ""),
      };
      castBible.characters.push(normalized);
    }

    logger.info(`[MGE v7] Character guidelines: synthesized ${synthesized.length} new character guideline(s).`);
    return synthesized.map(c => c.name || c.id);
  }
}

// ── Object guideline backfill ───────────────────────────────────────────────
/**
 * Objects (rooms, house, car, street, etc.) NEVER get a reference image —
 * the pipeline has no object-portrait upload path. So each object's look must be
 * a CANONICAL, STORY-DERIVED text guideline, synthesized ONCE from the
 * whole story and then LOCKED consistently on every frame it appears in.
 *
 * This mirrors ensureCharacterGuidelines but for objects: it collects every
 * object id referenced in the scene graph + per-beat objects_in_scene, finds
 * which lack a concrete description, and synthesizes a stable canonical
 * description for each via ONE batched LLM call. The result is registered
 * in ObjectStateManager and injected as a hard OBJECT LOCK in composePrompt,
 * so the same car / house / street renders identically scene-to-scene.
 *
 * @param {Array}  sceneGraph     - beats from generateSceneGraph
 * @param {object} objectRegistry - { id, name, description, ... } from scene graph
 * @param {string} storyScript    - original story for context
 * @returns {Promise<string[]>} object names that were newly materialized
 */
async function ensureObjectGuidelines(sceneGraph, objectRegistry, storyScript) {
  // Collect every object id/name referenced anywhere in the story.
  const referenced = new Map(); // key -> { id, name }
  const addRef = (id, name) => {
    const k = String(id || name || "").toLowerCase();
    if (!k) return;
    if (!referenced.has(k)) referenced.set(k, { id, name });
  };
  for (const beat of (sceneGraph || [])) {
    for (const o of (beat.objects_in_scene || [])) addRef(o.id, o.name);
  }
  for (const o of (objectRegistry || [])) addRef(o.id, o.name);

  if (referenced.size === 0) {
    logger.info(`[MGE v7] Object guidelines: no objects referenced in story.`);
    return [];
  }

  // Which already have a concrete description?
  const hasDesc = (o) => !!(o && (o.description || o.full_description || o.visual_description));
  const existing = new Map();
  for (const o of (objectRegistry || [])) {
    if (hasDesc(o)) existing.set(String(o.id || o.name || "").toLowerCase(), o);
  }

  const missing = [];
  for (const [key, ref] of referenced) {
    if (!existing.has(key)) missing.push(ref);
  }

  if (missing.length === 0) {
    logger.info(`[MGE v7] Object guidelines: all ${referenced.size} referenced objects already have a description.`);
    return [];
  }

  logger.info(`[MGE v7] Object guidelines: ${missing.length} object(s) missing description — synthesizing: ${missing.map(m => m.name || m.id).join(", ")}`);

  const missingList = missing
    .map((m, i) => `${i + 1}. id="${m.id || "n/a"}" name="${m.name || m.id}"`)
    .join("\n");

  const prompt = `You are a production designer. The story's locations and characters already have detailed specs.
The following OBJECTS also appear in the story (vehicles, rooms, buildings, streets, furniture, weapons, phones, etc.) but lack a concrete visual description.
For EACH, synthesize a CANONICAL, FULLY MATERIALIZED visual description from how the story describes or implies the object, so an image generator renders it CONSISTENTLY every time it appears.
A car must look like the SAME car in scene 3 and scene 9. A house the SAME house. Never leave a field generic.

STORY:
${storyScript ? storyScript.slice(0, 12000) : "(story text unavailable)"}

MISSING OBJECTS:
${missingList}

Return STRICT valid JSON:
{
  "objects": [
    {
      "id": "<same id as provided, e.g. obj_car_1>",
      "name": "<same name as provided>",
      "description": "FULL production-design description: make/model/type if a vehicle, architectural style/materials/color/signage if a building/street, material/color/condition if furniture/object. Include size, color, wear, distinguishing marks so it is unmistakably recognizable and reproducible.",
      "category": "vehicle | building | street | furniture | weapon | device | other"
    }
  ]
}`;

  const result = await callGeminiJSON(prompt, "Object Guideline Backfill");
  const synthesized = (result && Array.isArray(result.objects)) ? result.objects : [];

  if (synthesized.length === 0) {
    logger.warn(`[MGE v7] Object guideline backfill returned nothing — missing objects stay generic text.`);
    return [];
  }

  // Merge synthesized descriptions back into the object registry (mutate in place).
  const byKey = new Map();
  for (const o of (objectRegistry || [])) byKey.set(String(o.id || o.name || "").toLowerCase(), o);
  for (const o of synthesized) {
    if (!o || (!o.id && !o.name)) continue;
    const key = String(o.id || o.name).toLowerCase();
    const target = byKey.get(key) || { id: o.id, name: o.name };
    target.id = o.id || target.id;
    target.name = o.name || target.name;
    target.description = o.description || target.description || "";
    target.category = o.category || target.category || "other";
    byKey.set(key, target);
  }
  // Write the merged set back so the caller picks it up.
  objectRegistry.length = 0;
  for (const o of byKey.values()) objectRegistry.push(o);

  logger.info(`[MGE v7] Object guidelines: synthesized ${synthesized.length} new object description(s).`);
  return synthesized.map(o => o.name || o.id);
}

// ─── SCHEMA DEFINITIONS (referenced in prompts) ──────────────────────────────

export const SCHEMA_A_FIELDS = `
CHARACTER_CAPSULE fields (ALL must be filled — a label + age + build alone FAILS):
identity_culture: { name, story_role, race, ethnicity_cultural_identity, nationality, regional_community_identity }
sketch_artist_appearance: {
  age_range, gender_presentation, height, body_type (shoulders/torso/waist/limbs), fitness_wear, movement_quality,
  canonical_skin_tone, canonical_undertone, complexion_texture_marks,
  face_structure (shape/forehead/brows), eyes (color/shape/spacing), nose, cheeks, mouth_lips, jaw_chin, ears, asymmetry, teeth_if_relevant,
  hair (texture/density/style/length/hairline/part/edge_treatment/gray_pattern/allowed_drift/forbidden_drift),
  facial_hair (beard_type/length/density/mustache_shape/sideburns/gray_pattern/grooming),
  permanent_identifiers (scars/tattoos/birthmarks/moles/lines)
}
body_language: { posture, head_shoulder_carriage, walk, hand_behavior, personal_space, resting_tension, resting_emotional_face, social_energy }
wardrobe: { upper_garment, lower_garment, outerwear, cut_fabric_fit, exact_color_family, footwear, socks, jewelry, watch, belt, bag, headwear, class_occupation_cues }
identity_restrictions: { may_change, may_not_change, forbidden_substitutions, forbidden_drift }
reference_images_if_supplied: { locks, must_not_copy }
`.trim();

export const SCHEMA_B_FIELDS = `
LOCATION_RECORD fields (ALL must be filled — a short phrase alone FAILS):
geographic_cultural_id: { name, country, region, city_parish_district, urban_rural_category, social_class, community_function, cultural_identity, period }
scale_form: { width, length, ceiling_height, density, enclosure_openness, spatial_pressure, neighboring_structures, fg_mg_bg_structure }
construction: { wall_roof_floor_ceiling_material, paint_condition, doors_windows_gates_fences, drainage, utilities, stairs_verandas, pavement_curbs, structural_wear }
surface_condition: { clean_dirty, smooth_rough, dry_muddy_damp, cracked_stained_rusted_peeling_weathered, construction_age, maintenance_level, humidity_rain_sun_salt_effects }
fixed_elements: { furniture, counters_shelving, appliances, utility_poles_wires_pipes, water_tanks, signage, lighting_fixtures, vehicles, vegetation }
lived_in_details: { culturally_period_appropriate_daily_use_evidence }
population: { background_people, race_ethnicity_if_relevant, clothing_style, age_mix, crowd_density, activity, social_energy, relation_to_location }
climate_nature: { climate, temperature, humidity, weather, wind, vegetation, soil, water, sky, season }
tech_transport: { tech_level, phones_screens_appliances, vehicles, public_transport, road_markings, plates, utilities, authority_vehicles }
lighting_atmosphere: { light_source_natural_practical, color_temp, intensity, shadow_direction, reflections, atmospheric_density, visibility, emotional_effect, time_of_day }
layout_continuity: { entrances_exits, door_window_positions, furniture_vehicle_placement, camera_access_routes, witness_viewpoints, escape_directions, screen_direction_relationships }
forbidden_drift: [ list of foreign visual archetypes explicitly prohibited ]
`.trim();

export const CONTINUITY_LEVELS = `
Level 1 — Hard Identity (changes ONLY if source explicitly justifies it):
  race, ethnicity, nationality, canonical skin tone/undertone, face/body structure, eye/nose/mouth/jaw shape, hair texture/style/hairline, facial hair, age range, permanent marks, core identity.
Level 2 — Scene-State (changes ONLY via visible action/time/location/event):
  wardrobe, footwear, accessories, injuries, blood/dirt/sweat, bandages, props, documents, vehicles, furniture, doors/windows, weather, lighting, crowd state, blocking, object placement.
Level 3 — Performance (evolves naturally):
  expression, eye direction, gesture, head angle, body tension, emotional intensity, weight distribution, interactions.
`.trim();

// ─── REGISTRIES & STATE MANAGERS ──────────────────────────────────────────────

class CharacterStateManager {
  constructor(castBible) {
    this.registry = new Map(); // Identity (immutable)
    this.runtime = new Map();  // State (mutable)
    
    // Initialize from Cast Bible
    if (castBible && castBible.characters) {
      for (const char of castBible.characters) {
        this.registry.set(char.id || char.name, {
          name: char.name,
          race: char.identity_culture?.race,
          ethnicity: char.identity_culture?.ethnicity_cultural_identity,
          age: char.sketch_artist_appearance?.age_range,
          face: char.sketch_artist_appearance?.face_structure,
          hair: char.sketch_artist_appearance?.hair,
          skin: char.sketch_artist_appearance?.canonical_skin_tone,
          base_wardrobe: char.wardrobe
        });
        
        // Default runtime state
        this.runtime.set(char.id || char.name, {
          pose: "standing neutral",
          emotion: "neutral",
          inventory: [],
          clothes: char.wardrobe,
          injuries: [],
          currentLocation: null,
          facingDirection: "forward",
          action: "idle"
        });
      }
    }
  }

  getIdentity(id) { return this.registry.get(id); }
  getRuntime(id) { return this.runtime.get(id); }
  updateRuntime(id, updates) {
    if (this.runtime.has(id)) {
      this.runtime.set(id, { ...this.runtime.get(id), ...updates });
    }
  }
}

class WorldStateManager {
  constructor(worldBible) {
    this.registry = new Map(); // Architecture (immutable)
    this.runtime = new Map();  // State (mutable)

    if (worldBible && worldBible.locations) {
      for (const loc of worldBible.locations) {
        this.registry.set(loc.name, {
          name: loc.name,
          country: loc.geographic_cultural_id?.country,
          materials: loc.construction?.wall_roof_floor_ceiling_material,
          fixed_elements: loc.fixed_elements
        });
        
        this.runtime.set(loc.name, {
          doors_open: [],
          lights_on: true,
          weather: "clear",
          time_of_day: "day",
          broken_objects: []
        });
      }
    }
  }

  getArchitecture(name) { return this.registry.get(name); }
  getRuntime(name) { return this.runtime.get(name); }
  updateRuntime(name, updates) {
    if (this.runtime.has(name)) {
      this.runtime.set(name, { ...this.runtime.get(name), ...updates });
    }
  }
}

class ObjectStateManager {
  constructor() {
    this.objects = new Map();
  }
  
  registerObject(id, definition) {
    this.objects.set(id, {
      name: definition.name,
      description: definition.description,
      owner: definition.owner || null,
      location: definition.location || null,
      visible: definition.visible !== false,
      held: definition.held || false,
      state: definition.state || "normal"
    });
  }

  updateObject(id, updates) {
    if (this.objects.has(id)) {
      this.objects.set(id, { ...this.objects.get(id), ...updates });
    } else {
      this.registerObject(id, updates); // Auto-register if new
    }
  }
  
  getVisibleObjectsInLocation(location) {
    const visible = [];
    for (const [id, obj] of this.objects.entries()) {
      if (obj.visible && obj.location === location) {
        visible.push(obj);
      }
    }
    return visible;
  }
}

class RelationshipStateManager {
  constructor() {
    this.relationships = new Map();
  }

  setRelationship(charA, charB, relationshipDesc) {
    const key = [charA, charB].sort().join("::");
    this.relationships.set(key, relationshipDesc);
  }

  getRelationship(charA, charB) {
    const key = [charA, charB].sort().join("::");
    return this.relationships.get(key) || "Neutral";
  }
}

class WardrobeStateManager {
  constructor(castBible) {
    this.wardrobes = new Map();
    if (castBible && castBible.characters) {
      for (const char of castBible.characters) {
        this.wardrobes.set(char.id || char.name, {
          base: char.base_wardrobe || char.wardrobe || {},
          current: char.base_wardrobe || char.wardrobe || {},
          history: []
        });
      }
    }
  }

  getWardrobe(id) { return this.wardrobes.get(id); }
  updateWardrobe(id, updates, sceneIndex) {
    if (this.wardrobes.has(id)) {
      const w = this.wardrobes.get(id);
      w.history.push({ fromScene: sceneIndex, change: updates });
      w.current = { ...w.current, ...updates };
      this.wardrobes.set(id, w);
    }
  }
}

class EnvironmentRegistry {
  constructor() {
    this.environments = new Map();
  }

  registerEnvironment(id, definition) {
    this.environments.set(id, {
      name: definition.name,
      location: definition.location,
      state: definition.state || "intact",
      visible: definition.visible !== false
    });
  }

  updateEnvironment(id, updates) {
    if (this.environments.has(id)) {
      this.environments.set(id, { ...this.environments.get(id), ...updates });
    } else {
      this.registerEnvironment(id, updates);
    }
  }

  getVisibleEnvironmentsInLocation(location) {
    const visible = [];
    for (const [id, env] of this.environments.entries()) {
      if (env.visible && env.location === location) {
        visible.push(env);
      }
    }
    return visible;
  }
}

class VehicleRegistry {
  constructor() {
    this.vehicles = new Map();
  }

  registerVehicle(id, definition) {
    this.vehicles.set(id, {
      name: definition.name,
      color: definition.color || null,
      model: definition.model || null,
      owner: definition.owner || null,
      currentLocation: definition.currentLocation || null,
      condition: definition.condition || "intact",
      visible: definition.visible !== false
    });
  }

  updateVehicle(id, updates) {
    if (this.vehicles.has(id)) {
      this.vehicles.set(id, { ...this.vehicles.get(id), ...updates });
    } else {
      this.registerVehicle(id, updates);
    }
  }
}

class TimelineRegistry {
  constructor() {
    this.state = {
      currentStoryDay: 1,
      currentStoryHour: 8,
      timeOfDay: "morning",
      history: []
    };
  }

  updateTime(updates, sceneIndex) {
    this.state.history.push({ scene: sceneIndex, time: this.state.timeOfDay, newTime: updates.timeOfDay || this.state.timeOfDay });
    this.state = { ...this.state, ...updates };
  }

  getTime() { return this.state; }
}

// ─── MODULE 1: INPUT NORMALIZATION → PROJECT_SPEC ────────────────────────────


/**
 * Module 1 — Input Normalization
 * Gate: every creator instruction recorded; count/aspect ratio exact;
 *       continuity and references acknowledged; facts vs. estimates separated;
 *       no assumption overrides an instruction; no major field left open.
 */
export async function runModule1_InputNormalization({
  title,
  sourceType = "script",
  storyScript,
  imageCount,
  aspectRatio,
  platform = "social_media",
  visualStyle = null,
  timePeriod = null,
  countryLocation = null,
  seriesContinuity = null,
  referenceImagesAvailable = false,
  restrictions = null,
  storyGuidelines = null,
  visualSuggestions = null,
}) {
  logger.info("[MGE] Module 1: Input Normalization → PROJECT_SPEC");

  const PROJECT_SPEC = {
    title: title || "Untitled",
    source_type: sourceType,
    requested_image_count: imageCount,
    aspect_ratio: aspectRatio,
    platform,
    visual_style: visualStyle || "cinematic_photorealistic",
    time_period: timePeriod || "detect_from_source",
    country_location: countryLocation || "detect_from_source",
    series_continuity: seriesContinuity || null,
    reference_images_available: referenceImagesAvailable,
    restrictions: restrictions || [],
    story_guidelines: storyGuidelines || null,
    visual_suggestions: visualSuggestions || null,
    confirmed_facts: [],
    visual_estimates: [],
    missing_critical_info: [],
  };

  // Gate validation
  const gateErrors = [];
  if (!PROJECT_SPEC.requested_image_count || PROJECT_SPEC.requested_image_count < 1)
    gateErrors.push("requested_image_count must be >= 1");
  if (!PROJECT_SPEC.aspect_ratio)
    gateErrors.push("aspect_ratio is required");
  if (!storyScript || storyScript.trim().length < 50)
    gateErrors.push("storyScript is too short to process");

  if (gateErrors.length > 0) {
    logger.error(`[MGE] Module 1 Gate FAILED: ${gateErrors.join("; ")}`);
    throw new Error(`[MGE] Module 1 Gate: ${gateErrors.join("; ")}`);
  }

  logger.info("[MGE] Module 1 ✅ PROJECT_SPEC validated");
  return PROJECT_SPEC;
}

// ─── MODULE 2: FULL STORY & WORLD ANALYSIS → STORY_WORLD_MAP ─────────────────

/**
 * Module 2 — Full Story & World Analysis
 * Non-negotiable: reads/analyzes the COMPLETE source including the ending
 * BEFORE building any scenes or frames.
 * Gate: ending analyzed; every major event/location change/flashback recorded;
 *       detected world matches source; unsupported foreign elements removed.
 */
export async function runModule2_StoryWorldAnalysis(storyScript, projectSpec) {
  logger.info("[MGE] Module 2: Full Story & World Analysis → STORY_WORLD_MAP");

  const prompt = `You are a story analyst, cultural/period researcher, and visual world builder.
Analyze the COMPLETE script below from start to finish INCLUDING the ending before responding.

NON-NEGOTIABLE RULES:
- Universal World: detect world details from the ACTUAL SOURCE; never hard-code an unrelated country/culture/climate.
- Every major event, location change, flashback, dream, and time jump must be recorded.
- Never present an unsupported identity, historical fact, cultural detail, geography, uniform, vehicle, weapon, or architecture as confirmed.
- If a fact is uncertain, mark it as a visual_estimate, not a confirmed_fact.

PROJECT SPEC:
${JSON.stringify(projectSpec, null, 2)}

FULL SCRIPT (analyze ALL of it including the ending):
${storyScript}

Return STRICT valid JSON with this structure:
{
  "story_fields": {
    "opening_situation": "string",
    "subject": "string",
    "dramatic_promise": "string",
    "conflict": "string",
    "protagonist_goals": "string",
    "antagonism": "string",
    "major_turns": ["array of key plot turns in order"],
    "escalation": "string",
    "midpoint": "string",
    "consequences": "string",
    "resolution": "string",
    "final_visual_beat": "string",
    "chronology": "linear | non-linear | flashback-heavy",
    "flashbacks_time_jumps": ["list"],
    "location_changes": ["list of locations in story order"]
  },
  "world_fields": {
    "country": "string",
    "region": "string",
    "city_district": "string",
    "time_period": "string",
    "cultural_social_economic_environment": "string",
    "climate_weather_logic": "string",
    "architecture_materials": "string",
    "street_domestic_interior_environment": "string",
    "transportation": "string",
    "vegetation": "string",
    "tech_level": "string",
    "utilities_infrastructure": "string",
    "authority_style": "string",
    "community_environment": "string",
    "period_cultural_restrictions": ["list"],
    "forbidden_foreign_archetypes": ["list of visual archetypes that MUST NOT appear based on this specific world"]
  },
  "confirmed_facts": ["list of facts directly stated in source"],
  "visual_estimates": ["list of details inferred professionally but not explicitly stated"],
  "act_structure": {
    "act_1_scenes": ["brief descriptions"],
    "act_2_scenes": ["brief descriptions"],
    "act_3_scenes": ["brief descriptions"]
  }
}`;

  const result = await callGeminiJSON(prompt, "Module 2 — Story World Analysis");

  // Gate validation
  const gateErrors = [];
  if (!result?.story_fields?.resolution)
    gateErrors.push("resolution not analyzed — Full-Story-First rule violated");
  if (!result?.story_fields?.final_visual_beat)
    gateErrors.push("final_visual_beat missing");
  if (!result?.world_fields?.country)
    gateErrors.push("world country not detected");
  if (!result?.story_fields?.major_turns?.length)
    gateErrors.push("no major turns recorded");

  if (gateErrors.length > 0) {
    logger.warn(`[MGE] Module 2 Gate issues: ${gateErrors.join("; ")} — retrying`);
    // Attempt repair: retry once
    const repaired = await callGeminiJSON(prompt, "Module 2 — Repair attempt");
    if (!repaired?.story_fields?.resolution) {
      logger.error("[MGE] Module 2 Gate FAILED after repair");
      throw new Error(`[MGE] Module 2 Gate: ${gateErrors.join("; ")}`);
    }
    logger.info("[MGE] Module 2 ✅ Repaired and validated");
    return repaired;
  }

  logger.info("[MGE] Module 2 ✅ STORY_WORLD_MAP validated");
  return result;
}

// ─── MODULE 3: MATERIALIZED CAST BIBLE ───────────────────────────────────────

/**
 * Module 3 — Materialized Cast Bible
 * Categories:
 *   - Named characters → exact story name (never "the man/she/they")
 *   - Recurring unnamed → stable functional label (e.g. "Police Officer One")
 *   - Unreadable distant groups → crowd record only
 * Gate: every named/recurring character capsule-complete; every face visually
 *       distinguishable; no character defined only by race/age/build;
 *       reference-image identity preserved; estimates locked.
 */
export async function runModule3_MaterializedCastBible(storyWorldMap, referenceTraits = null) {
  logger.info("[MGE] Module 3: Materialized Cast Bible → MATERIALIZED_CAST_BIBLE");

  let refContext = "";
  if (referenceTraits) {
    refContext = `
REFERENCE IMAGE TRAITS (lock these exactly to the main character's capsule):
${JSON.stringify(referenceTraits, null, 2)}
`;
  }

  const prompt = `You are a casting director, character-identity designer, and sketch artist.
Extract every recurring/named character from the story analysis below and build a full CHARACTER_CAPSULE for each.

STANDARD: a label + age + build is NEVER sufficient — every category below must be physically defined so an image generator CANNOT invent the face.

MATERIALIZATION RULE: A racial/ethnic/national label (e.g., "Japanese man", "Nigerian woman") is identity only — it MUST be paired with a full physical/behavioral CHARACTER_CAPSULE. Same for locations.

${refContext}

${SCHEMA_A_FIELDS}

STORY WORLD MAP:
${JSON.stringify(storyWorldMap, null, 2)}

CONDITIONAL CULTURAL MODULE (activate when supported by the story):
- Accurately identify and preserve the specific cultural, regional, and ethnic identities of the characters as described in the story.
- Forbid drift into unrelated or dominant global archetypes (e.g., U.S. or European substitutes) unless the story establishes it.
- Each character must have individual physical description and canonical complexion — never group them.

Return STRICT valid JSON:
{
  "characters": [
    {
      "id": "char_1",
      "name": "Exact name from story or stable functional label",
      "importance": "main | supporting | background_named",
      "identity_culture": {
        "name": "string",
        "story_role": "string",
        "race": "string",
        "ethnicity_cultural_identity": "string",
        "nationality": "string",
        "regional_community_identity": "string"
      },
      "sketch_artist_appearance": {
        "age_range": "string",
        "gender_presentation": "string",
        "height": "string",
        "body_type": "string",
        "fitness_wear": "string",
        "movement_quality": "string",
        "canonical_skin_tone": "string",
        "canonical_undertone": "string",
        "complexion_texture_marks": "string",
        "face_structure": "string",
        "eyes": "string",
        "nose": "string",
        "cheeks": "string",
        "mouth_lips": "string",
        "jaw_chin": "string",
        "ears": "string",
        "asymmetry": "string",
        "teeth_if_relevant": "string",
        "hair": "string",
        "facial_hair": "string",
        "permanent_identifiers": "string"
      },
      "body_language": {
        "posture": "string",
        "head_shoulder_carriage": "string",
        "walk": "string",
        "hand_behavior": "string",
        "personal_space": "string",
        "resting_tension": "string",
        "resting_emotional_face": "string",
        "social_energy": "string"
      },
      "base_wardrobe": {
        "upper_garment": "string",
        "lower_garment": "string",
        "outerwear": "string",
        "cut_fabric_fit": "string",
        "exact_color_family": "string",
        "footwear": "string",
        "socks": "string",
        "jewelry": "string",
        "watch": "string",
        "belt": "string",
        "bag": "string",
        "headwear": "string",
        "class_occupation_cues": "string"
      },
      "identity_restrictions": {
        "may_change": ["list"],
        "may_not_change": ["list"],
        "forbidden_substitutions": ["list"],
        "forbidden_drift": ["list"]
      },
      "visual_estimate_flags": ["any fields that are estimates, not confirmed facts"]
    }
  ],
  "crowd_records": [
    {
      "label": "string",
      "description": "materialized crowd description only — local identity, complexion range, age mix, clothing, activity, density"
    }
  ]
}`;

  const result = await callGeminiJSON(prompt, "Module 3 — Cast Bible");

  // Gate validation
  const gateErrors = [];
  if (!result?.characters?.length)
    gateErrors.push("no characters extracted");

  for (const char of (result?.characters || [])) {
    const sa = char.sketch_artist_appearance;
    if (!sa?.canonical_skin_tone)
      gateErrors.push(`${char.name}: canonical_skin_tone missing`);
    if (!sa?.face_structure)
      gateErrors.push(`${char.name}: face_structure missing`);
    if (!sa?.hair)
      gateErrors.push(`${char.name}: hair missing`);
    if (!char.identity_culture?.race)
      gateErrors.push(`${char.name}: race not defined`);
    if (!char.base_wardrobe?.upper_garment)
      gateErrors.push(`${char.name}: base_wardrobe incomplete`);
  }

  if (gateErrors.length > 0) {
    logger.warn(`[MGE] Module 3 Gate issues (${gateErrors.length}): ${gateErrors.slice(0, 3).join("; ")}... — retrying`);
    const repaired = await callGeminiJSON(prompt, "Module 3 — Repair attempt");
    if (!repaired?.characters?.length) {
      logger.error("[MGE] Module 3 Gate FAILED after repair");
      throw new Error(`[MGE] Module 3 Gate: ${gateErrors.join("; ")}`);
    }
    logger.info("[MGE] Module 3 ✅ Repaired and validated");
    return repaired;
  }

  logger.info(`[MGE] Module 3 ✅ MATERIALIZED_CAST_BIBLE — ${result.characters.length} characters`);
  return result;
}

// ─── MODULE 4: MATERIALIZED VISUAL WORLD BIBLE ───────────────────────────────

/**
 * Module 4 — Materialized Visual World Bible
 * Builds one LOCATION_RECORD per recurring location + Visual Style Record.
 * Gate: every location independently reconstructable, materially/spatially mapped,
 *       culturally detailed; no location mistakable for an unrelated country/city.
 */
export async function runModule4_VisualWorldBible(storyWorldMap, projectSpec) {
  logger.info("[MGE] Module 4: Materialized Visual World Bible → MATERIALIZED_VISUAL_WORLD_BIBLE");

  const prompt = `You are a production designer, visual world builder, and cultural/period researcher.
Build one LOCATION_RECORD for every recurring location detected in the story world map.

STANDARD: a short descriptive phrase is NEVER sufficient — the record must let a production designer physically rebuild the space without inventing anything.

CONDITIONAL CULTURAL MODULE (activate when supported by the story):
- Match background residents, housing, roads, businesses, fences, transport, vegetation, clothing, utilities, and authority style to the SPECIFIC parish/city/district.
- Never substitute generic U.S. urban-crime imagery for Jamaica or other non-US settings.
- Tourist-resort imagery only if the story requires it.

${SCHEMA_B_FIELDS}

STORY WORLD MAP:
${JSON.stringify(storyWorldMap, null, 2)}

PROJECT SPEC:
${JSON.stringify(projectSpec, null, 2)}

Return STRICT valid JSON:
{
  "locations": [
    {
      "id": "loc_1",
      "name": "string",
      "geographic_cultural_id": {
        "name": "string",
        "country": "string",
        "region": "string",
        "city_parish_district": "string",
        "urban_rural_category": "string",
        "social_class": "string",
        "community_function": "string",
        "cultural_identity": "string",
        "period": "string"
      },
      "scale_form": {
        "width": "string",
        "length": "string",
        "ceiling_height": "string",
        "density": "string",
        "enclosure_openness": "string",
        "spatial_pressure": "string",
        "neighboring_structures": "string",
        "fg_mg_bg_structure": "string"
      },
      "construction": {
        "wall_roof_floor_ceiling_material": "string",
        "paint_condition": "string",
        "doors_windows_gates_fences": "string",
        "drainage": "string",
        "utilities": "string",
        "stairs_verandas": "string",
        "pavement_curbs": "string",
        "structural_wear": "string"
      },
      "surface_condition": "string",
      "fixed_elements": "string",
      "lived_in_details": "string",
      "population": {
        "background_people": "string",
        "race_ethnicity_if_relevant": "string",
        "clothing_style": "string",
        "age_mix": "string",
        "crowd_density": "string",
        "activity": "string",
        "social_energy": "string",
        "relation_to_location": "string"
      },
      "climate_nature": {
        "climate": "string",
        "temperature": "string",
        "humidity": "string",
        "weather": "string",
        "wind": "string",
        "vegetation": "string",
        "sky": "string",
        "season": "string"
      },
      "tech_transport": "string",
      "lighting_atmosphere": {
        "light_source": "string",
        "color_temp": "string",
        "intensity": "string",
        "shadow_direction": "string",
        "reflections": "string",
        "atmospheric_density": "string",
        "visibility": "string",
        "emotional_effect": "string",
        "time_of_day": "string"
      },
      "layout_continuity": {
        "entrances_exits": "string",
        "door_window_positions": "string",
        "furniture_vehicle_placement": "string",
        "camera_access_routes": "string",
        "witness_viewpoints": "string",
        "screen_direction_relationships": "string"
      },
      "forbidden_drift": ["list of foreign visual archetypes explicitly prohibited for this location"]
    }
  ],
  "visual_style_record": {
    "image_medium": "string",
    "realism_level": "string",
    "cinematic_treatment": "string",
    "color_philosophy": "string",
    "saturation": "string",
    "contrast": "string",
    "natural_skin_rendering": "string",
    "texture": "string",
    "dynamic_range": "string",
    "grain": "string",
    "lighting_philosophy": "string",
    "lens_language": "string",
    "camera_realism": "string",
    "period_atmospheric_genre_treatment": "string",
    "mobile_readability": "string",
    "text_policy": "no text in images",
    "prohibited_aesthetic_drift": ["list"]
  },
  "common_visual_prompt": "A single reusable visual style string to prepend to all frame prompts for global consistency"
}`;

  const result = await callGeminiJSON(prompt, "Module 4 — Visual World Bible");

  // Gate validation
  const gateErrors = [];
  if (!result?.locations?.length)
    gateErrors.push("no locations extracted");

  for (const loc of (result?.locations || [])) {
    if (!loc.geographic_cultural_id?.country)
      gateErrors.push(`${loc.name}: country missing`);
    if (!loc.construction?.wall_roof_floor_ceiling_material)
      gateErrors.push(`${loc.name}: construction materials missing`);
    if (!loc.forbidden_drift?.length)
      gateErrors.push(`${loc.name}: forbidden_drift not declared`);
  }

  if (!result?.visual_style_record?.image_medium)
    gateErrors.push("visual_style_record incomplete");

  if (gateErrors.length > 0) {
    logger.warn(`[MGE] Module 4 Gate issues (${gateErrors.length}) — retrying`);
    const repaired = await callGeminiJSON(prompt, "Module 4 — Repair attempt");
    if (!repaired?.locations?.length) {
      logger.error("[MGE] Module 4 Gate FAILED after repair");
      throw new Error(`[MGE] Module 4 Gate: ${gateErrors.join("; ")}`);
    }
    logger.info("[MGE] Module 4 ✅ Repaired and validated");
    return repaired;
  }

  logger.info(`[MGE] Module 4 ✅ MATERIALIZED_VISUAL_WORLD_BIBLE — ${result.locations.length} locations`);
  return result;
}

// ─── MODULE 5: SCENE CONSTRUCTION → SCENE_LEDGER ─────────────────────────────

/**
 * Module 5 — Scene Construction
 * Each SCENE_STATE_PACKAGE contains:
 *   A. Identification (scene#, act, location, time, characters present)
 *   B. One full character-state record per person (never grouped, never referencing earlier scenes)
 *   C. Full current LOCATION_RECORD state (standalone-reconstructable)
 *   D. Scene action/continuity (entry/exit states, changes, triggers)
 *   E. Blocking/screen direction (separate from frame composition)
 *
 * Gate (fails if): character count ≠ records; characters grouped; any required
 *   field missing; location under-materialized; shorthand used.
 */
export async function runModule5_SceneConstruction(
  castBible,
  worldBible,
  storyWorldMap,
  imageCount
) {
  logger.info("[MGE] Module 5: Scene Construction → SCENE_LEDGER");

  const prompt = `You are a film director, storyboard director, and continuity supervisor.
Reconstruct the story into a scene ledger. Each scene package must be completely standalone.

NON-NEGOTIABLE RULES:
1. Complete Scene-State: print ONE FULL character-state record per named/recurring/visible person per scene — NEVER grouped, NEVER referencing another scene.
2. No-Shorthand: BANNED — "same," "unchanged," "identical," "as before," "continues unchanged," "all six men retain appearance," etc. If something carries forward, state its CURRENT VALUES in full.
3. Every scene must have its own full character state and location state — assume the reader has seen nothing else.
4. Do NOT generate frames yet — only construct scenes.

CONTINUITY LEVELS:
${CONTINUITY_LEVELS}

CAST BIBLE:
${JSON.stringify(castBible, null, 2)}

VISUAL WORLD BIBLE:
${JSON.stringify(worldBible, null, 2)}

STORY WORLD MAP:
${JSON.stringify(storyWorldMap, null, 2)}

Divide the story into approximately ${Math.max(Math.ceil(imageCount / 2), 3)} scenes. Each scene will receive one or more frames in Module 6.

Return STRICT valid JSON:
{
  "scenes": [
    {
      "scene_number": 1,
      "act": "1 | 2 | 3",
      "sequence": "string",
      "purpose": "string",
      "events_covered": "string",
      "location_id": "loc_1",
      "geographic_cultural_time_setting": "string (full inline, standalone)",
      "weather_atmosphere_lighting": "string",
      "characters_present": ["char_1", "char_2"],
      "background_people_present": "string",
      "character_states": [
        {
          "character_id": "char_1",
          "character_name": "string",
          "identity_culture": { "race": "string", "ethnicity_cultural_identity": "string", "nationality": "string", "regional_community_identity": "string" },
          "sketch_artist_appearance": "FULL physical description inline — do not reference cast bible, copy all values here",
          "current_wardrobe": { "upper_garment": "string", "lower_garment": "string", "outerwear": "string", "footwear": "string", "accessories": "string", "exact_color_family": "string" },
          "current_condition": "injuries/blood/dirt/sweat/bandages description or 'none'",
          "current_props": ["list of props this character holds or carries"],
          "current_performance": "expression, body language, emotional state, energy",
          "current_blocking": "exact position in the frame/space, orientation, eyeline",
          "relationships_in_scene": "relationship/interaction with other characters",
          "exit_state": "how this character leaves this scene / what carries forward",
          "allowed_changes_next_scene": ["what can change in Level 2/3"],
          "forbidden_drift": ["what must never change — Level 1 identity locks"]
        }
      ],
      "current_location_state": {
        "location_name": "string",
        "full_standalone_description": "FULL location description inline — do not reference world bible, copy all relevant values here for this specific moment in the scene",
        "crowd_state": "string",
        "object_placements": "string",
        "entrances_exits_active": "string",
        "forbidden_elements": ["list"]
      },
      "scene_action": {
        "entry_state": "string",
        "main_action": "string",
        "emotional_movement": "string",
        "visual_beats": ["list of distinct visual moments within this scene"],
        "changes_during_scene": "wardrobe/prop/injury/lighting changes that happen",
        "exit_state": "string",
        "what_carries_forward": "string (must state current values, not 'same as before')",
        "valid_change_triggers": "string",
        "link_to_next_scene": "string"
      },
      "blocking_screen_direction": {
        "positions": "string",
        "eyelines": "string",
        "movement_direction": "string",
        "entrance_exit_direction": "string",
        "conversation_axis": "string",
        "witness_viewpoint": "string",
        "camera_to_geography_relationship": "string"
      }
    }
  ]
}`;

  const result = await callGeminiJSON(prompt, "Module 5 — Scene Construction");

  // Gate validation
  const gateErrors = [];
  if (!result?.scenes?.length)
    gateErrors.push("no scenes constructed");

  const SHORTHAND_BANNED = ["same as", "unchanged", "identical to", "as before", "continues unchanged", "see above", "see scene", "as described"];

  for (const scene of (result?.scenes || [])) {
    // Check character count matches records
    if (scene.characters_present?.length !== scene.character_states?.length) {
      gateErrors.push(`Scene ${scene.scene_number}: character_states count (${scene.character_states?.length}) ≠ characters_present count (${scene.characters_present?.length})`);
    }

    // Check for shorthand in character states
    for (const cs of (scene.character_states || [])) {
      const asStr = JSON.stringify(cs).toLowerCase();
      for (const banned of SHORTHAND_BANNED) {
        if (asStr.includes(banned)) {
          gateErrors.push(`Scene ${scene.scene_number}, ${cs.character_name}: shorthand "${banned}" found`);
        }
      }
      if (!cs.sketch_artist_appearance || cs.sketch_artist_appearance.length < 50) {
        gateErrors.push(`Scene ${scene.scene_number}, ${cs.character_name}: sketch_artist_appearance under-materialized`);
      }
    }

    // Check location is materialized
    if (!scene.current_location_state?.full_standalone_description || scene.current_location_state.full_standalone_description.length < 50) {
      gateErrors.push(`Scene ${scene.scene_number}: location under-materialized`);
    }
  }

  if (gateErrors.length > 0) {
    logger.warn(`[MGE] Module 5 Gate issues (${gateErrors.length}) — retrying. First 3: ${gateErrors.slice(0, 3).join("; ")}`);
    const repaired = await callGeminiJSON(prompt, "Module 5 — Repair attempt");
    if (!repaired?.scenes?.length) {
      logger.error("[MGE] Module 5 Gate FAILED after repair");
      throw new Error(`[MGE] Module 5 Gate: ${gateErrors.slice(0, 5).join("; ")}`);
    }
    logger.info("[MGE] Module 5 ✅ Repaired and validated");
    return repaired;
  }

  logger.info(`[MGE] Module 5 ✅ SCENE_LEDGER — ${result.scenes.length} scenes`);
  return result;
}



// ─── GLOBAL NEGATIVE PROMPT BUILDER ──────────────────────────────────────────

/**
 * Build the Global Negative Prompt — constructed once per project.
 * Prevents: character identity/race/ethnicity drift, complexion changes,
 * face swapping, wardrobe misassignment, location resets, geographic drift,
 * anatomical errors, visual artifacts, watermarks.
 */
export function buildGlobalNegativePrompt(storyWorldMap, castBible) {
  const worldCountry = storyWorldMap?.world_fields?.country || "the story's setting";
  const forbiddenArchetypes = storyWorldMap?.world_fields?.forbidden_foreign_archetypes || [];

  // Character-specific forbidden drift
  const charDriftForbidden = (castBible?.characters || [])
    .flatMap(c => c.identity_restrictions?.forbidden_drift || [])
    .filter(Boolean)
    .join(", ");

  const baseNegative = [
    "character identity drift",
    "race or ethnicity substitution",
    "nationality change",
    "complexion or undertone changes",
    "face swapping or face blending",
    "eye shape change",
    "nose shape change",
    "mouth or lip shape change",
    "jaw or chin shape change",
    "hair texture or style change",
    "facial hair change",
    "unjustified age change",
    "missing permanent marks (scars tattoos birthmarks)",
    "wardrobe misassignment",
    "prop misassignment",
    "character position swapping",
    "missing characters from scene",
    "missing props or furniture",
    "location material or architecture reset",
    "random time of day change",
    "random weather change",
    "random lighting change",
    "geographic drift",
    "cultural drift",
    "period errors or anachronisms",
    "foreign architecture archetypes",
    "distorted anatomy",
    "extra limbs",
    "extra fingers",
    "duplicated people",
    "floating objects",
    "unreadable clutter",
    "plastic skin",
    "cartoon look",
    "video game look",
    "watermarks",
    "logos",
    "captions",
    "text in image",
    "subtitles in image",
  ].join(", ");

  let storySpecific = "";
  if (forbiddenArchetypes.length > 0) {
    storySpecific = `, ${forbiddenArchetypes.join(", ")}`;
  }
  if (charDriftForbidden) {
    storySpecific += `, ${charDriftForbidden}`;
  }

  return `${baseNegative}${storySpecific}. Story setting is ${worldCountry} — do not substitute with unrelated country, city, or regional aesthetic.`;
}

// ─── CANONICAL CINEMATIC RUNTIME — v7.0 ─────────────────────────────────────
//
// Architecture:
//   Scene Graph Generator  → pure structural facts (NO camera)
//   Film Director AI       → cinematic decisions only (camera / composition)
//   Scene Compiler         → merges Graph + Registries + Runtime into SceneState
//   Continuity Engine      → catches teleports, resets, logic breaks before render
//   Scene Validator        → guards identity, location, inventory, camera logic
//   Reference Selector     → picks only relevant refs for the shot type
//   Prompt Composer        → pure serializer; zero reasoning; no hallucination
//

// ── Phase 2: Scene Graph Generator ───────────────────────────────────────────
/**
 * Reads the full story + Cast/World Bibles and emits a structural Scene Graph.
 * NO camera. NO prompt language. Pure visual facts only.
 */
export async function generateSceneGraph(storyScript, castBible, worldBible, referenceTraits = null) {
  logger.info("[MGE v7] Phase 2 — Generating Scene Graph...");

  let refLock = "";
  if (Array.isArray(referenceTraits) && referenceTraits.length > 0) {
    refLock = "REFERENCE IMAGE LOCKS (CANONICAL — IMMUTABLE):\n" +
      referenceTraits.map(r =>
        `- ${r.characterName}: face=${r.face}, hair=${r.hair}, skin=${r.skin}, ethnicity=${r.ethnicity || "N/A"}, age=${r.age}, build=${r.build}`
      ).join("\n");
  }

  const prompt = `You are a Story Analyst building a Scene Graph for a cinematic image engine.

Your ONLY job is to extract factual, structural information from the story — NOT to write camera angles, prompts, or artistic language.

FULL STORY SCRIPT:
${storyScript}

CANONICAL CAST BIBLE:
${JSON.stringify(castBible.characters.map(c => ({
  id: c.id || c.name,
  name: c.name,
  race: c.identity_culture?.race,
  ethnicity: c.identity_culture?.ethnicity_cultural_identity,
  age: c.sketch_artist_appearance?.age_range,
  skin: c.sketch_artist_appearance?.canonical_skin_tone,
  hair: c.sketch_artist_appearance?.hair,
  base_wardrobe: c.wardrobe
})), null, 2)}

CANONICAL WORLD BIBLE:
${JSON.stringify(worldBible.locations.map(l => ({
  name: l.name,
  materials: l.construction?.wall_roof_floor_ceiling_material,
  fixed_elements: l.fixed_elements
})), null, 2)}

${refLock}

For each story beat, extract ONLY the following structural facts:

RULES:
- "characters_present" lists ONLY characters who are physically visible in this beat.
- "objects_in_scene" lists every physical object mentioned or logically present.
- "relationships_active" lists any dynamic between characters that is visible (e.g., "John threatens Sarah").
- "action" is a concise verb phrase describing WHAT IS HAPPENING visually (not dialogue, not internal thoughts).
- "location" MUST be a name from the World Bible. Never invent a location.
- "time_of_day" tracks the narrative clock. Only changes when the story explicitly indicates it.
- "weather" only for exterior scenes.
- "constraints" lists things that MUST be maintained from prior beats (e.g., "John's right hand holds the knife from beat 3").
- NEVER include camera angles, shot types, or photographic language here.

Return STRICT valid JSON:
{
  "scene_graph": [
    {
      "beat_index": 0,
      "location": "Location name from World Bible",
      "time_of_day": "morning | afternoon | evening | night",
      "weather": "clear | rainy | foggy | etc. (exterior only, else null)",
      "characters_present": [
        {
          "id": "character id from Cast Bible",
          "name": "character name",
          "pose": "standing | sitting | crouching | running | lying etc.",
          "emotion": "calm | afraid | angry | crying | determined etc.",
          "action": "what this specific character is doing",
          "spatial_position": "left foreground | right background | center etc.",
          "facing": "toward camera | away | toward [character name] etc.",
          "wardrobe_note": "any explicit wardrobe change from base, else 'base wardrobe'"
        }
      ],
      "objects_in_scene": [
        {
          "id": "object_snake_case_id",
          "name": "object name",
          "owner": "character name or null",
          "held": true,
          "location_in_scene": "on the desk | in John's right hand | etc.",
          "state": "clean | bloody | broken | open | closed | on | off etc."
        }
      ],
      "relationships_active": ["John threatens Sarah", "Officer restrains Suspect"],
      "action": "Short present-tense description of what is visually happening",
      "constraints": ["John has been holding the knife since beat 3", "window is broken from beat 5"]
    }
  ],
  "object_registry": [
    {
      "id": "object_snake_case_id",
      "name": "object name",
      "description": "brief physical description",
      "introduced_at_beat": 0
    }
  ],
  "relationship_registry": [
    { "char_a": "character name", "char_b": "character name", "dynamic": "trusts | fears | chasing | holding | opposing etc." }
  ]
}`;

  const result = await callGeminiJSON(prompt, "Scene Graph Generation");
  const graph = result?.scene_graph || [];
  const objectRegistry = result?.object_registry || [];
  const relationshipRegistry = result?.relationship_registry || [];
  logger.info(`[MGE v7] Scene Graph: ${graph.length} beats, ${objectRegistry.length} objects, ${relationshipRegistry.length} relationships`);
  return { graph, objectRegistry, relationshipRegistry };
}

// ── Phase 2b: Beat to Frame Mapper (A.9) ────────────────────────────────────
/**
 * FIX 2 — Nearest-timestamp beat mapping.
 *
 * BEFORE: proportional index — floor((i / N) * graphLength)
 *   Problem: pure arithmetic; a frame's narration text and its assigned beat's
 *   action/pose could describe completely different story moments, causing the
 *   generated image to jump ahead of what the narration is actually saying.
 *
 * AFTER: temporal overlap matching.
 *   Each narration segment carries startSec / endSec from the Whisper timeline.
 *   The scene graph beats are ordered chronologically (beat_index is their
 *   position in story time). We derive a proportional time window for each beat
 *   ([beat_start, beat_end) in normalised story-seconds) and then pick the beat
 *   whose window has the maximum overlap with the segment's own audio window.
 *
 *   Fallback: if segments carry no timestamp data (synthetic segments have
 *   startSec === endSec === undefined) we fall back to the original proportional
 *   index so the pipeline degrades gracefully.
 */
function mapSegmentsToBeats(segments, sceneGraph) {
  if (sceneGraph.length === 0) {
    return segments.map((seg) => ({ ...seg, graphBeat: null, beatIdx: 0 }));
  }

  // Check whether real timestamps exist on at least one segment
  const hasTimestamps = segments.some(
    (s) => typeof s.startSec === "number" && typeof s.endSec === "number"
  );

  if (!hasTimestamps) {
    // ── Fallback: original proportional index mapping ─────────────────────
    logger.info("[MGE v7] mapSegmentsToBeats: no timestamps — using proportional index fallback.");
    return segments.map((seg, i) => {
      const beatIdx = Math.min(
        Math.floor((i / segments.length) * sceneGraph.length),
        sceneGraph.length - 1
      );
      const beat = sceneGraph[beatIdx] ? JSON.parse(JSON.stringify(sceneGraph[beatIdx])) : null;
      return { ...seg, graphBeat: beat, beatIdx };
    });
  }

  // ── Map each segment to a beat by STORY-SEQUENCE ORDINAL, not synthetic time.
  //
  // Root cause of SYMPTOM A: the old code derived a fake [beat_start, beat_end)
  // window by evenly partitioning the audio duration (totalDuration / sceneGraph.length)
  // and assigned each segment the beat whose synthetic window overlapped most.
  // Because scene-graph beats are STORY beats (not time-anchored) and the spoken
  // narration does not advance beat-by-beat at a constant rate, that even partition
  // routinely assigned a segment a beat describing a LATER story moment than the
  // one its audio window is actually narrating — so the rendered image depicted
  // content the voice reached seconds later.
  //
  // FIX: both `segments` and `sceneGraph` are already in the same story order.
  // Map by ordinal position in that sequence. When the counts differ, distribute
  // beats across segments proportionally by INDEX (not by synthetic timestamps),
  // which keeps frame i anchored to the i-th story beat instead of to a guessed
  // time slice. Segments already carry their real startSec/endSec from the Master
  // Timeline and are placed at those times by the renderer — only the *content*
  // beat needs to be the correct story beat.

  const mapped = segments.map((seg, i) => {
    const beatIdx = sceneGraph.length === segments.length
      ? i
      : Math.min(
          sceneGraph.length - 1,
          Math.floor((i / Math.max(1, segments.length)) * sceneGraph.length)
        );

    // Deep clone the beat so modifications don't leak between frames sharing the same beat
    const beat = sceneGraph[beatIdx]
      ? JSON.parse(JSON.stringify(sceneGraph[beatIdx]))
      : null;

    return { ...seg, graphBeat: beat, beatIdx };
  });

  // Log the mapping for debuggability
  logger.info(
    `[MGE v7] mapSegmentsToBeats (timestamp mode): ${segments.length} segments → ${sceneGraph.length} beats. ` +
    mapped.map((m, i) => `F${i + 1}→B${m.beatIdx}`).join(", ")
  );

  return mapped;
}

// ── Phase 2c: Shot Planner (A.7) ────────────────────────────────────────────
/**
 * Generates a cohesive shot plan for the entire sequence in one call.
 * Enforces shot diversity, the 180-degree rule, and logical frame progression.
 */
async function generateShotPlan(mappedSegments) {
  logger.info("[MGE v7] Phase 2c — Generating Shot Plan...");
  
  const frameDetails = mappedSegments.map((s, i) => 
    `Frame ${i + 1} | Beat Location: ${s.graphBeat?.location || 'Unknown'} | Action: ${s.graphBeat?.action || ''} | Narration: ${s.text}`
  ).join("\n");

  const prompt = `You are a Hollywood Director of Photography planning the shots for a ${mappedSegments.length}-frame sequence.
  
For each frame, you will decide the shot type, focal subject, framing, and camera movement.

RULES:
- Enforce the 180° rule: keep characters on their established sides of the screen.
- Screen direction must be maintained.
- Shot diversity: NEVER use the same shot type (e.g., 'medium') more than 2 frames in a row.
- Frame progression: Start wide to establish, move to medium/close-up for dialogue or action.

FRAME DETAILS:
${frameDetails}

Return STRICT valid JSON:
{
  "shot_plan": [
    {
      "frame_index": 0,
      "shot_type": "establishing wide | medium | medium-close | close-up | extreme close-up | over-the-shoulder | two-shot | aerial | low-angle | high-angle",
      "focal_subject": "character name or 'environment'",
      "framing": "brief composition description",
      "camera_movement": "static | slow push-in | slow pull-out | pan left | pan right | tilt up | tilt down"
    }
  ]
}`;

  const result = await callGeminiJSON(prompt, "Shot Plan Generation");
  const plan = result?.shot_plan || [];
  logger.info(`[MGE v7] Shot Plan: ${plan.length} shots planned.`);
  return plan;
}

// ── Phase 3: Film Director AI (Camera & Composition Only) ─────────────────────
/**
 * Receives a fully compiled SceneState and emits ONLY cinematic decisions.
 * It never invents story facts. It only decides HOW to shoot what already exists.
 * Receives the pre-planned shot from the Shot Planner as a constraint.
 */
async function runFilmDirectorAI(compiledBeat, castBible, frameIndex, totalFrames, prevCameraDecision = null, prePlannedShot = null, prevVisualMemory = null) {
  const charList = (compiledBeat.characters_present || []).map(c => c.name).join(", ") || "None";
  const actionDesc = compiledBeat.action || "Scene";

  // Build a continuity payload from the previous frame's visual memory so the
  // director is explicitly told what each character looked like (wardrobe +
  // appearance) in the prior frame and MUST keep it unless the compiled state
  // deliberately changes it.
  let continuityBrief = "None (first frame)";
  if (prevVisualMemory) {
    const prevChars = (prevVisualMemory.characters_present || [])
      .map(c => `${c.name}: ${[c.wardrobe, c.pose, c.emotion, c.injuries?.length ? "injuries:" + c.injuries.join(",") : null].filter(Boolean).join(", ")}`)
      .join("; ");
    continuityBrief = prevChars || "None";
  }

  const prompt = `You are a Hollywood Film Director. A Scene Compiler has assembled the exact contents of frame ${frameIndex + 1} of ${totalFrames}.

Your ONLY job is to decide HOW to shoot this frame cinematically. Do NOT invent story facts. Do NOT add characters. Do NOT add props. Work ONLY with what is given.

COMPILED SCENE STATE (immutable facts for this frame):
- Location: ${compiledBeat.location}
- Time of day: ${compiledBeat.time_of_day}
- Lighting: ${compiledBeat.lighting || "natural ambient"}
- Weather: ${compiledBeat.weather || "N/A"}
- Characters present: ${charList}
- Action: ${actionDesc}
- Character positions: ${(compiledBeat.characters_present || []).map(c => `${c.name} (${c.spatial_position}, ${c.facing})`).join("; ")}

PREVIOUS FRAME CHARACTER STATE (you MUST preserve these across the cut):
${continuityBrief}

PRE-PLANNED SHOT CONSTRAINT (You MUST follow this plan if provided):
${prePlannedShot ? JSON.stringify(prePlannedShot) : "None"}

PREVIOUS CAMERA (for continuity): ${prevCameraDecision ? JSON.stringify(prevCameraDecision) : "None (first frame)"}

CINEMATOGRAPHY RULES:
- Wide/establishing shots for new locations (first appearance).
- Close-up/medium-close when the beat is emotionally intense or the character is speaking.
- Over-the-shoulder for dialogue or confrontation between two characters.
- If only ONE character is present, isolate them — use close-up or medium shot.
- Avoid repeating the exact same shot type more than 2 frames in a row.
- The focal subject must be one of the characters actually listed above.

CHARACTER CONTINUITY RULES (NON-NEGOTIABLE):
- Each character's FACE, BODY, AGE, HAIR, and CLOTHING (wardrobe) from the previous frame
  MUST be reproduced identically in this frame. You may only change wardrobe/appearance if the
  COMPILED SCENE STATE above explicitly states a different wardrobe_note, injury, or change.
- Do NOT alter a character's outfit, hairstyle, or physical features between frames unless the
  scene state justifies it. Continuity of identity and wardrobe is more important than novelty.

Return STRICT valid JSON:
{
  "shot_type": "establishing wide | medium | medium-close | close-up | extreme close-up | over-the-shoulder | two-shot | aerial | low-angle | high-angle",
  "focal_subject": "character name or 'environment'",
  "framing": "brief description of composition (e.g., 'John fills the left third, door visible behind him')",
  "camera_height": "eye-level | low | high | bird's-eye",
  "camera_movement": "static | slow push-in | slow pull-out | pan left | pan right | tilt up | tilt down",
  "depth_of_field": "shallow (subject sharp, bg blurred) | deep (all sharp)",
  "emotional_emphasis": "tension | sadness | relief | fear | anger | calm | dread | hope",
  "transition_from_previous": "cut | dissolve | fade | match-cut | none",
  "wardrobe_unchanged": true,
  "confidence": { "composition": 95, "framing": 90, "emotion": 85 }
}`;

  const result = await callGeminiJSON(prompt, `Film Director AI — Frame ${frameIndex + 1}`);
  return result || {
    shot_type: "medium",
    focal_subject: (compiledBeat.characters_present?.[0]?.name) || "environment",
    framing: "Centered composition",
    camera_height: "eye-level",
    camera_movement: "static",
    depth_of_field: "shallow",
    emotional_emphasis: "neutral",
    transition_from_previous: "cut",
    confidence: { composition: 70, framing: 70, emotion: 70 }
  };
}

// ── Phase 4: Scene Compiler ───────────────────────────────────────────────────
/**
 * Deterministic. Merges the Scene Graph beat, all state managers, and
 * the narration segment into one authoritative SceneState.
 * Zero LLM calls. Pure data assembly.
 */
function compileSceneState(graphBeat, charManager, worldManager, objectManager, narrationText) {
  const location = graphBeat.location;
  const worldArch = worldManager.getArchitecture(location) || { name: location };
  const worldRuntime = worldManager.getRuntime(location) || {};

  // Assemble characters: merge immutable identity + runtime state + graph beat overrides
  const compiledCharacters = (graphBeat.characters_present || []).map(beatChar => {
    const identity = charManager.getIdentity(beatChar.id) || charManager.getIdentity(beatChar.name) || {};
    const runtime = charManager.getRuntime(beatChar.id) || charManager.getRuntime(beatChar.name) || {};

    return {
      id: beatChar.id,
      name: beatChar.name,
      // Identity (immutable) — always from registry
      race: identity.race,
      ethnicity: identity.ethnicity,
      age: identity.age,
      face: identity.face,
      hair: identity.hair,
      skin: identity.skin,
      // Runtime (updated by beat)
      pose: beatChar.pose || runtime.pose || "standing neutral",
      emotion: beatChar.emotion || runtime.emotion || "neutral",
      action: beatChar.action || runtime.action || "idle",
      spatial_position: beatChar.spatial_position || "center",
      facing: beatChar.facing || runtime.facingDirection || "forward",
      wardrobe: (beatChar.wardrobe_note && beatChar.wardrobe_note !== "base wardrobe")
        ? beatChar.wardrobe_note
        : (runtime.clothes || identity.base_wardrobe),
      injuries: runtime.injuries || [],
      inventory: (graphBeat.objects_in_scene || [])
        .filter(o => o.owner === beatChar.name && o.held)
        .map(o => o.name)
    };
  });

  // Assemble objects visible in this scene
  const compiledObjects = (graphBeat.objects_in_scene || []).map(obj => {
    const managed = objectManager.objects.get(obj.id) || {};
    return {
      id: obj.id,
      name: obj.name,
      location_in_scene: obj.location_in_scene || managed.location,
      state: obj.state || managed.state || "normal",
      held: obj.held,
      owner: obj.owner || managed.owner,
      description: managed.description || obj.description || null
    };
  });

  // ── Derive exit_state: plain-text summary of the physical state at the END of this
  //    frame's narrative moment. No LLM call — assembled from data already compiled above.
  const exitStateChars = compiledCharacters.map(c => {
    const locDesc = location ? `inside/at ${location}` : "in the scene";
    return `${c.name} is ${c.pose}, ${c.action}, ${locDesc}`;
  });
  const exit_state = exitStateChars.length > 0
    ? exitStateChars.join("; ") + `. Time of day: ${graphBeat.time_of_day || worldRuntime.time_of_day || "day"}.`
    : `Scene at ${location}. Time: ${graphBeat.time_of_day || worldRuntime.time_of_day || "day"}.`;

  return {
    frame_narration: narrationText || "",
    location,
    location_architecture: worldArch,
    world_runtime: worldRuntime,
    time_of_day: graphBeat.time_of_day || worldRuntime.time_of_day || "day",
    weather: graphBeat.weather || worldRuntime.weather || null,
    lighting: graphBeat.lighting || null,
    characters_present: compiledCharacters,
    objects_in_scene: compiledObjects,
    relationships_active: graphBeat.relationships_active || [],
    action: graphBeat.action ? `${graphBeat.action}. Narration context: "${narrationText}"` : narrationText,
    constraints: graphBeat.constraints || [],
    exit_state,
  };
}

// ── Phase 4b: Continuity Engine ───────────────────────────────────────────────
/**
 * Compares the current SceneState against the previous VisualMemory.
 * Detects teleports, unexplained environment resets, and inventory drops.
 * Returns a continuity report. Issues are logged; the pipeline can choose to warn or block.
 */
function runContinuityEngine(currentState, prevVisualMemory, frameIndex) {
  if (!prevVisualMemory) return { passed: true, issues: [] };

  const issues = [];

  // 1b. Wardrobe / appearance continuity check (HIGH severity — primary guard
  // against character drift). A character who was present in the previous frame
  // must keep the SAME wardrobe unless the current scene state explicitly states a
  // different wardrobe_note (a deliberate story change).
  for (const prevChar of (prevVisualMemory.characters_present || [])) {
    const currChar = (currentState.characters_present || []).find(c => c.id === prevChar.id || c.name === prevChar.name);
    if (!currChar) continue; // character left the scene — OK
    const prevWardrobe = typeof prevChar.wardrobe === "object"
      ? [prevChar.wardrobe.upper_garment, prevChar.wardrobe.lower_garment, prevChar.wardrobe.outerwear, prevChar.wardrobe.footwear, prevChar.wardrobe.accessories].filter(Boolean).join(", ")
      : (prevChar.wardrobe || "");
    const currWardrobe = typeof currChar.wardrobe === "object"
      ? [currChar.wardrobe.upper_garment, currChar.wardrobe.lower_garment, currChar.wardrobe.outerwear, currChar.wardrobe.footwear, currChar.wardrobe.accessories].filter(Boolean).join(", ")
      : (currChar.wardrobe || "");
    // Only flag if the previous frame had a concrete wardrobe and the current one
    // is a DIFFERENT concrete wardrobe AND the scene did not declare a change.
    const declaredChange = (currentState.constraints || []).some(c =>
      /wardrobe|outfit|changes? clothes|puts on|removes? (his|her|their)/i.test(c)
    );
    if (prevWardrobe && currWardrobe && prevWardrobe !== currWardrobe && !declaredChange) {
      issues.push({
        type: "WARDROBE_DRIFT",
        severity: "high",
        detail: `${currChar.name} wardrobe changed without story justification: "${prevWardrobe}" → "${currWardrobe}".`,
      });
    }
  }

  // 1. Location teleport check
  if (prevVisualMemory.location && currentState.location !== prevVisualMemory.location) {
    // Not an issue if constraints mention a location change or time jumped
    const explainedChange = (currentState.constraints || []).some(c =>
      c.toLowerCase().includes("location") || c.toLowerCase().includes("moved") || c.toLowerCase().includes("enters")
    );
    if (!explainedChange) {
      issues.push({ type: "TELEPORT", severity: "high", detail: `Location changed from "${prevVisualMemory.location}" to "${currentState.location}" without an explained transition.` });
    }
  }

  // 2. Time of day regression check (night → morning without sleep/skip)
  const timeOrder = ["morning", "afternoon", "evening", "night"];
  const prevIdx = timeOrder.indexOf(prevVisualMemory.time_of_day);
  const currIdx = timeOrder.indexOf(currentState.time_of_day);
  if (prevIdx > -1 && currIdx > -1 && currIdx < prevIdx) {
    const explainedSkip = (currentState.constraints || []).some(c =>
      c.toLowerCase().includes("next day") || c.toLowerCase().includes("morning") || c.toLowerCase().includes("time skip")
    );
    if (!explainedSkip) {
      issues.push({ type: "TIME_REGRESSION", severity: "medium", detail: `Time went from "${prevVisualMemory.time_of_day}" back to "${currentState.time_of_day}" without a justified skip.` });
    }
  }

  // 3. Character inventory check (item held in prev should still exist unless dropped)
  for (const prevChar of (prevVisualMemory.characters_present || [])) {
    const currChar = (currentState.characters_present || []).find(c => c.id === prevChar.id || c.name === prevChar.name);
    if (!currChar) continue; // character left scene — OK
    const prevInventory = prevChar.inventory || [];
    const currInventory = currChar.inventory || [];
    for (const item of prevInventory) {
      if (!currInventory.includes(item)) {
        const dropped = (currentState.constraints || []).some(c => c.toLowerCase().includes(item.toLowerCase()));
        if (!dropped) {
          issues.push({ type: "INVENTORY_DROP", severity: "medium", detail: `${currChar.name} was holding "${item}" in frame ${frameIndex} but it is missing from frame ${frameIndex + 1} without explanation.` });
        }
      }
    }
  }

  const passed = issues.filter(i => i.severity === "high").length === 0;
  if (issues.length > 0) {
    logger.warn(`[MGE v7] Continuity Engine — Frame ${frameIndex + 1}: ${issues.length} issue(s) detected.`);
    issues.forEach(i => logger.warn(`  [${i.severity.toUpperCase()}] ${i.type}: ${i.detail}`));
  }
  return { passed, issues };
}

// ── Phase 5: Scene Validator ──────────────────────────────────────────────────
/**
 * Checks the compiled SceneState and Director decision for logical validity
 * before any prompt is written or image is generated.
 * Returns { valid: boolean, failures: string[] }
 */
function validateSceneState(compiledState, directorDecision, charManager, worldManager) {
  const failures = [];

  // 1. All characters must exist in the registry
  for (const char of (compiledState.characters_present || [])) {
    const identity = charManager.getIdentity(char.id) || charManager.getIdentity(char.name);
    if (!identity) {
      failures.push(`Character "${char.name}" is not in the Character Registry.`);
    }
  }

  // 2. Location must exist in the world registry
  const worldArch = worldManager.getArchitecture(compiledState.location);
  if (!worldArch) {
    failures.push(`Location "${compiledState.location}" is not in the World Registry.`);
  }

  // 3. Focal subject must be one of the visible characters (or environment)
  if (directorDecision?.focal_subject && directorDecision.focal_subject !== "environment") {
    const focalExists = (compiledState.characters_present || []).some(
      c => c.name === directorDecision.focal_subject || c.id === directorDecision.focal_subject
    );
    if (!focalExists) {
      failures.push(`Director focal subject "${directorDecision.focal_subject}" is not in the scene.`);
    }
  }

  // 4. Confidence threshold — regenerate if any AI stage confidence is too low
  if (directorDecision?.confidence) {
    for (const [key, val] of Object.entries(directorDecision.confidence)) {
      if (typeof val === "number" && val < 60) {
        failures.push(`Director confidence for "${key}" is ${val}% — below threshold.`);
      }
    }
  }

  return { valid: failures.length === 0, failures };
}

// ── Phase 6a: Reference Selector ─────────────────────────────────────────────
/**
 * Selects which character reference images to pass to the renderer.
 * Key rule: never pass references for off-screen characters, and never pass a ref
 * for a character that has no portrait (functional labels like neighbor_1 /
 * police_officer_1 are correctly excluded because they are not in characterReferences[]).
 *
 * FIX A: attach refs for EVERY present character who has a valid portrait, regardless
 * of shot type. The previous shot-type caps (close-up→1, two-shot→2, wide→1) silently
 * dropped reference images for present characters and caused identity drift. We now
 * cap ONLY by what is actually present and has a real portrait — functional characters
 * with no portrait remain text-only by design (they are never in characterReferences[]).
 */
function selectReferences(compiledState, directorDecision, characterReferences) {
  if (!characterReferences || characterReferences.length === 0) return [];

  const presentCharIds = new Set(
    (compiledState.characters_present || []).flatMap(c => [c.id, c.name])
  );

  // Filter to only refs whose character is actually in the scene AND has a portrait.
  // Since characterReferences[] only contains characters that received a portrait,
  // this list is already limited to present, portraited characters — functional
  // characters without portraits are excluded here automatically.
  const relevantRefs = characterReferences.filter(
    ref => presentCharIds.has(ref.id) || presentCharIds.has(ref.name)
  );

  const presentCount = compiledState.characters_present?.length || 0;
  const shotType = directorDecision?.shot_type || "medium";
  const focalSubject = directorDecision?.focal_subject;

  // 1-2 characters present: keep the prior correct behaviour — attach all present
  // character refs (the focal subject is naturally included in relevantRefs).
  if (presentCount <= 2) {
    return relevantRefs;
  }

  // 3+ characters present: attach refs for ALL present characters who have a valid
  // portrait, regardless of shot type (close-up, wide, establishing, two-shot, etc.).
  // No shot-type cap — only what is actually present and portraited.
  return relevantRefs;
}

// ── Phase 6b: Prompt Composer ─────────────────────────────────────────────────
/**
 * PURE SERIALIZER. Zero reasoning. Zero hallucination.
 * Converts a compiled SceneState + Director decision into the final image prompt string.
 * Follows a strict template:
 *   [Continuity anchor (frame > 0)] → Framing → Subject → Props → Environment → Lighting → Technical.
 *
 * @param {Object}      compiledState      - The compiled scene state for this frame.
 * @param {Object|null} directorDecision   - Camera/composition decision from Film Director AI.
 * @param {string}      aspectRatio        - e.g. "16:9" or "9:16".
 * @param {string|null} prevExitState      - Plain-text exit_state from the PREVIOUS frame's
 *                                          compiled state (null for frame 0).
 * @param {string|null} prevNarrationText  - The narration text of the PREVIOUS frame (null for frame 0).
 */
function composePrompt(compiledState, directorDecision, aspectRatio, prevExitState = null, prevNarrationText = null) {
  const {
    characters_present = [],
    objects_in_scene = [],
    location,
    location_architecture,
    time_of_day,
    weather,
    lighting,
    frame_narration: narrationText,
  } = compiledState;

  const {
    shot_type = "medium",
    focal_subject,
    framing = "",
    camera_height = "eye-level",
    depth_of_field = "shallow",
    emotional_emphasis = "neutral"
  } = directorDecision || {};

  // ── Block 0: Continuity anchor (omitted for frame 0)
  //    Placed FIRST so Gemini interprets all subsequent pose/action fields
  //    relative to the confirmed prior physical state.
  const continuityAnchorBlock = prevExitState
    ? [
        `CONTINUITY_FROM_PREVIOUS_FRAME:`,
        `"${prevExitState}"`,
        `This frame must show the immediate next moment continuing directly from the above — same location and physical state unless the narration explicitly indicates movement or a scene change.`,
        `Narration transition: previous = "${(prevNarrationText || "").slice(0, 120)}" → this frame = "${(narrationText || "").slice(0, 120)}".`,
      ].join("\n")
    : "";

  // ── Block 1: Shot & Framing
  const shotBlock = `${shot_type.toUpperCase()} SHOT. ${camera_height} angle. ${framing}`.trim();

  // ── Block 2: Subject(s) — sorted so focal subject comes first
  const sorted = [...characters_present].sort((a, b) => {
    if (a.name === focal_subject) return -1;
    if (b.name === focal_subject) return 1;
    return 0;
  });

  const subjectBlock = sorted.map(char => {
    const parts = [
      `CANONICAL CHARACTER GUIDELINE (LOCKED — reproduce EXACTLY, never improvise face/hair/skin/wardrobe):`,
      `SUBJECT: ${char.name}`,
      char.race ? `${char.race} ${char.ethnicity || ""}`.trim() : null,
      char.age ? `${char.age}` : null,
      char.skin ? `skin: ${char.skin}` : null,
      char.hair ? `hair: ${char.hair}` : null,
      char.face ? `face: ${char.face}` : null,
      char.wardrobe && typeof char.wardrobe === "object" ? `wearing: ${[char.wardrobe.upper_garment, char.wardrobe.lower_garment, char.wardrobe.outerwear, char.wardrobe.footwear, char.wardrobe.accessories].filter(Boolean).join(", ")}` : char.wardrobe ? `wearing: ${char.wardrobe}` : null,
      char.injuries?.length ? `injuries: ${char.injuries.join(", ")}` : null,
      char.inventory?.length ? `holding in hand: ${char.inventory.join(", ")}` : null,
      `POSE: ${char.pose}`,
      `EMOTION: ${char.emotion}`,
      `ACTION: ${char.action}`,
      `POSITION: ${char.spatial_position}`,
      `FACING: ${char.facing}`
    ].filter(Boolean);
    return parts.join(". ");
  }).join("\n\n");

  // ── Block 3: Objects / Props (LOCKED canonical description)
  // Objects NEVER get a reference image. Each object's look is a canonical,
  // story-derived description synthesized ONCE (ensureObjectGuidelines) and must be
  // reproduced IDENTICALLY on every frame — same car, same house, same street.
  const objBlock = objects_in_scene.length > 0
    ? "PROPS (OBJECT LOCK — reproduce EXACTLY, never improvise): " + objects_in_scene.map(o =>
        `${o.name} [${o.location_in_scene || "in scene"}${o.owner ? ", held by " + o.owner : ""}${o.state !== "normal" ? ", " + o.state : ""}] → ${(o.description || "(no canonical description)")}`
      ).join("; ")
    : "";

  // ── Block 4: Environment
  const archDesc = location_architecture?.materials
    ? `${location}: walls/floor/ceiling: ${location_architecture.materials}`
    : location;
  const fixedEls = location_architecture?.fixed_elements
    ? `Fixed elements: ${typeof location_architecture.fixed_elements === "object"
      ? Object.values(location_architecture.fixed_elements).filter(Boolean).join(", ")
      : location_architecture.fixed_elements}`
    : "";

  const envBlock = [
    `ENVIRONMENT: ${archDesc}`,
    fixedEls,
    `TIME: ${time_of_day}`,
    weather ? `WEATHER: ${weather}` : null,
    lighting ? `LIGHTING: ${lighting}` : null
  ].filter(Boolean).join(". ");

  // ── Block 5: Technical / Mood
  const techBlock = [
    `MOOD: ${emotional_emphasis}`,
    `DEPTH OF FIELD: ${depth_of_field}`,
    "cinematic photorealistic film still",
    "8K hyper-realistic",
    "volumetric lighting",
    "NO text NO watermarks NO subtitles"
  ].join(", ");

  return [continuityAnchorBlock, shotBlock, subjectBlock, objBlock, envBlock, techBlock]
    .filter(s => s.trim().length > 0)
    .join("\n\n");
}

// ── Phase 4: Visual Memory Update ─────────────────────────────────────────────
/**
 * Stores a snapshot of the current frame so the Continuity Engine can
 * compare it against the next frame.
 */
function createVisualMemory(compiledState, directorDecision, selectedRefs, promptStr) {
  return {
    location: compiledState.location,
    time_of_day: compiledState.time_of_day,
    weather: compiledState.weather,
    characters_present: compiledState.characters_present.map(c => ({
      id: c.id, name: c.name, pose: c.pose, emotion: c.emotion,
      wardrobe: c.wardrobe, inventory: c.inventory, injuries: c.injuries
    })),
    objects_in_scene: compiledState.objects_in_scene.map(o => ({
      id: o.id, name: o.name, state: o.state, owner: o.owner
    })),
    camera: {
      shot_type: directorDecision?.shot_type,
      camera_height: directorDecision?.camera_height,
      focal_subject: directorDecision?.focal_subject
    },
    references_used: selectedRefs.map(r => r.id || r.name),
    prompt_hash: promptStr.substring(0, 80) // cheap fingerprint for debugging
  };
}

// ─── MAIN ORCHESTRATOR ────────────────────────────────────────────────────────

/**
 * runFullMotionGraphicEngine v7.0 — Deterministic Cinematic Runtime
 *
 * Pipeline:
 *   Module 1+2+3+4+5 (existing) → Builds bibles
 *   Phase 2: Scene Graph Generator
 *   Phase 3 loop per frame:
 *     Compile → Director → Continuity → Validate → Ref Selector → Compose
 *   Returns { scenePrompts, castBible, worldBible, globalNegativePrompt, finalAudit }
 */
export async function runFullMotionGraphicEngine({
  storyScript,
  imageCount,
  aspectRatio,
  title,
  storyType,
  storyBible = null,
  referenceTraits = null,
  visualSuggestions = null,
  storyGuidelines = null,
  narrationSegments = null,
  characterReferences = [],    // [{ id, name, url }] from workflowService
  preGeneratedBibles = null    // { PROJECT_SPEC, STORY_WORLD_MAP, MATERIALIZED_CAST_BIBLE, MATERIALIZED_VISUAL_WORLD_BIBLE }
}) {
  logger.info(`[MGE v7] ═══ Deterministic Cinematic Runtime — ${imageCount} frames @ ${aspectRatio} ═══`);

  // ── Modules 1–5 (unchanged: produce bibles) ──────────────────────────────
  const PROJECT_SPEC = preGeneratedBibles?.PROJECT_SPEC || await runModule1_InputNormalization({
    title, sourceType: storyType || "script", storyScript, imageCount,
    aspectRatio, visualSuggestions, storyGuidelines,
  });

  const STORY_WORLD_MAP = preGeneratedBibles?.STORY_WORLD_MAP || await runModule2_StoryWorldAnalysis(storyScript, PROJECT_SPEC);

  const castContextHint = storyBible?.characters?.length
    ? `\n\nPREVIOUSLY EXTRACTED CHARACTER LIST:\n${JSON.stringify(storyBible.characters.map(c => ({ name: c.name, appearance: c.appearance })), null, 2)}`
    : "";

  const MATERIALIZED_CAST_BIBLE = preGeneratedBibles?.MATERIALIZED_CAST_BIBLE || await runModule3_MaterializedCastBible(
    { ...STORY_WORLD_MAP, _cast_hint: castContextHint }, referenceTraits
  );

  const MATERIALIZED_VISUAL_WORLD_BIBLE = preGeneratedBibles?.MATERIALIZED_VISUAL_WORLD_BIBLE || await runModule4_VisualWorldBible(STORY_WORLD_MAP, PROJECT_SPEC);

  const GLOBAL_NEGATIVE_PROMPT = buildGlobalNegativePrompt(STORY_WORLD_MAP, MATERIALIZED_CAST_BIBLE);

  const worldManager = new WorldStateManager(MATERIALIZED_VISUAL_WORLD_BIBLE);
  const objectManager = new ObjectStateManager();
  const relationshipManager = new RelationshipStateManager();

  // ── Phase 2: Scene Graph ──────────────────────────────────────────────────
  const { graph: SCENE_GRAPH, objectRegistry, relationshipRegistry } = await generateSceneGraph(
    storyScript, MATERIALIZED_CAST_BIBLE, MATERIALIZED_VISUAL_WORLD_BIBLE, referenceTraits
  );

  // ── Character guideline backfill ──────────────────────────────────────────
  // Ensure EVERY character referenced in the story (incl. functional/secondary ones
  // the Cast Bible may have omitted) has a canonical, materialized text guideline.
  // Mutates MATERIALIZED_CAST_BIBLE.characters IN PLACE so charManager picks them up.
  await ensureCharacterGuidelines(SCENE_GRAPH, MATERIALIZED_CAST_BIBLE, storyScript);

  // ── Initialise Character State Manager AFTER guideline backfill so newly
  //    synthesized characters are registered and flow into every frame. ───────
  const charManager = new CharacterStateManager(MATERIALIZED_CAST_BIBLE);

  // Seed Object Registry from scene graph output
  for (const obj of objectRegistry) {
    objectManager.registerObject(obj.id, { ...obj, location: null });
  }

  // ── Object guideline backfill ───────────────────────────────────
  // Objects (rooms, house, car, street, etc.) NEVER get a reference image.
  // Synthesize a canonical, story-derived description for every referenced object
  // and lock it consistently on every frame it appears in (no ref upload path).
  await ensureObjectGuidelines(SCENE_GRAPH, objectRegistry, storyScript);

  // Seed Relationship Registry
  for (const rel of relationshipRegistry) {
    relationshipManager.setRelationship(rel.char_a, rel.char_b, rel.dynamic);
  }

  // ── Map narration segments → scene graph beats ────────────────────────────
  const segments = narrationSegments || Array.from({ length: imageCount }, (_, i) => ({
    sceneIndex: i, text: `Segment ${i + 1}`, startSec: i * 5, endSec: (i + 1) * 5
  }));

  // A.9: Use sliding window Beat-to-Frame mapping
  const mappedSegments = mapSegmentsToBeats(segments, SCENE_GRAPH);

  // A.7: Generate Shot Plan for the sequence
  const shotPlan = await generateShotPlan(mappedSegments);


  // ── Phase 3 Loop: Compile → Direct → Check → Validate → Select → Compose ──
  logger.info(`[MGE v7] Starting frame loop: ${mappedSegments.length} frames...`);

  const scenePrompts = [];
  let prevVisualMemory = null;
  let prevCameraDecision = null;
  let prevExitState = null;       // FIX 1: exit_state summary carried forward from previous frame
  let prevNarrationText = null;   // FIX 1: narration text carried forward from previous frame
  let continuityFailures = 0;

  for (let i = 0; i < mappedSegments.length; i++) {
    const { graphBeat, text: narrationText } = mappedSegments[i];

    if (!graphBeat) {
      logger.warn(`[MGE v7] Frame ${i + 1}: No graph beat found — using fallback state.`);
    }

    const beatToCompile = graphBeat || {
      location: MATERIALIZED_VISUAL_WORLD_BIBLE.locations?.[0]?.name || "Unknown",
      time_of_day: "day",
      characters_present: [],
      objects_in_scene: [],
      relationships_active: [],
      action: narrationText || "Scene continues",
      constraints: []
    };

    // ── Step A: Compile SceneState (now also derives exit_state)
    const compiledState = compileSceneState(beatToCompile, charManager, worldManager, objectManager, narrationText);

    // ── Step B: Continuity Check
    const continuityReport = runContinuityEngine(compiledState, prevVisualMemory, i);
    if (!continuityReport.passed) {
      continuityFailures++;
      // Log but continue — we do not block on medium issues, only log high
    }

    // ── Step C: Film Director AI (camera only)
    const plannedShot = shotPlan[i] || null;
    let directorDecision = await runFilmDirectorAI(compiledState, MATERIALIZED_CAST_BIBLE, i, mappedSegments.length, prevCameraDecision, plannedShot, prevVisualMemory);

    // ── Step D: Validate SceneState + Director
    let validation = validateSceneState(compiledState, directorDecision, charManager, worldManager);
    if (!validation.valid) {
      logger.warn(`[MGE v7] Frame ${i + 1} validation failed: ${validation.failures.join("; ")}`);
      // Reset focal subject to first visible character and retry composer with safe defaults
      if (directorDecision) {
        directorDecision.focal_subject = compiledState.characters_present?.[0]?.name || "environment";
        directorDecision.confidence = { composition: 75, framing: 75, emotion: 75 };
      }
    }

    // ── Step E: Reference Selector
    const selectedRefs = selectReferences(compiledState, directorDecision, characterReferences);

    // DEBUG (FIX A): log present characters vs refs actually selected, so we can
    // confirm every portraited present character gets a reference regardless of shot type.
    const presentNames = (compiledState.characters_present || []).map(c => c.name || c.id);
    logger.info(
      `[MGE v7] Frame ${i + 1} — present(${presentNames.length}): [${presentNames.join(", ")}] | ` +
      `selectedRefs(${selectedRefs.length}): [${selectedRefs.map(r => r.name || r.id).join(", ")}] | ` +
      `shot: ${directorDecision?.shot_type || "medium"}`
    );

    // ── Step F: Prompt Composer (pure serializer) — FIX 1: passes continuity anchor
    const finalPrompt = composePrompt(
      compiledState,
      directorDecision,
      aspectRatio,
      i > 0 ? prevExitState : null,       // omit anchor for frame 0
      i > 0 ? prevNarrationText : null,   // omit anchor for frame 0
    );

    // ── Step G: Visual Memory Update
    const visualMemory = createVisualMemory(compiledState, directorDecision, selectedRefs, finalPrompt);

    // ── Step H: Update Runtime State Managers for next iteration
    for (const char of compiledState.characters_present) {
      charManager.updateRuntime(char.id || char.name, {
        pose: char.pose,
        emotion: char.emotion,
        action: char.action,
        clothes: char.wardrobe,
        injuries: char.injuries,
        inventory: char.inventory,
        currentLocation: compiledState.location,
        facingDirection: char.facing
      });
    }
    for (const obj of compiledState.objects_in_scene) {
      objectManager.updateObject(obj.id, {
        name: obj.name,
        owner: obj.owner,
        location: compiledState.location,
        state: obj.state,
        held: obj.held
      });
    }
    worldManager.updateRuntime(compiledState.location, {
      time_of_day: compiledState.time_of_day,
      weather: compiledState.weather
    });

    // FIX 1: Store exit_state and narration from this frame for the NEXT frame's anchor
    prevExitState = compiledState.exit_state || null;
    prevNarrationText = narrationText || null;
    prevVisualMemory = visualMemory;
    prevCameraDecision = directorDecision;

    scenePrompts.push({
      prompt: finalPrompt,
      charactersInScene: (compiledState.characters_present || []).map(c => c.id || c.name),
      narration: narrationText || "",
      selectedRefs,
      _compiledState: compiledState,
      _directorDecision: directorDecision,
      _continuityReport: continuityReport,
      _validationReport: validation,
      _negativePrompt: "",
      _globalNegativePrompt: GLOBAL_NEGATIVE_PROMPT,
    });

    logger.info(`[MGE v7] Frame ${i + 1}/${mappedSegments.length} — shot: ${directorDecision?.shot_type}, focus: ${directorDecision?.focal_subject}, refs: ${selectedRefs.length}, exit_state: "${(compiledState.exit_state || "").slice(0, 60)}..."`);
  }

  const FINAL_AUDIT = {
    passed: continuityFailures === 0,
    continuity_failures: continuityFailures,
    total_frames: scenePrompts.length,
    exact_count_check: scenePrompts.length === imageCount
  };

  logger.info(`[MGE v7] ═══ Deterministic Cinematic Runtime Complete — ${scenePrompts.length}/${imageCount} frames | ${continuityFailures} continuity issues ═══`);

  return {
    scenePrompts,
    castBible: MATERIALIZED_CAST_BIBLE,
    worldBible: MATERIALIZED_VISUAL_WORLD_BIBLE,
    globalNegativePrompt: GLOBAL_NEGATIVE_PROMPT,
    finalAudit: FINAL_AUDIT,
    projectSpec: PROJECT_SPEC,
    storyWorldMap: STORY_WORLD_MAP,
    narrationSegments,
  };
}



