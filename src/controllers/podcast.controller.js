import prisma from "../config/prisma.client.js";
import { CreationType } from "@prisma/client";
import { generatePodcast } from "../services/podcastService.js";

/**
 * Create a podcast
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

    // Generate podcast files
    const podcast = await generatePodcast({
      topic,
      tone,
      length,
      audience,
      episodes,
    });

    // Create workflow
    const workflow = await prisma.workflow.create({
      data: {
        title: `${topic} Podcast Workflow`,
        type: "PODCAST", 
        subType: type || null, 
        status: "COMPLETED",
        adminId,
      },
    });

    // Save podcast record
    const savedPodcast = await prisma.podcast.create({
      data: {
        title: podcast.title,
        script: podcast.script.join("\n\n"),
        audioURL: podcast.audioURL,
        duration: podcast.duration || null,
        subType: type || null,
        episodes: episodes || null,
        audience: audience || null,
        workflow: {
          connect: { id: workflow.id },
        },
      },
    });

    // Save media reference
    await prisma.workflow.create({
      data: {
        title: `${topic} Podcast Workflow`,
        type: CreationType.PODCAST,
        subType: type || null,
        status: "COMPLETED",
        adminId,
      },
    });

    res.json({
      success: true,
      message: "Podcast generated and stored successfully",
      data: {
        ...savedPodcast,
        script: podcast.script,
        publicURL: `${req.protocol}://${req.get("host")}/static${
          podcast.audioURL
        }`,
        workflowId: workflow.id,
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
      publicURL: `${req.protocol}://${req.get("host")}/static${p.audioURL}`,
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
