import bcrypt from "bcryptjs";
import prisma from "../config/prisma.client.js";

// GET Admin User Profile
export const getAdminUserProfile = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    const admin = await prisma.adminUser.findUnique({
      where: { id: userId },
    });

    if (!admin) {
      return res.status(404).json({ error: "Admin user not found" });
    }

    return res.status(200).json(admin);
  } catch (error) {
    console.error("Get AdminUser Profile Error:", error);
    return res.status(500).json({ error: "Failed to fetch profile" });
  }
};

// UPDATE Admin User
export const updateAdminUser = async (req, res) => {
  try {
    const userId = req.user.userId;

    const existing = await prisma.adminUser.findUnique({
      where: { id: userId },
    });

    if (!existing) {
      return res.status(404).json({ error: "Admin user not found" });
    }

    const { fullName, email, username, profileURL, role } = req.body;

    const updated = await prisma.adminUser.update({
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
export const changeAdminUserPassword = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { currentPassword, newPassword } = req.body;

    const user = await prisma.adminUser.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid)
      return res.status(401).json({ error: "Incorrect current password" });

    const hashed = await bcrypt.hash(newPassword, 10);

    await prisma.adminUser.update({
      where: { id: userId },
      data: { password: hashed },
    });

    return res.status(200).json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Password Change Error:", error);
    return res.status(500).json({ error: "Failed to change password" });
  }
};

// DELETE Admin User
export const deleteAdminUser = async (req, res) => {
  const { id } = req.params;

  try {
    const user = await prisma.adminUser.findUnique({
      where: { id },
      include: {
        creations: true,
        integrations: true,
        stories: true,
        voiceovers: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "Admin user not found" });
    }

    // Cascade delete related entities (orphan cleanup)
    await prisma.creation.deleteMany({ where: { adminId: id } });
    await prisma.integration.deleteMany({ where: { adminId: id } });
    await prisma.story.deleteMany({ where: { adminId: id } });
    await prisma.voiceover.deleteMany({ where: { adminId: id } });

    // Delete admin user
    await prisma.adminUser.delete({
      where: { id },
    });

    return res.status(200).json({ message: "Admin user deleted successfully" });
  } catch (error) {
    console.error("Delete AdminUser Error:", error);
    return res.status(500).json({ error: "Failed to delete admin user" });
  }
};
