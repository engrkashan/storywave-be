import { extractFromUrl, transcribeVideo } from "./inputService.js";
import { createLogger } from "../utils/logger.js";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { SCENE_PROMPT_VERSION_ONE, SCENE_PROMPT_VERSION_TWO } from "./promptService.js";


const logger = createLogger("StoryService");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const moduleRules = {
  true_crime_fiction_cinematic: `
Shared rules: third person. Short, speech-ready lines. Dates and times clear. Allegation vs proven kept distinct. Avoid gore. Keep human dignity.
Style overlay (cinematic blockbuster): high-stakes momentum with scene-driven suspense, tight cuts, and cliffhanger end beats. Use concrete, visual action. Keep the “wanting more” pull without sensationalism.
1) FICTION_CINEMATIC (Netflix-Style Drama)
* POV & tense: third person; choose present or past and stay consistent.
* Pacing: propulsive. Three to five beats per scene; each beat shifts power, risk, or knowledge.
* Scene rules: enter late, leave early. Hard transitions between beats.
* Fit to 3 chapters:
    * Ch. 1 – Hook in danger → What’s at stake → Inciting event.
    * Ch. 2 – Pressure rises → Midpoint turn → Spiral or timer.
    * Ch. 3 – Showdown setup → Showdown → Tag with fresh question or cost.
* Dialogue: minimal tags. Action beats carry tone.
* Ethics: if inspired by real events, change names and identifiers unless you have permission.
  `,
  true_crime_nonfiction_forensic: `
Shared rules: third person. Short, speech-ready lines. Dates and times clear. Allegation vs proven kept distinct. Avoid gore. Keep human dignity.
Style overlay (cinematic blockbuster): high-stakes momentum with scene-driven suspense, tight cuts, and cliffhanger end beats. Use concrete, visual action. Keep the “wanting more” pull without sensationalism.
2) NONFICTION_FORENSIC (Forensic Files / First 48)
* Voice: neutral third person, past tense.
* Episode flow mapped to 3 chapters:
    * Ch. 1 – Cold open scene → Rewind to timeline → First response or 911 → Scene work.
    * Ch. 2 – Victim profile → Leads → Lab work → Interview turns.
    * Ch. 3 – The break (digital/lab/timeline) → Confrontation or warrant → Outcome → Aftermath.
* Formatting: clear timestamps and locations. Mark allegation vs proven.
* Cinematic tension (ethical): compress exposition; end segments with an open question; keep pace while staying factual.
* No inline evidence tags.
  `,
  manipulation_sexual_manipulation: `
Policy note: adult and intense, not pornographic. No explicit sexual description. Realistic language allowed. Light profanity only when it serves character. Consent boundaries must be clear. No minors. No sexual violence as titillation. Fade to black at explicit moments.
Style overlay (cinematic blockbuster): suspense-first, sensual yet restrained. Cliffhangers at chapter ends. Tight, escalating stakes — always non-explicit and respectful.
* Narration: third person, fixed.
* Three-chapter arc:
    * Ch. 1 – Boundary crossed or near-miss (non-explicit); introduce tactics (love-bombing, mirroring, speed, secrecy).
    * Ch. 2 – Control/Erosion: tests, isolation, shaming, gaslight; the proof gathers.
    * Ch. 3 – Break/Reset: realization with proof or support; boundary language; safety plan; cost and forward path.
* Drop-in helpers as plain prose: red flags, gaslight moments, reward/withdraw cycles, support routes, one clear boundary line per chapter.
* Checklist: timeline clear; consent language plain; no explicit description; one boundary phrase per chapter.
  `,
  cultural_history_documentary: `
Style target: National Geographic–style documentary — informative, field-based, authoritative. Vivid but precise. Respectful to sources and places. Teach clearly; avoid hype.
* Voice: neutral third-person documentary. Calm, respectful, clear.
* Three-chapter flow:
    * Ch. 1 – Present-moment field entry → Quick bridge to past → Define terms once.
    * Ch. 2 – Lived voices (quotes or paraphrases) → Tension or contrast (power, class, language, diaspora) → Place anchors or maps.
    * Ch. 3 – Synthesis → Reflection that opens a question → Guidance for respectful engagement.
* Optional elements: archive lines with dates, expert interviews, brief field notes, context paragraphs, two-view debates, map anchors.
* Checklist: dates anchored; one concrete place per chapter; terminology defined once.
  `,
  homesteading_howto_field_guide: `
* Voice: friendly instructor. Second person fits tasks well.
* Each chapter: SCOPE → SAFETY → TOOLS/MATERIALS → STEPS → CHECKS/FIXES → CARE.
* Include: time window, weather, steps (one action each), failsafe rules, yield in eggs/pounds/gallons.
* Safety first: animal welfare and personal safety before risk steps.
* Style Mode: Explainer_in_Detail (teaches so a careful beginner can succeed safely).
  `,
  work_and_trades_shop_manual: `
1) SHOP_MANUAL (How-to for tools and tasks; second person allowed)
Structure: SCOPE → SAFETY → TOOLS/PARTS/SPECS → STEPS → TESTS/QA → TROUBLESHOOT → MAINTENANCE.
* Ch. 1 – Fundamentals and setup.
* Ch. 2 – Execution and testing.
* Ch. 3 – Troubleshooting patterns and maintenance plan.
* Style Mode: Explainer_in_Detail (step-locked, spec-clean).
  `,
  work_and_trades_shopfloordoc: `
2) SHOPFLOOR_DOC (Workplace documentary or profile; neutral third person)
Flow: present task → who is doing it → brief tool/process explainer → risk or safety moment → problem → fix or lesson → reflection on craft and training path.
End each chapter with a learning takeaway.
  `,
  investigative_discovery_journalistic: `
Style Mode: Investigative_Journalism (truthful, detailed, source-aware).
* Voice: neutral third person, factual and exact. Attribute claims; separate allegation vs proven.
* Ethics: verify facts; avoid speculation; minimize harm; maintain dignity.
* Formatting: clear timestamps, places, proper nouns spelled for TTS once.
* Devices: timeline cards, sourcing notes, plain-language explainers.
* Default structure: standard three-chapter arc.
    * Ch. 1 – Setup & Stakes → current scene or news hook → key question.
    * Ch. 2 – Escalation & Reversal → reporting turns, documents, interviews, data insight.
    * Ch. 3 – Resolution & Aftermath → what is known/unknown → next steps or accountability lens.
* Alternate outline: Case → Evidence → Reflection.
* End each chapter with precise open question or verified takeaway.
  `,
  storytelling_cinematic: `
Style Mode: Cinematic_Movie_Storytelling (scene-driven, visual, emotive).
* Voice: third person (default) or first if intake demands.
* Pacing: filmic beats; enter late, leave early; show don’t tell.
* Sound-free for TTS: paint visuals cleanly; use action beats instead of camera jargon.
* Devices: motif echoes, prop callbacks, simple visual symbolism.
* Default structure: standard three-chapter arc.
    * Ch. 1 – Setup & Stakes with a vivid hook and inciting event.
    * Ch. 2 – Escalation & Reversal with midpoint turn.
    * Ch. 3 – Resolution & Aftermath with a cost or lingering question.
* Alternate outline: Discovery → Confrontation → Consequence.
  `,
  conversation_narrated_documentary: `
Style Mode: Blended_Docu_Host (third-person facts with conversational breaks).
* Voice: third-person factual spine + short host reflections and questions.
* Rhythm: fact block → brief host aside → return to narrative. Keep asides 1–2 lines.
* Audience lens: explain terms once; use plain speech; keep it personable but precise.
* Default structure: standard three-chapter arc.
    * Ch. 1 – Setup & Stakes with host framing question.
    * Ch. 2 – Escalation & Reversal with host check-ins guiding listener through turns.
    * Ch. 3 – Resolution & Aftermath with host reflection and forward path.
* Alternate outline: Discovery → Conversation → Resolution.
* Guardrails: no rambling; no filler; asides must move story or clarify a fact.
  `,
  education_howto_trades: `
Style Mode: HOWTO_FIELD_MANUAL
* Voice: plain, confident, second person “you.”
* Dialect: Standard only.
* Pace: steady and unrushed. One idea per sentence.
* Paragraphs: 2–4 short sentences each.
* Prose rules: natural, simple, real-feeling. Active voice. No em dashes or semicolons.
* TTS rules: write numbers for the ear (e.g., “one eighth inch,” “seven thirty a.m.”).
* Jargon: allowed; define once.
* Safety: mention PPE and lockout/tagout before steps. Remind to follow local code.
* Legal: never advise outside license scope; say “local code.” No brand endorsements.
* Inspection: include what inspectors look for and how to document with photos.
Chapter Template:
Hook (one-line job + win) → Scope → Safety → Tools/Materials → Setup → Steps (4–8) → Verify → Common fails + fixes → Document → Recap (three bullets).
Sentence Patterns for Audio:
“You’ll need… Then… Finally…”
“Set the meter to volts A C. Confirm zero at the panel.”
  `,
  // Default fallback if storyType not matched
  default: `
Style Mode: Cinematic_Movie_Storytelling (scene-driven, visual, emotive).
* Voice: third person (default).
* Pacing: filmic beats; enter late, leave early; show don’t tell.
* Sound-free for TTS: paint visuals cleanly; use action beats instead of camera jargon.
* Default structure: standard three-chapter arc.
    * Ch. 1 – Setup & Stakes with a vivid hook and inciting event.
    * Ch. 2 – Escalation & Reversal with midpoint turn.
    * Ch. 3 – Resolution & Aftermath with a cost or lingering question.
  `,
};

/* -------------------------------------------------------------------------- */
/* 🧩 STEP -1 — Analyze Context (Build Story Bible)                            */
/* -------------------------------------------------------------------------- */
async function analyzeStoryContext({ inputText, storyGuidelines, storyType, voiceTone }) {
  logger.info("🧠 Analyzing story context and extracting Story Bible...");
  const prompt = `You are an expert Story Editor and Narrative Designer.
Your task is to analyze the provided raw story material and the user's specific story guidelines, and extract a highly structured "Story Bible".
This Story Bible will be used by the writing engine to ensure strict adherence to character details, tone, and plot constraints.

RAW STORY MATERIAL:
${inputText.slice(0, 15000)}

USER STORY GUIDELINES / CONSTRAINTS:
${storyGuidelines || "None provided."}

GENRE/TYPE: ${storyType}
TONE: ${voiceTone}

Extract the following in STRICT JSON format:
{
  "characters": [
    {
      "name": "Character Name",
      "role": "Role in story",
      "traits": "Key personality traits or motives",
      "appearance": "Physical description if available"
    }
  ],
  "settings": ["List of key locations or environment constraints"],
  "key_plot_points": ["Major narrative beats extracted from the material"],
  "tone_and_rules": ["List of specific writing constraints or rules derived from the user guidelines to strictly follow"]
}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.6",
      messages: [{ role: "user", content: prompt }],

      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(res.choices[0].message.content.trim());
    return JSON.stringify(parsed, null, 2);
  } catch (err) {
    logger.warn("⚠️ Context analysis failed, falling back to raw guidelines:", err.message);
    return JSON.stringify({
      fallback_guidelines: storyGuidelines || "None",
      fallback_material: "Use raw input material."
    }, null, 2);
  }
}

/* -------------------------------------------------------------------------- */
/* 🧩 STEP 0 — Generate Introduction (with characters and beginning)         */
/* -------------------------------------------------------------------------- */
async function generateIntro({
  inputText,
  analyzedContext,
  storyType,
  voiceTone,
  words,
  retries = 2,
}) {
  const moduleRule =
    moduleRules[storyType.toLowerCase()] || moduleRules["default"];
  const prompt = `
      Follow the UNIVERSAL MASTER PROMPT — STREAMLINED (AUG 2025 • TTS-READY) — THREE-CHAPTER EDITION (adjusted for streaming generation)

      GLOBAL BASE RULES
      * Voice: natural, simple, real-feeling. Short paragraphs (2–4 sentences). Active voice.
      * Dialogue: plain, everyday talk; no similes. Keep it how people speak.
      * Punctuation: no em dashes, no semicolons.
      * Inside chapters: no website names, no hashtags, no links, no emojis, no markdown. No parentheses.
      * Numbers & time (TTS): write dates and times clearly (e.g., “7:42 p.m., March 12, 2021”); avoid symbol clusters; expand tricky numbers for the ear.
      * Dialect: Standard only; light slang allowed if it preserves clarity and respect.
      * Master Ban List enforced.
      * No audio cues.
      * No complete story idea or summary.

      GENRE MODULE: ${storyType}
      ${moduleRule}

      Build Mode: Streaming Story Generation — Introduction with character intros and beginning.

      SERIES STRUCTURE (APPLIES TO ALL GENRES)
      * Introduction: Setup & Stakes: clear goal, context, immediate pressure, first turn. Introduce characters in a story tone.

      Generate the INTRODUCTION: ~${words} words, including the introduction of characters in a story tone and the beginning of the story.
      Tone: ${voiceTone}.
      STORY BIBLE / ANALYSIS CONTEXT (Follow strictly!):
      ${analyzedContext}

      Raw Input context for reference: ${inputText}.
      Do NOT include:
      - greetings or introductions
      - music cues
      - narration directions
      - filler content
      - summary of the story
      Return ONLY the plain text introduction of the story not the complete story.
  `;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-5.6",
        messages: [{ role: "user", content: prompt }],

      });

      let content = res.choices[0].message.content.trim();
      return content;
    } catch (err) {
      logger.warn(
        `Intro generation failed (Attempt ${attempt}):`,
        err.message
      );
      if (attempt === retries) throw new Error("Failed to generate intro");
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 🧩 STEP 1-3 — Generate Body Parts (continuations)                         */
/* -------------------------------------------------------------------------- */
async function generateBodyPart({
  inputText,
  analyzedContext,
  storyType,
  voiceTone,
  previous,
  partNum,
  words,
  retries = 2,
}) {
  const moduleRule =
    moduleRules[storyType.toLowerCase()] || moduleRules["default"];
  const prompt = `
      Follow the UNIVERSAL MASTER PROMPT — STREAMLINED (AUG 2025 • TTS-READY) — THREE-CHAPTER EDITION (adjusted for streaming generation)

      GLOBAL BASE RULES
      * Voice: natural, simple, real-feeling. Short paragraphs (2–4 sentences). Active voice.
      * Dialogue: plain, everyday talk; no similes. Keep it how people speak.
      * Punctuation: no em dashes, no semicolons.
      * Inside chapters: no website names, no hashtags, no links, no emojis, no markdown. No parentheses.
      * Numbers & time (TTS): write dates and times clearly (e.g., “7:42 p.m., March 12, 2021”); avoid symbol clusters; expand tricky numbers for the ear.
      * Dialect: Standard only; light slang allowed if it preserves clarity and respect.
      * Master Ban List enforced.
      * No audio cues.

      GENRE MODULE: ${storyType}
      ${moduleRule}

      Build Mode: Streaming Story Generation — Body Part ${partNum} of 3.

      SERIES STRUCTURE (APPLIES TO ALL GENRES)
      * Body Parts: Escalation & Reversal: complications, midpoint shift, consequences, timer or trap. Maintain overall arc.

      Continue the story SEAMLESSLY from the following previous text, ensuring no breaks, gaps, or flaws in fluency:
      ${previous}

      Develop the plot step by step, building tension and character development.
      Tone: ${voiceTone}.
      STORY BIBLE / ANALYSIS CONTEXT (Follow strictly!):
      ${analyzedContext}

      Raw Input context for reference: ${inputText}.
      Do NOT include:
      - greetings or introductions
      - music cues
      - narration directions
      - filler content
      - repetitions of previous content
      Return ONLY the plain text continuation for this body part.
      Length: ~${words} words (adjust for pacing to keep interest high).
  `;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-5.6",
        messages: [{ role: "user", content: prompt }],

      });

      let content = res.choices[0].message.content.trim();
      return content;
    } catch (err) {
      logger.warn(
        `Body part ${partNum} generation failed (Attempt ${attempt}):`,
        err.message
      );
      if (attempt === retries)
        throw new Error(`Failed to generate body part ${partNum}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 🧩 STEP 4 — Generate Closing                                              */
/* -------------------------------------------------------------------------- */
async function generateClosing({
  inputText,
  analyzedContext,
  storyType,
  voiceTone,
  previous,
  words,
  retries = 2,
}) {
  const moduleRule =
    moduleRules[storyType.toLowerCase()] || moduleRules["default"];
  const prompt = `
      Follow the UNIVERSAL MASTER PROMPT — STREAMLINED (AUG 2025 • TTS-READY) — THREE-CHAPTER EDITION (adjusted for streaming generation)

      GLOBAL BASE RULES
      * Voice: natural, simple, real-feeling. Short paragraphs (2–4 sentences). Active voice.
      * Dialogue: plain, everyday talk; no similes. Keep it how people speak.
      * Punctuation: no em dashes, no semicolons.
      * Inside chapters: no website names, no hashtags, no links, no emojis, no markdown. No parentheses.
      * Numbers & time (TTS): write dates and times clearly (e.g., “7:42 p.m., March 12, 2021”); avoid symbol clusters; expand tricky numbers for the ear.
      * Dialect: Standard only; light slang allowed if it preserves clarity and respect.
      * Master Ban List enforced.
      * No audio cues.

      GENRE MODULE: ${storyType}
      ${moduleRule}

      Build Mode: Streaming Story Generation — Closing.

      SERIES STRUCTURE (APPLIES TO ALL GENRES)
      * Closing: Resolution & Aftermath (or Action Plan): payoff, answer the core question, cost, resonant end.

      Continue and CONCLUDE the story SEAMLESSLY from the following previous text, ensuring no breaks, gaps, or flaws in fluency:
      ${previous}

      Provide a satisfying resolution, wrapping up the arc with emotional depth.
      Tone: ${voiceTone}.
      STORY BIBLE / ANALYSIS CONTEXT (Follow strictly!):
      ${analyzedContext}

      Raw Input context for reference: ${inputText}.
      Do NOT include:
      - greetings or introductions
      - music cues
      - narration directions
      - filler content
      - repetitions of previous content
      Return ONLY the plain text closing.
      Length: ~${words} words (adjust for pacing to keep interest high).
  `;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-5.6",
        messages: [{ role: "user", content: prompt }],

      });

      let content = res.choices[0].message.content.trim();
      return content;
    } catch (err) {
      logger.warn(
        `Closing generation failed (Attempt ${attempt}):`,
        err.message
      );
      if (attempt === retries) throw new Error("Failed to generate closing");
    }
  }
}

export async function generateStory({
  textIdea,
  url,
  videoFile,
  storyType = "storytelling_cinematic",
  voiceTone = "neutral",
  storyLength = "30 minutes",
  voice,
  storyGuidelines,
}) {
  let inputText = textIdea || "";
  if (url) inputText = await extractFromUrl(url);
  if (videoFile) inputText = await transcribeVideo(videoFile);

  if (!inputText || inputText.trim().length < 50) {
    throw new Error("Insufficient or invalid input content.");
  }

  // 🧠 STEP -1: Generate the structured Story Bible context first
  const analyzedContext = await analyzeStoryContext({
    inputText,
    storyGuidelines,
    storyType,
    voiceTone
  });

  if (!inputText || inputText.trim().length < 50) {
    throw new Error("Insufficient or invalid input content.");
  }

  // 🔪 Limit token size before prompt (trim or summarize)
  if (inputText.length > 8000) {
    logger.info(" Input too long, summarizing before story generation...");
    inputText = await summarizeText(inputText);
  }

  // Parse storyLength to get minutes (e.g., "30 minutes" -> 30)
  const minutes = Math.max(10, parseInt(storyLength) || 30); // Min 10
  logger.info(`📝 Story length: ${minutes} minutes`);

  // Calculate total minimum words based on user specification
  let totalWords;
  if (minutes <= 10) totalWords = 5000;
  else if (minutes <= 20) totalWords = 1000;
  else if (minutes <= 30) totalWords = 1400;
  else if (minutes <= 40) totalWords = 1800;
  else if (minutes <= 50) totalWords = 2200;
  else totalWords = 25000;

  const parts = 3;
  let wordsPerPart = Math.floor(totalWords / parts);

  // If wordsPerPart > 4000, subdivide large parts with additional API hits
  const maxWordsPerCall = 4000;

  async function generateSubdivided(contentFunc, params, targetWords) {
    if (targetWords <= maxWordsPerCall) {
      return await contentFunc({ ...params, words: targetWords });
    } else {
      let fullContent = "";
      let remainingWords = targetWords;
      let subPrevious = params.previous || "";
      while (remainingWords > 0) {
        const subWords = Math.min(maxWordsPerCall, remainingWords);
        const subContent = await contentFunc({
          ...params,
          previous: subPrevious,
          words: subWords,
        });
        fullContent += subContent + "\n\n";
        subPrevious += "\n\n" + subContent;
        remainingWords -= subWords;
      }
      return fullContent.trim();
    }
  }

  // Generate intro
  const intro = await generateSubdivided(
    generateIntro,
    {
      inputText,
      analyzedContext,
      storyType,
      voiceTone,
    },
    wordsPerPart
  );


  let previous = intro;

  // Generate 3 body parts
  let bodyParts = [];
  for (let i = 1; i <= 1; i++) {
    const bodyPart = await generateSubdivided(
      generateBodyPart,
      {
        inputText,
        analyzedContext,
        storyType,
        voiceTone,
        previous,
        partNum: i,
      },
      wordsPerPart
    );
    bodyParts.push(bodyPart);
    previous += "\n\n" + bodyPart;
  }

  // Generate closing
  const closing = await generateSubdivided(
    generateClosing,
    {
      inputText,
      analyzedContext,
      storyType,
      voiceTone,
      previous,
    },
    wordsPerPart
  );

  const fullScript = [intro, ...bodyParts, closing].join("\n\n");

  return {
    script: fullScript.trim(),
  };
}

async function generatePromptForChunk({
  chunkText,
  chunkIndex,
  storyBible,
  visualSuggestions,
  prevVisualContext,
  prevChunkText,
  prevCharactersInScene,
  characterReferences
}) {
  const charactersStr = storyBible?.characters?.map(c => `- ${c.name} (ID: ${c.id}): ${c.appearance || "Clinical neutral appearance"} | Locked Wardrobe: ${c.clothing || c.base_clothing || "Default cinematic attire"}`).join('\n') || "None";
  const locationsStr = storyBible?.locations?.map(l => `- ${l.name}: ${l.description}`).join('\n') || "None";
  const artStyle = storyBible?.artStyle || "Cinematic photorealistic film still, 8K detail, hyper-realistic, volumetric lighting.";
  const synopsis = storyBible?.synopsis ? `STORY SYNOPSIS:\n${storyBible.synopsis}\n` : "";

  const prompt = `You are an elite cinematic film director, visual storyteller, and master prompt engineer.
Your objective is to visualize the complete story as a continuous, realistic movie step by step. You are generating the visual prompt for keyframe beat ${chunkIndex + 1} in the sequence.

GLOBAL MOVIE GUIDE:
${synopsis}

CHARACTERS (LOCKED IDENTITIES & WARDROBE):
${charactersStr}
(Note: Every character has a locked physical appearance and wardrobe. You MUST include their exact physical features and locked wardrobe whenever they appear.)

LOCATIONS & ENVIRONMENT:
${locationsStr}

CINEMATIC ART STYLE & LIGHTING DIRECTION:
${artStyle}
${visualSuggestions || ""}

PREVIOUS SCENE CONTEXT (For Sequential Visual Continuity):
Previous Narration: "${prevChunkText || "None"}"
Previous Characters Present: ${prevCharactersInScene?.length > 0 ? prevCharactersInScene.join(", ") : "None"}
Previous Visual & Environment State: ${prevVisualContext || "This is the first scene."}

CURRENT VOICEOVER CHUNK (Beat ${chunkIndex + 1}):
"${chunkText}"

CRITICAL DIRECTORIAL RULES:
1. STEP-BY-STEP CINEMATIC STORYTELLING: Treat each chunk as a keyframe beat in a realistic movie sequence. The visual prompt must clearly capture the specific step-by-step action occurring in this beat according to the script flow.
2. CHARACTER IDENTITY & WARDROBE LOCK: For reference characters, facial and physical features come from the reference image, BUT wardrobe is determined strictly by the story script (ignore any clothing in reference photos). For every character present in this frame, you MUST explicitly specify their locked facial features and story-derived wardrobe from the Character Guide. Do NOT alter their clothing across scenes unless the script explicitly describes a change of clothes.
3. TIME OF DAY & LIGHTING CONSISTENCY: Maintain strict environment, time of day/timezone, and lighting consistency with previous scenes in the same location unless time explicitly passes in the script.
4. DYNAMIC CHARACTER DETECTIVE & PRONOUN RESOLUTION:
   - Pronouns ("he", "she", "they") usually refer to the character(s) from the previous scene context.
   - However, if the chunk or story flow introduces new characters or transitions to a different location, update 'characters_present' and 'active_location' accordingly based on the script.
5. NO TEXT IN IMAGES: Ensure no text, labels, or captions appear in the visual prompt.

Return STRICT valid JSON:
{
  "active_location": "Name of the location",
  "characters_present": ["ID of characters present"],
  "core_action": "Clear, specific beat action",
  "visual_prompt": "Cinematic visual prompt specifying exact character appearances, locked wardrobe, location, lighting, camera framing, and keyframe action...",
  "visual_context_for_next_scene": "Detailed summary of character visual states, locked wardrobe, location, time of day, and positioning to carry over into the next beat"
}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.6", // Upgraded to gpt-5.6 as requested for advanced contextual understanding
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(res.choices[0].message.content.trim());
    return {
      prompt: parsed.visual_prompt,
      charactersInScene: parsed.characters_present || [],
      visualContext: parsed.visual_context_for_next_scene
    };
  } catch (err) {
    logger.error("Error generating chunk prompt:", err);
    return {
      prompt: `${artStyle} ${visualSuggestions || ""} Scene for voiceover: ${chunkText}`,
      charactersInScene: [],
      visualContext: ""
    };
  }
}

/**
 * generateScenePrompts — Chunk-based LLM generation
 *
 * Converts exact Whisper voiceover chunks into standalone image prompts
 * analyzing each chunk individually using the global movie guide.
 */
export async function generateScenePrompts(storyScript, count = 5, storyBible = null, visualSuggestions = null, narrationSegments = null, referenceTraits = null, characterReferences = []) {
  logger.info(`🎬 [Chunk-based Engine] generateScenePrompts — ${count} frames requested`);

  let segments = narrationSegments;
  if (!segments || segments.length === 0) {
    const words = storyScript.split(/\s+/).filter(Boolean);
    const chunkSize = Math.ceil(words.length / count);
    segments = Array.from({ length: count }, (_, i) => ({
      sceneIndex: i,
      startSec: i * 5,
      endSec: (i + 1) * 5,
      text: words.slice(i * chunkSize, (i + 1) * chunkSize).join(" ")
    }));
  }

  const scenePrompts = [];
  let prevVisualContext = null;
  let prevChunkText = null;
  let prevCharactersInScene = [];

  for (let i = 0; i < segments.length; i++) {
    const chunk = segments[i];
    logger.info(`🧠 Generating prompt for chunk ${i + 1}/${segments.length}`);

    const promptData = await generatePromptForChunk({
      chunkText: chunk.text,
      chunkIndex: i,
      storyBible,
      visualSuggestions,
      prevVisualContext,
      prevChunkText,
      prevCharactersInScene,
      characterReferences,
    });

    scenePrompts.push({
      prompt: promptData.prompt,
      charactersInScene: promptData.charactersInScene || [],
      narration: chunk.text,
      _startSec: chunk.startSec,
      _endSec: chunk.endSec,
      _negativePrompt: "",
      _globalNegativePrompt: storyBible?.globalNegativePrompt || ""
    });

    prevVisualContext = promptData.visualContext;
    prevChunkText = chunk.text;
    prevCharactersInScene = promptData.charactersInScene || [];
  }

  return { scenePrompts, castBible: storyBible?._preGeneratedBibles?.MATERIALIZED_CAST_BIBLE || null };
}

async function summarizeText(text) {
  const summaryPrompt = `Summarize the following text in under 800 words focusing only on the main ideas, tone, and narrative elements:\n\n${text.slice(
    0,
    15000
  )}`;
  const result = await openai.chat.completions.create({
    model: "gpt-5.6",
    messages: [{ role: "user", content: summaryPrompt }],

  });
  return result.choices?.[0]?.message?.content?.trim() || text.slice(0, 5000);
}

/**
 * Automatically analyze the script context and generate an enhanced version
 * that intelligently includes appropriate sound-effect cues (e.g. [door opening])
 * where they add value to the storytelling.
 */
export async function enhanceScriptWithSoundEffects(script) {
  logger.info("🔊 Enhancing script with ElevenLabs sound effects...");
  const prompt = `You are a cinematic audio director. Your task is to enhance the provided script by adding background sound-effect cues.

RULES:
1. The original content, meaning, tone, and narrative flow of the script MUST remain perfectly unchanged. Do NOT rewrite, add, or remove any narration text.
2. Insert sound-effect cues in square brackets immediately after the specific word or phrase they correspond to (e.g., He swung the hammer [heavy thud] down.).
3. Focus on QUALITY over QUANTITY. Create only special, impactful sounds like a roaring fire, a tribal drum beat, or a gunshot, depending on the context. Do NOT add constant ambient noises.
4. Only add sound effects where they significantly improve the listening experience.
5. Output ONLY the enhanced script. No explanations or extra text.

SCRIPT:
${script}
`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.6",
      messages: [{ role: "user", content: prompt }],

    });
    return res.choices[0].message.content.trim() || script;
  } catch (err) {
    logger.warn(`Failed to enhance script with sound effects: ${err.message}`);
    return script;
  }
}

/**
 * Enhance a specific scene's narration with sound effects based on its visual context.
 */
export async function enhanceSceneWithSoundEffects(scenePrompt, narrationChunk) {
  logger.info("🔊 Enhancing scene narration with visual context sound effects...");
  const prompt = `You are a cinematic audio director. Your task is to enhance the provided narration chunk by adding background sound-effect cues that perfectly match the visual scene.

RULES:
1. The original content, meaning, tone, and narrative flow of the narration MUST remain perfectly unchanged. Do NOT rewrite, add, or remove any narration text.
2. Insert sound-effect cues in square brackets immediately after the specific word or phrase they correspond to (e.g., The cannon fired [loud explosion] with immense force.).
3. The sound effects MUST MATCH the visual scene described below. Focus on QUALITY over QUANTITY. Create only special, impactful sounds (e.g., fire crackling, drum beat, gunshot) that directly align with the visual action. Do NOT add generic ambient noise.
4. Output ONLY the enhanced narration. No explanations or extra text.

VISUAL SCENE DESCRIPTION:
${scenePrompt}

NARRATION:
${narrationChunk}
`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.6",
      messages: [{ role: "user", content: prompt }],

    });
    return res.choices[0].message.content.trim() || narrationChunk;
  } catch (err) {
    logger.warn(`Failed to enhance scene with sound effects: ${err.message}`);
    return narrationChunk;
  }
}
