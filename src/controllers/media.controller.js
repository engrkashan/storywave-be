import prisma from "../config/prisma.client.js";

export const createMediaHandler = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { mimetype, path, filename } = req.file;

    let type = "other";
    if (mimetype.startsWith("image")) {
      type = "image";
    } else if (mimetype === "application/pdf") {
      type = "pdf";
    } else if (
      mimetype === "application/msword" ||
      mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      type = "document";
    }

    const newMedia = await prisma.media.create({
      data: {
        fileType: mimetype,
        fileUrl: path,
        publicId: filename,
      },
    });

    return res.status(200).json({
      message: "Media uploaded successfully",
      media: newMedia,
    });
  } catch (error) {
    console.error("Upload Error:", error);
    return res.status(500).json({ error: "Failed to upload media" });
  }
};

export const getAllMediaHandler = async (_req, res) => {
  try {
    const mediaList = await prisma.media.findMany({
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json(mediaList);
  } catch (error) {
    console.error("Fetch Error:", error);
    return res.status(500).json({ error: "Failed to fetch media" });
  }
};

export const getMediaByIdHandler = async (req, res) => {
  const { id } = req.params;
  try {
    const media = await prisma.media.findUnique({
      where: { id },
    });

    if (!media) {
      return res.status(404).json({ error: "Media not found" });
    }

    return res.status(200).json(media);
  } catch (error) {
    console.error("Get Error:", error);
    return res.status(500).json({ error: "Failed to retrieve media" });
  }
};

export const deleteMediaHandler = async (req, res) => {
  const { id } = req.params;
  try {
    const media = await prisma.media.findUnique({ where: { id } });

    if (!media) {
      return res.status(404).json({ error: "Media not found" });
    }

    await prisma.media.delete({ where: { id } });

    return res.status(200).json({ message: "Media deleted successfully" });
  } catch (error) {
    console.error("Delete Error:", error);
    return res.status(500).json({ error: "Failed to delete media" });
  }
};
