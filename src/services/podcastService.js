import OpenAI from "openai";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import { generateVoiceover } from "./ttsService.js";
import { getAudioDuration } from "./audioService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * STEP 1 — Create a detailed outline for a long-form episode
 */
export async function generatePodcastOutline({
  topic,
  tone,
  audience,
  length,
}) {
  const prompt = `
You are a professional podcast writer.
Create a detailed outline for a ${length || 40}-minute podcast on "${topic}".
Tone: ${tone}.
Audience: ${audience || "general"}.
Break it into 6–8 major segments.
Each segment should include 3–5 bullet points describing talking ideas.

Return JSON only in this format:
[
  { "segment": "Intro: Setting the Stage", "points": ["...", "..."] },
  { "segment": "Deep Dive into X", "points": ["...", "..."] },
  ...
]
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
  });

  const content = res.choices[0].message.content.trim();

  try {
    const outline = JSON.parse(content);
    return outline;
  } catch {
    console.error("⚠️ Outline parsing failed. Raw:", content);
    throw new Error("Invalid outline format from model");
  }
}

/**
 * STEP 2 — Generate a detailed narration for each segment
 */
export async function generateSegmentScript({
  topic,
  tone,
  audience,
  segment,
}) {
  const prompt = `
You are a skilled podcast narrator.
Write the narration for the segment "${segment.segment}" 
from a podcast on "${topic}".
Tone: ${tone}.
Audience: ${audience}.
Focus on these ideas: ${segment.points.join(", ")}.
Conversational, natural, immersive.
Include light pacing cues like (Pause), (Emphasis), etc.
Length: ~900–1100 words.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.9,
  });

  return res.choices[0].message.content.trim();
}

/**
 * STEP 3 — Merge multiple audio parts into one MP3
 */
export async function mergeAudioFiles(tempDir, outputFile) {
  const files = fs
    .readdirSync(tempDir)
    .filter((f) => f.endsWith(".mp3"))
    .map((f) => path.join(tempDir, f))
    .sort();

  const listPath = path.join(tempDir, "list.txt");
  fs.writeFileSync(listPath, files.map((f) => `file '${f}'`).join("\n"));

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy"])
      .on("end", resolve)
      .on("error", reject)
      .save(outputFile);
  });

  console.log(`✅ Merged into ${outputFile}`);
}

/**
 * STEP 4 — Full long-form episode generator
 */
export async function generateLongPodcastEpisode({
  topic,
  tone = "engaging and reflective",
  audience = "general listeners",
  length = 40,
  voice = "onyx",
  episodeNo = 1,
}) {
  console.log(
    `🎧 Generating long-form podcast: ${topic} (Episode ${episodeNo})`
  );

  const outline = await generatePodcastOutline({
    topic,
    tone,
    audience,
    length,
  });
  const tempDir = path.resolve(`./tmp_${Date.now()}`);
  fs.mkdirSync(tempDir);

  const segments = [];
  for (let i = 0; i < outline.length; i++) {
    console.log(`📝 Segment ${i + 1}/${outline.length}: ${outline[i].segment}`);
    const script = await generateSegmentScript({
      topic,
      tone,
      audience,
      segment: outline[i],
    });
    const filename = `segment_${i + 1}.mp3`;

    const audioUrl = await generateVoiceover(script, filename, voice);
    const duration = await getAudioDuration(audioUrl).catch(() => 0);

    // Save local for merging
    const localPath = path.join(tempDir, filename);
    fs.writeFileSync(
      localPath,
      Buffer.from(await fetch(audioUrl).then((r) => r.arrayBuffer()))
    );

    segments.push({
      title: outline[i].segment,
      script,
      audioUrl,
      duration,
    });
  }

  const mergedFile = path.join(tempDir, `final_episode_${episodeNo}.mp3`);
  await mergeAudioFiles(tempDir, mergedFile);

  console.log(`🎙️ Episode ${episodeNo} complete.`);

  const totalDuration = segments.reduce((acc, s) => acc + s.duration, 0);

  return {
    episodeTitle: `${topic} — Episode ${episodeNo}`,
    topic,
    audience,
    tone,
    totalDuration,
    segments,
    mergedFile,
  };
}
