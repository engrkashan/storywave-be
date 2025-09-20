import fs from "fs";
import path from "path";
import prisma from "../config/prisma.client.js";
import { extractFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory } from "./storyService.js";
import { generateVoiceover } from "./ttsService.js";
import { createVideo } from "./videoService.js";

export async function runWorkflow({ adminId, title, url, videoFile, textIdea }) {
    // 1️⃣ Create workflow entry
    const workflow = await prisma.workflow.create({
        data: {
            title,
            type: "STORY",
            status: "PENDING",
            adminId,
            metadata: {},
        },
    });

    // 2️⃣ Process input
    let inputText = textIdea;
    let inputSource = "TEXT";

    if (url) {
        inputText = await extractFromUrl(url);
        inputSource = url;
    }
    if (videoFile) {
        inputText = await transcribeVideo(videoFile);
        inputSource = videoFile;
    }

    await prisma.input.create({
        data: {
            type: url ? "URL" : videoFile ? "VIDEO" : "TEXT",
            source: inputSource,
            processed: true,
            workflowId: workflow.id,
        },
    });

    // 3️⃣ Generate story
    const storyType = "horror"; // TODO: pass from req.body
    const { outline, script } = await generateStory(inputText, storyType);

    const story = await prisma.story.create({
        data: {
            title,
            outline,
            content: script,
            workflowId: workflow.id,
        },
    });

    // 4️⃣ Generate voiceover
    const uniqueFilename = `${workflow.id}-${Date.now()}.mp3`;
    const voiceFile = await generateVoiceover(script, uniqueFilename);

    const voiceover = await prisma.voiceover.create({
        data: {
            script,
            audioURL: voiceFile,
            workflowId: workflow.id,
        },
    });

    // 5️⃣ Generate video (ensure public/videos exists)
    const videosDir = path.join(process.cwd(), "public", "videos");
    if (!fs.existsSync(videosDir)) {
        fs.mkdirSync(videosDir, { recursive: true });
    }

    const videoFilename = `${workflow.id}-${Date.now()}.mp4`;
    const videoOutputPath = path.join(videosDir, videoFilename);

    // Example: use some static images pattern or generated images
    const imagesPattern = "public/images/frame_%03d.png"; // you must have these ready
    await createVideo(imagesPattern, path.join(process.cwd(), voiceFile), videoOutputPath);

    const video = await prisma.video.create({
        data: {
            videoURL: `/videos/${videoFilename}`,
            workflowId: workflow.id,
        },
    });

    // 6️⃣ Update workflow
    await prisma.workflow.update({
        where: { id: workflow.id },
        data: { status: "COMPLETED" },
    });

    return { workflow, story, voiceover, video };
}
