import prisma from "../config/prisma.client.js";

// export const getOverview = async (req, res) => {
//   try {
//     // Fetch counts directly from each table
//     const [storiesCount, videosCount, voiceoversCount, podcastsCount] =
//       await Promise.all([
//         prisma.story.count(),
//         prisma.video.count(),
//         prisma.voiceover.count(),
//         prisma.podcast.count(),
//       ]);

//     const userId = req?.user?.userId;
//     if (!userId) {
//       return res.status(401).json({ error: "Unauthorized: User not found" });
//     }

//     // Fetch workflows for this admin
//     const workflows = await prisma.workflow.findMany({
//       where: { adminId: userId },
//       include: {
//         story: true,
//         voiceover: true,
//         video: true,
//         podcast: {
//           include: {
//             episodes: true,
//           },
//         },
//       },
//       orderBy: { createdAt: "desc" },
//     });

//     // Build stories array
//     const stories = workflows
//       .map((w) => ({
//         id: w.story?.id || w.id, // Fallback to workflow ID if story ID is missing
//         workflow: w.id,
//         title: w.story?.title || w.title || "Untitled Workflow",
//         type: "STORY",
//         createdAt: w.createdAt,
//         content: w.story?.content || null,
//         status: w.status,
//         error: w.metadata?.error || null, // Include error from metadata
//         voiceover: w.voiceover
//           ? {
//             id: w.voiceover.id,
//             voice: w.voiceover.voice || "Default",
//             audioURL: w.voiceover.audioURL || null,
//             script: w.voiceover.script || null,
//           }
//           : null,
//         video: w.video
//           ? {
//             id: w.video.id,
//             url: w.video.fileURL || null,
//             duration: w.video.duration || null,
//             subtitles: w.video.subtitles || null,
//           }
//           : null,
//       }));

//     // Take top 20 recent workflows (regardless of status)
//     const recentWorkflows = stories.slice(0, 20);

//     return res.status(200).json({
//       totalStories: storiesCount,
//       totalVideos: videosCount,
//       totalVoiceovers: voiceoversCount,
//       totalPodcasts: podcastsCount,
//       stories: recentWorkflows,
//     });
//   } catch (error) {
//     console.error("Overview Error:", error);
//     return res.status(500).json({ error: "Failed to fetch overview" });
//   }
// };


export const getOverview = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    // Fetch counts in parallel
    const [totalStories, videosCreated, voiceovers, podcasts] = await Promise.all([
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
