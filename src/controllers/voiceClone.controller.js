import prisma from "../config/prisma.client.js";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

/**
 * Clone a user’s voice using myshell-ai/OpenVoice
 */
export const cloneVoice = async (req, res) => {
  try {
    const { adminId, voiceName } = req.body;
    const voiceSample = req.file;

    if (!adminId || !voiceSample) {
      return res.status(400).json({
        success: false,
        message: "adminId and voice sample are required.",
      });
    }

    const uploadDir = path.join(process.cwd(), "public", "voices");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const inputPath = path.join(
      uploadDir,
      `${Date.now()}_${voiceSample.originalname}`
    );
    fs.writeFileSync(inputPath, voiceSample.buffer);

    const modelOutput = path.join(uploadDir, `${Date.now()}_cloned_voice`);

    console.log("🧠 Running OpenVoice cloning model...");
    const processClone = spawn("python", [
      "scripts/clone_voice.py",
      "--input",
      inputPath,
      "--output",
      modelOutput,
    ]);

    await new Promise((resolve, reject) => {
      processClone.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("Voice cloning failed"));
      });
    });

    const clonedFile = `${modelOutput}.pth`;
    if (!fs.existsSync(clonedFile)) {
      return res.status(500).json({
        success: false,
        message: "Voice cloning output not found.",
      });
    }

    // Create a workflow entry
    const workflow = await prisma.workflow.create({
      data: {
        title: `Voice Clone - ${voiceName || "Custom Voice"}`,
        type: "VOICEOVER",
        status: "COMPLETED",
        adminId,
      },
    });

    // Save voice asset record
    const savedVoice = await prisma.asset.create({
      data: {
        name: voiceName || `Voice_${Date.now()}`,
        type: "VOICE_MODEL",
        url: `/voices/${path.basename(clonedFile)}`,
        metadata: {
          sourceFile: voiceSample.originalname,
        },
        adminId,
      },
    });

    res.json({
      success: true,
      message: "Voice cloned successfully",
      data: {
        voiceName: savedVoice.name,
        modelURL: `${req.protocol}://${req.get("host")}/static${
          savedVoice.url
        }`,
        workflowId: workflow.id,
      },
    });
  } catch (err) {
    console.error("❌ Voice cloning failed:", err);
    res.status(500).json({
      success: false,
      message: "Failed to clone voice",
      error: err.message,
    });
  }
};
