import { extractFromUrl, transcribeVideo } from "./inputService.js";
import { createLogger } from "../utils/logger.js";
import OpenAI from "openai";
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
/* 🧩 STEP 0 — Generate Introduction (with characters and beginning)         */
/* -------------------------------------------------------------------------- */
async function generateIntro({
  inputText,
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
      Input context for the story: ${inputText}.
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
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8,
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
      Input context for the story: ${inputText}.
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
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.9,
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
      Input context for the story: ${inputText}.
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
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.9,
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
}) {
  let inputText = textIdea || "";
  if (url) inputText = await extractFromUrl(url);
  if (videoFile) inputText = await transcribeVideo(videoFile);

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

/**
 * Break story into visual scene prompts for image/video generation
 */
export async function generateScenePrompts(storyScript, count = 5, metadata = null, visualSuggestions = null) {
  // ── Step 1: Mechanically split the script into N equal word chunks ──────────
  // Each image represents the exact moment that chunk is being narrated.
  const words = storyScript.split(/\s+/).filter(Boolean);
  const chunkSize = Math.ceil(words.length / count);
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const slice = words.slice(i * chunkSize, (i + 1) * chunkSize).join(" ");
    if (slice.trim()) chunks.push(slice);
  }

  // ── Step 2: Build visual consistency context from metadata ──────────────────
  let consistencyInstructions = "";
  let characterRoster = "";
  if (metadata) {
    const { artStyle, colorPalette, environmentSignature, cinematicSpecs, synopsis, characters } = metadata;
    
    // Build a character ID map so the LLM can tag scenes correctly
    if (characters && characters.length > 0) {
      characterRoster = `
CHARACTER ROSTER (for reference — only tag a character if they naturally appear in this scene):
${characters.map(c => `- ID: "${c.id}" | Name: ${c.name} | ${c.sex || ""}, ${c.age || ""}, ${c.color || ""} | Appearance: ${c.appearance?.slice(0, 120) || ""}`).join("\n")}

IMPORTANT: The character reference images provided to the image model are APPEARANCE/LIKENESS references only — they show what the character looks like (face, skin, hair). The character's ACTION and POSE in the generated image must come entirely from the scene description you write. Do NOT describe the reference image pose.
`;
    }

    consistencyInstructions = `
VISUAL CONSISTENCY RULES (MANDATORY — apply to EVERY prompt):
${visualSuggestions ? `- User Visual Style Note: ${visualSuggestions}` : ""}
- Narrative Synopsis: ${synopsis}
- Art Style: ${artStyle} (Strictly follow this style)
- Color Palette: ${colorPalette} (Lighting and atmosphere)
- Environment: ${environmentSignature}
- Cinematic Specs: ${cinematicSpecs}
- Technical: Choose the most natural shot type for this story beat (wide establishing, medium, over-the-shoulder, aerial, insert, etc.). 8K, HDR. STRICTLY NO TEXT OR LETTERS IN THE IMAGE.
- Coherence: Every image must look like it belongs to the same high-budget ${artStyle} production.`.trim();
  }

  // ── Step 2.5: Pre-analyze scene continuity for wardrobe consistency ─────────
  let outfitContexts = new Array(chunks.length).fill("");
  if (metadata?.characters && metadata.characters.length > 0) {
    const continuityPrompt = `You are a Costume Designer and Script Supervisor.
    
Analyze the following sequential story chunks. Your job is to determine the wardrobe/outfits for the characters across these chunks.
- Group consecutive chunks that happen in the same continuous scene (same time and location).
- For each continuous scene, define the EXACT clothing worn by each character. The clothing MUST stay consistent across all chunks within that continuous scene.
- If the story jumps to a new location or a new day, logically determine if the outfit should change or stay the same.

${characterRoster}

STORY CHUNKS:
${chunks.map((chunk, i) => `[CHUNK ${i}]: ${chunk.slice(0, 300)}...`).join("\n\n")}

OUTPUT FORMAT — Return STRICT valid JSON mapping each chunk index to an outfit description string:
{
  "outfits": [
    {
      "chunkIndex": 0,
      "outfitContext": "Ethan is wearing a tailored charcoal suit with a crisp white shirt, slightly wrinkled from travel. Sarah is wearing a burgundy trench coat over a black turtleneck."
    }
  ]
}`;

    try {
      logger.info("👕 Pre-analyzing script for wardrobe continuity...");
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: continuityPrompt }],
        temperature: 0.2,
        response_format: { type: "json_object" },
      });
      const parsed = JSON.parse(res.choices[0].message.content.trim());
      if (parsed.outfits && Array.isArray(parsed.outfits)) {
        parsed.outfits.forEach(o => {
          if (o.chunkIndex >= 0 && o.chunkIndex < chunks.length) {
            outfitContexts[o.chunkIndex] = o.outfitContext;
          }
        });
      }
      logger.info("✅ Wardrobe continuity analysis complete.");
    } catch (err) {
      logger.warn(`⚠️ Wardrobe continuity analysis failed: ${err.message}. Proceeding without strict wardrobe contexts.`);
    }
  }

  // ── Step 3: Generate one tight prompt per chunk, anchored to opening line ───
  const scenePromises = chunks.map(async (chunk, i) => {
    // The opening sentence is literally what the narrator says when this image appears
    const openingSentence = (chunk.match(/[^.!?]+[.!?]/)?.[0] ?? chunk.slice(0, 150)).trim();

    let wardrobeInstruction = "";
    if (outfitContexts[i]) {
      wardrobeInstruction = `\nWARDROBE INSTRUCTIONS FOR THIS SCENE:\n${outfitContexts[i]}\nIMPORTANT: You must incorporate these exact clothing details into your prompt if the character is visible.`;
    }

    const singlePrompt = `You are a world-class Cinematic Art Director and Storyboard Supervisor.

${consistencyInstructions}

${characterRoster}${wardrobeInstruction}

${SCENE_PROMPT_VERSION_TWO}

NARRATION ANCHOR — this is the exact sentence being SPOKEN when this image appears on screen:
"${openingSentence}"

Full narration chunk (for context only):
"${chunk.slice(0, 500)}"

TASK: Write ONE cinematic image-generation prompt for this exact spoken moment.

Critical Rules:
- The prompt describes a FREEZE-FRAME from a high-budget film — single moment, no motion blur descriptions.
- Determine naturally from the narration: does a specific named character physically appear in this shot, or is it a wide environment/object/action shot? NOT every scene needs a character in frame.
- If a character IS in the scene, describe their PHYSICAL ACTIONS, EXPRESSION, and POSE for this specific moment. DO NOT describe the reference image itself — that is handled separately for likeness matching.
- If the scene is about an environment, object, or abstract moment — write it as such. No need to force a character into frame.
- Choose the shot type that best serves the emotional and narrative beat — wide, medium, two-shot, POV, insert, overhead, etc. Avoid defaulting to close-ups.
- Specify: chosen shot type, subject, lighting, atmosphere, lens, mood.
- STRICTLY NO text, captions, subtitles, or letters in the image.

OUTPUT FORMAT — Return STRICT valid JSON:
{
  "prompt": "The detailed cinematic prompt string (environment, action, lighting, mood, shot type)",
  "charactersInScene": ["list ONLY character IDs from the CHARACTER ROSTER above that physically appear in this specific shot. Use [] if no named character is in frame."]
}`;

    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: singlePrompt }],
        temperature: 0.8,
        max_tokens: 400,
        response_format: { type: "json_object" },
      });
      
      const rawText = res.choices[0].message.content.trim();
      const parsed = JSON.parse(rawText);
      const charIds = (parsed.charactersInScene || []).filter(id => typeof id === "string" && id.startsWith("char_"));
      
      logger.info(`✅ Scene ${i + 1}/${chunks.length}: "${parsed.prompt.slice(0, 80)}..." | chars: [${charIds.join(", ") || "none"}]`);
      return { prompt: parsed.prompt, charactersInScene: charIds };
    } catch (err) {
      logger.warn(`⚠️ Scene ${i + 1} prompt failed: ${err.message} — using opening sentence fallback`);
      return { prompt: openingSentence, charactersInScene: [] };
    }
  });

  try {
    const scenes = await Promise.all(scenePromises);
    logger.info(`✅ Generated ${scenes.length} chunk-anchored scene prompts`);
    return scenes;
  } catch (err) {
    logger.error("Failed to generate scene prompts:", err);
    return [];
  }
}

async function summarizeText(text) {
  const summaryPrompt = `Summarize the following text in under 800 words focusing only on the main ideas, tone, and narrative elements:\n\n${text.slice(
    0,
    15000
  )}`;
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: summaryPrompt }],
    temperature: 0.5,
  });
  return result.choices?.[0]?.message?.content?.trim() || text.slice(0, 5000);
}
