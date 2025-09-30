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

    const podcast = await generatePodcast({ topic, tone, length, audience });

    res.json({
      success: true,
      message: "Podcast generated successfully",
      data: podcast,
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
