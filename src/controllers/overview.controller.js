import prisma from "../config/prisma.client.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("OverviewController");

export const getOverview = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    const role = req?.user?.role;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Role-based access
    const whereByRole = role === "CREATOR" ? { userId } : {};

    // Status counts (parallel)
    const [
      totalStories,
      videosCreated,
      voiceovers,
      podcasts,
      pendingStories,
      completedStories,
      failedStories,
    ] = await Promise.all([
      prisma.story.count({ where: whereByRole }),
      prisma.video.count({ where: whereByRole }),
      prisma.voiceover.count({ where: whereByRole }),
      prisma.story.count({ where: { ...whereByRole, isPodcast: true } }),
      prisma.workflow.count({
        where: {
          ...whereByRole,
          status: { in: ["PENDING", "PROCESSING", "SCHEDULED"] },
        },
      }),
      prisma.workflow.count({ where: { ...whereByRole, status: "COMPLETED" } }),
      prisma.workflow.count({
        where: { ...whereByRole, status: { in: ["FAILED", "CANCELLED"] } },
      }),
    ]);

    //  Recent workflows
    const workflows = await prisma.workflow.findMany({
      where: whereByRole,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        status: true,
        metadata: true,
        createdAt: true,
        story: {
          select: {
            id: true,
            isPodcast: true,
            audioURL: true,
            coverArtURL: true,
            coverArtURL_16_9: true,
            coverArtURL_9_16: true,
            series: true,
          },
        },
        video: {
          select: {
            fileURL: true,
            video_16_9: true,
            video_9_16: true,
          },
        },
        user: {
          select: {
            id: true,
            fullName: true,
            role: true,
          },
        },
      },
    });

    const stories = workflows.map((w) => ({
      id: w.id,
      workflow: w.id,
      title: w.title || "Untitled Workflow",
      status: w.status,
      series: w.story?.series || null,
      createdAt: w.createdAt,
      error: w.metadata?.error || null,
      isPodcast: w.story?.isPodcast || false,
      audioURL: w.story?.audioURL || null,
      thumbnail: w.story?.coverArtURL_16_9 || w.story?.coverArtURL_9_16 || w.story?.coverArtURL || null,
      video: w.video ? {
        fileURL: w.video.fileURL,
        video_16_9: w.video.video_16_9,
        video_9_16: w.video.video_9_16,
      } : null,
      owner: {
        id: w.user?.id,
        name: w.user?.fullName,
        role: w.user?.role,
      },
    }));

    return res.status(200).json({
      role,
      totalStories,
      videosCreated,
      voiceovers,
      podcasts,
      stats: {
        pending: pendingStories,
        completed: completedStories,
        cancelled: failedStories,
      },
      stories,
    });
  } catch (error) {
    logger.error("Overview Error:", error);
    return res.status(500).json({ error: "Failed to fetch overview" });
  }
};

// Get Workflow by ID
export const getWorkflowById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const role = req.user?.role;

    if (!userId) {
      return res
        .status(401)
        .json({ error: "Unauthorized – missing user identity" });
    }

    const filter = role === "CREATOR" ? { id, userId } : { id };

    const workflow = await prisma.workflow.findFirst({
      where: filter,
      include: {
        story: true,
        voiceover: true,
        video: true,
        inputs: true,
        media: true,
        tasks: true,
        user: { select: { id: true, fullName: true, role: true } },
      },
    });

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    return res.status(200).json({
      id: workflow.id,
      title: workflow.title,
      type: workflow.type,
      subType: workflow.subType,
      status: workflow.status,
      scheduledAt: workflow.scheduledAt,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      metadata: workflow.metadata || {},
      owner: workflow.user
        ? {
          id: workflow.user.id,
          name: workflow.user.fullName,
          role: workflow.user.role,
        }
        : null,
      story: workflow.story
        ? {
          id: workflow.story.id,
          title: workflow.story.title,
          outline: workflow.story.outline,
          content: workflow.story.content,
          series: workflow.story.series,
          coverArtPrompt: workflow.story.coverArtPrompt,
          coverArtURL: workflow.story.coverArtURL,
          coverArtURL_9_16: workflow.story.coverArtURL_9_16,
          coverArtURL_16_9: workflow.story.coverArtURL_16_9,
          seoContent: workflow.story.seoContent,
          visualSuggestions: workflow.story.visualSuggestions,
        }
        : null,
      voiceover: workflow.voiceover
        ? {
          id: workflow.voiceover.id,
          script: workflow.voiceover.script,
          audioURL: workflow.voiceover.audioURL,
          voice: workflow.voiceover.voice,
        }
        : null,
      video: workflow.video
        ? {
          id: workflow.video.id,
          title: workflow.video.title,
          fileURL: workflow.video.fileURL,
          video_16_9: workflow.video.video_16_9,
          video_9_16: workflow.video.video_9_16,
          subtitles: workflow.video.subtitles,
        }
        : null,
      inputs: workflow.inputs.map((i) => ({
        id: i.id,
        type: i.type,
        source: i.source,
        processed: i.processed,
      })),
      media: workflow.media.map((m) => ({
        id: m.id,
        type: m.type,
        fileUrl: m.fileUrl,
        fileType: m.fileType,
        publicId: m.publicId,
        metadata: m.metadata || {},
      })),
      tasks: workflow.tasks.map((t) => ({
        id: t.id,
        step: t.step,
        status: t.status,
        log: t.log,
        metadata: t.metadata || {},
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    });
  } catch (error) {
    logger.error("Get Workflow By ID Error:", error);
    return res.status(500).json({ error: "Failed to fetch workflow" });
  }
};

// cancel workflow
export const cancelWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const role = req.user?.role;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workflow = await prisma.workflow.findFirst({
      where: {
        id,
        ...(role === "CREATOR" ? { userId } : {}),
      },
    });

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    await prisma.workflow.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    return res.status(200).json({ message: "Workflow cancelled successfully" });
  } catch (error) {
    logger.error("Cancel Workflow Error:", error);
    return res.status(500).json({ error: "Failed to cancel workflow" });
  }
};

// Delete Workflow
export const deleteWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const role = req.user?.role;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workflow = await prisma.workflow.findFirst({
      where: {
        id,
        ...(role === "CREATOR" ? { userId } : {}),
      },
      include: {
        story: {
          select: { id: true },
        },
      },
    });

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    // If this workflow has a story, delete the story (which will delete all its workflows)
    if (workflow.story) {
      // Get all workflows for this story
      const allWorkflows = await prisma.workflow.findMany({
        where: { storyId: workflow.story.id },
        select: { id: true },
      });

      // Delete all workflows for this story (MongoDB doesn't support cascade)
      if (allWorkflows.length > 0) {
        await prisma.workflow.deleteMany({
          where: {
            id: { in: allWorkflows.map((w) => w.id) },
          },
        });
      }

      // Delete the story
      await prisma.story.delete({
        where: { id: workflow.story.id },
      });
    } else {
      // No story associated, just delete the workflow
      await prisma.workflow.delete({ where: { id } });
    }

    return res.status(200).json({
      message: "Workflow deleted successfully",
    });
  } catch (error) {
    logger.error("Delete Workflow Error:", error);
    return res.status(500).json({ error: "Failed to delete workflow" });
  }
};
