import OpenAI from "openai";
import fs from "fs";
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
Create a detailed outline for a ${length || 40}-minute podcast on "${topic}".
Tone: ${tone}.
Audience: ${audience || "general"}.
Break it into 6–8 major segments.
Each segment should include 3–5 bullet points describing talking ideas.

Return *only valid JSON array*, no explanations, no markdown, no intro text.
Format:
[
  { "segment": "Intro: Setting the Stage", "points": ["...", "..."] },
  { "segment": "Deep Dive into X", "points": ["...", "..."] },
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

      // 🧹 Strip markdown/code fences or extra text
      content = content
        .replace(/^```json\s*/i, "")
        .replace(/^```/, "")
        .replace(/```$/g, "")
        .replace(/^[^{\[]*/, "") // remove anything before first [ or {
        .replace(/[^}\]]*$/g, "") // remove anything after last ] or }
        .trim();

      const outline = JSON.parse(content);

      if (
        !Array.isArray(outline) ||
        !outline.every((s) => s.segment && s.points)
      ) {
        throw new Error("Invalid structure");
      }

      console.log(`✅ Parsed outline with ${outline.length} segments.`);
      return outline;
    } catch (err) {
      console.warn(
        `⚠️ Outline parsing failed (Attempt ${attempt}/${retries}):`,
        err.message
      );
      if (attempt === retries) {
        throw new Error("Invalid outline format from model");
      }
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
You are a skilled podcast narrator.
Write the narration for the segment "${segment.segment}" 
from a podcast on "${topic}".
Tone: ${tone}.
Audience: ${audience}.
Focus on these ideas: ${segment.points.join(", ")}.
Style: conversational, natural, immersive — like someone thinking aloud.
Include light pacing cues like (Pause), (Emphasis), (Beat).
Length: ~900–1100 words.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.9,
  });

  return res.choices[0].message.content.trim();
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

  console.log(`✅ Merged into ${outputFile}`);
}

/* -------------------------------------------------------------------------- */
/* 🎧 STEP 4 — Full Long-Form Podcast Generator (with final Cloudinary upload)*/
/* -------------------------------------------------------------------------- */
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

  // 1️⃣ Generate structured outline
  const outline = await generatePodcastOutline({
    topic,
    tone,
    audience,
    length,
  });

  // 2️⃣ Create temp directory
  const tempDir = path.resolve(`./tmp_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const segments = [];

  // 3️⃣ Generate each segment
  for (let i = 0; i < outline.length; i++) {
    const segment = outline[i];
    console.log(`📝 Segment ${i + 1}/${outline.length}: ${segment.segment}`);

    const script = await generateSegmentScript({
      topic,
      tone,
      audience,
      segment,
    });

    const filename = `segment_${i + 1}.mp3`;
    const audioUrl = await generateVoiceover(script, filename, voice);
    const duration = await getAudioDuration(audioUrl).catch(() => 0);

    // Download from Cloudinary for merging
    const localPath = path.join(tempDir, filename);
    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(localPath, Buffer.from(arrayBuffer));

    segments.push({
      title: segment.segment,
      script,
      audioUrl,
      duration,
    });
  }

  // 4️⃣ Merge all segment mp3s
  const mergedFile = path.join(tempDir, `final_episode_${episodeNo}.mp3`);
  await mergeAudioFiles(tempDir, mergedFile);

  console.log(`✅ Merged final episode: ${mergedFile}`);

  // 5️⃣ Upload merged file to Cloudinary
  console.log(`☁️ Uploading merged file to Cloudinary...`);
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
  console.log(`✅ Uploaded final episode to Cloudinary: ${finalCloudinaryUrl}`);

  const totalDuration = segments.reduce((acc, s) => acc + (s.duration || 0), 0);

  // Clean temp files
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.warn("⚠️ Failed to clean temp dir:", err.message);
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
