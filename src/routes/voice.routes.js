import express from "express";
import {
    getVoicePreview,
    getFishVoices,
    getElevenLabsVoices,
} from "../controllers/voice.controller.js";

const router = express.Router();

// Get Fish Audio voices
router.get("/fish-voices", getFishVoices);

// Get ElevenLabs voices
router.get("/elevenlabs-voices", getElevenLabsVoices);

// Generate voice preview
router.post("/preview", getVoicePreview);

export default router;
