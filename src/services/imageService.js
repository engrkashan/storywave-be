/**
 * imageService.js — Storywave Image Generation Pipeline
 *
 * Provider chain (in priority order):
 *   Tier 1: Gemini Pro Image   (config.ai.image.primaryModel)  — multimodal, best quality
 *   Tier 2: Gemini Flash Image (config.ai.image.fallbackModel) — fallback on quota/timeout/server error
 *
 * Safety Violations trigger intelligent LLM-based prompt repair (up to MAX_SAFETY_REPAIRS attempts)
 * before the scene is declared failed. Image reuse / adjacent-frame duplication is NEVER performed.
 *
 * Every generation attempt is logged in a per-scene PromptDebugReport.
 */

import fs from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { config } from "../config/workflow.config.js";
import { createLogger } from "../utils/logger.js";
import { withExponentialBackoff } from "../utils/retry.js";

// OpenAI client — used as fallback for prompt repair when Gemini repair model is unavailable
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const logger = createLogger("ImageService");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  timeout: 180000, // 180 s — high-res generation can be slow
});

// ─── Model IDs come from config — never hardcoded here ───────────────────────
const MODELS = {
  PRO: config.ai.image.primaryModel,  // Tier 1
  FLASH: config.ai.image.fallbackModel, // Tier 2 — fallback only
};

const MAX_SAFETY_REPAIRS = 3; // Max LLM prompt-repair cycles before failing a scene

/* --------------------------------------------------
   UTILS
-------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

/* --------------------------------------------------
   CHARACTER REF: Fetch remote image → base64 for Gemini multimodal
-------------------------------------------------- */
async function fetchImageAsBase64(url) {
  // Already a base64 data URL from the frontend — parse directly
  if (url.startsWith("data:image")) {
    const match = url.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (match) {
      return { mimeType: match[1], base64: match[2] };
    }
  }
  // Cloudinary / remote URL
  const { default: fetch } = await import("node-fetch");
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to fetch character reference: ${response.statusText}`);
  const buffer = await response.buffer();
  const mimeType = response.headers.get("content-type") || "image/jpeg";
  return { base64: buffer.toString("base64"), mimeType };
}

/* --------------------------------------------------
   STRUCTURED ERROR CLASSIFICATION
   Each error type maps to a specific handling strategy:
     SAFETY        → intelligent prompt repair → retry
     RATE_LIMIT    → switch to Flash tier
     QUOTA         → switch to Flash tier
     INTERNAL      → retry same model
     PROMPT_TOO_LONG → compress prompt → retry
     INVALID_PROMPT  → repair prompt → retry
     UNKNOWN       → retry up to limit, then fail
-------------------------------------------------- */
function classifyGeminiError(err) {
  const msg = (err.message || "").toLowerCase();

  if (
    msg.includes("safety") ||
    msg.includes("blocked") ||
    msg.includes("policy") ||
    msg.includes("prohibited") ||
    msg.includes("harmful") ||
    msg.includes("inappropriate") ||
    msg.includes("finish_reason: safety") ||
    msg.includes("content_filter")
  ) {
    return "SAFETY";
  }
  if (msg.includes("429") || msg.includes("too many requests") || msg.includes("rate limit")) {
    return "RATE_LIMIT";
  }
  if (msg.includes("quota") || msg.includes("resource_exhausted")) {
    return "QUOTA";
  }
  if (
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("internal server error") ||
    msg.includes("service unavailable") ||
    msg.includes("econnreset") ||
    msg.includes("timeout") ||
    msg.includes("fetch failed")
  ) {
    return "INTERNAL";
  }
  if (msg.includes("token") || msg.includes("too long") || msg.includes("max_tokens")) {
    return "PROMPT_TOO_LONG";
  }
  if (msg.includes("invalid") || msg.includes("malformed")) {
    return "INVALID_PROMPT";
  }
  return "UNKNOWN";
}

/* --------------------------------------------------
   INTELLIGENT SAFETY PROMPT REPAIR
   Uses a cheap text model to rewrite ONLY the unsafe wording.
   Preserves: location, characters, actions, emotions, continuity.
   Never modifies: narration, scene metadata, frame package, story bible.
   Returns { repairedPrompt, reasoning } or throws on failure.
-------------------------------------------------- */
async function repairSafetyPrompt({
  originalPrompt,
  safetyErrorMessage,
  sceneMeta = {},       // { sceneId, location, environment, characters, action, narration, emotion, camera, storyProgress, negativeGuidance }
  previousScenePrompt = null,
  nextScenePrompt = null,
  attemptNumber = 1,
}) {
  logger.warn(`🔧 [PromptRepair] Scene ${sceneMeta.sceneId} — Safety repair attempt #${attemptNumber}`);

  const systemInstruction = `You are a cinematic image prompt editor for a storytelling platform.

A generated image prompt was rejected by the AI image generator due to a safety policy violation.

YOUR TASK:
Rewrite ONLY the words or phrases that likely triggered the safety filter.

STRICT RULES:
1. PRESERVE the exact same scene: location, characters, emotions, actions, camera framing.
2. DO NOT simplify the scene or remove dramatic tension.
3. DO NOT shorten the prompt unnecessarily.
4. DO NOT change the story progression or character identity.
5. DO NOT alter the narration, scene metadata, or story bible — you only rewrite the production_prompt string.
6. Replace violent or graphic language with cinematic equivalents (e.g. "tense confrontation" instead of "fighting").
7. Replace explicit content with tasteful alternatives.
8. Replace copyrighted terms with descriptive equivalents.
9. The repaired prompt must be semantically identical while being Gemini-policy compliant.
10. Return ONLY a JSON object: { "repairedPrompt": "...", "reasoning": "what you changed and why" }`;

  const userMessage = `
ORIGINAL PROMPT (rejected):
${originalPrompt}

SAFETY ERROR:
${safetyErrorMessage}

SCENE METADATA (immutable — do not change these values, only use them as guidance):
${JSON.stringify(sceneMeta, null, 2)}

${previousScenePrompt ? `PREVIOUS SCENE PROMPT (for continuity reference):\n${previousScenePrompt}\n` : ""}
${nextScenePrompt ? `NEXT SCENE PROMPT (for continuity reference):\n${nextScenePrompt}\n` : ""}

INSTRUCTION: Rewrite ONLY the unsafe wording in the original prompt. Return { "repairedPrompt": "...", "reasoning": "..." }`;

  // ── Try Gemini repair model first ───────────────────────────────────────
  let parsed = null;
  try {
    const geminiResponse = await ai.models.generateContent({
      model: config.ai.image.repairModel,
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const rawGemini = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const cleanedGemini = rawGemini.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(cleanedGemini);
    if (!parsed.repairedPrompt) throw new Error("Gemini repair returned empty repairedPrompt");
    logger.info(`🔧 [PromptRepair/Gemini] Scene ${sceneMeta.sceneId} v${attemptNumber + 1} — ${parsed.reasoning}`);
  } catch (geminiRepairErr) {
    // ── Gemini repair model unavailable — fall back to OpenAI ────────────
    logger.warn(`⚠️ [PromptRepair] Gemini repair failed (${geminiRepairErr.message}). Falling back to OpenAI...`);

    if (!openai) {
      throw new Error(`Prompt repair failed: Gemini unavailable and OPENAI_API_KEY not set. Original error: ${geminiRepairErr.message}`);
    }

    const openaiModel = process.env.OPENAI_REPAIR_MODEL || config.ai.image.openaiRepairModel || "gpt-5.6";
    logger.info(`🔧 [PromptRepair/OpenAI] Scene ${sceneMeta.sceneId} — Using ${openaiModel}`);

    const openaiResponse = await openai.chat.completions.create({
      model: openaiModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userMessage },
      ],

      max_tokens: 2048,
    });

    const rawOpenAI = openaiResponse.choices?.[0]?.message?.content || "{}";
    parsed = JSON.parse(rawOpenAI);
    if (!parsed.repairedPrompt) throw new Error("OpenAI repair returned empty repairedPrompt");
    logger.info(`🔧 [PromptRepair/OpenAI] Scene ${sceneMeta.sceneId} v${attemptNumber + 1} — ${parsed.reasoning}`);
  }

  return parsed;
}

/* --------------------------------------------------
   PRE-FLIGHT PROMPT VALIDATION
   Validates before any Gemini API call. Repairs issues inline.
   Returns { valid: boolean, issues: string[] }
-------------------------------------------------- */
function validatePrompt(prompt, sceneMeta = {}) {
  const issues = [];

  if (!prompt || prompt.trim().length < 20) issues.push("Prompt is too short or empty");
  if (/same as (previous|before|above)/i.test(prompt)) issues.push("Prompt contains forbidden shorthand 'same as previous'");
  if (/unchanged|identical to/i.test(prompt)) issues.push("Prompt contains forbidden shorthand 'unchanged'");
  if (/\[.*?\]/g.test(prompt) && /\[location\]|\[character\]|\[action\]/i.test(prompt)) issues.push("Prompt contains unresolved template variables");
  if (!sceneMeta.location && !prompt.toLowerCase().includes("location")) issues.push("No location information present");
  if (!sceneMeta.action && prompt.split(" ").length < 30) issues.push("Prompt may be too brief to convey action");

  // Token limit: Gemini handles ~8000 tokens; we cap at ~4000 words as safety margin
  const wordCount = prompt.split(/\s+/).length;
  if (wordCount > 4000) issues.push(`Prompt exceeds safe length (${wordCount} words > 4000 limit)`);

  return { valid: issues.length === 0, issues };
}

/* --------------------------------------------------
   PROMPT BUILDER
   Assembles the final multimodal prompt using professional prompt engineering strategies:
   - Hyper-specific descriptions (not labels — full material/texture/color detail)
   - Context + intent framing so the model understands the PURPOSE of the scene
   - Step-by-step scene decomposition (background → midground → foreground → subject)
   - Camera and cinematic language (shot size, lens feel, depth of field, angle)
   - Semantic negative prompts embedded as affirmative directives ("an empty street with no
     traffic" instead of "no cars")
-------------------------------------------------- */
function buildFinalPrompt({ prompt, commonPrompt, characterTextSection, styleSection, continuityInstructions, sceneMeta = {} }) {
  // Context + intent block: helps the model understand WHY this image is being created
  const intentBlock = [
    sceneMeta.storyProgress ? `STORY CONTEXT: This is ${sceneMeta.storyProgress} of the narrative.` : "",
    sceneMeta.narration ? `NARRATION HEARD BY VIEWER: "${sceneMeta.narration.slice(0, 200)}"` : "",
    sceneMeta.emotion ? `EMOTIONAL BEAT: ${sceneMeta.emotion}` : "",
  ].filter(Boolean).join(" ");

  return [
    `# VISUAL STYLE & INTENT:`,
    commonPrompt || "Cinematic, hyper-realistic, professional photography",
    intentBlock,
    styleSection || "",
    characterTextSection || "",
    "",
    `# SCENE COMPOSITION (step-by-step, background → foreground):`,
    `Step 1 — BACKGROUND: Establish the environment. ${sceneMeta.location ? `The scene takes place in: ${sceneMeta.location}.` : ""} Render full architectural depth, surface textures, and ambient atmosphere.`,
    `Step 2 — MIDGROUND: Place supporting elements, secondary characters or objects that give the scene context and scale.`,
    `Step 3 — FOREGROUND SUBJECT: ${prompt}`,
    "",
    `# CAMERA & LENS:`,
    sceneMeta.camera
      ? `Shot: ${sceneMeta.camera}. Use cinematic depth of field appropriate to this shot size. Control focus to emphasize the primary subject.`
      : "Medium shot, eye-level perspective, anamorphic lens feel, shallow depth of field drawing attention to the primary subject.",
    "",
    `# CONTINUITY & ENVIRONMENT CONSTRAINTS:`,
    continuityInstructions || "Maintain consistent architecture, lighting, and character appearance throughout.",
    "",
    `# TECHNICAL SPECS:`,
    "Photographed on Arri Alexa 65 with anamorphic prime lenses. 8K resolution, razor-sharp focus, volumetric lighting, cinematic color grading, masterpiece quality.",
    "The image must contain absolutely no text, words, letters, numbers, captions, subtitles, watermarks, or logos anywhere in the frame.",
  ].filter(s => s.trim() !== "").join("\n");
}

/* --------------------------------------------------
   CONTINUITY INSTRUCTIONS BUILDER
   Uses SEMANTIC NEGATIVE PROMPTS — affirmative descriptions of the intended state
   rather than prohibition lists. Gemini responds better to affirmative direction.
   Example:  ❌ "No location drift"
             ✅ "The scene takes place inside a wood-paneled federal courtroom with
                elevated judge's bench, American flag, and fluorescent overhead lighting.
                This is an interior space. No outdoor elements, street scenes, or
                natural light sources should appear anywhere in the frame."
-------------------------------------------------- */
function buildContinuityInstructions({ visualState, globalNegativePrompt, frameNegativePrompt }) {
  const lines = [];

  // Environment — describe it fully in the affirmative, then state the exclusion
  if (visualState?.location) {
    lines.push(`ENVIRONMENT: The scene is set inside/at: ${visualState.location}. This is the ONLY valid setting for this image. Render it as a complete, believable space with full depth and atmosphere.`);
  }
  if (visualState?.architecture) {
    lines.push(`ARCHITECTURAL DETAIL: ${visualState.architecture}. Reproduce every surface, texture, and structural element as described. The architecture does not change between frames.`);
  }
  if (visualState?.lighting) {
    lines.push(`LIGHTING LOCK: The light source is ${visualState.lighting}. This specific quality and direction of light must be consistent. Do not introduce new windows, lamps, or outdoor light.`);
  }
  if (visualState?.weather) {
    lines.push(`WEATHER & ATMOSPHERE: ${visualState.weather}. The atmospheric conditions are fixed for this sequence.`);
  }
  if (visualState?.wardrobe) {
    lines.push(`WARDROBE LOCK: Characters are dressed as follows: ${visualState.wardrobe}. Clothing does not change between frames unless the story explicitly describes it changing.`);
  }
  if (visualState?.activeCharacters?.length > 0) {
    lines.push(`CAST: The only people present in this scene are: ${visualState.activeCharacters.join(", ")}. The frame contains exactly these individuals — no additional bystanders, crowds, or unnamed figures unless the scene description requires them.`);
  }

  // HARD IDENTITY LOCK — ALWAYS applied (not conditional on negative prompts).
  // This is the primary guard against face/appearance/wardrobe drift between scenes.
  // Physical identity is immutable across the whole sequence; it may only change
  // when the compiled scene state itself carries a different wardrobe/pose.
  lines.push(
    "IDENTITY LOCK (MANDATORY): Each character's race, ethnicity, skin tone, undertone, " +
    "facial bone structure, nose shape, eye shape and color, hair texture, hair color, " +
    "haircut, facial hair, age, and any permanent marks (scars/tattoos/birthmarks) are FIXED " +
    "attributes. Reproduce them IDENTICALLY to how they appeared in the prior frame. " +
    "Faces are NEVER blended, swapped, or composited with other characters' features."
  );
  lines.push(
    "WARDROBE INTEGRITY (MANDATORY): Do not reassign clothing between characters, introduce " +
    "new outfits, or alter fabric colors, cuts, or fit. A character wears the SAME garments " +
    "frame-to-frame unless this scene's description explicitly states a change."
  );
  lines.push(
    "CONTINUITY DIRECTIVE (MANDATORY): Nothing about a character's face, body, age, hair, or " +
    "clothing may drift between frames. If the previous frame is supplied as a reference, " +
    "the character MUST look like the exact same person wearing the exact same clothes."
  );

  // Convert negative prompt strings into affirmative semantic equivalents
  const negSource = [globalNegativePrompt, frameNegativePrompt].filter(Boolean).join(", ");
  if (negSource) {
    if (/race|ethnicity|complexion/i.test(negSource)) {
      lines.push("IDENTITY LOCK: Each character's race, ethnicity, skin tone, undertone, facial bone structure, nose shape, eye shape, hair texture and color are fixed attributes established earlier. These attributes are immutable. Reproduce them identically.");
    }
    if (/location|geographic|architecture/i.test(negSource)) {
      lines.push("LOCATION INTEGRITY: The architectural language, cultural aesthetic, and geographic identity of this setting are fixed. Do not substitute with any other country's architecture, any generic placeholder, or any tourist-resort aesthetic.");
    }
    if (/wardrobe|clothing/i.test(negSource)) {
      lines.push("WARDROBE INTEGRITY: Do not reassign clothing between characters, introduce new outfits, or alter fabric colors or cuts unless the scene text explicitly describes the change.");
    }
    if (/face swap|identity/i.test(negSource)) {
      lines.push("FACE INTEGRITY: Each character occupies their own distinct visual identity. Faces are not blended, swapped, or composited with features from other characters.");
    }
    if (/age/i.test(negSource)) {
      lines.push("AGE LOCK: Character ages are fixed. Do not make characters appear younger, older, or more/less mature than established.");
    }
  }

  // Universal — always applied
  lines.push("TEXT-FREE FRAME: The image contains absolutely no text, words, letters, numbers, captions, subtitles, watermarks, logos, or printed labels anywhere in the frame — not on signs, clothing, books, screens, or any surface.");

  return lines.join("\n");
}

/* --------------------------------------------------
   SHARED GEMINI IMAGE CALLER
   Single internal function used by both PRO and FLASH tiers.
   Handles: multimodal parts assembly, API call, response parsing, logging.
-------------------------------------------------- */
async function callGeminiImageModel({
  modelId,
  finalPrompt,
  inlineImages,
  prevFrameImage,     // FIX 3: { mimeType, base64 } of the immediately preceding frame, or null
  aspectRatio,
  sceneId,
  attempt,
}) {
  const startMs = Date.now();
  logger.info(`📡 [${modelId}] Scene ${sceneId} — Attempt ${attempt} | CharRefs: ${inlineImages.length} | PrevFrame: ${prevFrameImage ? "yes" : "no"} | PromptLen: ${finalPrompt.length} chars`);

  // Build multimodal parts:
  // Order: prompt text → [optional] prev-frame visual anchor → character reference images
  const parts = [{ text: finalPrompt }];

  // FIX 3: Previous frame image injected as a visual continuity anchor (frame > 0 only)
  if (prevFrameImage) {
    parts.push({
      text: "\n[PREVIOUS FRAME — visual continuity reference]\nThe attached image shows the immediately preceding moment in this story. Continue directly from this exact visual state — same room, same lighting, and same character position unless the narration explicitly describes movement or a scene change.\n"
    });
    parts.push({ inlineData: { mimeType: prevFrameImage.mimeType, data: prevFrameImage.base64 } });
  }

  // Character reference images (identity lock — always after prev-frame anchor)
  for (const inlineImg of inlineImages) {
    const charIdentifier = inlineImg.charName || inlineImg.charId || "Character";
    parts.push({ text: `\n[Reference Image for character: ${charIdentifier}]\n` });
    parts.push({ inlineData: { mimeType: inlineImg.mimeType, data: inlineImg.base64 } });
  }

  if (inlineImages.length > 0) {
    logger.info(`🖼️ [${modelId}] Scene ${sceneId} — ${inlineImages.length} character reference(s) included: ${inlineImages.map(i => i.charName || i.charId).join(", ")}`);
  }

  const response = await ai.models.generateContent({
    model: modelId,
    contents: [{ role: "user", parts }],
    config: {
      generationConfig: {
        candidateCount: 1,
        quality: "pro",
      },
      imageConfig: {
        aspectRatio,
        imageSize: "4K",
        responseMimeType: "image/png",
      },
    },
  });

  // Check for safety blocks in response metadata
  const candidate = response.candidates?.[0];
  if (candidate?.finishReason === "SAFETY") {
    const safetyRatings = candidate.safetyRatings?.map(r => `${r.category}:${r.probability}`).join(", ") || "unknown";
    throw new Error(`SAFETY: Image blocked by safety filters — ratings: ${safetyRatings}`);
  }

  const imagePart = candidate?.content?.parts?.find((p) => p.inlineData);
  const imageBytes = imagePart?.inlineData?.data;

  const durationMs = Date.now() - startMs;
  logger.info(`⏱️ [${modelId}] Scene ${sceneId} — API call completed in ${durationMs}ms`);

  return { imageBytes, durationMs };
}

/* --------------------------------------------------
   CORE GENERATION FUNCTION (replaces generateWithImagen)
   Tier 1 (PRO) → Tier 2 (FLASH) on infrastructure failures.
   Safety violations → intelligent repair → retry (same tier).
   Logs a PromptDebugReport for every scene.
-------------------------------------------------- */
async function generateWithGemini({
  prompt,
  commonPrompt,
  index,
  tempDir,
  aspectRatio = "16:9",
  characterReferences = [],
  sceneCharacters = [],
  styleUrl = null,
  visualState = null,             // Full VisualState object for continuity constraints
  globalNegativePrompt = null,    // From MGE _globalNegativePrompt
  frameNegativePrompt = null,     // From MGE _negativePrompt
  sceneMeta = {},                 // { location, characters, action, narration, emotion, camera, storyProgress }
  previousScenePrompt = null,
  nextScenePrompt = null,
  prevFrameImagePath = null,      // FIX 3: absolute path to the previous frame's generated PNG
  onCheckCancelled = null,
  stickyTierRef = null,           // B5: optional { tier: "PRO"|"FLASH" } shared across a batch
}) {
  await ensureDir(tempDir);

  const sceneId = `scene_${String(index).padStart(3, "0")}`;
  logger.info(`🎨 [GenWithGemini] ${sceneId} — starting | Prompt preview: "${prompt.slice(0, 80)}..."`);

  // ── Build per-scene PromptDebugReport ────────────────────────────────────
  const debugReport = {
    sceneId,
    narration: sceneMeta.narration || null,
    location: sceneMeta.location || visualState?.location || "unknown",
    characters: sceneMeta.characters || [],
    referenceImages: [],
    attempts: [],
    finalModel: null,
    finalPromptVersion: null,
    generatedImage: null,
    totalDurationMs: 0,
    safetyRepairs: 0,
    outcome: "pending",
  };

  // ── Pre-flight validation ─────────────────────────────────────────────────
  const validation = validatePrompt(prompt, { ...sceneMeta, location: visualState?.location });
  if (!validation.valid) {
    logger.warn(`⚠️ [PreFlight] ${sceneId} — Validation issues: ${validation.issues.join("; ")}`);
  }

  // ── Build character text section ──────────────────────────────────────────
  let characterTextSection = "";
  if (sceneCharacters.length > 0 && characterReferences.length > 0) {
    characterTextSection = `
# CHARACTER LIKENESS REFERENCES:
The attached reference image(s) define what these characters LOOK LIKE — face, skin tone, hair texture, body structure, age, and distinctive physical features ONLY.

CRITICAL:
1. Extract ONLY facial features, skin tone, and body structure from the reference image.
2. COMPLETELY IGNORE the action, pose, clothing, and expression shown in the reference image.
3. Characters MUST perform the exact action and show the exact expression described in the SCENE DESCRIPTION.
4. Do NOT freeze characters in a neutral pose from the reference image.`;
  } else if (characterReferences.length > 0) {
    characterTextSection = `
# CHARACTER LIKENESS REFERENCE:
The attached reference image defines the main character's appearance — face, skin tone, hair, body structure, age ONLY.

CRITICAL: The character MUST perform the action described in the SCENE DESCRIPTION. Ignore reference pose.`;
  }

  // ── Style section ─────────────────────────────────────────────────────────
  const styleSection = styleUrl
    ? `\n# STYLE REFERENCE ANCHOR:\nMatch the exact visual style, color grading, film grain, and lighting mood: ${styleUrl}.`
    : "";

  // ── Continuity instructions (natural-language constraints, not raw negatives) ─
  const continuityInstructions = buildContinuityInstructions({
    visualState,
    globalNegativePrompt,
    frameNegativePrompt,
  });

  // ── Pre-fetch character reference images as base64 (fetched ONCE, never reloaded) ──
  // Resolution strategy (three tiers):
  //   Tier 1 — Exact ID match: sceneCharacters IDs match characterReferences[].id
  //   Tier 2 — Fallback all:   IDs present but none resolved (MGE char_1 vs storyMetadata ID mismatch)
  //                             → inject ALL refs (user preference: always inject all on mismatch)
  //   Tier 3 — No sceneChars:  no character list provided → inject ALL refs for max consistency
  let inlineImages = [];
  try {
    if (sceneCharacters && sceneCharacters.length > 0) {
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      let matchedRefs = sceneCharacters
        .map((charItem) => {
          const charId = typeof charItem === "object" ? charItem.id || charItem.name : charItem;
          const target = norm(charId);
          if (!target) return null;
          return characterReferences.find((c) => {
            const cId = norm(c.id);
            const cName = norm(c.name);
            return cId === target || cName === target || (target.length > 2 && (cId.includes(target) || cName.includes(target) || target.includes(cName)));
          });
        })
        .filter(Boolean);

      // Deduplicate
      matchedRefs = Array.from(new Set(matchedRefs));

      // Fallback: if single character reference exists and scene characters were provided but fuzzy match missed, use it
      if (matchedRefs.length === 0 && characterReferences.length === 1) {
        matchedRefs = [...characterReferences];
      }

      const refsToUse = matchedRefs;

      if (matchedRefs.length === 0 && characterReferences.length > 0) {
        logger.warn(`⚠️ [GenWithGemini] ${sceneId} — No characterReferences matched scene IDs [${sceneCharacters.join(", ")}]. Generating WITHOUT reference images (text-only) to avoid identity blending.`);
      }

      for (const ref of refsToUse) {
        if (!ref?.url) continue;
        try {
          const charData = await fetchImageAsBase64(ref.url);
          inlineImages.push({ mimeType: charData.mimeType, base64: charData.base64, charId: ref.id, charName: ref.name });
          debugReport.referenceImages.push({ charId: ref.id, charName: ref.name, url: ref.url });
        } catch (fetchErr) {
          logger.warn(`⚠️ [GenWithGemini] ${sceneId} — Could not fetch ref for "${ref.name || ref.id}": ${fetchErr.message}`);
        }
      }
    } else if (characterReferences.length > 0) {
      // Tier 3: no sceneCharacters list → inject ALL refs
      logger.info(`ℹ️ [GenWithGemini] ${sceneId} — No sceneCharacters specified. Injecting all ${characterReferences.length} character ref(s).`);
      for (const ref of characterReferences) {
        if (!ref?.url) continue;
        try {
          const charData = await fetchImageAsBase64(ref.url);
          inlineImages.push({ mimeType: charData.mimeType, base64: charData.base64, charId: ref.id, charName: ref.name });
          debugReport.referenceImages.push({ charId: ref.id, charName: ref.name, url: ref.url });
        } catch (fetchErr) {
          logger.warn(`⚠️ [GenWithGemini] ${sceneId} — Could not fetch ref for "${ref.name || ref.id}": ${fetchErr.message}`);
        }
      }
    }
  } catch (err) {
    logger.warn(`⚠️ [GenWithGemini] ${sceneId} — Could not fetch character reference images: ${err.message}`);
  }


  // inlineImages is now fixed for ALL retries — never reloaded, never reordered, never removed
  const frozenInlineImages = [...inlineImages];

  // FIX 3: Load previous frame image once before the retry loop.
  // This is also frozen across retries — the reference to the prior frame never changes.
  let prevFrameImageData = null;
  if (prevFrameImagePath) {
    try {
      const rawBytes = await fs.promises.readFile(prevFrameImagePath);
      prevFrameImageData = {
        mimeType: "image/png",
        base64: rawBytes.toString("base64"),
      };
      logger.info(`🔗 [GenWithGemini] ${sceneId} — Previous frame loaded as visual anchor: ${prevFrameImagePath}`);
    } catch (loadErr) {
      // Non-fatal — generate without the visual anchor rather than crashing
      logger.warn(`⚠️ [GenWithGemini] ${sceneId} — Could not load previous frame image (${prevFrameImagePath}): ${loadErr.message}. Generating without visual anchor.`);
    }
  }

  const globalStartMs = Date.now();
  let currentPrompt = prompt;
  let promptVersion = 1;
  let lastError = null;

  // ── Two-tier provider loop: PRO → FLASH ──────────────────────────────────
  // B5: if a stickyTierRef was already downgraded to FLASH for this batch, start
  // directly at FLASH so the whole batch is rendered by one consistent model.
  let tierChain = [
    { name: "PRO", modelId: MODELS.PRO },
    { name: "FLASH", modelId: MODELS.FLASH },
  ];
  if (stickyTierRef && stickyTierRef.tier === "FLASH") {
    tierChain = [{ name: "FLASH", modelId: MODELS.FLASH }];
    logger.info(`🔷 [GenWithGemini] ${sceneId} — Batch already on FLASH tier (sticky). Skipping PRO.`);
  }

  for (const tier of tierChain) {
    logger.info(`🔷 [GenWithGemini] ${sceneId} — Trying Tier: ${tier.name} (${tier.modelId})`);

    let safetyRepairCount = 0;
    let tierExhausted = false;

    // ── Per-tier attempt loop (max 3 infrastructure retries per tier) ─────
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (onCheckCancelled) await onCheckCancelled();

      // Build final prompt fresh on every attempt (includes latest repaired currentPrompt)
      const finalPrompt = buildFinalPrompt({
        prompt: currentPrompt,
        commonPrompt,
        characterTextSection,
        styleSection,
        continuityInstructions,
        sceneMeta,   // context + intent + camera framing injected here
      });

      const attemptLog = {
        tier: tier.name,
        model: tier.modelId,
        attemptNumber: attempt,
        promptVersion,
        promptSnippet: currentPrompt.slice(0, 200),
        outcome: "pending",
        errorType: null,
        errorMessage: null,
        safetyRepairApplied: false,
        durationMs: null,
      };

      try {
        const { imageBytes, durationMs } = await callGeminiImageModel({
          modelId: tier.modelId,
          finalPrompt,
          inlineImages: frozenInlineImages,    // Always the same refs — never changed
          prevFrameImage: prevFrameImageData,  // FIX 3: visual anchor from previous frame
          aspectRatio,
          sceneId,
          attempt: `${tier.name}-${attempt}`,
        });

        if (!imageBytes) throw new Error(`${tier.modelId} returned empty image`);

        const filePath = path.join(tempDir, `${sceneId}.png`);
        await fs.promises.writeFile(filePath, Buffer.from(imageBytes, "base64"));

        attemptLog.outcome = "success";
        attemptLog.durationMs = durationMs;
        debugReport.attempts.push(attemptLog);
        debugReport.finalModel = tier.modelId;
        debugReport.finalPromptVersion = `v${promptVersion}`;
        debugReport.generatedImage = filePath;
        debugReport.totalDurationMs = Date.now() - globalStartMs;
        debugReport.safetyRepairs = safetyRepairCount;
        debugReport.outcome = "success";

        _emitDebugReport(debugReport, tempDir);
        logger.info(`✅ [GenWithGemini] ${sceneId} — Success with ${tier.name} (Prompt v${promptVersion}) → ${filePath}`);
        return { filePath, tier: tier.name };

      } catch (err) {
        lastError = err;
        const errorType = classifyGeminiError(err);
        attemptLog.errorType = errorType;
        attemptLog.errorMessage = err.message;

        logger.warn(`⚠️ [GenWithGemini] ${sceneId} — ${tier.name} Attempt ${attempt}/3 [${errorType}]: ${err.message.slice(0, 120)}`);

        // ── Error-type routing ────────────────────────────────────────────
        if (errorType === "SAFETY") {
          if (safetyRepairCount >= MAX_SAFETY_REPAIRS) {
            logger.error(`❌ [GenWithGemini] ${sceneId} — Safety repair limit (${MAX_SAFETY_REPAIRS}) reached. Scene generation failed.`);
            attemptLog.outcome = "safety_repair_exhausted";
            debugReport.attempts.push(attemptLog);
            tierExhausted = true;
            break;
          }

          logger.warn(`🔧 [GenWithGemini] ${sceneId} — Safety violation. Initiating prompt repair (repair #${safetyRepairCount + 1})...`);
          attemptLog.safetyRepairApplied = true;

          try {
            const { repairedPrompt } = await repairSafetyPrompt({
              originalPrompt: currentPrompt,
              safetyErrorMessage: err.message,
              sceneMeta: {
                sceneId,
                location: visualState?.location || sceneMeta.location,
                environment: visualState?.architecture || sceneMeta.environment,
                camera: sceneMeta.camera,
                emotion: sceneMeta.emotion,
                characters: sceneMeta.characters,
                action: sceneMeta.action,
                narration: sceneMeta.narration,
                storyProgress: sceneMeta.storyProgress,
                negativeGuidance: continuityInstructions,
              },
              previousScenePrompt,
              nextScenePrompt,
              attemptNumber: safetyRepairCount + 1,
            });

            // IDENTITY FIX (B3): the repair LLM rewrites the production prompt freely and
            // may drop the inline Level-1 identity detail (face/hair/skin) that composePrompt
            // embedded. If the repaired text no longer names this scene's characters, re-append
            // the immutable character-likeness block so the regenerated face/wardrobe can't drift.
            let repairedPromptFinal = repairedPrompt;
            const sceneCharNames = (sceneCharacters || [])
              .map((id) => {
                const ref = characterReferences.find((c) => c.id === id || c.name === id);
                return ref?.name || (typeof id === "string" ? id : null);
              })
              .filter(Boolean);
            const missingNames = sceneCharNames.filter(
              (nm) => !repairedPrompt.toLowerCase().includes(nm.trim().toLowerCase())
            );
            if (missingNames.length > 0 && characterTextSection) {
              repairedPromptFinal = `${repairedPrompt}\n\n${characterTextSection}`;
              logger.warn(`🔧 [PromptRepair] ${sceneId} — Re-appending identity block (missing: ${missingNames.join(", ")}).`);
            }

            currentPrompt = repairedPromptFinal;  // Only production_prompt is changed
            promptVersion++;
            safetyRepairCount++;
            attemptLog.outcome = "safety_repair_applied";
            debugReport.attempts.push(attemptLog);
            // Don't increment `attempt` — retry this tier with repaired prompt from attempt 1
            attempt = 0; // loop will increment to 1
            continue;

          } catch (repairErr) {
            logger.error(`❌ [GenWithGemini] ${sceneId} — Prompt repair LLM failed: ${repairErr.message}`);
            attemptLog.outcome = "repair_failed";
            debugReport.attempts.push(attemptLog);
            tierExhausted = true;
            break;
          }

        } else if (errorType === "RATE_LIMIT" || errorType === "QUOTA") {
          // On the PRIMARY (Tier-1 PRO) model, retry up to 3 times with a 2s gap
          // before giving up on this tier — a transient quota/rate-limit should not
          // immediately downgrade the whole batch to FLASH (which would cause drift).
          if (tier.name === "PRO" && attempt < 3) {
            logger.warn(`⏳ [GenWithGemini] ${sceneId} — ${errorType} on PRO (Tier-1). Retry ${attempt}/3 after 2s gap before falling back to FLASH.`);
            attemptLog.outcome = "retry";
            debugReport.attempts.push(attemptLog);
            await sleep(2000);
            if (onCheckCancelled) await onCheckCancelled();
            continue;
          }
          // Either not PRO, or PRO retries exhausted → switch tiers.
          logger.warn(`⏭️ [GenWithGemini] ${sceneId} — ${errorType} on ${tier.name}. Switching provider tier.`);
          attemptLog.outcome = "tier_switch";
          debugReport.attempts.push(attemptLog);
          // B5: downgrade the whole batch to FLASH so subsequent scenes stay consistent.
          if (stickyTierRef) {
            stickyTierRef.tier = "FLASH";
            stickyTierRef.reason = `${errorType} on ${tier.name}`;
            logger.warn(`🔷 [GenWithGemini] ${sceneId} — Batch downgraded to FLASH (sticky) due to ${errorType}. All remaining scenes will use FLASH.`);
          }
          tierExhausted = true;
          break;

        } else if (errorType === "PROMPT_TOO_LONG") {
          // Compress: truncate scene description to first 500 words
          logger.warn(`✂️ [GenWithGemini] ${sceneId} — Prompt too long. Compressing...`);
          currentPrompt = currentPrompt.split(/\s+/).slice(0, 500).join(" ");
          promptVersion++;
          attemptLog.outcome = "prompt_compressed";
          debugReport.attempts.push(attemptLog);
          await sleep(2000);
          continue;

        } else {
          // INTERNAL / UNKNOWN → retry same tier
          attemptLog.outcome = "retry";
          debugReport.attempts.push(attemptLog);
          if (attempt < 3) {
            await sleep(2000);
            if (onCheckCancelled) await onCheckCancelled();
          }
        }
      }
    }

    if (!tierExhausted) {
      // All 3 attempts on this tier failed non-safety reasons
      logger.warn(`⚠️ [GenWithGemini] ${sceneId} — Tier ${tier.name} exhausted (non-safety). Switching to next tier.`);
    }
  }

  // Both tiers exhausted — generation permanently failed
  debugReport.outcome = "failed";
  debugReport.totalDurationMs = Date.now() - globalStartMs;
  _emitDebugReport(debugReport, tempDir);

  logger.error(`❌ [GenWithGemini] ${sceneId} — All tiers exhausted. Scene generation failed permanently.`);
  throw lastError || new Error(`Image generation failed for ${sceneId} after all tiers and repairs`);
}

/* --------------------------------------------------
   PROMPT DEBUG REPORT EMITTER
   Writes a per-scene JSON debug artifact to tempDir.
   File: {tempDir}/debug_scene_XXX.json
-------------------------------------------------- */
function _emitDebugReport(report, tempDir) {
  try {
    const reportPath = path.join(tempDir, `debug_${report.sceneId}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch {
    // Non-fatal — never block generation on debug writing
  }
}

/* --------------------------------------------------
   MULTI IMAGE ORCHESTRATOR
   Bounded parallel generation. No image reuse. No adjacent-frame duplication.
   Each failed scene is logged explicitly and left as null.
-------------------------------------------------- */
export async function generateMultiImages(
  prompts,
  tempDir,
  aspectRatio = "16:9",
  commonPrompt = null,
  characterReferences = [],
  styleUrl = null,
  onCheckCancelled = null,
  onImageReady = null,
  checkpointManager = null,
) {
  const concurrencyLimit = config.workflow.imageConcurrency || 3;
  logger.info(`🚀 [MultiImages] Starting bounded parallel generation — Total: ${prompts.length}, Concurrency: ${concurrencyLimit}, PrimaryModel: ${MODELS.PRO}, FallbackModel: ${MODELS.FLASH}`);

  // IDENTITY FIX (B5): keep the image model CONSISTENT across the whole batch.
  // If a quota/rate-limit forces a fallback to FLASH for one scene, every subsequent
  // scene in this workflow must use FLASH too — mixing PRO and FLASH mid-batch causes
  // visible identity/style drift between scenes. This mutable ref is shared by all
  // scenes in this generateMultiImages call; once set to "FLASH" it stays.
  const stickyTierRef = { tier: "PRO", reason: null };

  const results = new Array(prompts.length).fill(null);

  // ── Visual State tracker — updated per scene to maintain environment persistence ──
  // Each scene inherits location/lighting/weather from the previous unless the story changes them
  let activeVisualState = {
    location: null,
    timeOfDay: null,
    weather: null,
    lighting: null,
    architecture: null,
    cameraStyle: null,
    wardrobe: null,
    characterStates: {},
    activeCharacters: [],
    environmentObjects: [],
  };

  // Build an ordered prompt list with prev/next context available per scene
  const resolvedPrompts = prompts.map((p) =>
    typeof p === "object" ? p : { prompt: p, charactersInScene: [], narration: null }
  );

  async function processImage(promptObj, index) {
    if (onCheckCancelled) await onCheckCancelled();

    const sceneId = `scene_${String(index + 1).padStart(3, "0")}`;
    const expectedFilePath = path.join(tempDir, `${sceneId}.png`);

    // Resume / Checkpoint logic
    if (checkpointManager && checkpointManager.isImageCompleted(sceneId) && fs.existsSync(expectedFilePath)) {
      logger.info(`⏩ [MultiImages] ${sceneId} — Skipping (checkpoint complete)`);
      results[index] = expectedFilePath;
      if (onImageReady) await onImageReady(expectedFilePath, index);
      return;
    }

    if (checkpointManager) checkpointManager.markImageRunning(sceneId);

    const safePrompt = promptObj.prompt || "";
    const sceneCharacters = promptObj.charactersInScene || [];
    const narration = promptObj.narration || null;
    const framePackage = promptObj._framePackage || null;
    const frameNeg = promptObj._negativePrompt || null;
    const globalNeg = promptObj._globalNegativePrompt || null;
    // v7 MGE: use per-frame Reference Selector output when available.
    // D.1: Validate selectedRefs — must be a non-empty array of objects with a url field.
    const rawSelectedRefs = Array.isArray(promptObj.selectedRefs) ? promptObj.selectedRefs : [];
    const validSelectedRefs = rawSelectedRefs.filter(
      (r) => r && typeof r === "object" && typeof r.url === "string" && r.url.length > 0
    );

    // PER-FRAME REFERENCE RESOLUTION (FIX A wins, FIX B is empty-list fallback only).
    //
    // Priority:
    //   1. validSelectedRefs (from MGE selectReferences / FIX A) — ALWAYS used when non-empty.
    //      FIX A already attaches refs for every present portraited character regardless of
    //      shot type, so this is the authoritative list and must never be overridden.
    //   2. FIX B fallback: if the engine returned an EMPTY selectedRefs but the scene still
    //      lists characters and portraits exist, derive refs directly from sceneCharacters
    //      by id/name. This recovers refs for frames where the engine omitted selectedRefs.
    //   3. Legacy/back-compat: no scene-character list at all → inject ALL refs (unchanged).
    //
    // We NEVER fall back to the entire characterReferences array when a scene HAS an explicit
    // character list (that would blend identities). Functional characters with no portrait
    // (neighbor_1, police_officer_1) are simply absent from characterReferences[] and stay
    // text-only by design.
    let perFrameRefs;
    if (validSelectedRefs.length > 0) {
      // FIX A path: authoritative, do not override.
      perFrameRefs = validSelectedRefs;
    } else if (sceneCharacters.length > 0 && characterReferences.length > 0) {
      // FIX B (empty-list fallback): derive refs strictly from this scene's own characters.
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      let derivedRefs = sceneCharacters
        .map((charItem) => {
          const charId = typeof charItem === "object" ? charItem.id || charItem.name : charItem;
          const target = norm(charId);
          if (!target) return null;
          return characterReferences.find((c) => {
            const cId = norm(c.id);
            const cName = norm(c.name);
            return cId === target || cName === target || (target.length > 2 && (cId.includes(target) || cName.includes(target) || target.includes(cName)));
          });
        })
        .filter(Boolean);

      derivedRefs = Array.from(new Set(derivedRefs));

      if (derivedRefs.length === 0 && characterReferences.length === 1) {
        derivedRefs = [...characterReferences];
      }

      perFrameRefs = derivedRefs;

      if (perFrameRefs.length > 0) {
        logger.info(
          `🔗 [MultiImages] ${sceneId} — FIX B fallback: derived ${perFrameRefs.length} ref(s) from sceneCharacters ` +
          `[${sceneCharacters.join(", ")}] → [${perFrameRefs.map((r) => r.name || r.id).join(", ")}].`
        );
      } else {
        logger.warn(
          `⚠️ [MultiImages] ${sceneId} — No refs resolved for scene characters [${sceneCharacters.join(", ")}] ` +
          `(none have portraits). Generating WITHOUT reference images (text-only) — functional characters are expected text-only.`
        );
      }
    } else {
      // No scene character list at all — legacy/backward-compat: inject ALL refs.
      perFrameRefs = characterReferences;
    }

    // ── Extract Visual State from frame package (MGE provides full location data) ─
    let sceneVisualState = { ...activeVisualState };
    if (framePackage) {
      const loc = framePackage.current_location_state;
      if (loc) {
        sceneVisualState = {
          ...sceneVisualState,
          location: loc.location_name || sceneVisualState.location,
          lighting: loc.lighting_current || sceneVisualState.lighting,
          architecture: loc.full_standalone_description
            ? loc.full_standalone_description.slice(0, 200)
            : sceneVisualState.architecture,
          activeCharacters: sceneCharacters.length > 0 ? sceneCharacters : sceneVisualState.activeCharacters,
        };
      }
      if (framePackage.camera_state) {
        sceneVisualState.cameraStyle = framePackage.camera_state.shot_size || sceneVisualState.cameraStyle;
      }
    }

    // Build scene metadata object for repair and validation
    const sceneMeta = {
      sceneId,
      location: sceneVisualState.location,
      environment: sceneVisualState.architecture,
      camera: sceneVisualState.cameraStyle,
      characters: sceneCharacters,
      action: framePackage?.frame_id?.visual_beat || null,
      narration,
      emotion: null,
      storyProgress: framePackage?.frame_id?.act
        ? `Act ${framePackage.frame_id.act}, Scene ${framePackage.frame_id.scene_number}`
        : null,
    };

    // Previous and next scene prompts (for safety repair context)
    const prevScenePrompt = index > 0 && resolvedPrompts[index - 1]
      ? resolvedPrompts[index - 1].prompt
      : null;
    const nextScenePrompt = index < resolvedPrompts.length - 1 && resolvedPrompts[index + 1]
      ? resolvedPrompts[index + 1].prompt
      : null;

    // FIX 3 (B4 fix): Resolve the previous frame's generated image path as a visual anchor.
    //
    // Concurrency safety:
    //   generateMultiImages() uses a bounded worker pool (default concurrencyLimit = 3).
    //   At concurrency > 1, frame N+1 may start before frame N is complete, making
    //   results[index-1] still null at this point.
    //
    //   Strategy (improved): prefer the in-memory result, but ALSO check the expected
    //   on-disk filename (scene_NNN.png) that generateWithGemini writes on success. Because
    //   image generation is serialized per index (processImage(i) awaits its own generation
    //   before resolving), a prior frame's file frequently exists on disk even though the
    //   in-memory results[] slot hasn't been published yet. This restores the visual anchor
    //   under concurrency (no identity drift) WITHOUT forcing imageConcurrency=1.
    //
    //   Only skip the anchor if neither the in-memory result NOR the on-disk file exists.
    let prevFrameImagePath = null;
    if (index > 0) {
      const prevResult = results[index - 1];
      const expectedPrevFile = path.join(tempDir, `scene_${String(index).padStart(3, "0")}.png`);
      if (typeof prevResult === "string" && prevResult.length > 0) {
        prevFrameImagePath = prevResult;
        logger.info(`🔗 [MultiImages] ${sceneId} — Previous frame confirmed complete → injecting as visual anchor: scene_${String(index).padStart(3, "0")}.png`);
      } else if (fs.existsSync(expectedPrevFile)) {
        prevFrameImagePath = expectedPrevFile;
        logger.info(`🔗 [MultiImages] ${sceneId} — Previous frame found on disk (parallel) → injecting as visual anchor: scene_${String(index).padStart(3, "0")}.png`);
      } else {
        logger.warn(
          `⚠️ [MultiImages] ${sceneId} — CONCURRENCY_SKIP: frame ${index} (scene_${String(index).padStart(3, "0")}.png) not yet available ` +
          `when frame ${index + 1} started. Visual anchor skipped for this scene.`
        );
      }
    }

    let success = false;
    let imgResult = { imageUrl: null, error: null };

    try {
      logger.info(`🎨 [MultiImages] ${sceneId} (${index + 1}/${prompts.length}) — Starting generation | Location: ${sceneVisualState.location || "unknown"} | Characters: [${sceneCharacters.join(", ")}] | PrevFrame: ${prevFrameImagePath ? "anchored" : "none"}`);

      const result = await withExponentialBackoff(async () => {
        return await generateWithGemini({
          prompt: safePrompt,
          commonPrompt,
          index: index + 1,
          tempDir,
          aspectRatio,
          characterReferences: perFrameRefs,  // v7: per-frame selected refs only
          sceneCharacters,
          styleUrl,
          visualState: sceneVisualState,
          globalNegativePrompt: globalNeg,
          frameNegativePrompt: frameNeg,
          sceneMeta,
          previousScenePrompt: prevScenePrompt,
          nextScenePrompt,
          prevFrameImagePath,                 // FIX 3: visual anchor from previous frame
          onCheckCancelled,
          stickyTierRef,                      // B5: keep model consistent across the batch
        });
      }, `Image ${sceneId}`, 6, 8000);

      logger.info(`✅ [MultiImages] ${sceneId} — Generated with ${result.tier}: ${result.filePath}`);
      imgResult = { imageUrl: result.filePath, error: null };
      success = true;

      // Propagate visual state forward to next scene
      activeVisualState = { ...sceneVisualState };

    } catch (err) {
      // Generation permanently failed — log explicitly. NEVER reuse any other image.
      logger.error(`❌ [MultiImages] ${sceneId} — Permanently failed after all tiers and repairs: ${err.message}`);
      imgResult = { imageUrl: null, error: err.message };
      success = false;
    }

    if (success && checkpointManager) checkpointManager.markImageCompleted(sceneId);
    if (!success && checkpointManager) checkpointManager.markImageFailed(sceneId);

    results[index] = imgResult.imageUrl;

    // Streaming pipeline: trigger segment render as soon as image is ready
    if (success && onImageReady) {
      await onImageReady(imgResult.imageUrl, index);
    }
  }

  // Bounded worker pool
  const executing = new Set();
  for (let i = 0; i < resolvedPrompts.length; i++) {
    const p = processImage(resolvedPrompts[i], i);
    executing.add(p);
    p.finally(() => executing.delete(p));
    if (executing.size >= concurrencyLimit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);

  const succeeded = results.filter(Boolean).length;
  const failed = results.length - succeeded;
  logger.info(`🏁 [MultiImages] Complete — ${succeeded}/${prompts.length} generated, ${failed} failed permanently.`);

  return results.map((r) => (r ? { imageUrl: r } : { imageUrl: null }));
}

/* --------------------------------------------------
   SINGLE IMAGE ORCHESTRATOR
   Used for: style reference, cover art, character portraits, single-image media
-------------------------------------------------- */
export async function generateImage(
  prompt,
  index,
  tempDir,
  aspectRatio = "16:9",
  commonPrompt = null,
  characterReferences = [],
  styleUrl = null,
) {
  const promptObj = typeof prompt === "object" ? prompt : { prompt };
  const safePrompt = promptObj.prompt || (typeof prompt === "string" ? prompt : "");
  const sceneCharacters = promptObj.charactersInScene || [];
  const frameNeg = promptObj._negativePrompt || null;
  const globalNeg = promptObj._globalNegativePrompt || null;

  const sceneId = `scene_${String(index).padStart(3, "0")}`;
  logger.info(`🎨 [SingleImage] ${sceneId} — Starting`);

  try {
    const result = await generateWithGemini({
      prompt: safePrompt,
      commonPrompt,
      index,
      tempDir,
      aspectRatio,
      characterReferences,
      sceneCharacters,
      styleUrl,
      globalNegativePrompt: globalNeg,
      frameNegativePrompt: frameNeg,
    });
    logger.info(`✅ [SingleImage] ${sceneId} — Succeeded: ${result.filePath}`);
    return { imageUrl: result.filePath, error: null };
  } catch (err) {
    logger.error(`❌ [SingleImage] ${sceneId} — Failed: ${err.message}`);
    return { imageUrl: null, error: err.message };
  }
}
