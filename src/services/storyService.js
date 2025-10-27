import OpenAI from "openai";
import { extractFromUrl, transcribeVideo } from "./inputService.js";
import { log } from "console";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* 🧩 STEP 1 — Generate a structured outline (6–10 segments/chapters)        */
/* -------------------------------------------------------------------------- */
async function generateStoryOutline({
  inputText,
  storyType,
  voiceTone,
  minutes,
  retries = 2,
}) {
  const segmentCount = Math.min(10, Math.max(6, Math.floor(minutes / 5))); // e.g., 6 for 30 min, up to 10 for >50 min
  const prompt = `
      You are a professional creative storyteller.
      Create a detailed outline for a single, cohesive ${minutes}-minute ${storyType} story.
      Tone: ${voiceTone}.
      Break it into ${segmentCount} major chapters or scenes to build engagement through rising tension, character development, twists, and cliffhangers at chapter ends.
      Each chapter should have 3–5 concise bullet points describing key events, emotions, and plot progression.
      Ensure the overall story arc maintains listener interest with pacing, suspense, and vivid elements.
      Input context for the story: ${inputText}.
      Do NOT include:
      - greetings or introductions
      - music cues
      - narration directions
      - filler content
      Return ONLY valid JSON in this format:
      [
        { "chapter": "Chapter Title", "points": ["Point 1", "Point 2", "..."] },
        ...
      ]
`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8,
      });

      let content = res.choices[0].message.content.trim();
      content = content
        .replace(/^```json\s*/i, "")
        .replace(/```$/g, "")
        .trim();
      const outline = JSON.parse(content);

      if (
        !Array.isArray(outline) ||
        !outline.every((s) => s.chapter && s.points)
      ) {
        throw new Error("Invalid structure");
      }

      return outline;
    } catch (err) {
      console.warn(`Outline parsing failed (Attempt ${attempt}):`, err.message);
      if (attempt === retries)
        throw new Error("Invalid outline format from model");
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 🧠 STEP 2 — Generate script for each chapter                               */
/* -------------------------------------------------------------------------- */
async function generateChapterScript({
  inputText,
  storyType,
  voiceTone,
  chapter,
  chapterIndex,
  totalChapters,
}) {
  const prompt = `
    You are a professional creative storyteller.
    Write the full narrative script for chapter ${chapterIndex + 1} of ${totalChapters} in a single, lengthy ${storyType} story.
    Tone: ${voiceTone}.
    Focus only on these plot points: ${chapter.points.join(", ")}.
    Build on the overall story context: ${inputText}.
    Ensure engagement with vivid descriptions, dialogue, internal thoughts, suspense, and a cliffhanger or hook to transition to the next chapter.
    Do NOT include:
    - chapter titles or headings
    - greetings or stage directions
    - music cues
    - filler content
    Start directly with the narrative.
    Length: ~${Math.floor(150 * (chapterIndex + 1) / totalChapters * 1.5)} words (adjust for pacing to keep interest high).
    Return only the plain text narrative.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.9,
    // max_tokens: 2000,
  });

  // Clean up any stray elements
  let script = res.choices[0].message.content.trim();
  script = script
    .split("\n")
    .filter((line) => !/^[\[\🎙️]/.test(line) && !line.startsWith("Chapter"))
    .join("\n");

  return script;
}

export async function generateStory({
  textIdea,
  url,
  videoFile,
  storyType = "fiction",
  voiceTone = "neutral",
  storyLength = "30 minutes",
}) {
  let inputText = textIdea || "";
  if (url) inputText = await extractFromUrl(url);
  if (videoFile) inputText = await transcribeVideo(videoFile);

  if (!inputText || inputText.trim().length < 50) {
    throw new Error("Insufficient or invalid input content.");
  }

  // 🔪 Limit token size before prompt (trim or summarize)
  if (inputText.length > 8000) {
    console.log("🧹 Input too long, summarizing before story generation...");
    const summaryPrompt = `Summarize the following text in under 800 words focusing only on the main ideas, tone, and narrative elements:\n\n${inputText.slice(
      0,
      15000
    )}`;
    const summary = await summarizeText(summaryPrompt);
    inputText = summary;
  }

  // Parse storyLength to get minutes (e.g., "30 minutes" -> 30)
  const minutes = Math.max(10, parseInt(storyLength * 10) || 30); // Min 10, no upper limit but prompt mentions up to 50+
  console.log(`📝 Story length: ${minutes} minutes`);
  // Generate outline
  const outline = await generateStoryOutline({
    inputText,
    storyType,
    voiceTone,
    minutes,
  });

  // Generate scripts for each chapter
  let fullScript = "";
  for (let i = 0; i < outline.length; i++) {
    const chapter = outline[i];
    const script = await generateChapterScript({
      inputText,
      storyType,
      voiceTone,
      chapter,
      chapterIndex: i,
      totalChapters: outline.length,
    });
    fullScript += script + "\n\n"; // Separate chapters slightly for flow
  }

  // Format outline as bullet points string
  const outlineText = outline
    .map(
      (ch) => `- **${ch.chapter}**\n  ${ch.points.map((p) => `- ${p}`).join("\n  ")}`
    )
    .join("\n");

  return {
    outline: outlineText || "No outline generated.",
    script: fullScript.trim(),
  };
}

async function summarizeText(summaryPrompt) {
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: summaryPrompt }],
    temperature: 0.5,
    // max_tokens: 1500,
  });
  return result.choices?.[0]?.message?.content?.trim() || "";
}