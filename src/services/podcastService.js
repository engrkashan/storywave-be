import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import OpenAI from "openai";
import path from "path";
import { mixPodcast } from "./audioService.js";
import { generateVoiceover } from "./ttsService.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate multiple script sections with enhanced delivery instructions.
 */
export async function generatePodcastScript({ topic, tone, length, audience }) {
  let sections = 3;
  if (length === "short") sections = 2;
  if (length === "medium") sections = 4;
  if (length === "long") sections = 6;

  const scripts = [];

  for (let i = 1; i <= sections; i++) {
    const prompt = `
      You are a world-class, professional male podcast host and scriptwriter.
      Write section ${i} of a ${length} podcast on "${topic}".
      Tone: ${tone}.
      Audience: ${audience || "general listeners"}.
      Structure: Write a dynamic, engaging script with a natural conversational flow, using contractions and informal language appropriate for a podcast.
      
      CRITICAL for Realism: Include specific delivery notes for the voice model to follow, using parentheses. These enhance pacing and tone:
      - (Pause) for natural breaths or dramatic effect.
      - (Emphasis) on key words.
      - (Slight chuckle) or (Whispering) for specific moods.
      - (Deepens voice) for a serious point.
      - (Speaks quickly) or (Speaks slowly) for pacing.
      
      Length: around 500 words per section.
      End with a strong, expressive hook for the next section if not the last one.
    `;

    // Using gpt-4o-mini for better comprehension of complex delivery instructions
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", 
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9, // Higher temperature for more creative, expressive scripts
    });

    const script = response.choices[0].message.content;
    scripts.push(script);
  }

  return scripts;
}

/**
 * Merge multiple audio files into one MP3 using fluent-ffmpeg.
 */
async function mergeAudioFiles(files, outputFile) {
  return new Promise((resolve, reject) => {
    const ffmpegCommand = ffmpeg();

    files.forEach((file) => ffmpegCommand.input(file));

    ffmpegCommand
      .on("error", (err) => {
        console.error("FFMPEG Merge Error:", err);
        reject(err);
      })
      .on("end", () => {
        console.log(`Audio merged successfully to ${outputFile}`);
        resolve(outputFile);
      })
      // Use complex filter to ensure proper concatenation
      .complexFilter([
          { filter: 'concat', options: { n: files.length, v: 0, a: 1 }, outputs: 'aout' }
      ], 'aout')
      .outputOptions([
          '-map aout',
          '-c:a libmp3lame',
          '-q:a 2' // High-quality VBR encoding
      ])
      .save(outputFile);
  });
}

/**
 * Full pipeline: scripts -> TTS per section (using 'onyx' male voice) -> merge -> mix
 */
export async function generatePodcast({ topic, tone, length, audience }) {
  console.log("Starting script generation...");
  const scripts = await generatePodcastScript({
    topic,
    tone,
    length,
    audience,
  });

  const outputDir = path.join(process.cwd(), "public", "podcasts");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const ttsFiles = [];
  const selectedVoice = 'onyx'; // Set male voice here

  console.log(`Generating ${scripts.length} voiceover sections using ${selectedVoice} voice...`);
  // Generate narration per section
  for (let i = 0; i < scripts.length; i++) {
    const filename = `section_${i + 1}_${Date.now()}.mp3`;
    // Pass the male voice ('onyx') to the TTS service
    const ttsPath = await generateVoiceover(scripts[i], filename, selectedVoice); 
    ttsFiles.push(ttsPath);
  }

  // Merge narration into one file
  console.log("Merging audio sections...");
  const narrationFile = path.join(outputDir, `narration_${Date.now()}.mp3`);
  await mergeAudioFiles(ttsFiles, narrationFile);

  // Clean up temporary section files
  ttsFiles.forEach(file => fs.unlinkSync(file));
  console.log("Temporary section files removed.");


  // Add intro/outro music, ducking, etc.
  console.log("Mixing final podcast...");
  const finalFile = path.join(outputDir, `podcast_${Date.now()}.mp3`);
  // Assuming mixPodcast is implemented in audioService.js
  await mixPodcast(narrationFile, finalFile);
  
  // Clean up intermediate narration file
  fs.unlinkSync(narrationFile);
  console.log("Intermediate narration file removed.");


  return {
    title: `${topic} Podcast`,
    script: scripts,
    audioURL: `/podcasts/${path.basename(finalFile)}`,
  };
}
