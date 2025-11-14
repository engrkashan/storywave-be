import fs from "fs";
import path from "path";
import prisma from "../config/prisma.client.js";
import { generateImage } from "./imageService.js";
import {
  extractContentFromUrl,
  extractFromUrl,
  transcribeVideo,
} from "./inputService.js";
import { generateStory } from "./storyService.js";
import { createVideo } from "./videoService.js";
import { cloudinary } from "../config/cloudinary.config.js";
import { generateVoiceover } from "./generateVoiceoverService.js";
import { transcribeWithTimestamps } from "./transcribeService.js";
import { deleteTempFiles } from "../utils/deleteTemp.js";

const TEMP_DIR = path.resolve(process.cwd(), "temp");
fs.mkdirSync(TEMP_DIR, { recursive: true });

const log = (msg, color = "\x1b[36m") => {
  const time = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`${color}[${time}] ${msg}\x1b[0m`);
};

function uploadLargePromise(filePath, options) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_large(filePath, options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

// Upload video to Cloudinary
async function uploadVideoToCloud(videoPath, filename) {
  const stats = fs.statSync(videoPath);
  console.log(
    "📦 Video size before upload:",
    (stats.size / 1024 / 1024).toFixed(2),
    "MB"
  );

  const uploaded = await uploadLargePromise(videoPath, {
    resource_type: "video",
    folder: "videos",
    public_id: path.parse(filename).name,
    chunk_size: 6000000,
    overwrite: true,
  });
  log(`✅ Video uploaded to Cloudinary: ${uploaded}`);
  return uploaded.secure_url;
}

function generateThumbnailPrompt(title, storyType) {
  const genres = {
    true_crime_fiction_cinematic: {
      style: "cinematic Netflix-style true-crime artwork",
      elements: "dark alleys, blurred police lights, cryptic evidence objects",
      colors: "moody reds, deep shadows, noir tones",
      mood: "intense, dramatic, suspense-filled",
    },

    true_crime_nonfiction_forensic: {
      style: "realistic forensic documentary visual",
      elements:
        "crime scene markers, fingerprint overlays, forensic tools, evidence closeups",
      colors: "cool blues, sterile whites, forensic lab tones",
      mood: "analytical, investigative, unbiased",
    },

    manipulation_sexual_manipulation: {
      style: "mature psychological manipulation symbolism",
      elements:
        "broken masks, tangled strings, shadowy silhouettes, metaphorical tension",
      colors: "dark purples, muted reds, deep dramatic contrasts",
      mood: "intense, psychological, emotionally charged",
    },

    cultural_history_documentary: {
      style: "National Geographic-style cultural documentary artwork",
      elements:
        "heritage artifacts, historical textures, symbolic cultural patterns",
      colors: "earthy tones, warm natural hues",
      mood: "educational, respectful, culturally rich",
    },

    homesteading_howto_field_guide: {
      style: "rustic, practical homesteading field-guide illustration",
      elements:
        "tools, wooden textures, garden elements, simple natural objects",
      colors: "greens, browns, softly lit outdoor tones",
      mood: "practical, peaceful, self-sufficient",
    },

    work_and_trades_shop_manual: {
      style: "technical how-to shop manual artwork",
      elements: "tools, machinery diagrams, workshop parts, reference shapes",
      colors: "industrial grays, metallic tones, clean technical colors",
      mood: "instructive, clear, mechanical",
    },

    work_and_trades_shopfloordoc: {
      style: "real-world shop-floor documentary style",
      elements: "factory environment, tools, workbenches, mechanical details",
      colors: "industrial tones, steel blues, warm highlights",
      mood: "authentic, gritty, hands-on",
    },

    investigative_discovery_journalistic: {
      style: "journalistic investigative documentary artwork",
      elements:
        "documents, maps, red string connections, headlines, evidence boards",
      colors: "cool investigative blues with high contrast shadows",
      mood: "urgent, analytical, truth-seeking",
    },

    storytelling_cinematic: {
      style: "dramatic cinematic movie-style illustration",
      elements:
        "symbolic objects based on the title, dramatic lighting, atmospheric depth",
      colors: "rich cinematic tones",
      mood: "emotional, visual, immersive",
    },

    conversation_narrated_documentary: {
      style: "blended narrated-documentary visual style",
      elements:
        "voice-wave graphics, symbolic objects from the story, soft documentary textures",
      colors: "neutral documentary tones with warm highlights",
      mood: "thoughtful, reflective, narrative-driven",
    },

    education_howto_trades: {
      style: "clear instructional educational trades illustration",
      elements: "tools, diagrams, step-by-step symbolic objects",
      colors: "clean, bright educational palette",
      mood: "practical, clear, helpful",
    },
  };

  const g = genres[storyType];

  return `
Create a highly detailed, cinematic 16:9 digital illustration based on the story titled "${title}". 
Style: ${g.style}. 
Include elements such as: ${g.elements}. 
Color palette: ${g.colors}. 
Mood: ${g.mood}. 
No text. Ultra-sharp, visually striking, thumbnail-quality artwork.
  `.trim();
}

export async function runWorkflow({
  adminId,
  title,
  url,
  videoFile,
  textIdea,
  storyType,
  voiceTone,
  storyLength,
}) {
  log(`🚀 Starting workflow: "${title}"`);

  const workflow = await prisma.workflow.create({
    data: { title, type: "STORY", status: "PENDING", adminId, metadata: {} },
  });
  log(`Workflow record created (ID: ${workflow.id})`);

  let srtPath; // Define srtPath outside try/catch for cleanup

  try {
    // 1️⃣ Prepare input (UNMODIFIED)
    log("Step 1: Preparing input text...");
    let inputText = textIdea || "";
    if (url) {
      log("Extracting text from URL...");
      inputText = await extractContentFromUrl(url);
    }

    if (videoFile) {
      log("Transcribing video to text...");
      inputText = await transcribeVideo(videoFile);
    }
    log(`Input text: ${inputText}`);
    if (!inputText || inputText.trim().length < 50)
      throw new Error("Invalid or empty input text.");

    await prisma.input.create({
      data: {
        type: url ? "URL" : videoFile ? "VIDEO" : "TEXT",
        source: url || videoFile || "TEXT",
        processed: true,
        workflowId: workflow.id,
      },
    });

    // 2️⃣ Generate story (UNMODIFIED)
    log("Step 2: Generating story...");
    const { outline, script } = await generateStory({
      textIdea: inputText,
      storyType,
      voiceTone,
      storyLength,
    });

    console.log("Generated Story Outline:", outline);
    console.log("Generated Story Script:", script);

    const story = await prisma.story.create({
      data: { title, outline, content: script, adminId },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { storyId: story.id },
    });

    // 3️⃣ Voiceover (UNMODIFIED)
    log("Step 3: Generating voiceover...");
    const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
    const { url: voiceURL, localPath: voiceLocalPath } =
      await generateVoiceover(script, voiceFilename);

    console.log("VOICE URL", voiceURL);
    await prisma.voiceover.create({
      data: { script, audioURL: voiceURL, workflowId: workflow.id, adminId },
    });

    log("Step 4: Generating a single image for the entire story...");

    const storyPrompt = generateThumbnailPrompt(title, storyType);
    console.log("Story Prompt: ",storyPrompt);

    let imageUrl = null;

    while (!imageUrl) {
      try {
        imageUrl = await generateImage(storyPrompt, 1);

        if (!imageUrl || !fs.existsSync(imageUrl)) {
          log("⚠️ Image file missing after generation. Retrying...");
          imageUrl = null;
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        const size = fs.statSync(imageUrl).size;
        if (size < 5000) {
          log("⚠️ Image seems corrupted (too small). Retrying...");
          imageUrl = null;
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        log("✅ Single image generated successfully.");
      } catch (err) {
        log(`❌ Image generation failed: ${err.message}`);
        log("🔁 Retrying in 5 seconds...");
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    // await prisma.media.create({
    //   data: {
    //     type: "IMAGE",
    //     fileUrl: imageUrl,
    //     fileType: "image/png",
    //     workflow: { connect: { id: workflow.id } },
    //     metadata: { prompt: storyPrompt },
    //   },
    // });
    

    // 5️⃣ Generate Subtitles (NEW LOGIC)
    log("Step 5: Generating timed subtitles using Whisper API...");

    const srtContent = await transcribeWithTimestamps(voiceLocalPath);

    srtPath = path.join(TEMP_DIR, `subtitles-${workflow.id}.srt`);
    fs.writeFileSync(srtPath, srtContent);

    log("✅ Subtitle (SRT) file generated successfully.");

    // 6️⃣ Create video (single image + subtitles)
    log("Step 6: Creating video with accurate subtitles...");

    const timestamp = Date.now();
    const videoFilename = `${workflow.id}-${timestamp}.mp4`;
    const videoPath = path.join(TEMP_DIR, videoFilename);

    console.log("Subtitles created at", srtPath);
    // Pass the SRT file path instead of the 'scenes' array
    await createVideo(title, imageUrl, voiceLocalPath, videoPath, srtPath); // <-- MODIFIED CALL

    // 7️⃣ Upload final video
    const videoURL = await uploadVideoToCloud(videoPath, videoFilename);
    log(`✅ Video uploaded successfully: ${videoURL}`);

    const video = await prisma.video.create({
      data: { title, fileURL: videoURL, adminId },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { videoId: video.id, status: "COMPLETED" },
    });

    log("🎉 Workflow completed successfully.");
    deleteTempFiles(TEMP_DIR);
    return {
      success: true,
      workflowId: workflow.id,
      story: {
        title: story.title,
        outline: story.outline,
        script: story.content,
      },
      voiceover: voiceURL,
      video: videoURL,
      image: imageUrl,
    };
  } catch (err) {
    log(`Workflow failed: ${err.message}`, "\x1b[31m");
    try {
      if (srtPath && fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
      deleteTempFiles(TEMP_DIR);
    } catch (cleanupErr) {
      log(`⚠️ Temp cleanup failed: ${cleanupErr.message}`);
    }
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "FAILED", metadata: { error: err.message } },
    });
    throw err;
  }
}
