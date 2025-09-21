import OpenAI from "openai";
import { extractFromUrl, transcribeVideo } from "./inputService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generate story outline and script from input text using OpenAI
 * @param {object} options
 * @param {string} options.textIdea - The core idea for the story.
 * @param {string} [options.url] - Optional reference URL.
 * @param {string} [options.videoFile] - Optional uploaded video/file.
 * @param {string} options.storyType - Genre (Horror, Fantasy, Comedy, etc).
 * @param {string} [options.voiceTone] - Style/tone of storytelling (dramatic, funny, mysterious).
 * @param {string} [options.storyLength] - Desired length (short, medium, long).
 */
export async function generateStory({
    textIdea,
    url,
    videoFile,
    storyType,
    voiceTone = "neutral",
    storyLength = "medium",
}) {
    // Extract input text
    let inputText = textIdea;
    if (url) inputText = await extractFromUrl(url);
    if (videoFile) inputText = await transcribeVideo(videoFile);

    // Build prompt
    const prompt = `
        You are an expert storyteller and creative writer.  
        **Your Task**:  
        - Take the following idea (may be text, URL extract, or transcript).  
        - Create a **${storyLength} length, engaging, and original story**.  
        - Genre: ${storyType}  
        - Tone: ${voiceTone}  

        **Requirements**:  
        1. Provide a concise **Outline** summarizing the main plot and structure.  
        2. Write a **Script** with immersive narration, dialogue, and vivid details.  

        **Idea / Inspiration**:  
        ${inputText}

        **Format strictly**:
        Outline:
        - ...

        Script:
        - ...
    `;

    let retries = 3;
    let success = false;
    let text = "";

    while (retries > 0 && !success) {
        try {
            const result = await openai.chat.completions.create({
                model: "gpt-4o-mini", // or "gpt-4o" if you want better quality
                messages: [
                    { role: "system", content: "You are a creative writing assistant." },
                    { role: "user", content: prompt },
                ],
                temperature: 0.8,
            });

            text = result.choices[0].message.content;
            success = true;
        } catch (err) {
            console.error(`Attempt failed. Retries left: ${retries - 1}`, err.message);
            if (retries > 1) {
                retries--;
                await sleep(2000);
            } else {
                throw new Error("Failed to generate story after multiple retries.");
            }
        }
    }

    // Parse outline & script
    const outlineMatch = text.match(/Outline:\s*(.*?)\s*Script:/s);
    const scriptMatch = text.match(/Script:\s*(.*)/s);

    const outline = outlineMatch ? outlineMatch[1].trim() : "";
    const script = scriptMatch ? scriptMatch[1].trim() : "";

    return { outline, script };
}
