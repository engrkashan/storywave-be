import prisma from "../config/prisma.client.js";
import { logHistory } from "../utils/historyLogger.js";

// CREATE Voiceover
export const createVoiceover = async (req, res) => {
  try {
    const userId = req?.user?.userId;
    const { script, audioURL, voice } = req.body;

    if (!script) {
      return res.status(400).json({ error: "Script is required" });
    }

    const voiceover = await prisma.voiceover.create({
      data: {
        script,
        audioURL,
        voice,
        adminId: userId,
      },
    });

    return res
      .status(200)
      .json({ message: "Voiceover created successfully", voiceover });
  } catch (error) {
    console.error("Create Voiceover Error:", error);
    return res.status(500).json({ error: "Failed to create voiceover" });
  }
};

// GET all Voiceovers
export const getAllVoiceovers = async (req, res) => {
  try {
    const userId = req?.user?.userId;

    const voiceovers = await prisma.voiceover.findMany({
      where: { adminId: userId },
      orderBy: { createdAt: "desc" },
    });

    return res.status(200).json(voiceovers);
  } catch (error) {
    console.error("Get Voiceovers Error:", error);
    return res.status(500).json({ error: "Failed to fetch voiceovers" });
  }
};

// GET Single Voiceover
export const getVoiceoverById = async (req, res) => {
  const { id } = req.params;

  try {
    const voiceover = await prisma.voiceover.findUnique({
      where: { id },
    });

    if (!voiceover) {
      return res.status(404).json({ error: "Voiceover not found" });
    }

    return res.status(200).json(voiceover);
  } catch (error) {
    console.error("Get Voiceover Error:", error);
    return res.status(500).json({ error: "Failed to fetch voiceover" });
  }
};

// UPDATE Voiceover
export const updateVoiceover = async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await prisma.voiceover.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Voiceover not found" });
    }

    const { script, audioURL, voice } = req.body;

    const updated = await prisma.voiceover.update({
      where: { id },
      data: {
        script: script ?? existing.script,
        audioURL: audioURL ?? existing.audioURL,
        voice: voice ?? existing.voice,
        updatedAt: new Date(),
      },
    });

    return res
      .status(200)
      .json({ message: "Voiceover updated successfully", voiceover: updated });
  } catch (error) {
    console.error("Update Voiceover Error:", error);
    return res.status(500).json({ error: "Failed to update voiceover" });
  }
};

// DELETE Voiceover
export const deleteVoiceover = async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await prisma.voiceover.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "Voiceover not found" });
    }

    await prisma.voiceover.delete({ where: { id } });

    return res.status(200).json({ message: "Voiceover deleted successfully" });
  } catch (error) {
    console.error("Delete Voiceover Error:", error);
    return res.status(500).json({ error: "Failed to delete voiceover" });
  }
};
