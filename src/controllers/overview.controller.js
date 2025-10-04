import prisma from "../config/prisma.client.js";

// GET /api/overview
export const getOverview = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    // Count items directly from each table
    const [storiesCount, videosCount, voiceoversCount, podcastsCount] = await Promise.all([
      prisma.story.count({
        where: { workflow: { adminId: userId } },
      }),
      prisma.video.count({
        where: { workflow: { adminId: userId } },
      }),
      prisma.voiceover.count({
        where: { workflow: { adminId: userId } },
      }),
      prisma.podcast.count({
        where: { workflow: { adminId: userId } },
      }),
    ]);

    // Fetch all stories
    const stories = await prisma.story.findMany({
      where: { workflow: { adminId: userId } },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json({
      totalStories: storiesCount,
      videosCreated: videosCount,
      voiceovers: voiceoversCount,
      podcasts: podcastsCount,
      stories,
    });
  } catch (error) {
    console.error("Overview Error:", error);
    return res.status(500).json({ error: "Failed to fetch overview" });
  }
};
