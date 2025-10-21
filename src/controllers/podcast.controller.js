import prisma from "../config/prisma.client.js";
import { CreationType } from "@prisma/client";

import { generateLongPodcastEpisode } from "../services/podcastService.js"; 

/**
 * Create a long-form podcast (30–40 min) with structured segments
 */
export const createPodcast = async (req, res) => {
  try {
    const { topic, tone, type, audience, length, adminId, voice } = req.body;

    // 🧩 Validate input
    if (!topic || !tone || !length || !adminId) {
      return res.status(400).json({
        success: false,
        message: "topic, tone, length, and adminId are required",
      });
    }

    console.log(`🎧 Starting long-form podcast generation for: ${topic}`);

    // 1️⃣ Generate the full long-form episode (outline → TTS → merge)
    const generated = await generateLongPodcastEpisode({
      topic,
      tone,
      audience,
      length,
      voice: voice || "onyx",
    });

    // 2️⃣ Create workflow record
    const workflow = await prisma.workflow.create({
      data: {
        title: `${topic} Podcast Workflow`,
        type: CreationType.PODCAST,
        status: "COMPLETED",
        adminId,
        metadata: {
          length,
          totalDuration: generated.totalDuration,
          segments: generated.segments.length,
        },
      },
    });

    // 3️⃣ Create podcast record
    const savedPodcast = await prisma.podcast.create({
      data: {
        title: generated.episodeTitle,
        audience: audience || null,
        subType: type || null,
        adminId,
        workflowId: workflow.id,
      },
    });

    // 4️⃣ Create episode record
    const episodeRecord = await prisma.episode.create({
      data: {
        title: generated.episodeTitle,
        script: generated.segments.map((s) => s.script).join("\n\n---\n\n"),
        audioURL: generated.mergedFileUrl,
        duration: generated.totalDuration,
        episodeNo: 1,
        podcastId: savedPodcast.id,
      },
    });

    // 5️⃣ Store each segment (optional granular storage)
    for (let i = 0; i < generated.segments.length; i++) {
      const seg = generated.segments[i];
      await prisma.media.create({
        data: {
          type: "PODCAST",
          fileUrl: seg.audioUrl,
          fileType: "audio/mpeg",
          workflowId: workflow.id,
        },
      });
    }

    // ✅ Done
    return res.json({
      success: true,
      message: "Long-form podcast generated successfully",
      data: {
        podcast: savedPodcast,
        episode: episodeRecord,
      },
    });
  } catch (err) {
    console.error("❌ Error generating podcast:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to generate podcast",
      error: err.message,
    });
  }
};

/**
 * Fetch all podcasts with episodes and metadata
 */
export const getPodcasts = async (req, res) => {
  try {
    const podcasts = await prisma.podcast.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        episodes: true,
        workflow: true,
      },
    });

    res.json({
      success: true,
      data: podcasts,
    });
  } catch (err) {
    console.error("❌ Error fetching podcasts:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch podcasts",
      error: err.message,
    });
  }
};
