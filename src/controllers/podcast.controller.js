import prisma from "../config/prisma.client.js";
import { generatePodcast } from "../services/podcastService.js";

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
        audioURL: podcast.audioURL,
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

    res.json({
      success: true,
      message: "Podcast generated and stored successfully",
      data: savedPodcast,
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
