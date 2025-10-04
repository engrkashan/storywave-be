import prisma from "../config/prisma.client.js";

// GET My Creations (Stories + Podcasts)
export const getMyCreations = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: User not found" });
    }

    const workflows = await prisma.workflow.findMany({
      where: { adminId: userId },
      include: {
        story: true,
        podcast: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const stories = workflows
      .filter((w) => w.story)
      .map((w) => ({
        id: w.story.id,
        title: w.story.title,
        type: "STORY",
        content: w.story.content,
        outline: w.story.outline,
        createdAt: w.story.createdAt,
      }));

    const podcasts = workflows
      .filter((w) => w.podcast)
      .map((w) => ({
        id: w.podcast.id,
        title: w.podcast.title,
        type: "PODCAST",
        audioURL: w.podcast.audioURL,
        duration: w.podcast.duration,
        guests: w.podcast.guests,
        episodes: w.podcast.episodes,
        audience: w.podcast.audience,
        createdAt: w.podcast.createdAt,
      }));

    return res.status(200).json({
      message: "My Creations fetched successfully",
      totalStories: stories.length,
      totalPodcasts: podcasts.length,
      data: {
        stories,
        podcasts,
      },
    });
  } catch (error) {
    console.error("Get My Creations Error:", error);
    return res.status(500).json({ error: "Failed to fetch creations" });
  }
};
