// import prisma from "../config/prisma.client.js";

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

//     // Fetch all items directly from each table, ordered by creation date
//     const [ videos, voiceovers, podcasts] = await Promise.all([
//       prisma.video.findMany({ orderBy: { createdAt: "desc" } }),
//       prisma.voiceover.findMany({ orderBy: { createdAt: "desc" } }),
//       prisma.podcast.findMany({ orderBy: { createdAt: "desc" } }),
//     ]);

//     const userId = req?.user?.userId;
//     if (!userId) {
//       return res.status(401).json({ error: "Unauthorized: User not found" });
//     }

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

//     const stories = workflows
//       .filter((w) => w.story)
//       .map((w) => ({
//         id: w.story.id,
//         title: w.story.title || w.video?.title || "Untitled Story",
//         type: "STORY",
//         createdAt: w.story.createdAt,
//         content: w.story.content || null,
//         voiceover: w.voiceover
//           ? {
//               id: w.voiceover.id,
//               voice: w.voiceover.voice || "Default",
//               audioURL: w.voiceover.audioURL || null,
//               script: w.voiceover.script || null,
//             }
//           : null,
//         video: w.video
//           ? {
//               id: w.video.id,
//               url: w.video.fileURL || null,
//               duration: w.video.duration || null,
//               subtitles: w.video.subtitles || null,
//             }
//           : null,
//       }));

//     return res.status(200).json({
//       totalStories: storiesCount,
//       totalVideos: videosCount,
//       totalVoiceovers: voiceoversCount,
//       totalPodcasts: podcastsCount,
//       stories,
//       videos,
//       voiceovers,
//     });
//   } catch (error) {
//     console.error("Overview Error:", error);
//     return res.status(500).json({ error: "Failed to fetch overview" });
//   }
// };


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

    // Fetch other items directly from each table, ordered by creation date
    const [videos, voiceovers, podcasts] = await Promise.all([
      prisma.video.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.voiceover.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.podcast.findMany({ orderBy: { createdAt: "desc" } }),
    ]);

    const userId = req?.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized: User not found" });
    }

    // Fetch workflows for this admin
    const workflows = await prisma.workflow.findMany({
      where: { adminId: userId },
      include: {
        story: true,
        voiceover: true,
        video: true,
        podcast: {
          include: {
            episodes: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Build stories array
    const stories = workflows
      .filter((w) => w.story)
      .map((w) => ({
        id: w.story.id,
        title: w.story.title || w.video?.title || "Untitled Story",
        type: "STORY",
        createdAt: w.story.createdAt,
        content: w.story.content || null,
        status: w.status, // <-- status added
        voiceover: w.voiceover
          ? {
            id: w.voiceover.id,
            voice: w.voiceover.voice || "Default",
            audioURL: w.voiceover.audioURL || null,
            script: w.voiceover.script || null,
          }
          : null,
        video: w.video
          ? {
            id: w.video.id,
            url: w.video.fileURL || null,
            duration: w.video.duration || null,
            subtitles: w.video.subtitles || null,
          }
          : null,
      }));

    // ⭐ NEW: Only take 3 completed stories
    const completedStories = stories
      .filter((s) => s.status === "COMPLETED")
      .slice(0, 3);

    return res.status(200).json({
      totalStories: storiesCount,
      totalVideos: videosCount,
      totalVoiceovers: voiceoversCount,
      totalPodcasts: podcastsCount,

      stories: completedStories, // only 3 completed stories

      videos,
      voiceovers,
      podcasts,
    });
  } catch (error) {
    console.error("Overview Error:", error);
    return res.status(500).json({ error: "Failed to fetch overview" });
  }
};
