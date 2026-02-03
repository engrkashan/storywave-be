import prisma from "../config/prisma.client.js";
import { fork } from "child_process";
import path from "path";
import { generateStory } from "../services/storyService.js";
import crypto from "crypto";
import { runWorkflow } from "../services/workflowService.js";

// Helper — consistent random title
function generateRandomTitle(storyType = "Story") {
  const randomId = crypto.randomBytes(3).toString("hex");
  const timestamp = Date.now();
  return `${storyType}_${randomId}_${timestamp}`;
}

// POST Create Workflow (Start background process)
export const createWorkflow = async (req, res) => {
  try {
    const userId = req.user?.userId;

    const {
      title,
      url,
      videoFile,
      textIdea,
      imagePrompt,
      storyType = "Story",
      voiceTone = "neutral",
      storyLength = "30 minutes",
      shouldGenerateImage,
      scheduledAt,
      voice,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: missing user" });
    }

    if (!textIdea && !url && !videoFile) {
      return res
        .status(400)
        .json({ error: "You must provide textIdea, url, or videoFile." });
    }

    const finalTitle = title || generateRandomTitle(storyType);

    // 👉 Build the payload for worker process
    const workflowPayload = {
      userId,
      title: finalTitle,
      url,
      videoFile,
      textIdea,
      imagePrompt,
      storyType,
      voice,
      shouldGenerateImage,
      voiceTone,
      storyLength,
      scheduledAt,
    };

    // 👉 PATH to worker file
    const workerPath = path.resolve("src/workers/workflow.worker.js");

    // 👉 Start worker
    const worker = fork(workerPath);

    // Send data to worker
    worker.send(workflowPayload);

    // Optional: log worker results (not sent to frontend)
    worker.on("message", (msg) => {
      if (msg.status === "success") {
        console.log("Workflow finished:", msg.result);
      } else {
        console.error("Workflow worker error:", msg.error);
      }
    });

    // Immediate response
    return res.status(200).json({
      message: "Workflow started in background",
      title: finalTitle,
      status: "processing",
    });
  } catch (err) {
    console.error("Error running workflow:", err);
    return res.status(500).json({ error: err.message || "Workflow failed" });
  }
};

// POST Create Story (No workflow, just logic)
export const createStory = async (req, res) => {
  try {
    const {
      textIdea,
      url,
      videoFile,
      storyType = "Story",
      voiceTone = "neutral",
      storyLength = "30 minutes",
      voice,
    } = req.body;

    if (!textIdea && !url && !videoFile) {
      return res
        .status(400)
        .json({ error: "You must provide textIdea, url, or videoFile." });
    }

    const { outline, script } = await generateStory({
      textIdea,
      url,
      videoFile,
      storyType,
      voiceTone,
      storyLength,
      voice,
    });

    return res.status(200).json({ outline, script });
  } catch (err) {
    console.error("Error generating story:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to generate story" });
  }
};

// GET Scheduled Stories
export const getScheduledStories = async (req, res) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workflows = await prisma.workflow.findMany({
      where: {
        userId,
        type: "STORY",
        status: "SCHEDULED",
        scheduledAt: {
          gt: new Date(),
        },
      },
      orderBy: { scheduledAt: "asc" },
      include: {
        story: true,
      },
    });

    const formatted = workflows.map((wf) => ({
      workflowId: wf.id,
      title: wf.title,
      scheduledAt: wf.scheduledAt,
      storyId: wf.story?.id || null,
    }));

    return res.status(200).json(formatted);
  } catch (err) {
    console.error("Error fetching scheduled stories:", err);
    return res.status(500).json({ error: "Failed to fetch scheduled stories" });
  }
};

// GET all Stories (for current admin)
export const getStories = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    const stories = await prisma.story.findMany({
      where: { userId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        Workflow: {
          include: {
            media: {
              where: {
                type: "VIDEO",
                fileType: { contains: "mp4" },
              },
              select: {
                id: true,
                fileUrl: true,
                fileType: true,
                uploadedAt: true,
              },
            },
          },
        },
      },
    });

    // Flatten the workflows and return only relevant story media
    const result = stories.map((story) => ({
      id: story.id,
      title: story.title,
      createdAt: story.createdAt,
      media: story.Workflow.flatMap((wf) => wf.media || []),
    }));

    return res.status(200).json(result);
  } catch (error) {
    console.error("Get Stories Error:", error);
    return res.status(500).json({ error: "Failed to fetch stories" });
  }
};

// GET single Story with mp4 media only
export const getStoryById = async (req, res) => {
  try {
    const { id } = req.params;

    const story = await prisma.story.findUnique({
      where: { id },
      include: {
        Workflow: {
          include: {
            media: {
              where: {
                type: "VIDEO",
                fileType: { contains: "mp4" },
              },
              select: {
                id: true,
                fileUrl: true,
                fileType: true,
                uploadedAt: true,
              },
            },
          },
        },
      },
    });

    if (!story) {
      return res.status(404).json({ error: "Story not found" });
    }

    const media = story.Workflow.flatMap((wf) => wf.media || []);

    return res.status(200).json({
      id: story.id,
      title: story.title,
      createdAt: story.createdAt,
      media,
    });
  } catch (error) {
    console.error("Get Story Error:", error);
    return res.status(500).json({ error: "Failed to fetch story" });
  }
};

// DELETE Story (Transactional)
export const deleteStory = async (req, res) => {
  try {
    const storyId = req.params.id;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: missing user" });
    }

    // 1️⃣ Check story ownership + fetch all related data
    const story = await prisma.story.findFirst({
      where: { id: storyId, userId },
      include: {
        Workflow: {
          include: {
            inputs: true,
            tasks: true,
            media: true,
            voiceover: true,
            video: true,
            podcast: {
              include: { episodes: true },
            },
          },
        },
      },
    });

    if (!story) {
      return res.status(404).json({ error: "Story not found or not allowed" });
    }

    // 2️⃣ Transactional deletion
    // NOTE: With "onDelete: Cascade" in Prisma, deleting the Workflow would delete children.
    // However, Story -> Workflow implies Workflow depends on Story? No, Schema says: Workflow.storyId -> Story.id
    // But duplicate relation? Story has Workflow[].
    // Let's check schema:
    // Workflow { storyIdString? @db.ObjectId } -> Story { Workflow Workflow[] }
    // If we delete Story, we might leave Orphan workflows if we don't cascade workflow deletion.
    // But `Workflow` has `story` relation. Adding onDelete Cascade there?
    // Wait, Workflow acts as the parent container usually.
    // If we delete Story, we want to delete the workflows associated with it?
    // YES.
    // So we manually delete workflows here, and thanks to our NEW schema changes, deleting Workflow will cascade delete Tasks, Inputs, Media etc.

    await prisma.$transaction(async (tx) => {
      // Delete workflows (Cascade will handle their children)
      for (const workflow of story.Workflow) {
        await tx.workflow.delete({ where: { id: workflow.id } });
      }

      // Finally delete the story itself
      await tx.story.delete({
        where: { id: storyId },
      });
    });

    return res.status(200).json({
      message: "✅ Story and all related data deleted successfully",
    });
  } catch (err) {
    console.error("❌ Error deleting story transactionally:", err);
    return res.status(500).json({
      error: err.message || "Failed to delete story and related data",
    });
  }
};

// DELETE Scheduled Story (Cancel)
export const deleteScheduledStory = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    const workflow = await prisma.workflow.findFirst({
      where: { id, userId, status: "SCHEDULED" },
    });

    if (!workflow) {
      return res.status(404).json({ error: "Scheduled story not found" });
    }

    await prisma.workflow.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    return res
      .status(200)
      .json({ message: "Scheduled story cancelled successfully" });
  } catch (error) {
    console.error("Cancel Scheduled Story Error:", error);
    return res.status(500).json({ error: "Failed to cancel scheduled story" });
  }
};
