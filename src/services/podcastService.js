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
      ❌ No greetings or intro phrases.
      ✅ Jump straight into the discussion.
      Use (Pause), (Emphasis) where it improves rhythm.
      Around 500 words.
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
 * Full generation pipeline: scripts → voiceover → Cloudinary → metadata
 */
export async function generatePodcast({
  topic,
  tone,
  length,
  audience,
  episodes,
}) {
  console.log("🎙️ Starting podcast generation...");
  const scripts = await generatePodcastScript({
    topic,
    tone,
    length,
    audience,
    episodes,
  });

  const selectedVoice = "onyx";
  const episodeData = [];

  for (let i = 0; i < scripts.length; i++) {
    const filename = `podcast_episode_${i + 1}_${Date.now()}.mp3`;
    const audioURL = await generateVoiceover(
      scripts[i],
      filename,
      selectedVoice
    );

    // Optional: Get duration via ffmpeg if you want to include it
    const duration = await getAudioDuration(audioURL).catch(() => 0);

    episodeData.push({
      title: `${topic} — Episode ${i + 1}`,
      script: scripts[i],
      audioURL, 
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
