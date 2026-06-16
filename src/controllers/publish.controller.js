import prisma from "../config/prisma.client.js";
import { createLogger } from "../utils/logger.js";
import {
  getMallaryChannels,
  getMallaryBrands,
  pingMallary,
  getDefaultScheduleTime,
} from "../services/mallaryService.js";
import {
  scheduleStoryPost,
  cancelSocialPost,
  rescheduleSocialPost,
  syncPostStatuses,
} from "../services/socialPublishService.js";

const logger = createLogger("PublishController");

/**
 * GET /api/publish/health
 * Check Mallary API connectivity
 */
export async function checkHealth(req, res) {
  try {
    const result = await pingMallary();
    return res.json({
      success: true,
      mallaryConnected: result.ok,
      message: result.ok ? "Mallary API is reachable" : result.error,
    });
  } catch (err) {
    logger.error(`Health check failed: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * GET /api/publish/channels
 * List all connected channels from Mallary
 */
export async function getChannels(req, res) {
  try {
    const channels = await getMallaryChannels();
    return res.json({ success: true, channels });
  } catch (err) {
    logger.error(`getChannels error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * GET /api/publish/brands
 * List brands from Mallary
 */
export async function getBrands(req, res) {
  try {
    const data = await getMallaryBrands();
    return res.json({ success: true, brands: data?.brands || data?.data || [] });
  } catch (err) {
    logger.error(`getBrands error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * POST /api/publish/post
 * Manually schedule a post from the dashboard
 * Body: { workflowId, platform, channelId, channelName, caption, scheduledAt, thumbnailUrl, tags, title }
 */
export async function createPost(req, res) {
  const {
    workflowId,
    platform,
    channelId,
    channelName,
    caption,
    scheduledAt,
    thumbnailUrl,
    tags = [],
    title,
    mediaUrl,
  } = req.body;

  if (!workflowId || !platform || !channelId || !mediaUrl) {
    return res.status(400).json({
      success: false,
      message: "workflowId, platform, channelId, and mediaUrl are required",
    });
  }

  try {
    // Validate workflow exists
    const workflow = await prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!workflow) {
      return res.status(404).json({ success: false, message: "Workflow not found" });
    }

    // Default to 1 hour from now if no scheduledAt
    const resolvedScheduledAt = scheduledAt || getDefaultScheduleTime(60);

    const socialPost = await scheduleStoryPost({
      workflowId,
      platform,
      channelId,
      channelName,
      mediaUrl,
      caption,
      scheduledAt: resolvedScheduledAt,
      thumbnailUrl,
      tags,
      title,
    });

    return res.status(201).json({ success: true, socialPost });
  } catch (err) {
    logger.error(`createPost error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * GET /api/publish/posts
 * List all social posts (with optional filters)
 * Query: ?workflowId=&platform=&status=&page=&limit=
 */
export async function getPosts(req, res) {
  const { workflowId, platform, status, page = 1, limit = 20 } = req.query;

  try {
    const where = {};
    if (workflowId) where.workflowId = workflowId;
    if (platform) where.platform = platform.toLowerCase();
    if (status) where.status = status.toUpperCase();

    const [posts, total] = await Promise.all([
      prisma.socialPost.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
        include: {
          workflow: {
            select: {
              id: true,
              title: true,
              status: true,
            },
          },
        },
      }),
      prisma.socialPost.count({ where }),
    ]);

    return res.json({
      success: true,
      posts,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    logger.error(`getPosts error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * GET /api/publish/posts/:id
 * Get a single social post by ID
 */
export async function getPostById(req, res) {
  const { id } = req.params;
  try {
    const post = await prisma.socialPost.findUnique({
      where: { id },
      include: {
        workflow: {
          select: { id: true, title: true, status: true, metadata: true },
        },
      },
    });
    if (!post) return res.status(404).json({ success: false, message: "Post not found" });
    return res.json({ success: true, post });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * PATCH /api/publish/posts/:id/cancel
 * Cancel a scheduled post
 */
export async function cancelPost(req, res) {
  const { id } = req.params;
  try {
    const post = await cancelSocialPost(id);
    return res.json({ success: true, post });
  } catch (err) {
    logger.error(`cancelPost error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * PATCH /api/publish/posts/:id/reschedule
 * Reschedule a post to a new time
 * Body: { scheduledAt: ISO string }
 */
export async function reschedulePost(req, res) {
  const { id } = req.params;
  const { scheduledAt } = req.body;

  if (!scheduledAt) {
    return res.status(400).json({ success: false, message: "scheduledAt is required" });
  }

  try {
    const post = await rescheduleSocialPost(id, scheduledAt);
    return res.json({ success: true, post });
  } catch (err) {
    logger.error(`reschedulePost error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * POST /api/publish/sync
 * Manually trigger status sync from Mallary (admin only)
 */
export async function syncStatuses(req, res) {
  try {
    await syncPostStatuses();
    return res.json({ success: true, message: "Status sync complete" });
  } catch (err) {
    logger.error(`syncStatuses error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * GET /api/publish/stats
 * Aggregate stats for the publish dashboard
 */
export async function getStats(req, res) {
  try {
    const [byStatus, byPlatform, recent] = await Promise.all([
      prisma.socialPost.groupBy({
        by: ["status"],
        _count: { status: true },
      }),
      prisma.socialPost.groupBy({
        by: ["platform"],
        _count: { platform: true },
      }),
      prisma.socialPost.findMany({
        orderBy: { createdAt: "desc" },
        take: 5,
        include: {
          workflow: { select: { id: true, title: true } },
        },
      }),
    ]);

    return res.json({
      success: true,
      stats: {
        byStatus: byStatus.reduce((acc, s) => ({ ...acc, [s.status]: s._count.status }), {}),
        byPlatform: byPlatform.reduce((acc, p) => ({ ...acc, [p.platform]: p._count.platform }), {}),
        recent,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}
