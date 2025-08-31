import express from "express";
import {
  createCreation,
  getCreations,
  getCreationById,
  updateCreation,
  deleteCreation,
} from "../controllers/creation.controller.js";
import { verifyToken } from "../middlewares/auth.js";

const router = express.Router();

router.post("/", verifyToken, createCreation); 
router.get("/", verifyToken, getCreations); 
router.get("/:id", verifyToken, getCreationById); 
router.patch("/:id", verifyToken, updateCreation); 
router.delete("/:id", verifyToken, deleteCreation); 

export default router;
