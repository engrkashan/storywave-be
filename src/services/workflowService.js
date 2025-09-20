import prisma from "../config/prisma.client.js";
import { extractFromUrl, transcribeVideo } from "./inputService.js";
import { generateStory } from "./storyService.js";
import { generateVoiceover } from "./ttsService.js";

export async function runWorkflow({ adminId, title, url, videoFile, textIdea }) {
    // 1️⃣ Create workflow entry in DB
    const workflow = await prisma.workflow.create({
        data: {
            title,
            type: "STORY",
            status: "PENDING",
            adminId,
            metadata: {},
        },
    });

    // 2️⃣ Save input
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
    const storyType = "horror"
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
    const voiceFile = await generateVoiceover(
        script,
        `${workflow.id}-${Date.now()}.mp3`
    );

    const voiceover = await prisma.voiceover.create({
        data: {
            script,
            audioURL: voiceFile,
            workflowId: workflow.id,
        },
    });

    // 5️⃣ Update workflow status to completed
    await prisma.workflow.update({
        where: { id: workflow.id },
        data: { status: "COMPLETED" },
    });

    return { workflow, story, voiceover };
}
