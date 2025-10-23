import OpenAI from "openai";
import { extractFromUrl, transcribeVideo } from "./inputService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function generateStory({
  textIdea,
  url,
  videoFile,
  storyType = "fiction",
  voiceTone = "neutral",
  storyLength = "medium",
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

  const prompt = `
You are a professional creative writer.
Create a ${storyLength}-length, immersive, and original **${storyType}** story.
Tone: ${voiceTone}.

Input context:
${inputText}

Output Format (strictly):
Outline:
- bullet points

Script:
Full story text
`;

  let retries = 3;
  let text = "";

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🧠 Generating story (attempt ${attempt}/${retries})...`);
      const result = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a disciplined creative storyteller. Be structured, clear, and vivid.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.9,
        max_tokens: 3000,
      });

      text = result.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("Empty response from model.");

      break; // success
    } catch (err) {
      console.error(
        `⚠️ Story generation attempt ${attempt} failed:`,
        err.message
      );
      if (attempt === retries)
        throw new Error(
          `Story generation failed after ${retries} retries: ${err.message}`
        );
      await sleep(2000 * attempt);
    }
  }

  const outlineMatch = text.match(/Outline:\s*(.*?)\s*Script:/s);
  const scriptMatch = text.match(/Script:\s*(.*)/s);

  return {
    outline: outlineMatch?.[1]?.trim() || "No outline generated.",
    script: scriptMatch?.[1]?.trim() || text,
  };
}

async function summarizeText(summaryPrompt) {
  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: summaryPrompt }],
    temperature: 0.5,
    max_tokens: 1500,
  });
  return result.choices?.[0]?.message?.content?.trim() || "";
}
