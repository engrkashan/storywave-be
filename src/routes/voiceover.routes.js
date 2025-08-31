import express from "express";
import {
  createVoiceover,
  getAllVoiceovers,
  getVoiceoverById,
  updateVoiceover,
  deleteVoiceover,
} from "../controllers/voiceover.controller.js";
import { verifyToken } from "../middlewares/auth.js";

const router = express.Router();

router.post("/", verifyToken, createVoiceover);
router.get("/", verifyToken, getAllVoiceovers);
router.get("/:id", verifyToken, getVoiceoverById);
router.patch("/:id", verifyToken, updateVoiceover);
router.delete("/:id", verifyToken, deleteVoiceover);

export default router;
