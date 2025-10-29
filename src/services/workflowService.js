import fs from "fs";
import path from "path";
import prisma from "../config/prisma.client.js";
import { generateImage } from "./imageService.js";
import { extractContentFromUrl, extractFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory } from "./storyService.js";
import { createVideo } from "./videoService.js";
import cloudinary from "../config/cloudinary.config.js";
import { generateVoiceover } from "./generateVoiceoverService.js";
import { transcribeWithTimestamps } from "./transcribeService.js";

const log = (msg, color = "\x1b[36m") => {
  const time = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`${color}[${time}] ${msg}\x1b[0m`);
};

// Upload video to Cloudinary
async function uploadVideoToCloud(videoPath, filename) {
  const uploaded = await cloudinary.uploader.upload(videoPath, {
    resource_type: "video",
    folder: "videos",
    public_id: path.parse(filename).name,
    overwrite: true,
  });

  fs.unlinkSync(videoPath);
  return uploaded.secure_url;
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

    await prisma.voiceover.create({
      data: { script, audioURL: voiceURL, workflowId: workflow.id, adminId },
    });

    // 4️⃣ Generate a single image (UNMODIFIED)
    log("Step 4: Generating a single image for the entire story...");
    const storyPrompt = `Cinematic, detailed digital artwork representing the overall theme of the story titled "${title}". 
    The style should match ${storyType} genre, tone: ${voiceTone}. No text or captions in the image.`;

    let imageUrl;
    try {
      imageUrl = await generateImage(storyPrompt, 1);
      await prisma.media.create({
        data: {
          type: "IMAGE",
          fileUrl: imageUrl,
          fileType: "image/png",
          workflow: { connect: { id: workflow.id } },
          metadata: { prompt: storyPrompt },
        },
      });
      log("✅ Single image generated successfully.");
    } catch (err) {
      throw new Error("Failed to generate main image: " + err.message);
    }

    // 5️⃣ Generate Subtitles (NEW LOGIC)
    log("Step 5: Generating timed subtitles using Whisper API...");

    const srtContent = await transcribeWithTimestamps(voiceLocalPath);

    const tempDir = path.join(process.cwd(), "temp");
    fs.mkdirSync(tempDir, { recursive: true });

    srtPath = path.join(tempDir, `subtitles-${workflow.id}.srt`);
    fs.writeFileSync(srtPath, srtContent);

    log("✅ Subtitle (SRT) file generated successfully.");

    // 6️⃣ Create video (single image + subtitles)
    log("Step 6: Creating video with accurate subtitles...");

    const videoFilename = `${workflow.id}-${Date.now()}.mp4`;
    const videoPath = path.join(tempDir, videoFilename);

    // Pass the SRT file path instead of the 'scenes' array
    await createVideo(title, imageUrl, voiceLocalPath, videoPath, srtPath); // <-- MODIFIED CALL

    if (fs.existsSync(voiceLocalPath)) fs.unlinkSync(voiceLocalPath);
    if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath); // Cleanup the srt file

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
    // Cleanup any remaining files on failure
    if (srtPath && fs.existsSync(srtPath)) fs.unlinkSync(srtPath);

    log(`Workflow failed: ${err.message}`, "\x1b[31m");
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { status: "FAILED", metadata: { error: err.message } },
    });
    throw err;
  }
}
