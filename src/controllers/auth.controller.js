import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import prisma from "../config/prisma.client.js";

// REGISTER User
export const registerUser = async (req, res) => {
  try {
    const { fullName, email, username, password, profileURL, role } = req.body;

    const existing = await prisma.User.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (existing) {
      return res
        .status(400)
        .json({ error: "Email or username already in use" });
    }

    const newUser = await prisma.User.create({
      data: {
        fullName,
        email,
        username,
        password,
        profileURL,
        role,
      },
    });

    return res.status(201).json({
      message: "User registered successfully",
      user: {
        id: newUser.id,
        fullName: newUser.fullName,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role,
        password: newUser.password,
      },
    });
  } catch (error) {
    console.error("Register Error:", error);
    return res.status(500).json({ error: "Failed to register user" });
  }
};

// LOGIN User
export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.User.findFirst({
      where: { email },
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    if (user.password !== password)
      return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    await prisma.User.update({
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
        password: user.password,
      },
    });
  } catch (error) {
    console.error("Login Error:", error);
    return res.status(500).json({ error: "Failed to login" });
  }
};

// GET all users
export const getAllUsers = async (req, res) => {
  try {
    const users = await prisma.User.findMany({
      select: {
        id: true,
        fullName: true,
        username: true,
        email: true,
        role: true,
        password: true,
        lastLoginAt: true,
      },
      orderBy: { fullName: "asc" },
    });

    return res.status(200).json({ users });
  } catch (error) {
    console.error("Get All Users Error:", error);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
};

// UPDATE User by ID
export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, email, username, password, profileURL, role } = req.body;

    const existingUser = await prisma.User.findUnique({ where: { id } });
    if (!existingUser) return res.status(404).json({ error: "User not found" });

    if (email || username) {
      const conflictUser = await prisma.User.findFirst({
        where: {
          AND: [{ id: { not: id } }, { OR: [{ email }, { username }] }],
        },
      });

      if (conflictUser)
        return res
          .status(400)
          .json({ error: "Email or username already in use by another user" });
    }

    const updatedUser = await prisma.User.update({
      where: { id },
      data: {
        fullName: fullName ?? existingUser.fullName,
        email: email ?? existingUser.email,
        username: username ?? existingUser.username,
        password: password ?? existingUser.password,
        profileURL: profileURL ?? existingUser.profileURL,
        role: role ?? existingUser.role,
      },
    });

    return res.status(200).json({
      message: "User updated successfully",
      user: {
        id: updatedUser.id,
        fullName: updatedUser.fullName,
        username: updatedUser.username,
        email: updatedUser.email,
        role: updatedUser.role,
        password: updatedUser.password,
      },
    });
  } catch (error) {
    console.error("Update User Error:", error);
    return res.status(500).json({ error: "Failed to update user" });
  }
};

// DELETE User by ID
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    const existingUser = await prisma.User.findUnique({
      where: { id: id },
    });

    if (!existingUser) {
      return res.status(404).json({ error: "User not found" });
    }

    await prisma.User.delete({
      where: { id: id },
    });

    return res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    console.error("Delete User Error:", error);
    return res.status(500).json({ error: "Failed to delete user" });
  }
};
