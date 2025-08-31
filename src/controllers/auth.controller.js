import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../config/prisma.client.js";

// REGISTER Admin User
export const registerAdminUser = async (req, res) => {
  try {
    const { fullName, email, username, password, profileURL, role } = req.body;

    // Check duplicates
    const existing = await prisma.adminUser.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existing) {
      return res
        .status(400)
        .json({ error: "Email or username already in use" });
    }

    // Hash password
    const hashed = await bcrypt.hash(password, 10);

    const newUser = await prisma.adminUser.create({
      data: {
        fullName,
        email,
        username,
        password: hashed,
        profileURL,
        role,
      },
    });

    return res
      .status(200)
      .json({
        message: "Admin user registered successfully",
        userId: newUser.id,
      });
  } catch (error) {
    console.error("Register Error:", error);
    return res.status(500).json({ error: "Failed to register admin user" });
  }
};

// LOGIN Admin User
export const loginAdminUser = async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;

    // Find by email OR username
    const user = await prisma.adminUser.findFirst({
      where: {
        OR: [{ email: emailOrUsername }, { username: emailOrUsername }],
      },
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    // Validate password
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Update lastLoginAt
    await prisma.adminUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        username: user.username,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({ error: "Failed to login" });
  }
};
