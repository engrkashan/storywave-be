import prisma from "../config/prisma.client.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("OverviewController");

export const getOverviewStats = async (req, res) => {
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
    });
  } catch (error) {
    logger.error("Overview Stats Error:", error);
    return res.status(500).json({ error: "Failed to fetch overview stats" });
  }
};

export const getWorkflows = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    const role = req?.user?.role;
    let { page = 1, limit = 20 } = req.query;

    page = parseInt(page, 10);
    limit = parseInt(limit, 10);
    const skip = (page - 1) * limit;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    logger.info(`[WORKFLOW DEBUG] controller entered — userId=${userId} role=${role} page=${page} limit=${limit}`);
    const t0 = Date.now();

    const whereByRole = role === "CREATOR" ? { userId } : {};

    // ─── FIX: Run findMany + count in parallel (was sequential — 2 serial RTTs) ──
    // ─── FIX: metadata removed from select — it was fetching multi-MB JSON blobs ─
    //         (storyMetadata, characterBible, MGE audit, soundscapePlan, etc.)      
    //         per workflow, causing the gateway 504 when the collection grew.        
    //         Only metadata.error is consumed here; recovered via a targeted query   
    //         scoped to FAILED workflows in this page only.                          
    logger.info(`[WORKFLOW DEBUG] before findMany + count (parallel)`);
    const t1 = Date.now();

    const [workflows, total] = await Promise.all([
      prisma.workflow.findMany({
        where: whereByRole,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          title: true,
          status: true,
          // metadata intentionally omitted — see fix comment above.
          // Only metadata.error is needed; fetched separately below for FAILED rows only.
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
      }),
      prisma.workflow.count({ where: whereByRole }),
    ]);

    logger.info(`[WORKFLOW DEBUG] after findMany + count: ${Date.now() - t1}ms — got ${workflows.length} rows, total=${total}`);

    // ─── Recover metadata.error for FAILED workflows only ───────────────────────
    // Tiny secondary query: at most `limit` IDs, status=FAILED, select only metadata.
    // Index-covered by _id (hash). No-op when no FAILED workflows are on this page.
    const failedIds = workflows
      .filter((w) => w.status === "FAILED")
      .map((w) => w.id);

    const errorByWorkflowId = {};
    if (failedIds.length > 0) {
      logger.info(`[WORKFLOW DEBUG] fetching metadata.error for ${failedIds.length} FAILED workflow(s)`);
      const t2 = Date.now();
      const failedMeta = await prisma.workflow.findMany({
        where: { id: { in: failedIds } },
        select: { id: true, metadata: true },
      });
      logger.info(`[WORKFLOW DEBUG] after error fetch: ${Date.now() - t2}ms`);
      for (const fm of failedMeta) {
        errorByWorkflowId[fm.id] = fm.metadata?.error || null;
      }
    }

    logger.info(`[WORKFLOW DEBUG] before mapping`);
    const stories = workflows.map((w) => ({
      id: w.id,
      workflow: w.id,
      title: w.title || "Untitled Workflow",
      status: w.status,
      series: w.story?.series || null,
      createdAt: w.createdAt,
      error: errorByWorkflowId[w.id] ?? null,
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

    logger.info(`[WORKFLOW DEBUG] response completed — total elapsed: ${Date.now() - t0}ms`);
    return res.status(200).json({
      stories,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      }
    });
  } catch (error) {
    logger.error("Get Workflows Error:", error);
    return res.status(500).json({ error: "Failed to fetch workflows" });
  }
};

export const getPublishOptions = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    const role = req?.user?.role;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const whereByRole = role === "CREATOR" ? { userId } : {};

    const workflows = await prisma.workflow.findMany({
      where: {
        ...whereByRole,
        status: "COMPLETED",
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
      },
    });

    return res.status(200).json(workflows);
  } catch (error) {
    logger.error("Get Publish Options Error:", error);
    return res.status(500).json({ error: "Failed to fetch publish options" });
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

    const [workflow, metaCommand] = await Promise.all([
      prisma.workflow.findFirst({
        where: filter,
        select: {
          id: true,
          title: true,
          type: true,
          subType: true,
          status: true,
          scheduledAt: true,
          createdAt: true,
          updatedAt: true,
          story: true,
          voiceover: true,
          video: true,
          inputs: true,
          media: true,
          tasks: true,
          user: { select: { id: true, fullName: true, role: true } },
        },
      }),
      prisma.$runCommandRaw({
        find: "Workflow",
        filter: { _id: { $oid: id } },
        projection: {
          "metadata.mediaType": 1,
          "metadata.aspectRatio": 1,
          "metadata.dualPlatform": 1,
          "metadata.voice": 1,
          "metadata.voiceTone": 1,
          "metadata.storyLength": 1,
          "metadata.storyType": 1,
          "metadata.subtitles": 1,
          "metadata.soundEffects": 1,
          "metadata.characterTalk": 1,
          "metadata.backgroundMusic": 1,
          "metadata.characterReferences": 1,
          "metadata.uploadedCharacterReferences": 1,
          "metadata.error": 1,
          "metadata.cancelledAt": 1,
        },
        limit: 1,
      }),
    ]);

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    const rawMeta = metaCommand?.cursor?.firstBatch?.[0]?.metadata || {};
    const filteredMetadata = {
      mediaType: rawMeta.mediaType || "multi_image",
      aspectRatio: rawMeta.aspectRatio || "16:9",
      dualPlatform: rawMeta.dualPlatform ?? false,
      voice: rawMeta.voice || null,
      voiceTone: rawMeta.voiceTone || null,
      storyLength: rawMeta.storyLength || null,
      storyType: rawMeta.storyType || null,
      subtitles: rawMeta.subtitles ?? true,
      soundEffects: rawMeta.soundEffects ?? false,
      characterTalk: rawMeta.characterTalk ?? false,
      backgroundMusic: rawMeta.backgroundMusic || null,
      characterReferences: rawMeta.characterReferences || rawMeta.uploadedCharacterReferences || null,
      error: rawMeta.error || null,
      cancelledAt: rawMeta.cancelledAt || null,
    };

    return res.status(200).json({
      id: workflow.id,
      title: workflow.title,
      type: workflow.type,
      subType: workflow.subType,
      status: workflow.status,
      scheduledAt: workflow.scheduledAt,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      metadata: filteredMetadata,
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
          coverArtURL_1_1: workflow.story.coverArtURL_1_1,
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

// Bulk Delete Workflows
export const bulkDeleteWorkflows = async (req, res) => {
  try {
    const { ids } = req.body;
    const userId = req.user?.userId;
    const role = req.user?.role;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }

    // Fetch all requested workflows with ownership check
    const workflows = await prisma.workflow.findMany({
      where: {
        id: { in: ids },
        ...(role === "CREATOR" ? { userId } : {}),
      },
      include: {
        story: { select: { id: true } },
      },
    });

    if (workflows.length === 0) {
      return res.status(404).json({ error: "No matching workflows found" });
    }

    // Collect story IDs that are linked to the workflows
    const storyIds = workflows
      .filter((w) => w.story?.id)
      .map((w) => w.story.id);

    // Get ALL workflow IDs belonging to those stories (to clean up siblings)
    let allWorkflowIdsToDelete = workflows.map((w) => w.id);

    if (storyIds.length > 0) {
      const siblingWorkflows = await prisma.workflow.findMany({
        where: { storyId: { in: storyIds } },
        select: { id: true },
      });
      const siblingIds = siblingWorkflows.map((w) => w.id);
      // Merge and de-duplicate
      allWorkflowIdsToDelete = [
        ...new Set([...allWorkflowIdsToDelete, ...siblingIds]),
      ];
    }

    // Delete all collected workflows first
    await prisma.workflow.deleteMany({
      where: { id: { in: allWorkflowIdsToDelete } },
    });

    // Delete stories (only those that had associated stories)
    if (storyIds.length > 0) {
      await prisma.story.deleteMany({
        where: { id: { in: storyIds } },
      });
    }

    logger.info(
      `Bulk deleted ${allWorkflowIdsToDelete.length} workflows and ${storyIds.length} stories by user ${userId}`
    );

    return res.status(200).json({
      message: `Successfully deleted ${workflows.length} workflow(s)`,
      deletedCount: workflows.length,
      deletedIds: workflows.map((w) => w.id),
    });
  } catch (error) {
    logger.error("Bulk Delete Workflows Error:", error);
    return res.status(500).json({ error: "Failed to bulk delete workflows" });
  }
};
