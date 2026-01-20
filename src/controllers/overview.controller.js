import prisma from "../config/prisma.client.js";

export const getOverview = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Fetch counts in parallel
    const [totalStories, videosCreated, voiceovers, podcasts] =
      await Promise.all([
        prisma.story.count(),
        prisma.video.count(),
        prisma.voiceover.count(),
        prisma.podcast.count(),
      ]);

    // Fetch last 20 workflows with only required fields
    const workflows = await prisma.workflow.findMany({
      where: { adminId: userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        title: true,
        status: true,
        metadata: true,
        createdAt: true,
        video: { select: { fileURL: true } },
      },
    });

    // Map workflows for frontend
    const stories = workflows.map((w) => ({
      id: w.id,
      workflow: w.id,
      title: w.title || "Untitled Workflow",
      status: w.status,
      createdAt: w.createdAt,
      error: w.metadata?.error || null,
      metadata: w.metadata || {},
      video: w.video ? { url: w.video.fileURL || null } : null,
    }));

    return res.status(200).json({
      totalStories,
      videosCreated,
      voiceovers,
      podcasts,
      stories,
    });
  } catch (error) {
    console.error("Overview Error:", error);
    return res.status(500).json({ error: "Failed to fetch overview" });
  }
};

// Get Workflow by ID
export const getWorkflowById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const workflow = await prisma.workflow.findFirst({
      where: { id, adminId: userId },
      include: {
        story: true,
        voiceover: true,
        video: true,
        podcast: {
          include: { episodes: true },
        },
        inputs: true,
        media: true,
        tasks: true,
      },
    });

    if (!workflow) return res.status(404).json({ error: "Workflow not found" });

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
      story: workflow.story
        ? {
            id: workflow.story.id,
            title: workflow.story.title,
            outline: workflow.story.outline,
            content: workflow.story.content,
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
            subtitles: workflow.video.subtitles,
          }
        : null,
      podcast: workflow.podcast
        ? {
            id: workflow.podcast.id,
            title: workflow.podcast.title,
            audience: workflow.podcast.audience,
            episodes: workflow.podcast.episodes.map((e) => ({
              id: e.id,
              title: e.title,
              script: e.script,
              audioURL: e.audioURL,
              duration: e.duration,
              episodeNo: e.episodeNo,
            })),
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
    console.error("Get Workflow By ID Error:", error);
    return res.status(500).json({ error: "Failed to fetch workflow" });
  }
};

// cancel workflow
export const cancelWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workflow = await prisma.workflow.findFirst({
      where: { id, adminId: userId },
    });

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    // Update status to CANCELLED
    await prisma.workflow.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    return res.status(200).json({ message: "Workflow cancelled successfully" });
  } catch (error) {
    console.error("Cancel Workflow Error:", error);
    return res.status(500).json({ error: "Failed to cancel workflow" });
  }
};

// Delete Workflow
export const deleteWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workflow = await prisma.workflow.findFirst({
      where: { id, adminId: userId },
      select: {
        id: true,
        voiceover: { select: { id: true } },
        podcast: { select: { id: true } },
      },
    });

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    const transactions = [
      prisma.input.deleteMany({ where: { workflowId: id } }),
      prisma.task.deleteMany({ where: { workflowId: id } }),
      prisma.media.deleteMany({ where: { workflowId: id } }),
    ];

    if (workflow.voiceover) {
      transactions.push(
        prisma.voiceover.delete({
          where: { id: workflow.voiceover.id },
        }),
      );
    }

    if (workflow.podcast) {
      transactions.push(
        prisma.podcast.delete({
          where: { id: workflow.podcast.id },
        }),
      );
    }

    transactions.push(prisma.workflow.delete({ where: { id } }));

    await prisma.$transaction(transactions);

    return res.status(200).json({
      message: "Workflow deleted successfully",
    });
  } catch (error) {
    console.error("Delete Workflow Error:", error);
    return res.status(500).json({ error: "Failed to delete workflow" });
  }
};
