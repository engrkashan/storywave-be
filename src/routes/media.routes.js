import express from "express";
import {
  createMediaHandler,
  getAllMediaHandler,
  getMediaByIdHandler,
  deleteMediaHandler,
} from "../controllers/media.controller.js";

import { mediaUpload } from "../utils/upload.mw.js";

const router = express.Router();

router.post("/", mediaUpload.single("file"), createMediaHandler);
router.get("/", getAllMediaHandler);
router.get("/:id", getMediaByIdHandler);
router.delete("/:id", deleteMediaHandler);

export default router;
