import prisma from "../config/prisma.client.js";
import { CreationType } from "@prisma/client";
import { generatePodcast } from "../services/podcastService.js";

/**
 * Create a new podcast (with episodes)
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

    // 1️⃣ Generate all episodes (scripts + audio)
    const generated = await generatePodcast({
      topic,
      tone,
      length,
      audience,
      episodes,
    });

    // 2️⃣ Create workflow
    const workflow = await prisma.workflow.create({
      data: {
        title: `${topic} Podcast Workflow`,
        type: CreationType.PODCAST,
        status: "COMPLETED",
        adminId,
      },
    });

    // 3️⃣ Create main podcast entry
    const savedPodcast = await prisma.podcast.create({
      data: {
        title: generated.title,
        subType: type || null,
        audience: audience || null,
        adminId,
        workflowId: workflow.id,
      },
    });

    // 4️⃣ Create all episode records
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

    // 5️⃣ Respond with success
    res.json({
      success: true,
      message: "Podcast with episodes generated successfully",
      data: {
        podcast: savedPodcast,
        episodes: episodeRecords.map((ep) => ({
          ...ep,
          publicURL: `${req.protocol}://${req.get("host")}/static${
            ep.audioURL
          }`,
        })),
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
 * Fetch all podcasts with their episodes
 */
export const getPodcasts = async (req, res) => {
  try {
    const podcasts = await prisma.podcast.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        episodes: true,
      },
    });

    const formatted = podcasts.map((p) => ({
      ...p,
      episodes: p.episodes.map((ep) => ({
        ...ep,
        publicURL: `${req.protocol}://${req.get("host")}/static${ep.audioURL}`,
      })),
    }));

    res.json({
      success: true,
      data: formatted,
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
