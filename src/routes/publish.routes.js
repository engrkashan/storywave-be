import express from "express";
import { verifyToken } from "../middlewares/auth.js";
import {
  checkHealth,
  getChannels,
  getProfiles,
  handleMallaryWebhook,
  createPost,
  getPosts,
  getPostById,
  cancelPost,
  reschedulePost,
  syncStatuses,
  getStats,
} from "../controllers/publish.controller.js";
import { sseMiddleware } from "../utils/sse.js";

const router = express.Router();

// Mallary webhooks (must be public)
router.post("/webhook/mallary", handleMallaryWebhook);

// SSE for live dashboard updates
router.get("/live-status", sseMiddleware);

// All other publish routes require authentication
router.use(verifyToken);

// Health / config
router.get("/health", checkHealth);

// Mallary channel management
router.get("/channels", getChannels);
router.get("/profiles", getProfiles);

// Post management
router.get("/posts", getPosts);
router.get("/stats", getStats);
router.post("/post", createPost);
router.get("/posts/:id", getPostById);
router.patch("/posts/:id/cancel", cancelPost);
router.patch("/posts/:id/reschedule", reschedulePost);

// Admin sync
router.post("/sync", syncStatuses);

export default router;
