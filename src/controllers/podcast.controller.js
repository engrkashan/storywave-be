import prisma from "../config/prisma.client.js";
import { CreationType } from "@prisma/client";
import { generatePodcast } from "../services/podcastService.js";

/**
 * Create a new podcast and store Cloudinary URLs
 */
export const createPodcast = async (req, res) => {
  try {
    const { topic, tone, type, audience, episodes, length, adminId } = req.body;

    if (!topic || !tone || !length || !adminId) {
      return res.status(400).json({
        success: false,
        message: "topic, tone, length, and adminId are required",
      });
    }

    // 1️⃣ Generate podcast (scripts + Cloudinary audio URLs)
    const generated = await generatePodcast({
      topic,
      tone,
      length,
      audience,
      episodes,
    });

    // 2️⃣ Workflow record
    const workflow = await prisma.workflow.create({
      data: {
        title: `${topic} Podcast Workflow`,
        type: CreationType.PODCAST,
        status: "COMPLETED",
        adminId,
      },
    });

    // 3️⃣ Podcast record
    const savedPodcast = await prisma.podcast.create({
      data: {
        title: generated.title,
        subType: type || null,
        audience: audience || null,
        adminId,
        workflowId: workflow.id,
      },
    });

    // 4️⃣ Episode records
    const episodeRecords = await Promise.all(
      generated.episodes.map((ep) =>
        prisma.episode.create({
          data: {
            title: ep.title,
            script: ep.script,
            audioURL: ep.audioURL,
            duration: ep.duration,
            episodeNo: ep.episodeNo,
            podcastId: savedPodcast.id,
          },
        })
      )
    );

    // 5️⃣ Response
    res.json({
      success: true,
      message: "Podcast with episodes generated successfully",
      data: {
        podcast: savedPodcast,
        episodes: episodeRecords,
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
 * Fetch all podcasts with episodes
 */
export const getPodcasts = async (req, res) => {
  try {
    const podcasts = await prisma.podcast.findMany({
      orderBy: { createdAt: "desc" },
      include: { episodes: true },
    });

    res.json({ success: true, data: podcasts });
  } catch (err) {
    console.error("Error fetching podcasts:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch podcasts",
      error: err.message,
    });
  }
};
