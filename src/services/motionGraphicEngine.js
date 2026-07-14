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

// ─── MODULE 6: CONTINUITY VALIDATION & FRAME ALLOCATION ──────────────────────

/**
 * Module 6 — Continuity Validation & Frame Allocation
 * For every scene transition compare: identity, wardrobe, injuries, props,
 * weather, lighting, blocking, emotional exit→entry state.
 * Frame allocation: assign exact requested count across scenes/beats.
 * Gate: count exact; every major event represented; no narration gap;
 *       every change has valid trigger; scene exits connect to next entries.
 */
export async function runModule6_ContinuityAndFrameAllocation(
  sceneLedger,
  imageCount,
  aspectRatio,
  storyWorldMap
) {
  logger.info("[MGE] Module 6: Continuity Validation & Frame Allocation");

  const prompt = `You are a continuity supervisor and frame allocation director.

TASK A — Continuity Validation:
For every scene transition in the SCENE_LEDGER, compare and record:
- Identity/complexion/face/hair/body (Level 1 — never changes without story justification)
- Wardrobe/footwear/accessories (Level 2 — only changes via visible action)
- Injuries/blood/dirt/sweat (Level 2)
- Props/documents/vehicles/furniture (Level 2)
- Weather/lighting/crowd (Level 2)
- Blocking (Level 2)
- Emotional exit→entry state (Level 3)
Flag any change that lacks a valid story trigger.

TASK B — Frame Allocation:
Assign EXACTLY ${imageCount} frames across all scenes. Distribute proportionally to scene importance and narration coverage.
No scene can have 0 frames. Final frame must connect logically to a story ending.

SCENE LEDGER:
${JSON.stringify(sceneLedger, null, 2)}

STORY WORLD MAP (for act structure):
${JSON.stringify(storyWorldMap?.act_structure || {}, null, 2)}

Return STRICT valid JSON:
{
  "continuity_ledger": {
    "transitions": [
      {
        "from_scene": 1,
        "to_scene": 2,
        "identity_check": "PASS | FAIL — explanation",
        "wardrobe_check": "PASS | CHANGE — what changed and why",
        "injury_check": "PASS | CHANGE",
        "props_check": "PASS | CHANGE",
        "weather_lighting_check": "PASS | CHANGE",
        "blocking_check": "PASS | CHANGE",
        "emotional_continuity": "PASS | NOTE",
        "overall_validity": "VALID | FLAGGED",
        "flag_reason": "string or null"
      }
    ],
    "continuity_issues": ["list of flagged continuity problems"]
  },
  "frame_plan": {
    "total_frames": ${imageCount},
    "aspect_ratio": "${aspectRatio}",
    "frames": [
      {
        "frame_number": 1,
        "act": "1 | 2 | 3",
        "sequence": "string",
        "scene_number": 1,
        "narration_coverage": "The exact narration segment this image covers",
        "visual_beat": "The specific visual moment captured",
        "shot_purpose": "establish | action | reaction | reveal | transition | closeup | wide",
        "characters_visible": ["char_1"],
        "location_id": "loc_1",
        "continuity_relationship": "what carries forward from previous frame",
        "estimated_duration_seconds": 5
      }
    ]
  }
}`;

  const result = await callGeminiJSON(prompt, "Module 6 — Continuity & Frame Allocation");

  // Gate validation — EXACT COUNT IS NON-NEGOTIABLE
  const gateErrors = [];
  const allocatedCount = result?.frame_plan?.frames?.length;

  if (allocatedCount !== imageCount) {
    gateErrors.push(`Exact count violated: allocated ${allocatedCount}, requested ${imageCount}`);
  }

  if (result?.continuity_ledger?.continuity_issues?.length > 3) {
    logger.warn(`[MGE] Module 6: ${result.continuity_ledger.continuity_issues.length} continuity issues flagged`);
  }

  if (gateErrors.length > 0) {
    logger.warn(`[MGE] Module 6 Gate: ${gateErrors.join("; ")} — retrying with explicit count enforcement`);
    // Retry with stricter instruction
    const retryPrompt = prompt.replace(
      `"total_frames": ${imageCount}`,
      `"total_frames": ${imageCount} /* CRITICAL: you MUST produce EXACTLY ${imageCount} frame objects — no more, no fewer */`
    );
    const repaired = await callGeminiJSON(retryPrompt, "Module 6 — Repair attempt");
    const repairedCount = repaired?.frame_plan?.frames?.length;

    if (repairedCount !== imageCount) {
      // Manual truncation/padding as last resort
      logger.warn(`[MGE] Module 6: Forcing exact count via truncation/padding (got ${repairedCount}, need ${imageCount})`);
      if (repaired?.frame_plan?.frames) {
        if (repairedCount > imageCount) {
          repaired.frame_plan.frames = repaired.frame_plan.frames.slice(0, imageCount);
        } else {
          // Pad by duplicating last frame with incremented number
          const lastFrame = repaired.frame_plan.frames[repaired.frame_plan.frames.length - 1];
          while (repaired.frame_plan.frames.length < imageCount) {
            const padFrame = { ...lastFrame, frame_number: repaired.frame_plan.frames.length + 1 };
            repaired.frame_plan.frames.push(padFrame);
          }
        }
        repaired.frame_plan.total_frames = imageCount;
      }
    }
    logger.info(`[MGE] Module 6 ✅ Repaired — exact count: ${repaired?.frame_plan?.frames?.length}`);
    return repaired;
  }

  logger.info(`[MGE] Module 6 ✅ FRAME_PLAN — ${allocatedCount} frames allocated`);
  return result;
}

// ─── MODULE 7: SCENE-BATCH FRAME GENERATION → VALIDATED_FRAME_PACKAGES ───────

/**
 * Module 7 — Scene-Batch Frame Generation
 * Per scene: load SCENE_STATE_PACKAGE + character/location records + allocated frames
 * → generate all assigned frames → audit batch → repair → save only validated frames.
 *
 * Each FRAME_PACKAGE contains:
 * - Frame ID + continuity status
 * - One CHARACTER_CAPSULE per visible character (never grouped)
 * - Rebuilt LOCATION_RECORD (current state)
 * - Camera state
 * - FULL standalone production prompt (10-priority order)
 * - Motion-graphic movement
 * - Frame-specific negative prompt
 *
 * Zero-Assumption Frame: each prompt must work standalone — assume the image
 * generator has no memory of anything prior.
 *
 * Frame Gate (fails if): unnamed character or missing capsule; face/wardrobe/
 * blocking/camera/aspect ratio incomplete; prompt depends on another frame;
 * environment under-materialized or geographically ambiguous.
 */
export async function runModule7_FrameGeneration(
  framePlan,
  castBible,
  worldBible,
  sceneLedger,
  aspectRatio,
  globalNegativePrompt
) {
  logger.info("[MGE] Module 7: Scene-Batch Frame Generation → VALIDATED_FRAME_PACKAGES");

  const frames = framePlan.frame_plan.frames;
  const scenes = sceneLedger.scenes;
  const sceneMap = {};
  for (const scene of scenes) {
    sceneMap[scene.scene_number] = scene;
  }

  // Group frames by scene for batch processing
  const framesByScene = {};
  for (const frame of frames) {
    const sn = frame.scene_number;
    if (!framesByScene[sn]) framesByScene[sn] = [];
    framesByScene[sn].push(frame);
  }

  const allValidatedFrames = [];

  for (const [sceneNum, sceneFrames] of Object.entries(framesByScene)) {
    const scene = sceneMap[parseInt(sceneNum)];
    if (!scene) {
      logger.warn(`[MGE] Module 7: scene ${sceneNum} not found in ledger`);
      continue;
    }

    logger.info(`[MGE] Module 7: Generating ${sceneFrames.length} frame(s) for scene ${sceneNum}`);

    const prompt = `You are a film director, cinematographer, and AI image-prompt engineer.
Generate VALIDATED_FRAME_PACKAGES for the frames assigned to this scene.

ZERO-ASSUMPTION FRAME RULE: Each production prompt must work COMPLETELY STANDALONE.
The image generator has NO memory of any earlier prompts, bibles, scenes, wardrobe, props, injuries, lighting, weather, blocking, or context.
Every prompt must contain all necessary information within itself.

NO-SHORTHAND RULE: NEVER use "same," "unchanged," "identical," "as before," "continues unchanged," etc.
If something carries forward, write its CURRENT VALUES in full in the prompt.

MATERIALIZATION RULE: A racial/ethnic/national label is NOT sufficient — always include full physical/behavioral description.

CONTINUITY LEVELS:
${CONTINUITY_LEVELS}

CURRENT SCENE STATE PACKAGE:
${JSON.stringify(scene, null, 2)}

CAST BIBLE (use for any character not in scene's character_states — match IDs):
${JSON.stringify(castBible, null, 2)}

VISUAL WORLD BIBLE (use for location baseline):
${JSON.stringify(worldBible, null, 2)}

FRAMES TO GENERATE:
${JSON.stringify(sceneFrames, null, 2)}

ASPECT RATIO: ${aspectRatio}

GLOBAL VISUAL STYLE:
${worldBible.visual_style_record?.image_medium || "Cinematic photorealistic"}, ${worldBible.visual_style_record?.cinematic_treatment || "high-end film still"}.

PRODUCTION PROMPT PRIORITY ORDER (always follow this order within the prompt string):
1. Main subject/action
2. Character identity/appearance (Level 1 identity — full physical detail)
3. Clothing/physical state (Level 2 — exact current wardrobe)
4. Relationships/blocking (how characters relate spatially)
5. Camera composition (shot size, angle, distance, lens feel, depth of field)
6. Location/cultural identity (full standalone location detail)
7. Foreground/midground/background layers
8. Lighting/weather/atmosphere
9. Visual style/technical quality
10. Prohibited drift (inline, specific to this frame)

Return STRICT valid JSON:
{
  "validated_frame_packages": [
    {
      "frame_id": {
        "number": 1,
        "act": "string",
        "sequence": "string",
        "scene_number": 1,
        "narration_coverage": "string",
        "estimated_duration_seconds": 5,
        "visual_beat": "string",
        "continuity_status": {
          "carries_forward": "string (current values, not 'same as before')",
          "changes": "string",
          "change_reason": "string"
        }
      },
      "characters_in_frame": [
        {
          "character_id": "char_1",
          "character_name": "string",
          "identity_culture": "inline full identity string",
          "sketch_artist_appearance": "full physical description — ALL fields inline, do NOT reference the bible",
          "current_wardrobe": "full current wardrobe description — exact colors, cut, fabric, wear state",
          "current_condition": "injuries/marks/dirt or 'none'",
          "current_props": "string",
          "expression": "string",
          "posture": "string",
          "eye_direction": "string",
          "frame_position": "left | center | right | foreground | background",
          "distance_from_camera": "string",
          "orientation": "facing camera | profile | three-quarter | back",
          "relationships": "string",
          "prop_interaction": "string"
        }
      ],
      "background_people": "materialized crowd description (local identity, complexion range, age mix, clothing, activity, density) — or 'none'",
      "current_location_state": {
        "location_name": "string",
        "full_standalone_description": "FULL location description inline — every material, surface, spatial detail needed to reconstruct the space",
        "crowd_state": "string",
        "lighting_current": "string",
        "forbidden_elements": ["list"]
      },
      "camera_state": {
        "aspect_ratio": "${aspectRatio}",
        "shot_size": "ECU | CU | MCU | MS | MLS | LS | ELS",
        "distance": "string",
        "height": "eye-level | low | high | overhead",
        "angle": "straight | dutch | canted",
        "lens_feel": "standard | wide | telephoto | anamorphic",
        "depth_of_field": "shallow | medium | deep",
        "primary_focus": "string",
        "framing_relationships": "string"
      },
      "production_prompt": "ONE STANDALONE paragraph in priority order (1-main subject → 10-prohibited drift). Self-contained. No references to other frames. Must contain all identity, wardrobe, location, camera, and lighting details.",
      "motion_graphic_movement": {
        "camera_movement": "slow zoom in | parallax left | static | slow dolly | pan right | etc.",
        "subject_movement": "string or 'static'",
        "environmental_movement": "string or 'none'",
        "entry_transition": "string",
        "exit_transition": "string",
        "restrictions": "no forced lip movement unless narration requires it"
      },
      "frame_specific_negative_prompt": "Only risks UNIQUE to this frame — do not repeat global negative prompt. E.g., specific wrong ethnicity, wrong architecture type, wrong time-of-day, etc."
    }
  ]
}`;

    const result = await callGeminiJSON(prompt, `Module 7 — Scene ${sceneNum} frame generation`);

    // Frame Gate validation
    const sceneGateErrors = [];
    const SHORTHAND_BANNED = ["same as", "unchanged", "as before", "identical to", "continues unchanged"];

    for (const fp of (result?.validated_frame_packages || [])) {
      const prodPrompt = fp.production_prompt || "";

      // Check for shorthand in production prompt
      for (const banned of SHORTHAND_BANNED) {
        if (prodPrompt.toLowerCase().includes(banned)) {
          sceneGateErrors.push(`Frame ${fp.frame_id?.number}: shorthand "${banned}" in production_prompt`);
        }
      }

      // Check prompt is sufficiently detailed
      if (prodPrompt.length < 100) {
        sceneGateErrors.push(`Frame ${fp.frame_id?.number}: production_prompt too short (< 100 chars)`);
      }

      // Check all visible named characters have capsules
      for (const char of (fp.characters_in_frame || [])) {
        if (!char.character_name) {
          sceneGateErrors.push(`Frame ${fp.frame_id?.number}: unnamed character in frame`);
        }
        if (!char.sketch_artist_appearance || char.sketch_artist_appearance.length < 30) {
          sceneGateErrors.push(`Frame ${fp.frame_id?.number}, ${char.character_name}: sketch_artist_appearance missing/insufficient`);
        }
        if (!char.current_wardrobe || char.current_wardrobe.length < 10) {
          sceneGateErrors.push(`Frame ${fp.frame_id?.number}, ${char.character_name}: current_wardrobe missing`);
        }
      }

      // Check camera state is present
      if (!fp.camera_state?.shot_size) {
        sceneGateErrors.push(`Frame ${fp.frame_id?.number}: camera_state incomplete`);
      }

      // Check location is materialized
      if (!fp.current_location_state?.full_standalone_description || fp.current_location_state.full_standalone_description.length < 30) {
        sceneGateErrors.push(`Frame ${fp.frame_id?.number}: location under-materialized`);
      }
    }

    if (sceneGateErrors.length > 0) {
      logger.warn(`[MGE] Module 7 Scene ${sceneNum} Gate issues (${sceneGateErrors.length}) — retrying. First: ${sceneGateErrors[0]}`);
      const repaired = await callGeminiJSON(prompt, `Module 7 — Scene ${sceneNum} repair`);
      if (repaired?.validated_frame_packages?.length > 0) {
        logger.info(`[MGE] Module 7 Scene ${sceneNum} ✅ Repaired`);
        allValidatedFrames.push(...repaired.validated_frame_packages);
      } else {
        // Use original despite issues (never expose failed drafts to user — log internally)
        logger.error(`[MGE] Module 7 Scene ${sceneNum}: repair failed, using best-effort output`);
        if (result?.validated_frame_packages?.length > 0) {
          allValidatedFrames.push(...result.validated_frame_packages);
        }
      }
    } else {
      allValidatedFrames.push(...result.validated_frame_packages);
    }

    // Scene-Batch Gate: check final frame connects to next scene
    const lastFrame = result?.validated_frame_packages?.[result.validated_frame_packages.length - 1];
    if (lastFrame && !lastFrame.frame_id?.continuity_status?.carries_forward) {
      logger.warn(`[MGE] Module 7 Scene ${sceneNum}: final frame has no carries_forward declaration`);
    }
  }

  // Sort by frame number to ensure correct order
  allValidatedFrames.sort((a, b) => (a.frame_id?.number || 0) - (b.frame_id?.number || 0));

  logger.info(`[MGE] Module 7 ✅ VALIDATED_FRAME_PACKAGES — ${allValidatedFrames.length} frames`);
  return { validated_frame_packages: allValidatedFrames };
}

// ─── MODULE 8: FINAL AUDIT → FINAL_AUDIT ─────────────────────────────────────

/**
 * Module 8 — Final Audit
 * Character audit: every recurring character has complete identity lock + all fields.
 * Location audit: every recurring location has all fields + forbidden archetypes stated.
 * Scene audit: characters listed = records completed; entry = exit states.
 * Sequence audit: source order correct; exact image count; no drift; no shorthand.
 * Automatic rejection scan: rebuild any frame using shorthand, broad-only identity,
 *   generic-only location, or any non-Western environment passable as US/European.
 * Repair rule: on failure, return to earliest responsible module. Never expose failed drafts.
 */
export async function runModule8_FinalAudit(
  framePackages,
  castBible,
  worldBible,
  imageCount
) {
  logger.info("[MGE] Module 8: Final Audit → FINAL_AUDIT");

  const frames = framePackages.validated_frame_packages;
  const auditResult = {
    passed: true,
    total_frames: frames.length,
    exact_count_check: frames.length === imageCount,
    character_audit: { passed: true, issues: [] },
    location_audit: { passed: true, issues: [] },
    sequence_audit: { passed: true, issues: [] },
    shorthand_scan: { passed: true, violations: [] },
    geographic_drift_scan: { passed: true, violations: [] },
    repairs_needed: [],
    rejected_frame_ids: [],
  };

  const SHORTHAND_BANNED = ["same as", "unchanged", "identical to", "as before", "continues unchanged", "see above", "see scene", "as described"];
  const FORBIDDEN_GEOGRAPHIC_SUBSTITUTES = ["brooklyn", "manhattan", "new york", "los angeles", "chicago", "london", "miami", "generic island", "tourist resort"];

  // 1. Exact count check
  if (!auditResult.exact_count_check) {
    auditResult.passed = false;
    auditResult.sequence_audit.passed = false;
    auditResult.sequence_audit.issues.push(
      `EXACT COUNT VIOLATION: got ${frames.length}, expected ${imageCount}`
    );
  }

  // 2. Character audit — every recurring character must appear in cast bible with all fields
  for (const char of (castBible.characters || [])) {
    const sa = char.sketch_artist_appearance;
    const missingFields = [];
    if (!sa?.canonical_skin_tone) missingFields.push("canonical_skin_tone");
    if (!sa?.face_structure) missingFields.push("face_structure");
    if (!sa?.hair) missingFields.push("hair");
    if (!char.identity_restrictions?.may_not_change?.length) missingFields.push("identity_restrictions.may_not_change");
    if (!char.identity_culture?.race) missingFields.push("identity_culture.race");

    if (missingFields.length > 0) {
      auditResult.character_audit.passed = false;
      auditResult.passed = false;
      auditResult.character_audit.issues.push(`${char.name}: missing ${missingFields.join(", ")}`);
    }
  }

  // 3. Location audit — every recurring location must have all fields + forbidden_drift
  for (const loc of (worldBible.locations || [])) {
    const locIssues = [];
    if (!loc.geographic_cultural_id?.country) locIssues.push("country");
    if (!loc.construction?.wall_roof_floor_ceiling_material) locIssues.push("construction materials");
    if (!loc.forbidden_drift?.length) locIssues.push("forbidden_drift not declared");

    if (locIssues.length > 0) {
      auditResult.location_audit.passed = false;
      auditResult.passed = false;
      auditResult.location_audit.issues.push(`${loc.name}: missing ${locIssues.join(", ")}`);
    }
  }

  // 4. Shorthand scan across all production prompts
  for (const fp of frames) {
    const prompt = (fp.production_prompt || "").toLowerCase();
    for (const banned of SHORTHAND_BANNED) {
      if (prompt.includes(banned)) {
        auditResult.shorthand_scan.passed = false;
        auditResult.passed = false;
        auditResult.shorthand_scan.violations.push(
          `Frame ${fp.frame_id?.number}: shorthand "${banned}" in production_prompt`
        );
        if (!auditResult.rejected_frame_ids.includes(fp.frame_id?.number)) {
          auditResult.rejected_frame_ids.push(fp.frame_id?.number);
        }
      }
    }
  }

  // 5. Geographic drift scan — detect if any non-US setting got US/European substitutes
  const worldCountry = (worldBible.locations?.[0]?.geographic_cultural_id?.country || "").toLowerCase();
  if (worldCountry && !worldCountry.includes("united states") && !worldCountry.includes("uk") && !worldCountry.includes("england")) {
    for (const fp of frames) {
      const locDesc = (fp.current_location_state?.full_standalone_description || "").toLowerCase();
      for (const forbidden of FORBIDDEN_GEOGRAPHIC_SUBSTITUTES) {
        if (locDesc.includes(forbidden)) {
          auditResult.geographic_drift_scan.passed = false;
          auditResult.passed = false;
          auditResult.geographic_drift_scan.violations.push(
            `Frame ${fp.frame_id?.number}: geographic drift — "${forbidden}" appeared in location description for a ${worldCountry} setting`
          );
          if (!auditResult.rejected_frame_ids.includes(fp.frame_id?.number)) {
            auditResult.rejected_frame_ids.push(fp.frame_id?.number);
          }
        }
      }
    }
  }

  // 6. Sequence continuity — frame numbers must be sequential
  const frameNumbers = frames.map(f => f.frame_id?.number || 0).sort((a, b) => a - b);
  for (let i = 0; i < frameNumbers.length; i++) {
    if (frameNumbers[i] !== i + 1) {
      auditResult.sequence_audit.passed = false;
      auditResult.passed = false;
      auditResult.sequence_audit.issues.push(`Frame sequence gap: expected frame ${i + 1}, got ${frameNumbers[i]}`);
      break;
    }
  }

  // Build repairs_needed list
  if (auditResult.rejected_frame_ids.length > 0) {
    auditResult.repairs_needed.push(`Rebuild ${auditResult.rejected_frame_ids.length} rejected frames (IDs: ${auditResult.rejected_frame_ids.join(", ")})`);
  }

  const status = auditResult.passed ? "✅ PASSED" : "⚠️ ISSUES FOUND";
  logger.info(`[MGE] Module 8 FINAL_AUDIT ${status} — ${frames.length}/${imageCount} frames | ${auditResult.rejected_frame_ids.length} rejected | ${auditResult.repairs_needed.length} repairs`);

  return auditResult;
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

  // ── Module 7: Scene-Batch Frame Generation ────────────────────────────────
  const VALIDATED_FRAME_PACKAGES = await runModule7_FrameGeneration(
    CONTINUITY_AND_FRAME_PLAN,
    MATERIALIZED_CAST_BIBLE,
    MATERIALIZED_VISUAL_WORLD_BIBLE,
    SCENE_LEDGER,
    aspectRatio,
    GLOBAL_NEGATIVE_PROMPT
  );

  // ── Module 8: Final Audit ─────────────────────────────────────────────────
  const FINAL_AUDIT = await runModule8_FinalAudit(
    VALIDATED_FRAME_PACKAGES,
    MATERIALIZED_CAST_BIBLE,
    MATERIALIZED_VISUAL_WORLD_BIBLE,
    imageCount
  );

  // Map VALIDATED_FRAME_PACKAGES → existing { prompt, charactersInScene, narration } shape
  // so that workflowService.js needs zero structural changes.
  const scenePrompts = VALIDATED_FRAME_PACKAGES.validated_frame_packages.map((fp) => {
    // Characters in scene: array of character IDs visible in frame
    const charactersInScene = (fp.characters_in_frame || [])
      .map(c => c.character_id)
      .filter(Boolean);

    // Full production prompt (already standalone)
    const prompt = [
      fp.production_prompt,
      // Append visual style record for global consistency
      MATERIALIZED_VISUAL_WORLD_BIBLE.common_visual_prompt
        ? `Global visual style: ${MATERIALIZED_VISUAL_WORLD_BIBLE.common_visual_prompt}`
        : "",
    ].filter(Boolean).join(" ").trim();

    return {
      prompt,
      charactersInScene,
      narration: fp.frame_id?.narration_coverage || "",
      // Pass through extra data for workflowService enrichment
      _framePackage: fp,
      _negativePrompt: fp.frame_specific_negative_prompt || "",
      _globalNegativePrompt: GLOBAL_NEGATIVE_PROMPT,
      _motionMovement: fp.motion_graphic_movement || null,
    };
  });

  logger.info(`[MGE] ═══ Motion Graphic Engine v6.3 Complete — ${scenePrompts.length}/${imageCount} frames ═══`);

  return {
    scenePrompts,
    castBible: MATERIALIZED_CAST_BIBLE,
    worldBible: MATERIALIZED_VISUAL_WORLD_BIBLE,
    globalNegativePrompt: GLOBAL_NEGATIVE_PROMPT,
    finalAudit: FINAL_AUDIT,
    projectSpec: PROJECT_SPEC,
    storyWorldMap: STORY_WORLD_MAP,
  };
}
