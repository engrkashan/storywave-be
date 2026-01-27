import express from "express";
import {
  changeUserPassword,
  deleteUser,
  getUserProfile,
  updateUser,
} from "../controllers/admin.controller.js";
import { verifyToken } from "../middlewares/auth.js";

const router = express.Router();

router.get("/profile", verifyToken, getUserProfile);
router.patch("/profile", verifyToken, updateUser);
router.patch("/change-password", verifyToken, changeUserPassword);
router.delete("/:id", verifyToken, deleteUser);

export default router;
