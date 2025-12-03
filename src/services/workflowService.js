import fs from "fs";
import path from "path";
import { cloudinary } from "../config/cloudinary.config.js";
import prisma from "../config/prisma.client.js";
import { deleteTempFiles } from "../utils/deleteTemp.js";
import { generateVoiceover } from "./generateVoiceoverService.js";
import { generateImage } from "./imageService.js";
import { extractContentFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory } from "./storyService.js";
import { transcribeWithTimestamps } from "./transcribeService.js";
import { createVideo } from "./videoService.js";

const TEMP_DIR = path.resolve(process.cwd(), "temp");
fs.mkdirSync(TEMP_DIR, { recursive: true });

const log = (msg, color = "\x1b[36m") => {
  const time = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`${color}[${time}] ${msg}\x1b[0m`);
};

let isProcessing = false;

export async function runScheduledWorkflows() {
  if (isProcessing) {
    console.log("⏳ A workflow is already processing... skipping this tick.");
    return;
  }

  isProcessing = true;

  try {
    const now = new Date();

    const workflow = await prisma.workflow.findFirst({
      where: {
        status: "SCHEDULED",
        scheduledAt: { lte: now },
      },
      orderBy: { scheduledAt: "asc" },
    });

    if (!workflow) {
      isProcessing = false;
      return;
    }

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "PROCESSING" },
    });

    await processExistingWorkflow(workflow);
  } catch (err) {
    console.error("Scheduler error:", err);
  }

  isProcessing = false;
}

export async function processExistingWorkflow(workflow) {
  const meta = workflow.metadata || {};

  return await runWorkflow({
    adminId: workflow.adminId,
    title: workflow.title,
    url: meta.url || null,
    videoFile: meta.videoFile || null,
    textIdea: meta.textIdea || null,
    imagePrompt: meta.imagePrompt || null,
    storyType: meta.storyType || null,
    voice: meta.voice || null,
    voiceTone: meta.voiceTone || null,
    storyLength: meta.storyLength || null,
    scheduledAt: null,
    existingWorkflow: workflow, // ADD THIS
  });
}

function uploadLargePromise(filePath, options) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_large(filePath, options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

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
  log(`Video uploaded to Cloudinary: ${uploaded}`);
  return uploaded.secure_url;
}

function generateThumbnailPrompt(title, storyType) {
  const genres = {
    true_crime_fiction_cinematic: {
      style:
        "cinematic Netflix-style true-crime artwork with high-contrast noir lighting",
      elements:
        "dark alleys, blurred police lights, cryptic evidence objects, shadowy suspect silhouette",
      colors: "moody reds, deep shadows, noir tones with stark highlights",
      mood: "intense, dramatic, suspense-filled, evoking mystery",
      composition: "rule of thirds, central focus on enigmatic clue",
    },

    true_crime_nonfiction_forensic: {
      style: "realistic forensic documentary visual with sharp details",
      elements:
        "crime scene markers, fingerprint overlays, forensic tools, evidence closeups, investigation board",
      colors:
        "cool blues, sterile whites, forensic lab tones with subtle yellow accents",
      mood: "analytical, investigative, unbiased, truth-revealing",
      composition: "balanced grid layout, focal point on key evidence",
    },

    manipulation_sexual_manipulation: {
      style: "mature psychological manipulation symbolism with surreal twists",
      elements:
        "broken masks, tangled strings, shadowy silhouettes, metaphorical tension, distorted faces",
      colors:
        "dark purples, muted reds, deep dramatic contrasts with ethereal glows",
      mood: "intense, psychological, emotionally charged, unsettling",
      composition: "asymmetrical for tension, central pull on symbolic figure",
    },

    cultural_history_documentary: {
      style:
        "National Geographic-style cultural documentary artwork with textured depth",
      elements:
        "heritage artifacts, historical textures, symbolic cultural patterns, ancient ruins or icons",
      colors: "earthy tones, warm natural hues, golden hour lighting",
      mood: "educational, respectful, culturally rich, exploratory",
      composition: "wide panoramic view, focal artifact in foreground",
    },

    homesteading_howto_field_guide: {
      style:
        "rustic, practical homesteading field-guide illustration with natural realism",
      elements:
        "tools, wooden textures, garden elements, simple natural objects, hands in action",
      colors: "greens, browns, softly lit outdoor tones with vibrant accents",
      mood: "practical, peaceful, self-sufficient, empowering",
      composition: "close-up on tools, balanced with scenic background",
    },

    work_and_trades_shop_manual: {
      style: "technical how-to shop manual artwork with precise lines",
      elements:
        "tools, machinery diagrams, workshop parts, reference shapes, blueprints overlay",
      colors:
        "industrial grays, metallic tones, clean technical colors with blue highlights",
      mood: "instructive, clear, mechanical, hands-on",
      composition: "diagram-centric, focal on machinery with annotations",
    },

    work_and_trades_shopfloordoc: {
      style: "real-world shop-floor documentary style with gritty authenticity",
      elements:
        "factory environment, tools, workbenches, mechanical details, workers in motion",
      colors: "industrial tones, steel blues, warm highlights from sparks",
      mood: "authentic, gritty, hands-on, industrious",
      composition: "dynamic angle, central action on workbench",
    },

    investigative_discovery_journalistic: {
      style:
        "journalistic investigative documentary artwork with collage elements",
      elements:
        "documents, maps, red string connections, headlines, evidence boards, magnifying glass",
      colors:
        "cool investigative blues with high contrast shadows and red accents",
      mood: "urgent, analytical, truth-seeking, revealing",
      composition: "pinboard layout, focal on connected clues",
    },

    storytelling_cinematic: {
      style: "dramatic cinematic movie-style illustration with epic depth",
      elements:
        "symbolic objects based on the title, dramatic lighting, atmospheric depth, heroic or tense figures",
      colors: "rich cinematic tones with golden or blue hour vibes",
      mood: "emotional, visual, immersive, narrative-driven",
      composition: "widescreen framing, central character or symbol",
    },

    conversation_narrated_documentary: {
      style: "blended narrated-documentary visual style with soft overlays",
      elements:
        "voice-wave graphics, symbolic objects from the story, soft documentary textures, subtle animations",
      colors: "neutral documentary tones with warm highlights and fades",
      mood: "thoughtful, reflective, narrative-driven, conversational",
      composition: "layered with foreground symbols, balanced flow",
    },

    education_howto_trades: {
      style:
        "clear instructional educational trades illustration with step-by-step clarity",
      elements:
        "tools, diagrams, step-by-step symbolic objects, charts or icons",
      colors: "clean, bright educational palette with primary accents",
      mood: "practical, clear, helpful, motivational",
      composition: "sequential layout, focal on instructional element",
    },

    horror_murder: {
      style:
        "gruesome horror illustration with stylized gore and chiaroscuro shadows",
      elements:
        "blood splatters, shadowy killers, weapons in silhouette, crime scenes with eerie fog",
      colors: "crimson reds, dark blacks, eerie greens and purples",
      mood: "terrifying, gruesome, suspenseful, nightmarish",
      composition:
        "tense close-up, asymmetrical for dread, focal on bloodied symbol",
    },
  };

  const g = genres[storyType] || genres.storytelling_cinematic;

  const titleKeywords = title
    .toLowerCase()
    .split(" ")
    .filter((word) =>
      ["murder", "blood", "killer", "crime", "horror"].includes(word)
    );
  const customElements =
    titleKeywords.length > 0
      ? `, incorporating ${titleKeywords.join(" and ")} motifs`
      : "";

  return `
    Create a highly detailed, cinematic 16:9 digital illustration based on the story titled "${title}". 
    Style: ${g.style}. 
    Include elements such as: ${g.elements}${customElements}. 
    Color palette: ${g.colors}. 
    Mood: ${g.mood}. 
    Composition: ${g.composition}, with high contrast and emotional hook. 
    Ultra-sharp, visually striking, thumbnail-quality artwork optimized for click-through. No text unless specified.
      `.trim();
}

export async function runWorkflow({
  adminId,
  title,
  url,
  videoFile,
  textIdea,
  imagePrompt,
  storyType,
  voice,
  voiceTone,
  storyLength,
  scheduledAt,
  existingWorkflow,
}) {
  const nowUTC = new Date().toISOString();
  const scheduledUTC = scheduledAt ? new Date(scheduledAt).toISOString() : null;

  const isScheduled = scheduledUTC && new Date(scheduledUTC) > new Date(nowUTC);
  log(
    isScheduled
      ? `🕒 Workflow "${title}" scheduled for ${scheduledAt}`
      : `🚀 Starting workflow: "${title}"`
  );

  let workflow = existingWorkflow;

  if (existingWorkflow) {
    await prisma.workflow.update({
      where: { id: existingWorkflow.id },
      data: { status: "PROCESSING" },
    });
  }

  if (!workflow) {
    workflow = await prisma.workflow.create({
      data: {
        title,
        type: "STORY",
        status: isScheduled ? "SCHEDULED" : "PENDING",
        scheduledAt: isScheduled ? new Date(scheduledUTC) : null,
        adminId,
        metadata: {
          url,
          videoFile,
          textIdea,
          imagePrompt,
          storyType,
          voice,
          voiceTone,
          storyLength,
        },
      },
    });
  }

  log(`Workflow record created (ID: ${workflow.id})`);

  if (isScheduled) {
    return {
      success: true,
      workflowId: workflow.id,
      status: "SCHEDULED",
    };
  }

  let srtPath;

  try {
    isProcessing = true;
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

    let outline, script;

    if (url || videoFile) {
      log("Step 2: Generating story...");
      try {
        ({ outline, script } = await generateStory({
          textIdea: inputText,
          storyType,
          voiceTone,
          storyLength,
        }));
      } catch (error) {
        throw new Error(`Story Generation Failed: ${error.message}`);
      }
    }

    if (textIdea) script = textIdea;

    const story = await prisma.story.create({
      data: { title, outline, content: script, adminId },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { storyId: story.id },
    });

    log("Step 3: Generating voiceover...");
    const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
    let voiceURL, voiceLocalPath;
    try {
      ({ url: voiceURL, localPath: voiceLocalPath } = await generateVoiceover(
        script,
        voiceFilename,
        voice
      ));
    } catch (error) {
      throw new Error(`Voiceover Generation Failed: ${error.message}`);
    }

    await prisma.voiceover.create({
      data: { script, audioURL: voiceURL, workflowId: workflow.id, adminId },
    });

    log("Step 4: Generating a single image for the entire story...");
    let storyPrompt = imagePrompt || generateThumbnailPrompt(title, storyType);
    let imageUrl = null;
    let imageRetryCount = 0;
    const MAX_IMAGE_RETRIES = 3;

    try {
      while (!imageUrl && imageRetryCount < MAX_IMAGE_RETRIES) {
        try {
          imageUrl = await generateImage(storyPrompt, 1);

          if (!imageUrl || !fs.existsSync(imageUrl) || fs.statSync(imageUrl).size < 5000) {
            throw new Error("Generated image file is invalid or too small");
          }

        } catch (err) {
          imageRetryCount++;
          log(`Image generation attempt ${imageRetryCount} failed: ${err.message}`, "\x1b[31m");

          if (imageRetryCount >= MAX_IMAGE_RETRIES) {
            throw new Error(`Failed to generate image after ${MAX_IMAGE_RETRIES} attempts. Last error: ${err.message}`);
          }

          // Handle Prompt Length Error
          if (err.message.toLowerCase().includes("prompt length") || err.message.toLowerCase().includes("too long")) {
            log("⚠️ Prompt too long, shortening it for next attempt...");
            // Truncate prompt to safe limit (e.g., 1000 chars) to ensure it passes
            storyPrompt = storyPrompt.substring(0, 1000) + "...";
          } else {
            // For other errors, wait a bit before retrying
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      }
    } catch (error) {
      // Show exact error message for better debugging/transparency as requested
      throw new Error(`Image Generation Failed: ${error.message}`);
    }

    log("Step 5: Generating timed subtitles...");
    try {
      const srtContent = await transcribeWithTimestamps(voiceLocalPath);
      srtPath = path.join(TEMP_DIR, `subtitles-${workflow.id}.srt`);
      fs.writeFileSync(srtPath, srtContent);
    } catch (error) {
      throw new Error(`Subtitle Generation Failed: ${error.message}`);
    }

    log("Step 6: Creating video...");
    const timestamp = Date.now();
    const videoFilename = `${workflow.id}-${timestamp}.mp4`;
    const videoPath = path.join(TEMP_DIR, videoFilename);

    let videoURL;
    try {
      await createVideo(title, imageUrl, voiceLocalPath, videoPath, srtPath);
      videoURL = await uploadVideoToCloud(videoPath, videoFilename);
    } catch (error) {
      throw new Error(`Video Creation Failed: ${error.message}`);
    }

    const video = await prisma.video.create({
      data: { title, fileURL: videoURL, adminId },
    });

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { videoId: video.id, status: "COMPLETED" },
    });

    log("🎉 Workflow completed successfully.");
    deleteTempFiles(TEMP_DIR);
    isProcessing = false;
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
    if (srtPath && fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
    deleteTempFiles(TEMP_DIR);

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "FAILED", metadata: { error: err.message } },
    });
    isProcessing = false;
    throw err;
  }
}
