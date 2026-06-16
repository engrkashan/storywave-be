import express from "express";
import { verifyToken } from "../middlewares/auth.js";
import {
  checkHealth,
  getChannels,
  getBrands,
  createPost,
  getPosts,
  getPostById,
  cancelPost,
  reschedulePost,
  syncStatuses,
  getStats,
} from "../controllers/publish.controller.js";

const router = express.Router();

// All publish routes require authentication
router.use(verifyToken);

// Health / config
router.get("/health", checkHealth);

// Mallary channel management
router.get("/channels", getChannels);
router.get("/brands", getBrands);

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
