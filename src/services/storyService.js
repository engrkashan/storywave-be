import { GoogleGenerativeAI } from "@google/generative-ai";
import { extractFromUrl, transcribeVideo } from "./inputService.js";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generate story outline and script from input text using Gemini
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
    // Extract input text from whichever source
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
            const result = await model.generateContent(prompt);
            text = result.response.text();
            success = true;
        } catch (err) {
            console.error(`Attempt failed. Retries left: ${retries - 1}`);
            if (err.status === 503 && retries > 1) {
                retries--;
                await sleep(2000);
            } else {
                console.error("Error generating story:", err);
                throw err;
            }
        }
    }

    if (!success) {
        throw new Error("Failed to generate story after multiple retries due to a 503 error.");
    }

    // Parse outline & script
    const outlineMatch = text.match(/Outline:\s*(.*?)\s*Script:/s);
    const scriptMatch = text.match(/Script:\s*(.*)/s);

    const outline = outlineMatch ? outlineMatch[1].trim() : "";
    const script = scriptMatch ? scriptMatch[1].trim() : "";

    return { outline, script };
}
