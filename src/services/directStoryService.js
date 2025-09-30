import { generateImage } from "./imageService.js";
import { generateStory } from "./storyService.js";
import { generateVoiceover } from "./ttsService.js";
import { createVideo } from "./videoService.js";
import fs from "fs";
import path from "path";

export async function generateDirectStoryVideo({
  textIdea,
  url,
  videoFile,
  storyType,
  voiceTone,
  storyLength,
}) {
  // 1️⃣ Generate story
  const { outline, script } = await generateStory({
    textIdea,
    url,
    videoFile,
    storyType,
    voiceTone,
    storyLength,
  });

  // 2️⃣ Split into scenes & generate images
  const scenes = script.split(/\n{2,}/).filter(Boolean);
  const imagePaths = [];

  for (let i = 0; i < scenes.length; i++) {
    const sceneText = scenes[i];
    const imgPath = await generateImage(`Illustration of: ${sceneText}`, i + 1);
    imagePaths.push(imgPath);
  }

  // 3️⃣ Voiceover
  const uniqueFilename = `voice_${Date.now()}.mp3`;
  const voiceFile = await generateVoiceover(script, uniqueFilename);

  // 4️⃣ Assemble video
  const videosDir = path.join(process.cwd(), "public", "videos");
  if (!fs.existsSync(videosDir)) {
    fs.mkdirSync(videosDir, { recursive: true });
  }

  const videoFilename = `video_${Date.now()}.mp4`;
  const videoOutputPath = path.join(videosDir, videoFilename);

  await createVideo(
    path.join(process.cwd(), "public", "images", "frame_%03d.png"),
    path.join(process.cwd(), voiceFile),
    videoOutputPath
  );

  return {
    outline,
    script,
    scenes,
    images: imagePaths,
    voiceover: `/voices/${uniqueFilename}`,
    video: `/videos/${videoFilename}`,
  };
}
