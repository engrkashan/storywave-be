import express from "express";
import {
    getVoicePreview,
    getFishVoices,
} from "../controllers/voice.controller.js";

const router = express.Router();

// Get Fish Audio voices
router.get("/fish-voices", getFishVoices);

// Generate voice preview
router.post("/preview", getVoicePreview);

export default router;
