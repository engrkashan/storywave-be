import prisma from "../config/prisma.client.js";

// CREATE Creation
export const createCreation = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    const { type, title, content, mediaURL, metadata } = req.body;

    if (!type) {
      return res.status(400).json({ error: "Creation type is required" });
    }

    const creation = await prisma.creation.create({
      data: {
        type,
        title,
        content,
        mediaURL,
        metadata,
        adminId: userId,
      },
    });

    return res
      .status(200)
      .json({ message: "Creation added successfully", creation });
  } catch (error) {
    console.error("Create Creation Error:", error);
    return res.status(500).json({ error: "Failed to create creation" });
  }
};

// GET All Creations for Admin
export const getCreations = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    const creations = await prisma.creation.findMany({
      where: { adminId: userId },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json(creations);
  } catch (error) {
    console.error("Get Creations Error:", error);
    return res.status(500).json({ error: "Failed to fetch creations" });
  }
};

// GET Single Creation
export const getCreationById = async (req, res) => {
  try {
    const { id } = req.params;

    const creation = await prisma.creation.findUnique({ where: { id } });

    if (!creation) {
      return res.status(404).json({ error: "Creation not found" });
    }

    return res.status(200).json(creation);
  } catch (error) {
    console.error("Get Creation Error:", error);
    return res.status(500).json({ error: "Failed to fetch creation" });
  }
};

// UPDATE Creation
export const updateCreation = async (req, res) => {
  try {
    const { id } = req.params;
    const { type, title, content, mediaURL, metadata } = req.body;

    const existing = await prisma.creation.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Creation not found" });
    }

    const updated = await prisma.creation.update({
      where: { id },
      data: {
        type: type ?? existing.type,
        title: title ?? existing.title,
        content: content ?? existing.content,
        mediaURL: mediaURL ?? existing.mediaURL,
        metadata: metadata ?? existing.metadata,
        updatedAt: new Date(),
      },
    });

    return res
      .status(200)
      .json({ message: "Creation updated successfully", creation: updated });
  } catch (error) {
    console.error("Update Creation Error:", error);
    return res.status(500).json({ error: "Failed to update creation" });
  }
};

// DELETE Creation
export const deleteCreation = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.creation.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Creation not found" });
    }

    await prisma.creation.delete({ where: { id } });

    return res.status(200).json({ message: "Creation deleted successfully" });
  } catch (error) {
    console.error("Delete Creation Error:", error);
    return res.status(500).json({ error: "Failed to delete creation" });
  }
};
