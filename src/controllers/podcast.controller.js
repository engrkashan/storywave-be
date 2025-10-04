import prisma from "../config/prisma.client.js";
import { generatePodcast } from "../services/podcastService.js";

/**
 * Create a podcast
 */
export const createPodcast = async (req, res) => {
  try {
    const { topic, tone, length, audience } = req.body;

    if (!topic || !tone || !length) {
      return res.status(400).json({
        success: false,
        message: "topic, tone, and length are required",
      });
    }

    // 1. Generate podcast files
    const podcast = await generatePodcast({ topic, tone, length, audience });

    // 2. Save podcast entry in DB
    const savedPodcast = await prisma.podcast.create({
      data: {
        title: podcast.title,
        script: podcast.script.join("\n\n"),
        audioURL: podcast.audioURL, // already relative path like /podcasts/xxx.mp3
      },
    });

    // 3. Save media record for easier access
    await prisma.media.create({
      data: {
        type: "PODCAST",
        fileUrl: podcast.audioURL,
        fileType: "audio/mpeg",
      },
    });

    // ✅ Return the full podcast including script and public URL
    res.json({
      success: true,
      message: "Podcast generated and stored successfully",
      data: {
        ...savedPodcast,
        script: podcast.script, // keep as array for frontend ease
        publicURL: `${req.protocol}://${req.get("host")}${podcast.audioURL}`,
      },
    });
  } catch (err) {
    console.error("Error generating podcast:", err);
    res.status(500).json({
      success: false,
      message: "Failed to generate podcast",
      error: err.message,
    });
  }
};

/**
 * Get all podcasts
 */
export const getPodcasts = async (req, res) => {
  try {
    const podcasts = await prisma.podcast.findMany({
      orderBy: { createdAt: "desc" },
    });

    const withUrls = podcasts.map((p) => ({
      ...p,
      publicURL: `${req.protocol}://${req.get("host")}${p.audioURL}`,
    }));

    res.json({
      success: true,
      data: withUrls,
    });
  } catch (err) {
    console.error("Error fetching podcasts:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch podcasts",
      error: err.message,
    });
  }
};
