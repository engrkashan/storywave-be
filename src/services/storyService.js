import OpenAI from "openai";
import { extractFromUrl, transcribeVideo } from "./inputService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function generateStory({
  textIdea,
  url,
  videoFile,
  storyType,
  voiceTone = "neutral",
  storyLength = "medium",
}) {
  let inputText = textIdea || "";
  if (url) inputText = await extractFromUrl(url);
  if (videoFile) inputText = await transcribeVideo(videoFile);

  if (!inputText || inputText.trim().length < 50) {
    throw new Error("Insufficient or invalid input content.");
  }

  const prompt = `
      You are a professional creative writer.
      Create a ${storyLength}-length, immersive, and original **${storyType}** story.
      Tone: ${voiceTone}.

      Input:
      ${inputText}

      Format strictly as:

      Outline:
      - bullet points

      Script:
      Full story text
`;

  let retries = 3,
    text = "";
  while (retries--) {
    try {
      const result = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a disciplined creative storyteller.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.85,
        max_tokens: 2000,
      });
      text = result.choices[0].message.content?.trim();
      if (text) break;
    } catch (err) {
      if (!retries) throw new Error("Story generation failed after retries.");
      await sleep(2000);
    }
  }

  const outlineMatch = text.match(/Outline:\s*(.*?)\s*Script:/s);
  const scriptMatch = text.match(/Script:\s*(.*)/s);

  return {
    outline: outlineMatch?.[1]?.trim() || "No outline generated.",
    script: scriptMatch?.[1]?.trim() || text,
  };
}
