import express from "express";
import {
  changeAdminUserPassword,
  deleteAdminUser,
  getAdminUserProfile,
  updateAdminUser,
} from "../controllers/admin.controller.js";
import { verifyToken } from "../middlewares/auth.js";

const router = express.Router();

router.get("/profile", verifyToken, getAdminUserProfile);
router.patch("/profile", verifyToken, updateAdminUser);
router.patch("/change-password", verifyToken, changeAdminUserPassword);
router.delete("/:id", verifyToken, deleteAdminUser);

export default router;
