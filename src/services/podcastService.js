import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { generateVoiceover } from "./ttsService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate a podcast script using GPT
 * @param {Object} options
 * @param {string} options.topic - Main theme or subject of the podcast
 * @param {string} options.tone - e.g. casual, professional, humorous
 * @param {string} options.length - short, medium, long (affects word count)
 * @param {string} options.audience - who it is for (optional)
 */
export async function generatePodcastScript({ topic, tone, length, audience }) {
  let wordCount = 500;
  if (length === "short") wordCount = 300;
  if (length === "medium") wordCount = 600;
  if (length === "long") wordCount = 1000;

  const prompt = `
You are a podcast scriptwriter.
Write a ${length} podcast script about "${topic}".
Tone: ${tone}.
Target audience: ${audience || "general listeners"}.
Make it engaging, structured (intro, main discussion, conclusion), 
and about ${wordCount} words long.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
  });

  const script = response.choices[0].message.content;
  return script;
}

/**
 * Full pipeline: script -> TTS -> audio file
 */
export async function generatePodcast({ topic, tone, length, audience }) {
  const script = await generatePodcastScript({ topic, tone, length, audience });

  const uniqueFilename = `podcast_${Date.now()}.mp3`;
  const audioFile = await generateVoiceover(script, uniqueFilename);

  return {
    title: `${topic} Podcast`,
    script,
    audioURL: `/audios/${uniqueFilename}`,
  };
}
