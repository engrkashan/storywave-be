import prisma from "../config/prisma.client.js";

export const getOverview = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const [storiesCount, videosCount, voiceoversCount, podcastsCount] =
      await Promise.all([
        prisma.story.count({ where: { adminId: userId } }),
        prisma.video.count({ where: { adminId: userId } }),
        prisma.voiceover.count({ where: { adminId: userId } }),
        prisma.podcast.count({ where: { adminId: userId } }),
      ]);

    const [stories, videos, voiceovers, podcasts] = await Promise.all([
      prisma.story.findMany({ where: { adminId: userId }, orderBy: { createdAt: "desc" } }),
      prisma.video.findMany({ where: { adminId: userId }, orderBy: { createdAt: "desc" } }),
      prisma.voiceover.findMany({ where: { adminId: userId }, orderBy: { createdAt: "desc" } }),
      prisma.podcast.findMany({ where: { adminId: userId }, orderBy: { createdAt: "desc" } }),
    ]);

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
