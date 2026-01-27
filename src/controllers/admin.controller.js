import bcrypt from "bcryptjs";
import prisma from "../config/prisma.client.js";

// GET Admin User Profile
export const getUserProfile = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json(user);
  } catch (error) {
    console.error("Get User Profile Error:", error);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
};

// UPDATE User
export const updateUser = async (req, res) => {
  try {
    const userId = req.user.userId;

    const existing = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!existing) {
      return res.status(404).json({ error: "User not found" });
    }

    const { fullName, email, username, profileURL, role } = req.body;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        fullName: fullName ?? existing.fullName,
        email: email ?? existing.email,
        username: username ?? existing.username,
        profileURL: profileURL ?? existing.profileURL,
        role: role ?? existing.role,
        updatedAt: new Date(),
      },
    });

    return res
      .status(200)
      .json({ message: "Admin user updated", user: updated });
  } catch (error) {
    console.error("Update AdminUser Error:", error);
    return res.status(500).json({ error: "Failed to update admin user" });
  }
};

// CHANGE PASSWORD
export const changeUserPassword = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { currentPassword, newPassword } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid)
      return res.status(401).json({ error: "Incorrect current password" });

    const hashed = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: userId },
      data: { password: hashed },
    });

    return res.status(200).json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("User Password Change Error:", error);
    return res.status(500).json({ error: "Failed to change password" });
  }
};

// DELETE User
export const deleteUser = async (req, res) => {
  const { id } = req.params;

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        creations: true,
        integrations: true,
        stories: true,
        voiceovers: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Cascade delete related entities (orphan cleanup)
    await prisma.creation.deleteMany({ where: { userId: id } });
    await prisma.integration.deleteMany({ where: { userId: id } });
    await prisma.story.deleteMany({ where: { userId: id } });
    await prisma.voiceover.deleteMany({ where: { userId: id } });

    // Delete user
    await prisma.user.delete({
      where: { id },
    });

    return res.status(200).json({ message: "User deleted successfully" });
  } catch (error) {
    console.error("Delete User Error:", error);
    return res.status(500).json({ error: "Failed to delete user" });
  }
};
