import express from "express";
import multer from "multer";
import { cloneVoice } from "../controllers/voiceClone.controller.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/", upload.single("voice_sample"), cloneVoice);

export default router;
