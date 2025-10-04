import fs from "fs";
import OpenAI from "openai";
import path from "path";
import { mergeAudioFiles, getAudioDuration } from "./audioService.js";
import { generateVoiceover } from "./ttsService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate multiple script sections with enhanced delivery instructions.
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
      You are a world-class podcast host.
      Write section ${i} of a ${sections}-part podcast on "${topic}".
      Tone: ${tone}.
      Audience: ${audience || "general listeners"}.
      Conversational and natural flow only.
      STRICT: No speaker labels, no production notes.
      Use delivery cues like (Pause), (Emphasis).
      Around 500 words.
      End with a hook for the next section unless last.
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
 * Full pipeline: scripts -> TTS per section -> merge -> final file -> duration
 */
export async function generatePodcast({
  topic,
  tone,
  length,
  audience,
  episodes,
}) {
  console.log("Starting script generation...");
  const scripts = await generatePodcastScript({
    topic,
    tone,
    length,
    audience,
    episodes,
  });

  const outputDir = path.join(process.cwd(), "public", "podcasts");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const ttsFiles = [];
  const selectedVoice = "onyx";

  console.log(
    `Generating ${scripts.length} voiceover sections using ${selectedVoice} voice...`
  );

  for (let i = 0; i < scripts.length; i++) {
    const filename = `section_${i + 1}_${Date.now()}.mp3`;
    const ttsPath = await generateVoiceover(
      scripts[i],
      filename,
      selectedVoice
    );
    ttsFiles.push(ttsPath);
  }

  // Merge narration sections into one file
  console.log("Merging audio sections...");
  const finalFile = path.join(outputDir, `podcast_${Date.now()}.mp3`);
  await mergeAudioFiles(ttsFiles, finalFile);

  // Clean up temporary section files
  ttsFiles.forEach((file) => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  console.log("Temporary section files removed.");

  // Extract duration
  const duration = await getAudioDuration(finalFile);

  return {
    title: `${topic} Podcast`,
    script: scripts,
    audioURL: `/podcasts/${path.basename(finalFile)}`,
    duration,
  };
}
