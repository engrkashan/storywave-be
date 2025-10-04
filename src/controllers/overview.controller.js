import prisma from "../config/prisma.client.js";

// GET /api/overview
export const getOverview = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    // Count creations by type
    const [storiesCount, videosCount, voiceoversCount, podcastsCount] =
      await Promise.all([
        prisma.creation.count({
          where: { adminId: userId, type: "STORY" },
        }),
        prisma.creation.count({
          where: { adminId: userId, type: "VIDEO" },
        }),
        prisma.creation.count({
          where: { adminId: userId, type: "VOICEOVER" },
        }),
        prisma.creation.count({
          where: { adminId: userId, type: "PODCAST" },
        }),
      ]);

    // Fetch all stories
    const stories = await prisma.creation.findMany({
      where: { adminId: userId, type: "STORY" },
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
