import OpenAI from "openai";
import fs from "fs";
import {cloudinary} from "../config/cloudinary.config.js";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import { generateVoiceover } from "./ttsService.js";
import { getAudioDuration } from "./audioService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* -------------------------------------------------------------------------- */
/* 🧩 STEP 1 — Generate a structured outline (6–8 segments)                   */
/* -------------------------------------------------------------------------- */
export async function generatePodcastOutline({
  topic,
  tone,
  audience,
  length,
  retries = 2,
}) {
  const prompt = `
      You are a professional podcast writer.
      Create a detailed outline for a ${
        length || 40
      }-minute podcast on "${topic}".
      Tone: ${tone}.
      Audience: ${audience || "general"}.
      Break it into 6–8 major segments.
      Each segment should have 3–5 concise bullet points.
      Do NOT include:
      - greetings or welcomes
      - music cues
      - narration stage directions
      - filler or unrelated content
      Return ONLY valid JSON in this format:
      [
        { "segment": "Segment Title", "points": ["Point 1", "Point 2", "..."] },
        ...
      ]
`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8,
      });

      let content = res.choices[0].message.content.trim();
      content = content
        .replace(/^```json\s*/i, "")
        .replace(/```$/g, "")
        .trim();
      const outline = JSON.parse(content);

      if (
        !Array.isArray(outline) ||
        !outline.every((s) => s.segment && s.points)
      ) {
        throw new Error("Invalid structure");
      }

      return outline;
    } catch (err) {
      console.warn(`Outline parsing failed (Attempt ${attempt}):`, err.message);
      if (attempt === retries)
        throw new Error("Invalid outline format from model");
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 🧠 STEP 2 — Generate script for each segment                               */
/* -------------------------------------------------------------------------- */
export async function generateSegmentScript({
  topic,
  tone,
  audience,
  segment,
}) {
  const prompt = `
    You are a professional podcast writer.
    Write the narration script for the segment "${
      segment.segment
    }" of a podcast on "${topic}".
    Tone: ${tone}.
    Audience: ${audience}.
    Focus only on these ideas: ${segment.points.join(", ")}.
    Do NOT include:
    - greetings or welcomes
    - music cues or sound directions
    - narration stage directions
    - filler or unrelated content
    Start directly with the topic content.
    Length: ~900–1100 words.
    Return only the text content.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
  });

  // Optional post-processing to remove stray stage directions or brackets
  let script = res.choices[0].message.content.trim();
  script = script
    .split("\n")
    .filter((line) => !/^[\[\🎙️]/.test(line))
    .join("\n");

  return script;
}

/* -------------------------------------------------------------------------- */
/* 🎚️ STEP 3 — Merge audio parts into one MP3                                */
/* -------------------------------------------------------------------------- */
export async function mergeAudioFiles(tempDir, outputFile) {
  const files = fs
    .readdirSync(tempDir)
    .filter((f) => f.endsWith(".mp3"))
    .map((f) => path.join(tempDir, f))
    .sort();
  if (!files.length) throw new Error("No audio files found to merge.");

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
}

/* -------------------------------------------------------------------------- */
/* 🎧 STEP 4 — Full Long-Form Podcast Generator                               */
/* -------------------------------------------------------------------------- */
export async function generateLongPodcastEpisode({
  topic,
  tone = "engaging and reflective",
  audience = "general listeners",
  length = 40,
  voice = "onyx",
  episodeNo = 1,
}) {
  // Generate outline
  const outline = await generatePodcastOutline({
    topic,
    tone,
    audience,
    length,
  });

  const tempDir = path.resolve(`./tmp_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const segments = [];

  for (let i = 0; i < outline.length; i++) {
    const segment = outline[i];

    const script = await generateSegmentScript({
      topic,
      tone,
      audience,
      segment,
    });

    const filename = `segment_${i + 1}.mp3`;
    const audioUrl = await generateVoiceover(script, filename, voice);
    const duration = await getAudioDuration(audioUrl).catch(() => 0);

    const localPath = path.join(tempDir, filename);
    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(localPath, Buffer.from(arrayBuffer));

    segments.push({ title: segment.segment, script, audioUrl, duration });
  }

  const mergedFile = path.join(tempDir, `final_episode_${episodeNo}.mp3`);
  await mergeAudioFiles(tempDir, mergedFile);

  const uploadRes = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "podcasts/final",
        resource_type: "video",
        public_id: path.basename(mergedFile, ".mp3"),
        format: "mp3",
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    fs.createReadStream(mergedFile).pipe(stream);
  });

  const finalCloudinaryUrl = uploadRes.secure_url;

  const totalDuration = segments.reduce((acc, s) => acc + (s.duration || 0), 0);

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.warn("Failed to clean temp dir:", err.message);
  }

  return {
    episodeTitle: `${topic} — Episode ${episodeNo}`,
    topic,
    audience,
    tone,
    totalDuration,
    segments,
    mergedFileUrl: finalCloudinaryUrl,
  };
}
