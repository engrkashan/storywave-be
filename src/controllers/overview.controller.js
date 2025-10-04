import prisma from "../config/prisma.client.js";

// GET /api/overview
export const getOverview = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Count items directly from each table
    const [storiesCount, videosCount, voiceoversCount, podcastsCount] =
      await Promise.all([
        prisma.story.count({
          where: { adminId: userId },
        }),
        prisma.video.count({
          where: { adminId: userId },
        }),
        prisma.voiceover.count({
          where: { adminId: userId },
        }),
        prisma.podcast.count({
          where: { adminId: userId },
        }),
      ]);

    // Fetch all stories
    const stories = await prisma.story.findMany({
      where: { adminId: userId },
      orderBy: { createdAt: "desc" },
    });

    // Fetch all videos
    const videos = await prisma.video.findMany({
      where: { adminId: userId },
      orderBy: { createdAt: "desc" },
    });

    // Fetch all voiceovers
    const voiceovers = await prisma.voiceover.findMany({
      where: { adminId: userId },
      orderBy: { createdAt: "desc" },
    });

    // Fetch all podcasts
    const podcasts = await prisma.podcast.findMany({
      where: { adminId: userId },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json({
      totalStories: storiesCount,
      totalVideos: videosCount,
      totalVoiceovers: voiceoversCount,
      totalPodcasts: podcastsCount,
      stories,
      videos,
      voiceovers,
      podcasts,
    });
  } catch (error) {
    console.error("Overview Error:", error);
    return res.status(500).json({ error: "Failed to fetch overview" });
  }
};
