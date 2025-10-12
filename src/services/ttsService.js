import fs from "fs";
import OpenAI from "openai";
import path from "path";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Cleans the script by removing common markdown artifacts but preserves
 * parentheses, as the new script prompt uses them for expressive delivery notes.
 */
function cleanScript(rawScript) {
  if (typeof rawScript !== "string") {
    rawScript = String(rawScript || "");
  }

  // Preserve content in parentheses (our delivery notes)
  return rawScript
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/#+\s/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/Target Audience:.*\n?/gi, "")
    .replace(/Length:.*\n?/gi, "")
    .replace(/End of Script/gi, "")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

/**
 * Generate TTS audio from a script chunk using the specified voice.
 * @param {string} script - The text to convert to speech.
 * @param {string} filename - The name for the output MP3 file.
 * @param {string} [voice='onyx'] - The desired OpenAI voice ('onyx' is a male voice).
 * @returns {Promise<string>} The path to the generated MP3 file.
 */
export async function generateVoiceover(script, filename, voice = "onyx") {
  const selectedVoice = voice || "onyx";

  const outputDir = path.join(process.cwd(), "public", "stories");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const cleaned = cleanScript(script);

  try {
    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: selectedVoice,
      input: cleaned,
    });

    const outputFile = path.join(outputDir, filename);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputFile, buffer);

    console.log(
      `Voiceover generated for ${filename} using voice ${selectedVoice}`
    );
    return outputFile;
  } catch (error) {
    console.error(`Error generating voiceover for ${filename}:`, error);
    throw new Error(`TTS generation failed: ${error.message}`);
  }
}
