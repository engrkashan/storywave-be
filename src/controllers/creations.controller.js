import prisma from "../config/prisma.client.js";

// GET My Creations
export const getMyCreations = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: User not found" });
    }

    // Fetch all workflows created by the current user
    const workflows = await prisma.workflow.findMany({
      where: { adminId: userId },
      include: {
        story: true,
        video: true,
        podcast: {
          include: {
            episodes: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // STORIES 
    const stories = workflows
      .filter((w) => w.story && w.video)
      .map((w) => ({
        id: w.story.id,
        title: w.story.title || w.video.title || "Untitled Story",
        type: "STORY",
        createdAt: w.story.createdAt,
        video: {
          id: w.video.id,
          url: w.video.fileURL || null,
          duration: w.video.duration || null,
          subtitles: w.video.subtitles || null,
        },
      }));

    // PODCASTS — only those that have a valid episode (.mp3)
    const podcasts = workflows
      .filter((w) => w.podcast)
      .map((w) => {
        const firstEpisode = w.podcast.episodes?.[0] || null;
        return {
          id: w.podcast.id,
          title: w.podcast.title || "Untitled Podcast",
          type: "PODCAST",
          audience: w.podcast.audience || "general",
          createdAt: w.podcast.createdAt,
          episode: firstEpisode
            ? {
                id: firstEpisode.id,
                title: firstEpisode.title,
                audioURL: firstEpisode.audioURL,
                duration: firstEpisode.duration,
                episodeNo: firstEpisode.episodeNo,
              }
            : null,
        };
      });

    return res.status(200).json({
      message: "My Creations fetched successfully",
      totalStories: stories.length,
      totalPodcasts: podcasts.length,
      data: { stories, podcasts },
    });
  } catch (error) {
    console.error("Get My Creations Error:", error);
    return res.status(500).json({ error: "Failed to fetch creations" });
  }
};
