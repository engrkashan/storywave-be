import express from "express";
import multer from "multer";
import {
  cloneVoice,
  getVoiceClones,
} from "../controllers/voiceClone.controller.js";
import { verifyToken } from "../middlewares/auth.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Protected routes
router.post("/", verifyToken, upload.single("voice_sample"), cloneVoice);
router.get("/", verifyToken, getVoiceClones);

export default router;
