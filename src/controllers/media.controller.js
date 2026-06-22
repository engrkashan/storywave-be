import prisma from "../config/prisma.client.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("MediaController");

export const createMediaHandler = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { mimetype, path, filename } = req.file;

    let type = "IMAGE"; // default
    if (mimetype.startsWith("image")) {
      type = "IMAGE";
    } else if (mimetype.startsWith("video")) {
      type = "VIDEO";
    } else if (mimetype.startsWith("audio")) {
      type = "AUDIO";
    }

    const newMedia = await prisma.media.create({
      data: {
        type,
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
    logger.error("Upload Error:", error);
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
    logger.error("Fetch Error:", error);
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
    logger.error("Get Error:", error);
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
    logger.error("Delete Error:", error);
    return res.status(500).json({ error: "Failed to delete media" });
  }
};
