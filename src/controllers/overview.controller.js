import prisma from "../config/prisma.client.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("OverviewController");

export const getOverviewStats = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    const role = req?.user?.role;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Role-based access
    const whereByRole = role === "CREATOR" ? { userId } : {};

    // Status counts (parallel)
    const [
      totalStories,
      videosCreated,
      voiceovers,
      podcasts,
      pendingStories,
      completedStories,
      failedStories,
    ] = await Promise.all([
      prisma.story.count({ where: whereByRole }),
      prisma.video.count({ where: whereByRole }),
      prisma.voiceover.count({ where: whereByRole }),
      prisma.story.count({ where: { ...whereByRole, isPodcast: true } }),
      prisma.workflow.count({
        where: {
          ...whereByRole,
          status: { in: ["PENDING", "PROCESSING", "SCHEDULED"] },
        },
      }),
      prisma.workflow.count({ where: { ...whereByRole, status: "COMPLETED" } }),
      prisma.workflow.count({
        where: { ...whereByRole, status: { in: ["FAILED", "CANCELLED"] } },
      }),
    ]);

    return res.status(200).json({
      role,
      totalStories,
      videosCreated,
      voiceovers,
      podcasts,
      stats: {
        pending: pendingStories,
        completed: completedStories,
        cancelled: failedStories,
      },
    });
  } catch (error) {
    logger.error("Overview Stats Error:", error);
    return res.status(500).json({ error: "Failed to fetch overview stats" });
  }
};

export const getWorkflows = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    const role = req?.user?.role;
    let { page = 1, limit = 20, type } = req.query;

    page = parseInt(page, 10);
    limit = parseInt(limit, 10);
    const skip = (page - 1) * limit;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    logger.info(`[WORKFLOW DEBUG] controller entered — userId=${userId} role=${role} page=${page} limit=${limit} type=${type}`);
    const t0 = Date.now();

    const whereClause = {
      ...(role === "CREATOR" ? { userId } : {}),
      ...(type && type !== "ALL" ? { type } : {}),
    };

    // 1. Fetch Workflow base records (no large relation graphs, no unprojected metadata)
    const [workflows, total] = await Promise.all([
      prisma.workflow.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          storyId: true,
          videoId: true,
          userId: true,
        },
      }),
      prisma.workflow.count({ where: whereClause }),
    ]);

    // 2. Parallel single-indexed batch lookups for relations & error projection
    const storyIds = workflows.map((w) => w.storyId).filter(Boolean);
    const videoIds = workflows.map((w) => w.videoId).filter(Boolean);
    const userIds = workflows.map((w) => w.userId).filter(Boolean);
    const failedIds = workflows.filter((w) => w.status === "FAILED").map((w) => w.id);

    const [stories, videos, users, failedErrorsRaw] = await Promise.all([
      storyIds.length > 0
        ? prisma.story.findMany({
            where: { id: { in: storyIds } },
            select: {
              id: true,
              isPodcast: true,
              audioURL: true,
              coverArtURL: true,
              coverArtURL_16_9: true,
              coverArtURL_9_16: true,
              series: true,
            },
          })
        : [],
      videoIds.length > 0
        ? prisma.video.findMany({
            where: { id: { in: videoIds } },
            select: {
              id: true,
              fileURL: true,
              video_16_9: true,
              video_9_16: true,
            },
          })
        : [],
      userIds.length > 0
        ? prisma.user.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              fullName: true,
              role: true,
            },
          })
        : [],
      failedIds.length > 0
        ? prisma.$runCommandRaw({
            find: "Workflow",
            filter: { _id: { $in: failedIds.map((id) => ({ $oid: id })) } },
            projection: { "metadata.error": 1 },
          }).catch(() => ({ cursor: { firstBatch: [] } }))
        : { cursor: { firstBatch: [] } },
    ]);

    const storyMap = new Map(stories.map((s) => [s.id, s]));
    const videoMap = new Map(videos.map((v) => [v.id, v]));
    const userMap = new Map(users.map((u) => [u.id, u]));
    const errorMap = new Map();
    if (failedErrorsRaw?.cursor?.firstBatch) {
      for (const doc of failedErrorsRaw.cursor.firstBatch) {
        errorMap.set(doc._id?.$oid || String(doc._id), doc.metadata?.error || null);
      }
    }

    const formattedStories = workflows.map((w) => {
      const s = w.storyId ? storyMap.get(w.storyId) : null;
      const v = w.videoId ? videoMap.get(w.videoId) : null;
      const u = w.userId ? userMap.get(w.userId) : null;

      return {
        id: w.id,
        workflow: w.id,
        title: w.title || "Untitled Workflow",
        status: w.status,
        series: s?.series || null,
        createdAt: w.createdAt,
        error: errorMap.get(w.id) ?? null,
        isPodcast: s?.isPodcast || false,
        audioURL: s?.audioURL || null,
        thumbnail: s?.coverArtURL_16_9 || s?.coverArtURL_9_16 || s?.coverArtURL || null,
        video: v
          ? {
              fileURL: v.fileURL,
              video_16_9: v.video_16_9,
              video_9_16: v.video_9_16,
            }
          : null,
        owner: {
          id: u?.id,
          name: u?.fullName,
          role: u?.role,
        },
      };
    });

    logger.info(`[WORKFLOW DEBUG] response completed — total elapsed: ${Date.now() - t0}ms`);
    return res.status(200).json({
      stories: formattedStories,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error("Get Workflows Error:", error);
    return res.status(500).json({ error: "Failed to fetch workflows" });
  }
};

export const getPublishOptions = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    const role = req?.user?.role;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const whereByRole = role === "CREATOR" ? { userId } : {};

    const workflows = await prisma.workflow.findMany({
      where: {
        ...whereByRole,
        status: "COMPLETED",
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
      },
    });

    return res.status(200).json(workflows);
  } catch (error) {
    logger.error("Get Publish Options Error:", error);
    return res.status(500).json({ error: "Failed to fetch publish options" });
  }
};

// Get Workflow by ID
export const getWorkflowById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const role = req.user?.role;

    if (!userId) {
      return res
        .status(401)
        .json({ error: "Unauthorized – missing user identity" });
    }

    const filter = role === "CREATOR" ? { id, userId } : { id };

    const [workflow, metaCommand] = await Promise.all([
      prisma.workflow.findFirst({
        where: filter,
        select: {
          id: true,
          title: true,
          type: true,
          subType: true,
          status: true,
          scheduledAt: true,
          createdAt: true,
          updatedAt: true,
          story: true,
          voiceover: true,
          video: true,
          inputs: true,
          media: true,
          tasks: true,
          user: { select: { id: true, fullName: true, role: true } },
        },
      }),
      prisma.$runCommandRaw({
        find: "Workflow",
        filter: { _id: { $oid: id } },
        projection: {
          "metadata.mediaType": 1,
          "metadata.aspectRatio": 1,
          "metadata.dualPlatform": 1,
          "metadata.voice": 1,
          "metadata.voiceTone": 1,
          "metadata.storyLength": 1,
          "metadata.storyType": 1,
          "metadata.storyGuidelines": 1,
          "metadata.useStoryGuidelinesOnlyForPrompts": 1,
          "metadata.textIdea": 1,
          "metadata.imagePrompt": 1,
          "metadata.shouldGenerateImage": 1,
          "metadata.subtitles": 1,
          "metadata.soundEffects": 1,
          "metadata.characterTalk": 1,
          "metadata.backgroundMusic": 1,
          "metadata.backgroundMusicStyle": 1,
          "metadata.characterReferences": 1,
          "metadata.uploadedCharacterReferences": 1,
          "metadata.characterReferenceUrl": 1,
          "metadata.uploadedMediaUrl": 1,
          "metadata.storyMetadata": 1,
          "metadata.error": 1,
          "metadata.cancelledAt": 1,
        },
        limit: 1,
      }),
    ]);

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    const rawMeta = metaCommand?.cursor?.firstBatch?.[0]?.metadata || {};
    const filteredMetadata = {
      ...rawMeta,
      mediaType: rawMeta.mediaType || "multi_image",
      aspectRatio: rawMeta.aspectRatio || "16:9",
      dualPlatform: rawMeta.dualPlatform ?? false,
      voice: rawMeta.voice || null,
      voiceTone: rawMeta.voiceTone || rawMeta.storyMetadata?.voiceTone || null,
      storyLength: rawMeta.storyLength || null,
      storyType: rawMeta.storyType || rawMeta.storyMetadata?.genre || null,
      storyGuidelines:
        rawMeta.storyGuidelines ||
        rawMeta.storyMetadata?.storyGuidelines ||
        rawMeta.storyMetadata?.fallback_guidelines ||
        rawMeta.directorialGuidelines ||
        rawMeta.guidelines ||
        null,
      useStoryGuidelinesOnlyForPrompts:
        rawMeta.useStoryGuidelinesOnlyForPrompts ??
        rawMeta.storyMetadata?.useStoryGuidelinesOnlyForPrompts ??
        false,
      textIdea: rawMeta.textIdea || rawMeta.concept || null,
      imagePrompt: rawMeta.imagePrompt || null,
      shouldGenerateImage: rawMeta.shouldGenerateImage ?? true,
      subtitles: rawMeta.subtitles ?? true,
      soundEffects: rawMeta.soundEffects ?? false,
      characterTalk: rawMeta.characterTalk ?? false,
      backgroundMusic: rawMeta.backgroundMusic ?? true,
      backgroundMusicStyle: rawMeta.backgroundMusicStyle || rawMeta.storyMetadata?.backgroundMusicStyle || null,
      characterReferences: rawMeta.characterReferences || rawMeta.uploadedCharacterReferences || rawMeta.storyMetadata?.characterReferences || null,
      storyMetadata: rawMeta.storyMetadata || null,
      error: rawMeta.error || null,
      cancelledAt: rawMeta.cancelledAt || null,
    };

    return res.status(200).json({
      id: workflow.id,
      title: workflow.title,
      type: workflow.type,
      subType: workflow.subType,
      status: workflow.status,
      scheduledAt: workflow.scheduledAt,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
      metadata: filteredMetadata,
      owner: workflow.user
        ? {
          id: workflow.user.id,
          name: workflow.user.fullName,
          role: workflow.user.role,
        }
        : null,
      story: workflow.story
        ? {
          id: workflow.story.id,
          title: workflow.story.title,
          outline: workflow.story.outline,
          content: workflow.story.content,
          series: workflow.story.series,
          coverArtPrompt: workflow.story.coverArtPrompt,
          coverArtURL: workflow.story.coverArtURL,
          coverArtURL_1_1: workflow.story.coverArtURL_1_1,
          coverArtURL_9_16: workflow.story.coverArtURL_9_16,
          coverArtURL_16_9: workflow.story.coverArtURL_16_9,
          seoContent: workflow.story.seoContent,
          visualSuggestions: workflow.story.visualSuggestions,
        }
        : null,
      voiceover: workflow.voiceover
        ? {
          id: workflow.voiceover.id,
          script: workflow.voiceover.script,
          audioURL: workflow.voiceover.audioURL,
          voice: workflow.voiceover.voice,
        }
        : null,
      video: workflow.video
        ? {
          id: workflow.video.id,
          title: workflow.video.title,
          fileURL: workflow.video.fileURL,
          video_16_9: workflow.video.video_16_9,
          video_9_16: workflow.video.video_9_16,
          subtitles: workflow.video.subtitles,
        }
        : null,
      inputs: workflow.inputs.map((i) => ({
        id: i.id,
        type: i.type,
        source: i.source,
        processed: i.processed,
      })),
      media: workflow.media.map((m) => ({
        id: m.id,
        type: m.type,
        fileUrl: m.fileUrl,
        fileType: m.fileType,
        publicId: m.publicId,
        metadata: m.metadata || {},
      })),
      tasks: workflow.tasks.map((t) => ({
        id: t.id,
        step: t.step,
        status: t.status,
        log: t.log,
        metadata: t.metadata || {},
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    });
  } catch (error) {
    logger.error("Get Workflow By ID Error:", error);
    return res.status(500).json({ error: "Failed to fetch workflow" });
  }
};

// Get Story Builder Data by Workflow ID (Dedicated for Story Builder pre-population & regeneration)
export const getStoryBuilderInfo = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const role = req.user?.role;

    if (!userId) {
      return res
        .status(401)
        .json({ error: "Unauthorized – missing user identity" });
    }

    const filter = role === "CREATOR" ? { id, userId } : { id };

    const workflow = await prisma.workflow.findFirst({
      where: filter,
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        scheduledAt: true,
        createdAt: true,
        metadata: true,
        storyId: true,
        userId: true,
      },
    });

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    const [story, voiceover, user] = await Promise.all([
      workflow.storyId
        ? prisma.story.findUnique({
            where: { id: workflow.storyId },
            select: {
              id: true,
              title: true,
              outline: true,
              content: true,
              series: true,
              coverArtPrompt: true,
              coverArtURL: true,
              coverArtURL_16_9: true,
              coverArtURL_9_16: true,
              coverArtURL_1_1: true,
              seoContent: true,
              visualSuggestions: true,
              isPodcast: true,
              audioURL: true,
            },
          })
        : prisma.story.findFirst({
            where: { Workflow: { some: { id: workflow.id } } },
            select: {
              id: true,
              title: true,
              outline: true,
              content: true,
              series: true,
              coverArtPrompt: true,
              coverArtURL: true,
              coverArtURL_16_9: true,
              coverArtURL_9_16: true,
              coverArtURL_1_1: true,
              seoContent: true,
              visualSuggestions: true,
              isPodcast: true,
              audioURL: true,
            },
          }),
      prisma.voiceover.findFirst({
        where: { workflowId: workflow.id },
        select: {
          id: true,
          script: true,
          audioURL: true,
          voice: true,
        },
      }),
      workflow.userId
        ? prisma.user.findUnique({
            where: { id: workflow.userId },
            select: { id: true, fullName: true, role: true },
          })
        : null,
    ]);

    const rawMeta = workflow.metadata || {};

    // 1. Gather all sources of character references
    const uploadedRefs = Array.isArray(rawMeta.uploadedCharacterReferences) ? rawMeta.uploadedCharacterReferences : [];
    const directRefs = Array.isArray(rawMeta.characterReferences) ? rawMeta.characterReferences : [];
    const storyMetaRefs = Array.isArray(rawMeta.storyMetadata?.characterReferences) ? rawMeta.storyMetadata.characterReferences : [];
    const mgeRefs = Array.isArray(rawMeta.mgeCastBible?.characters) ? rawMeta.mgeCastBible.characters : [];
    const storyModelRefs = Array.isArray(story?.characterReferences) ? story.characterReferences : [];

    const allSources = [...uploadedRefs, ...directRefs, ...storyMetaRefs, ...mgeRefs, ...storyModelRefs];

    // Helper to find a Cloudinary / HTTP URL by character name across all metadata sources
    const findRemoteUrlForName = (name) => {
      if (!name) return null;
      const cleanName = name.trim().toLowerCase();
      for (const item of allSources) {
        if (!item) continue;
        const itemName = (item.name || item.id || "").trim().toLowerCase();
        if (itemName === cleanName || itemName.includes(cleanName) || cleanName.includes(itemName)) {
          const u = item.url || item.secure_url || item.portraitUrl || item.referenceImageUrl || item.image;
          if (typeof u === "string" && u.startsWith("http")) return u;
          if (typeof item.base64 === "string" && item.base64.startsWith("http")) return item.base64;
        }
      }
      return null;
    };

    // 2. Build list of unique characters, guaranteeing clean Cloudinary URLs and ZERO base64 blobs
    const charMap = new Map();
    const primaryList = directRefs.length > 0 ? directRefs : (uploadedRefs.length > 0 ? uploadedRefs : allSources);

    for (const c of primaryList) {
      if (!c) continue;
      const charName = (c.name || c.id || "").trim();
      if (!charName) continue;
      const key = charName.toLowerCase();

      if (!charMap.has(key)) {
        const directUrl = (typeof c.url === "string" && c.url.startsWith("http")) ? c.url : null;
        const base64Url = (typeof c.base64 === "string" && c.base64.startsWith("http")) ? c.base64 : null;
        const remoteUrl = directUrl || base64Url || findRemoteUrlForName(charName);
        const fallbackBase64 = (!remoteUrl && typeof c.base64 === "string" && c.base64.startsWith("data:")) ? c.base64 : "";

        charMap.set(key, {
          id: c.id || `char_${charMap.size + 1}`,
          name: charName,
          url: remoteUrl || "",
          base64: fallbackBase64,
        });
      }
    }

    // Also include any characters from uploadedRefs that were not in directRefs
    for (const u of uploadedRefs) {
      if (!u) continue;
      const uName = (u.name || u.id || "").trim();
      if (!uName) continue;
      const key = uName.toLowerCase();
      if (!charMap.has(key)) {
        const remoteUrl = (typeof u.url === "string" && u.url.startsWith("http")) ? u.url : "";
        charMap.set(key, {
          id: u.id || `char_${charMap.size + 1}`,
          name: uName,
          url: remoteUrl,
          base64: "",
        });
      }
    }

    // Support legacy single character reference image URL if list is still empty
    if (charMap.size === 0 && (rawMeta.characterReferenceUrl || rawMeta.uploadedCharacterReferenceUrl)) {
      const singleUrl = rawMeta.characterReferenceUrl || rawMeta.uploadedCharacterReferenceUrl;
      if (typeof singleUrl === "string" && singleUrl.startsWith("http")) {
        charMap.set("main_char", {
          id: "char_1",
          name: "Main Character",
          url: singleUrl,
          base64: "",
        });
      }
    }

    const normalizedCharRefs = Array.from(charMap.values());

    const resolvedStoryGuidelines =
      rawMeta.storyGuidelines ||
      rawMeta.storyMetadata?.storyGuidelines ||
      rawMeta.storyMetadata?.fallback_guidelines ||
      rawMeta.directorialGuidelines ||
      rawMeta.guidelines ||
      "";

    const resolvedUseGuidelinesOnly =
      rawMeta.useStoryGuidelinesOnlyForPrompts ??
      rawMeta.storyMetadata?.useStoryGuidelinesOnlyForPrompts ??
      false;

    const builderMetadata = {
      ...rawMeta,
      url: rawMeta.url || null,
      videoFile: rawMeta.videoFile || null,
      textIdea: rawMeta.textIdea || rawMeta.concept || story?.content || story?.outline || voiceover?.script || "",
      storyGuidelines: resolvedStoryGuidelines,
      useStoryGuidelinesOnlyForPrompts: resolvedUseGuidelinesOnly,
      imagePrompt: rawMeta.imagePrompt || "",
      shouldGenerateImage: rawMeta.shouldGenerateImage ?? true,
      storyType: rawMeta.storyType || rawMeta.genre || rawMeta.storyMetadata?.genre || story?.series || "fiction",
      voice: rawMeta.voice || voiceover?.voice || null,
      voiceTone: rawMeta.voiceTone || rawMeta.tone || rawMeta.storyMetadata?.voiceTone || null,
      storyLength: rawMeta.storyLength || (story?.duration ? `${story.duration} minutes` : null),
      mediaType: rawMeta.mediaType || "single_image",
      imageCount: rawMeta.imageCount || 5,
      backgroundMusic: rawMeta.backgroundMusic ?? true,
      backgroundMusicStyle: rawMeta.backgroundMusicStyle || rawMeta.storyMetadata?.backgroundMusicStyle || "",
      soundEffects: rawMeta.soundEffects ?? false,
      characterTalk: rawMeta.characterTalk ?? false,
      subtitles: rawMeta.subtitles ?? true,
      aspectRatio: rawMeta.aspectRatio || "16:9",
      dualPlatform: rawMeta.dualPlatform ?? false,
      series: rawMeta.series || story?.series || rawMeta.storyMetadata?.series || "",
      coverArtPrompt: rawMeta.coverArtPrompt || story?.coverArtPrompt || rawMeta.storyMetadata?.coverArtPrompt || "",
      seoContent: rawMeta.seoContent || story?.seoContent || rawMeta.storyMetadata?.seoContent || null,
      visualSuggestions: rawMeta.visualSuggestions || story?.visualSuggestions || rawMeta.storyMetadata?.visualSuggestions || "",
      uploadedMediaUrl: rawMeta.uploadedMediaUrl || null,
      characterReferences: normalizedCharRefs,
      storyMetadata: rawMeta.storyMetadata || null,
      useOmniAudio: rawMeta.useOmniAudio ?? false,
      autoPublish: rawMeta.autoPublish ?? true,
    };

    return res.status(200).json({
      id: workflow.id,
      title: workflow.title || story?.title || "",
      type: workflow.type,
      status: workflow.status,
      scheduledAt: workflow.scheduledAt,
      createdAt: workflow.createdAt,
      metadata: builderMetadata,
      story: story || null,
      voiceover: voiceover || null,
      owner: user
        ? {
            id: user.id,
            name: user.fullName,
            role: user.role,
          }
        : null,
    });
  } catch (error) {
    logger.error("Get Story Builder Info Error:", error);
    return res.status(500).json({ error: "Failed to fetch story builder details" });
  }
};

// cancel workflow
export const cancelWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const role = req.user?.role;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workflow = await prisma.workflow.findFirst({
      where: {
        id,
        ...(role === "CREATOR" ? { userId } : {}),
      },
    });

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    await prisma.workflow.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    return res.status(200).json({ message: "Workflow cancelled successfully" });
  } catch (error) {
    logger.error("Cancel Workflow Error:", error);
    return res.status(500).json({ error: "Failed to cancel workflow" });
  }
};

// Delete Workflow
export const deleteWorkflow = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    const role = req.user?.role;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const workflow = await prisma.workflow.findFirst({
      where: {
        id,
        ...(role === "CREATOR" ? { userId } : {}),
      },
      include: {
        story: {
          select: { id: true },
        },
      },
    });

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    // If this workflow has a story, delete the story (which will delete all its workflows)
    if (workflow.story) {
      // Get all workflows for this story
      const allWorkflows = await prisma.workflow.findMany({
        where: { storyId: workflow.story.id },
        select: { id: true },
      });

      // Delete all workflows for this story (MongoDB doesn't support cascade)
      if (allWorkflows.length > 0) {
        await prisma.workflow.deleteMany({
          where: {
            id: { in: allWorkflows.map((w) => w.id) },
          },
        });
      }

      // Delete the story
      await prisma.story.delete({
        where: { id: workflow.story.id },
      });
    } else {
      // No story associated, just delete the workflow
      await prisma.workflow.delete({ where: { id } });
    }

    return res.status(200).json({
      message: "Workflow deleted successfully",
    });
  } catch (error) {
    logger.error("Delete Workflow Error:", error);
    return res.status(500).json({ error: "Failed to delete workflow" });
  }
};

// Bulk Delete Workflows
export const bulkDeleteWorkflows = async (req, res) => {
  try {
    const { ids } = req.body;
    const userId = req.user?.userId;
    const role = req.user?.role;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }

    // Fetch all requested workflows with ownership check
    const workflows = await prisma.workflow.findMany({
      where: {
        id: { in: ids },
        ...(role === "CREATOR" ? { userId } : {}),
      },
      include: {
        story: { select: { id: true } },
      },
    });

    if (workflows.length === 0) {
      return res.status(404).json({ error: "No matching workflows found" });
    }

    // Collect story IDs that are linked to the workflows
    const storyIds = workflows
      .filter((w) => w.story?.id)
      .map((w) => w.story.id);

    // Get ALL workflow IDs belonging to those stories (to clean up siblings)
    let allWorkflowIdsToDelete = workflows.map((w) => w.id);

    if (storyIds.length > 0) {
      const siblingWorkflows = await prisma.workflow.findMany({
        where: { storyId: { in: storyIds } },
        select: { id: true },
      });
      const siblingIds = siblingWorkflows.map((w) => w.id);
      // Merge and de-duplicate
      allWorkflowIdsToDelete = [
        ...new Set([...allWorkflowIdsToDelete, ...siblingIds]),
      ];
    }

    // Delete all collected workflows first
    await prisma.workflow.deleteMany({
      where: { id: { in: allWorkflowIdsToDelete } },
    });

    // Delete stories (only those that had associated stories)
    if (storyIds.length > 0) {
      await prisma.story.deleteMany({
        where: { id: { in: storyIds } },
      });
    }

    logger.info(
      `Bulk deleted ${allWorkflowIdsToDelete.length} workflows and ${storyIds.length} stories by user ${userId}`
    );

    return res.status(200).json({
      message: `Successfully deleted ${workflows.length} workflow(s)`,
      deletedCount: workflows.length,
      deletedIds: workflows.map((w) => w.id),
    });
  } catch (error) {
    logger.error("Bulk Delete Workflows Error:", error);
    return res.status(500).json({ error: "Failed to bulk delete workflows" });
  }
};
