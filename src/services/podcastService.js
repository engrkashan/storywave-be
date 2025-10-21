import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { getAudioDuration } from "./audioService.js";
import { generateVoiceover } from "./ttsService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate multiple script sections (one per episode)
 */
export async function generatePodcastScript({
  topic,
  tone,
  length,
  audience,
  episodes,
}) {
  let sections = episodes || 3;

  if (typeof length === "string") {
    if (length === "short") sections = 2;
    if (length === "medium") sections = 4;
    if (length === "long") sections = 6;
  }

  const scripts = [];

  for (let i = 1; i <= sections; i++) {
    const prompt = `
      You are an expert storyteller and conversational writer.
      Write episode ${i} of a ${sections}-part podcast on "${topic}".
      Tone: ${tone}.
      Audience: ${audience || "general listeners"}.
      Conversational, natural, immersive style — like someone thinking out loud or discussing ideas with energy and flow.

      ❌ DO NOT start with greetings, intros, or phrases like "Welcome", "In this episode", "Thanks for listening", etc.
      ✅ Start immediately with the main discussion — like jumping straight into the topic mid-conversation.
      No speaker labels, no production directions.
      Use subtle natural cues like (Pause), (Emphasis) where they enhance flow.
      Aim for around 500 words.
      If this is not the last episode, end with a subtle teaser leading into the next one.
    `;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
    });

    scripts.push(response.choices[0].message.content.trim());
  }

  return scripts;
}

/**
 * Full generation pipeline:
 * scripts -> voiceover per episode -> store metadata
 */
export async function generatePodcast({
  topic,
  tone,
  length,
  audience,
  episodes,
}) {
  console.log("Starting podcast generation...");
  const scripts = await generatePodcastScript({
    topic,
    tone,
    length,
    audience,
    episodes,
  });

  const outputDir = path.join(process.cwd(), "public", "podcasts");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const selectedVoice = "onyx";
  const episodeData = [];

  for (let i = 0; i < scripts.length; i++) {
    const filename = `podcast_episode_${i + 1}_${Date.now()}.mp3`;
    const ttsPath = await generateVoiceover(
      scripts[i],
      filename,
      selectedVoice
    );

    const duration = await getAudioDuration(ttsPath);

    episodeData.push({
      title: `${topic} — Episode ${i + 1}`,
      script: scripts[i],
      audioURL: `/podcasts/${path.basename(ttsPath)}`,
      duration,
      episodeNo: i + 1,
    });
  }

  return {
    title: `${topic} Podcast`,
    audience,
    episodes: episodeData,
  };
}
