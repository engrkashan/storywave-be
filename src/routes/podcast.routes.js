import express from "express";
import { createPodcast } from "../controllers/podcast.controller.js";

const router = express.Router();

// POST /api/podcast
router.post("/", createPodcast);

export default router;
