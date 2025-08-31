import express from "express";
import {
  registerAdminUser,
  loginAdminUser,
} from "../controllers/auth.controller.js";

const router = express.Router();

router.post("/register", registerAdminUser);
router.post("/login", loginAdminUser);

export default router;
