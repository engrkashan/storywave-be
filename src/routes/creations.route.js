import express from "express";
import { getMyCreations } from "../controllers/creations.controller.js";
import { verifyToken } from "../middlewares/auth.js";

const router = express.Router();

router.get("/", verifyToken, getMyCreations);

export default router;
