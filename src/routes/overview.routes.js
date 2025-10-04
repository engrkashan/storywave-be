import express from "express";
import { getOverview } from "../controllers/overview.controller.js";
import { verifyToken } from "../middlewares/auth.js";

const router = express.Router();

// GET /api/overview
router.get("/", verifyToken, getOverview);

export default router;
