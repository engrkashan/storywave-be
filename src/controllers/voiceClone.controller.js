import fs from "fs";
import path from "path";
import { Client } from "@gradio/client";
import prisma from "../config/prisma.client.js";

export const cloneVoice = async (req, res) => {
  const transaction = prisma.$transaction.bind(prisma);

  try {
    const adminId = req.user?.userId;
    const text = req.body.text || "Hello, this is your cloned voice!";
    const voiceSample = req.file;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: adminId missing from token.",
      });
    }

    if (!voiceSample) {
      return res.status(400).json({
        success: false,
        message: "Voice sample is required.",
      });
    }

    // ====== Save temp file ======
    const tempDir = path.join(process.cwd(), "tmp_uploads");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const tempPath = path.join(
      tempDir,
      `${Date.now()}_${voiceSample.originalname}`
    );
    fs.writeFileSync(tempPath, voiceSample.buffer);

    // ====== Prepare Blob ======
    const audioBlob = new Blob([fs.readFileSync(tempPath)], {
      type: voiceSample.mimetype || "audio/wav",
    });

    // ====== Connect to model ======
    const client = await Client.connect("tonyassi/voice-clone", {
      hf_token: process.env.HF_API_KEY,
    });

    // ====== Call the model ======
    const result = await client.predict("/predict", {
      text,
      audio: audioBlob,
    });

    // Extract URL from result (it’s an object)
    const output = result?.data?.[0];
    const audioURL =
      typeof output === "string" ? output : output?.url || output?.path || null;

    if (!audioURL || typeof audioURL !== "string")
      throw new Error("Model did not return a valid audio URL");

    // ====== Store in DB ======
    const voiceRecord = await transaction(async (tx) => {
      const workflow = await tx.workflow.create({
        data: {
          title: `Voice Clone - ${new Date().toISOString()}`,
          type: "VOICEOVER",
          status: "COMPLETED",
          adminId,
          metadata: { source: "HuggingFace - tonyassi/voice-clone" },
        },
      });

      const voiceover = await tx.voiceover.create({
        data: {
          script: text,
          audioURL,
          voice: voiceSample.originalname,
          adminId,
          workflowId: workflow.id,
        },
      });

      await tx.media.create({
        data: {
          type: "AUDIO",
          fileUrl: audioURL,
          fileType: "audio/wav",
          workflowId: workflow.id,
        },
      });

      await tx.creation.create({
        data: {
          type: "VOICEOVER",
          title: `Voice Clone - ${voiceSample.originalname}`,
          content: text,
          mediaURL: audioURL,
          adminId,
          metadata: { workflowId: workflow.id },
        },
      });

      return { workflow, voiceover };
    });

    fs.unlinkSync(tempPath);

    return res.status(200).json({
      success: true,
      message: "Voice cloned successfully",
      data: {
        audioURL,
        workflowId: voiceRecord.workflow.id,
        voiceoverId: voiceRecord.voiceover.id,
      },
    });
  } catch (error) {
    console.error("Voice cloning failed:", error);
    return res.status(500).json({
      success: false,
      message: "Voice cloning failed",
      error: error.message,
    });
  }
};

export const getVoiceClones = async (req, res) => {
  try {
    const adminId = req.user?.userId;

    if (!adminId) {
      return res.status(400).json({
        success: false,
        message: "Missing adminId in token.",
      });
    }

    const voiceovers = await prisma.voiceover.findMany({
      where: { adminId },
      orderBy: { createdAt: "desc" },
      include: {
        workflow: {
          include: {
            media: true,
          },
        },
      },
    });

    return res.status(200).json({
      success: true,
      message: "Voice clones fetched successfully.",
      data: voiceovers.map((v) => ({
        id: v.id,
        audioURL: v.audioURL,
        voice: v.voice,
        createdAt: v.createdAt,
      })),
    });
  } catch (error) {
    console.error("Failed to fetch voice clones:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch voice clones",
      error: error.message,
    });
  }
};
