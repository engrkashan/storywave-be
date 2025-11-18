import { generateVoiceover } from "./generateVoiceoverService.js";
import { generateImage } from "./imageService.js";
import { extractContentFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory } from "./storyService.js";
import { transcribeWithTimestamps } from "./transcribeService.js";
import { createVideo } from "./videoService.js";

import fs from "fs";
import path from "path";
import prisma from "../config/prisma.client.js";

const TEMP_DIR = path.resolve(process.cwd(), "temp");
fs.mkdirSync(TEMP_DIR, { recursive: true });

export async function runWorkflowSteps(workflow) {
  let srtPath;

  const { id: workflowId, adminId, metadata: incomingMeta } = workflow;

  const { url, videoFile, textIdea, storyType, voiceTone, storyLength } =
    incomingMeta;

  try {
    let inputText = textIdea || "";
    console.log(incomingMeta)
    if (url)
       {inputText = await extractContentFromUrl(url);}
    if (videoFile) inputText = await transcribeVideo(videoFile);

    // if (!inputText || inputText.trim().length < 50)
    //   throw new Error("Invalid or empty input text.");

    await prisma.input.create({
      data: {
        type: url ? "URL" : videoFile ? "VIDEO" : "TEXT",
        source: url || videoFile || "TEXT",
        processed: true,
        workflowId,
      },
    });

    let outline, script;

    if (url || videoFile) {
      ({ outline, script } = await generateStory({
        textIdea: inputText,
        storyType,
        voiceTone,
        storyLength,
      }));
    }

    if (textIdea) script = textIdea;

    const story = await prisma.story.create({
      data: { title: workflow.title, outline, content: script, adminId },
    });

    await prisma.workflow.update({
      where: { id: workflowId },
      data: { storyId: story.id },
    });

    const voiceFilename = `${workflowId}-${Date.now()}.mp3`;
    const { url: voiceURL, localPath: voiceLocalPath } =
      await generateVoiceover(script, voiceFilename);

    await prisma.voiceover.create({
      data: { script, audioURL: voiceURL, workflowId, adminId },
    });

    const prompt = "thumbnail prompt here";
    const imageUrl = await generateImage(prompt, 1);

    const srtContent = await transcribeWithTimestamps(voiceLocalPath);
    srtPath = path.join(TEMP_DIR, `subtitles-${workflowId}.srt`);
    fs.writeFileSync(srtPath, srtContent);

    const videoFilename = `${workflowId}-${Date.now()}.mp4`;
    const videoPath = path.join(TEMP_DIR, videoFilename);

    await createVideo(
      workflow.title,
      imageUrl,
      voiceLocalPath,
      videoPath,
      srtPath
    );

    const videoURL = await uploadVideoToCloud(videoPath, videoFilename);

    const video = await prisma.video.create({
      data: { title: workflow.title, fileURL: videoURL, adminId },
    });

    await prisma.workflow.update({
      where: { id: workflowId },
      data: { videoId: video.id },
    });
  } catch (err) {
    if (srtPath && fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
    throw err;
  }
}
