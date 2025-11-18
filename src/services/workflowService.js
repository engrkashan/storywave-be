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
import { runWorkflowSteps } from "./workflowSteps.js";

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

// export async function runWorkflow({
//   adminId,
//   title,
//   url,
//   videoFile,
//   textIdea,
//   storyType,
//   voiceTone,
//   storyLength,
//   scheduledAt,
// }) {
//   log(`🚀 Starting workflow: "${title}"`);

//   const workflow = await prisma.workflow.create({
//     data: {
//       title,
//       type: "STORY",
//       status: scheduledAt ? "SCHEDULED" : "PENDING",
//       scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
//       adminId,
//       metadata: {},
//     },
//   });
//   log(`Workflow record created (ID: ${workflow.id})`);

//   let srtPath;

//   try {
//     log("Step 1: Preparing input text...");
//     let inputText = textIdea || "";
//     if (url) {
//       log("Extracting text from URL...");
//       inputText = await extractContentFromUrl(url);
//     }

//     if (videoFile) {
//       log("Transcribing video to text...");
//       inputText = await transcribeVideo(videoFile);
//     }

//     log(`Input text: ${inputText}`);
//     if (!inputText || inputText.trim().length < 50)
//       throw new Error("Invalid or empty input text.");

//     await prisma.input.create({
//       data: {
//         type: url ? "URL" : videoFile ? "VIDEO" : "TEXT",
//         source: url || videoFile || "TEXT",
//         processed: true,
//         workflowId: workflow.id,
//       },
//     });

//     let outline, script;

//     if (url || videoFile) {
//       log("Step 2: Generating story...");
//       ({ outline, script } = await generateStory({
//         textIdea: inputText,
//         storyType,
//         voiceTone,
//         storyLength,
//       }));
//     }

//     console.log("Generated Story Outline:", outline);
//     console.log("Generated Story Script:", script);

//     if (textIdea) {
//       script = textIdea;
//     }

//     const story = await prisma.story.create({
//       data: { title, outline, content: script, adminId },
//     });

//     await prisma.workflow.update({
//       where: { id: workflow.id },
//       data: { storyId: story.id },
//     });

//     log("Step 3: Generating voiceover...");
//     const voiceFilename = `${workflow.id}-${Date.now()}.mp3`;
//     const { url: voiceURL, localPath: voiceLocalPath } =
//       await generateVoiceover(script, voiceFilename);

//     console.log("VOICE URL", voiceURL);
//     await prisma.voiceover.create({
//       data: { script, audioURL: voiceURL, workflowId: workflow.id, adminId },
//     });

//     log("Step 4: Generating a single image for the entire story...");

//     const storyPrompt = generateThumbnailPrompt(title, storyType);
//     console.log("Story Prompt: ", storyPrompt);

//     let imageUrl = null;

//     while (!imageUrl) {
//       try {
//         imageUrl = await generateImage(storyPrompt, 1);

//         if (!imageUrl || !fs.existsSync(imageUrl)) {
//           log("⚠️ Image file missing after generation. Retrying...");
//           imageUrl = null;
//           await new Promise((r) => setTimeout(r, 3000));
//           continue;
//         }

//         const size = fs.statSync(imageUrl).size;
//         if (size < 5000) {
//           log("⚠️ Image seems corrupted (too small). Retrying...");
//           imageUrl = null;
//           await new Promise((r) => setTimeout(r, 3000));
//           continue;
//         }

//         log("✅ Single image generated successfully.");
//       } catch (err) {
//         log(`❌ Image generation failed: ${err.message}`);
//         log("🔁 Retrying in 5 seconds...");
//         await new Promise((r) => setTimeout(r, 5000));
//       }
//     }

//     log("Step 5: Generating timed subtitles using Whisper API...");

//     const srtContent = await transcribeWithTimestamps(voiceLocalPath);

//     srtPath = path.join(TEMP_DIR, `subtitles-${workflow.id}.srt`);
//     fs.writeFileSync(srtPath, srtContent);

//     log("✅ Subtitle (SRT) file generated successfully.");

//     log("Step 6: Creating video with accurate subtitles...");

//     const timestamp = Date.now();
//     const videoFilename = `${workflow.id}-${timestamp}.mp4`;
//     const videoPath = path.join(TEMP_DIR, videoFilename);

//     console.log("Subtitles created at", srtPath);

//     await createVideo(title, imageUrl, voiceLocalPath, videoPath, srtPath);

//     const videoURL = await uploadVideoToCloud(videoPath, videoFilename);
//     log(`✅ Video uploaded successfully: ${videoURL}`);

//     const video = await prisma.video.create({
//       data: { title, fileURL: videoURL, adminId },
//     });

//     await prisma.workflow.update({
//       where: { id: workflow.id },
//       data: { videoId: video.id, status: "COMPLETED" },
//     });

//     log("🎉 Workflow completed successfully.");
//     deleteTempFiles(TEMP_DIR);
//     return {
//       success: true,
//       workflowId: workflow.id,
//       story: {
//         title: story.title,
//         outline: story.outline,
//         script: story.content,
//       },
//       voiceover: voiceURL,
//       video: videoURL,
//       image: imageUrl,
//     };
//   } catch (err) {
//     log(`Workflow failed: ${err.message}`, "\x1b[31m");
//     try {
//       if (srtPath && fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
//       deleteTempFiles(TEMP_DIR);
//     } catch (cleanupErr) {
//       log(`⚠️ Temp cleanup failed: ${cleanupErr.message}`);
//     }
//     await prisma.workflow.update({
//       where: { id: workflow.id },
//       data: { status: "FAILED", metadata: { error: err.message } },
//     });
//     throw err;
//   }
// }

export async function runWorkflow({
  adminId,
  title,
  url,
  videoFile,
  textIdea,
  storyType,
  voiceTone,
  storyLength,
  scheduledAt,
}) {
  const isScheduled = scheduledAt && new Date(scheduledAt) > new Date();

  log(
    isScheduled
      ? `🕒 Workflow "${title}" scheduled for ${scheduledAt}`
      : `🚀 Starting workflow: "${title}"`
  );

  // Create workflow record first
  const workflow = await prisma.workflow.create({
    data: {
      title,
      type: "STORY",
      status: isScheduled ? "SCHEDULED" : "PENDING",
      scheduledAt: isScheduled ? new Date(scheduledAt) : null,
      adminId,
      metadata: {},
    },
  });

  log(`Workflow record created (ID: ${workflow.id})`);

  if (isScheduled) {
    return {
      success: true,
      workflowId: workflow.id,
      status: "SCHEDULED",
    };
  }

  // Run immediately
  await runWorkflowSteps(workflow);

  let srtPath;

  try {
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
      ({ outline, script } = await generateStory({
        textIdea: inputText,
        storyType,
        voiceTone,
        storyLength,
      }));
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
    const { url: voiceURL, localPath: voiceLocalPath } =
      await generateVoiceover(script, voiceFilename);

    await prisma.voiceover.create({
      data: { script, audioURL: voiceURL, workflowId: workflow.id, adminId },
    });

    log("Step 4: Generating a single image for the entire story...");
    const storyPrompt = generateThumbnailPrompt(title, storyType);
    let imageUrl = null;

    while (!imageUrl) {
      try {
        imageUrl = await generateImage(storyPrompt, 1);
        if (
          !imageUrl ||
          !fs.existsSync(imageUrl) ||
          fs.statSync(imageUrl).size < 5000
        ) {
          log("Image generation issue, retrying...");
          imageUrl = null;
          await new Promise((r) => setTimeout(r, 3000));
        }
      } catch (err) {
        log(`Image generation failed: ${err.message}`, "\x1b[31m");
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    log("Step 5: Generating timed subtitles...");
    const srtContent = await transcribeWithTimestamps(voiceLocalPath);
    srtPath = path.join(TEMP_DIR, `subtitles-${workflow.id}.srt`);
    fs.writeFileSync(srtPath, srtContent);

    log("Step 6: Creating video...");
    const timestamp = Date.now();
    const videoFilename = `${workflow.id}-${timestamp}.mp4`;
    const videoPath = path.join(TEMP_DIR, videoFilename);
    await createVideo(title, imageUrl, voiceLocalPath, videoPath, srtPath);

    const videoURL = await uploadVideoToCloud(videoPath, videoFilename);

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
    if (srtPath && fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
    deleteTempFiles(TEMP_DIR);

    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "FAILED", metadata: { error: err.message } },
    });

    throw err;
  }
}
