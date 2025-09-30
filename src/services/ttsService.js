import OpenAI from "openai";
import fs from "fs";
import path from "path";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate a voiceover from text with expressive cues
 * @param {string} script - Podcast script with emotions
 * @param {string} filename - Saved MP3 name
 */
export async function generateVoiceover(script, filename) {
  // Ensure /public/stories exists
  const outputDir = path.join(process.cwd(), "public", "stories");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const response = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "nova", // "aria" or "verse" are more expressive than "onyx"
    input: script,
  });

  const outputFile = path.join(outputDir, filename);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputFile, buffer);

  return `/stories/${filename}`;
}
