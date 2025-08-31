import express from "express";
import {
  createStory,
  getStories,
  getStoryById,
  updateStory,
  deleteStory,
} from "../controllers/story.controller.js";
import { verifyToken } from "../middlewares/auth.js";

const router = express.Router();

// CREATE
router.post("/", verifyToken, createStory);

// READ
router.get("/", verifyToken, getStories);
router.get("/:id", verifyToken, getStoryById);

// UPDATE
router.patch("/:id", verifyToken, updateStory);

// DELETE
router.delete("/:id", verifyToken, deleteStory);

export default router;
