import prisma from "../config/prisma.client.js";

export const getOverview = async (req, res) => {
  try {
    // Fetch counts directly from each table
    const [storiesCount, videosCount, voiceoversCount, podcastsCount] =
      await Promise.all([
        prisma.story.count(),
        prisma.video.count(),
        prisma.voiceover.count(),
        prisma.podcast.count(),
      ]);

    // Fetch all items directly from each table, ordered by creation date
    const [stories, videos, voiceovers, podcasts] = await Promise.all([
      prisma.story.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.video.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.voiceover.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.podcast.findMany({ orderBy: { createdAt: "desc" } }),
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
