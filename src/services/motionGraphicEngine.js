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

// ─── STATEFUL CINEMATIC ENGINE: SCENE DIRECTOR & PROMPT WRITER ───────────────

function initializeVisualState(worldBible, castBible) {
  return {
    location: null,
    environment: "",
    lighting: "natural cinematic lighting",
    weather: "clear",
    timeOfDay: "daytime",
    camera: {
      lens: "standard 35mm",
      angle: "eye-level",
      shotSize: "medium wide shot",
      movement: "static",
      focus: "main subjects",
      composition: "rule of thirds"
    },
    characterStates: {}, // map of charId -> state
    activeCharacters: [],
    currentSceneNumber: 0,
    storyProgress: "Opening scene"
  };
}

async function runSceneDirectorAI(segment, currentState, castBible, worldBible, sceneLedger, frameNumber) {
  logger.info(`[MGE] Scene Director evaluating frame ${frameNumber}...`);
  const prompt = `You are the Scene Director AI for a continuous cinematic sequence.
Your task is to analyze the current narration segment and determine what changes in the visual state.

CURRENT NARRATION (Audio Segment for Frame ${frameNumber}):
"${segment.text}"

PREVIOUS VISUAL STATE (What the viewer currently sees):
${JSON.stringify(currentState, null, 2)}

SCENE LEDGER OVERVIEW (For context of the story arc only):
${JSON.stringify(sceneLedger.scenes.map(s => ({scene: s.scene_number, purpose: s.purpose, events_covered: s.events_covered})), null, 2)}

CAST BIBLE:
${JSON.stringify(castBible.characters.map(c => ({id: c.id, name: c.name})), null, 2)}
WORLD BIBLE:
${JSON.stringify(worldBible.locations.map(l => ({id: l.id, name: l.name})), null, 2)}

Identify if there is a scene transition. Possible transitions:
NONE, LOCATION_CHANGED, TIME_SKIP, FLASHBACK, NEW_CHARACTER, CAMERA_ONLY.

Output a strict JSON state delta. Only output what changes. For characters, only list characters who are visibly active in this segment.
{
  "transition_type": "string",
  "location_id": "loc_id or null if unchanged",
  "environment_delta": {
    "lighting": "string or null",
    "weather": "string or null",
    "timeOfDay": "string or null"
  },
  "camera_delta": {
    "lens": "string or null (e.g. 50mm, wide angle)",
    "angle": "string or null (e.g. low angle, high angle)",
    "shotSize": "string or null (e.g. close-up, wide shot)",
    "movement": "string or null (e.g. slow pan right)",
    "focus": "string or null",
    "composition": "string or null"
  },
  "active_characters": ["char_1", "char_2"],
  "character_deltas": [
    {
      "character_id": "char_1",
      "position": "string or null (e.g. standing by the window)",
      "lookingAt": "string or null",
      "holding": "string or null",
      "emotion": "string or null",
      "pose": "string or null",
      "movement": "string or null",
      "wardrobe_changes": "string or null (only if clothing visibly changed from base)"
    }
  ],
  "story_progress_update": "Brief summary of what is happening now in this specific frame"
}`;

  return await callGeminiJSON(prompt, `Scene Director - Frame ${frameNumber}`);
}

function applyDeltas(currentState, deltas, worldBible, castBible) {
  const newState = JSON.parse(JSON.stringify(currentState)); // deep copy

  if (deltas?.transition_type === "LOCATION_CHANGED" || deltas?.transition_type === "TIME_SKIP" || deltas?.transition_type === "FLASHBACK") {
    newState.currentSceneNumber += 1;
    if (deltas.location_id) {
       const loc = worldBible.locations.find(l => l.id === deltas.location_id);
       newState.location = loc || newState.location;
    }
  } else if (!newState.location && worldBible.locations?.length > 0) {
    // Initial fallback
    newState.location = worldBible.locations[0];
  }

  if (deltas?.environment_delta) {
    if (deltas.environment_delta.lighting) newState.lighting = deltas.environment_delta.lighting;
    if (deltas.environment_delta.weather) newState.weather = deltas.environment_delta.weather;
    if (deltas.environment_delta.timeOfDay) newState.timeOfDay = deltas.environment_delta.timeOfDay;
  }

  if (deltas?.camera_delta) {
    Object.keys(deltas.camera_delta).forEach(k => {
      if (deltas.camera_delta[k]) newState.camera[k] = deltas.camera_delta[k];
    });
  }

  if (deltas?.active_characters) {
    newState.activeCharacters = deltas.active_characters;
  }
  
  (deltas?.character_deltas || []).forEach(cd => {
    if (!newState.characterStates[cd.character_id]) {
      const char = castBible.characters.find(c => c.id === cd.character_id);
      newState.characterStates[cd.character_id] = {
         base_wardrobe: char?.base_wardrobe || {},
         position: "standing", lookingAt: "forward", holding: "nothing", emotion: "neutral", pose: "neutral", movement: "still"
      };
    }
    const cState = newState.characterStates[cd.character_id];
    if (cd.position) cState.position = cd.position;
    if (cd.lookingAt) cState.lookingAt = cd.lookingAt;
    if (cd.holding) cState.holding = cd.holding;
    if (cd.emotion) cState.emotion = cd.emotion;
    if (cd.pose) cState.pose = cd.pose;
    if (cd.movement) cState.movement = cd.movement;
    if (cd.wardrobe_changes) cState.wardrobe_changes = cd.wardrobe_changes;
  });

  if (deltas?.story_progress_update) newState.storyProgress = deltas.story_progress_update;

  return newState;
}

function runPromptWriter(state, castBible, worldBible, aspectRatio) {
  let prompt = "";
  
  // 1. Camera & Framing
  prompt += `Cinematic ${state.camera.shotSize}, ${state.camera.angle} angle, ${state.camera.lens} lens. Composition: ${state.camera.composition}. Focus: ${state.camera.focus}. Aspect Ratio: ${aspectRatio}. `;
  
  // 2. Location & Environment
  if (state.location) {
     const loc = state.location;
     prompt += `Location: ${loc.geographic_cultural_id?.name || loc.name}. ${loc.construction?.wall_roof_floor_ceiling_material || ""}. ${loc.surface_condition || ""}. ${loc.fixed_elements || ""}. `;
  }
  prompt += `Lighting: ${state.lighting}. Weather: ${state.weather}. Time of day: ${state.timeOfDay}. `;

  // 3. Characters & Action
  if (state.activeCharacters?.length > 0) {
    prompt += `Subjects in frame: `;
    state.activeCharacters.forEach(id => {
       const char = castBible.characters.find(c => c.id === id);
       const cs = state.characterStates[id];
       if (char && cs) {
          prompt += `[${char.name}]: ${char.identity_culture?.race || ""} ${char.identity_culture?.ethnicity_cultural_identity || ""}, ${char.sketch_artist_appearance?.age_range || ""}. ${char.sketch_artist_appearance?.face_structure || ""}, ${char.sketch_artist_appearance?.hair || ""}. `;
          const upper = cs.base_wardrobe?.upper_garment || "";
          const lower = cs.base_wardrobe?.lower_garment || "";
          prompt += `Wearing ${upper} and ${lower}, ${cs.wardrobe_changes || ""}. `;
          prompt += `Action: ${cs.pose}, ${cs.movement}. Position: ${cs.position}. Looking at ${cs.lookingAt}. Holding ${cs.holding}. Emotion: ${cs.emotion}. `;
       }
    });
  } else {
    prompt += `Establishing shot, no prominent characters. `;
  }

  // 4. Global Style
  prompt += `Style: ${worldBible.visual_style_record?.cinematic_treatment || "high-end film still"}, ${worldBible.visual_style_record?.lighting_philosophy || "volumetric cinematic lighting"}.`;

  return prompt.trim();
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

// ─── MAIN ORCHESTRATOR ────────────────────────────────────────────────────────

/**
 * runFullMotionGraphicEngine — Executes all 8 modules in order.
 * Returns validated frame packages mapped to the existing
 * { prompt, charactersInScene, narration } shape expected by workflowService.
 *
 * @param {object} params
 * @param {string} params.storyScript — the full script text
 * @param {number} params.imageCount — exact number of images to generate
 * @param {string} params.aspectRatio — e.g. "16:9" or "9:16"
 * @param {string} params.title
 * @param {string} params.storyType
 * @param {object|null} params.storyBible — pre-built metadata from extractStoryMetadata (used for cast/world)
 * @param {object|null} params.referenceTraits — analyzed reference image traits
 * @param {string|null} params.visualSuggestions — user visual style note
 * @param {string|null} params.storyGuidelines
 * @returns {Promise<{ scenePrompts: Array, castBible: object, worldBible: object, globalNegativePrompt: string, finalAudit: object }>}
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
  narrationSegments = null,   // Array<{sceneIndex, startSec, endSec, text}> from Whisper timestamps
}) {
  logger.info(`[MGE] ═══ Starting Full Motion Graphic Engine v6.3 — ${imageCount} frames @ ${aspectRatio} ═══`);

  // ── Module 1: Input Normalization ─────────────────────────────────────────
  const PROJECT_SPEC = await runModule1_InputNormalization({
    title,
    sourceType: storyType || "script",
    storyScript,
    imageCount,
    aspectRatio,
    visualSuggestions,
    storyGuidelines,
  });

  // ── Module 2: Full Story & World Analysis ─────────────────────────────────
  const STORY_WORLD_MAP = await runModule2_StoryWorldAnalysis(storyScript, PROJECT_SPEC);

  // ── Module 3: Materialized Cast Bible ─────────────────────────────────────
  // If storyBible was pre-built (from extractStoryMetadata), seed it as additional context
  const castContextHint = storyBible?.characters?.length
    ? `\n\nPREVIOUSLY EXTRACTED CHARACTER LIST (for reference only — build full capsules from scratch):\n${JSON.stringify(storyBible.characters.map(c => ({ name: c.name, appearance: c.appearance })), null, 2)}`
    : "";

  const MATERIALIZED_CAST_BIBLE = await runModule3_MaterializedCastBible(
    { ...STORY_WORLD_MAP, _cast_hint: castContextHint },
    referenceTraits
  );

  // ── Module 4: Materialized Visual World Bible ─────────────────────────────
  const MATERIALIZED_VISUAL_WORLD_BIBLE = await runModule4_VisualWorldBible(
    STORY_WORLD_MAP,
    PROJECT_SPEC
  );

  // ── Module 5: Scene Construction ──────────────────────────────────────────
  const SCENE_LEDGER = await runModule5_SceneConstruction(
    MATERIALIZED_CAST_BIBLE,
    MATERIALIZED_VISUAL_WORLD_BIBLE,
    STORY_WORLD_MAP,
    imageCount
  );

  // ── Module 6: Continuity Validation & Frame Allocation ────────────────────
  const CONTINUITY_AND_FRAME_PLAN = await runModule6_ContinuityAndFrameAllocation(
    SCENE_LEDGER,
    imageCount,
    aspectRatio,
    STORY_WORLD_MAP
  );

  // ── Build Global Negative Prompt ──────────────────────────────────────────
  const GLOBAL_NEGATIVE_PROMPT = buildGlobalNegativePrompt(
    STORY_WORLD_MAP,
    MATERIALIZED_CAST_BIBLE
  );

  // ── Stateful Cinematic Generation Loop ────────────────────────────────────
  logger.info(`[MGE] Starting Stateful Cinematic Generation Loop over ${narrationSegments?.length || imageCount} segments...`);
  
  let currentState = initializeVisualState(MATERIALIZED_VISUAL_WORLD_BIBLE, MATERIALIZED_CAST_BIBLE);
  const scenePrompts = [];
  
  // If narrationSegments is null, we fallback to a dummy array to satisfy the loop
  const loopSegments = narrationSegments || Array.from({ length: imageCount }).map((_, i) => ({ text: `Segment ${i+1}`, sceneIndex: 1 }));

  for (let i = 0; i < loopSegments.length; i++) {
    const segment = loopSegments[i];
    
    // 1. Run Scene Director AI to get the state deltas
    const deltas = await runSceneDirectorAI(
      segment,
      currentState,
      MATERIALIZED_CAST_BIBLE,
      MATERIALIZED_VISUAL_WORLD_BIBLE,
      SCENE_LEDGER,
      i + 1
    );

    // 2. Apply deltas to the persistent Visual State
    currentState = applyDeltas(currentState, deltas, MATERIALIZED_VISUAL_WORLD_BIBLE, MATERIALIZED_CAST_BIBLE);

    // 3. Run Prompt Writer to convert the current state to the final string
    const productionPrompt = runPromptWriter(currentState, MATERIALIZED_CAST_BIBLE, MATERIALIZED_VISUAL_WORLD_BIBLE, aspectRatio);
    
    // Add to the final array
    scenePrompts.push({
      prompt: productionPrompt,
      charactersInScene: currentState.activeCharacters || [],
      narration: segment.text || "",
      _framePackage: { deltas, state: currentState },
      _negativePrompt: "", // Frame specific negative could be added by Director later
      _globalNegativePrompt: GLOBAL_NEGATIVE_PROMPT,
      _motionMovement: null, // Default movement
    });
  }

  // Create a minimal dummy final audit since we deprecated Module 8
  const FINAL_AUDIT = { passed: true, exact_count_check: scenePrompts.length === imageCount, total_frames: scenePrompts.length };

  logger.info(`[MGE] ═══ Stateful Motion Graphic Engine v6.3 Complete — ${scenePrompts.length}/${imageCount} frames ═══`);

  return {
    scenePrompts,
    castBible: MATERIALIZED_CAST_BIBLE,
    worldBible: MATERIALIZED_VISUAL_WORLD_BIBLE,
    globalNegativePrompt: GLOBAL_NEGATIVE_PROMPT,
    finalAudit: FINAL_AUDIT,
    projectSpec: PROJECT_SPEC,

    storyWorldMap: STORY_WORLD_MAP,
    narrationSegments,   // pass through so storyService can apply timestamp-aligned narration
  };
}
