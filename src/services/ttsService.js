import OpenAI from "openai";
import fs from "fs";
import path from "path";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate a voiceover from text with a selectable voice.
 * @param {string} script - The text to convert to speech.
 * @param {string} filename - File name for the saved audio.
 * @returns {Promise<string>} - Path to the saved audio file (relative to /public).
 */
export async function generateVoiceover(script, filename) {
    const response = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: "onyx",
        input: script,
    });

    console.log(response)

    // Ensure /public/stories exists
    const outputDir = path.join(process.cwd(), "public", "stories");
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputFile = path.join(outputDir, filename);
    console.log("Saving file to:", outputFile);

    // Write file (response supports .arrayBuffer)
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(outputFile, buffer);

    return `/stories/${filename}`;
}
