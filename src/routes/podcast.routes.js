import express from "express";
import {
  createPodcast,
  getPodcasts,
} from "../controllers/podcast.controller.js";

const router = express.Router();

// POST /api/podcast -> generate & save a podcast
router.post("/", createPodcast);

// GET /api/podcast -> list all podcasts
router.get("/", getPodcasts);

export default router;
