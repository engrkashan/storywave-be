import {
  getOverview,
  cancelWorkflow,
  deleteWorkflow,
} from "../controllers/overview.controller.js";
import { verifyToken } from "../middlewares/auth.js";
import express from "express";

const router = express.Router();

// GET /api/overview
router.get("/", verifyToken, getOverview);

// POST /api/overview/cancel/:id
router.post("/cancel/:id", verifyToken, cancelWorkflow);

// DELETE /api/overview/:id
router.delete("/:id", verifyToken, deleteWorkflow);

export default router;
