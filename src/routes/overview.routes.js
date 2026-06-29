import {
  getOverviewStats,
  getWorkflows,
  getPublishOptions,
  cancelWorkflow,
  deleteWorkflow,
  getWorkflowById,
  bulkDeleteWorkflows,
} from "../controllers/overview.controller.js";
import { verifyToken } from "../middlewares/auth.js";
import express from "express";

const router = express.Router();

// GET /api/overview/stats
router.get("/stats", verifyToken, getOverviewStats);

// GET /api/overview/workflows
router.get("/workflows", verifyToken, getWorkflows);

// GET /api/overview/publish-options
router.get("/publish-options", verifyToken, getPublishOptions);

// GET /api/overview/:id
router.get("/:id", verifyToken, getWorkflowById);

// POST /api/overview/cancel/:id
router.post("/cancel/:id", verifyToken, cancelWorkflow);

// DELETE /api/overview/bulk (bulk delete - must be before /:id)
router.delete("/bulk", verifyToken, bulkDeleteWorkflows);

// DELETE /api/overview/:id
router.delete("/:id", verifyToken, deleteWorkflow);

export default router;
