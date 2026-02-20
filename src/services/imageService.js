import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MIDJOURNEY_API_BASE = "https://api.midapi.ai/api/v1/mj";

const MODELS = {
  PREMIUM: "gemini-3-pro-image-preview",
  FAST: "imagen-4.0-fast-generate-001",
};

/* --------------------------------------------------
   GLOBAL STATE (IN-MEMORY)
-------------------------------------------------- */

let imagenCounter = 0;
let isThrottling = false;
let throttlePromise = null;

/* --------------------------------------------------
   UTILS
-------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function downloadImage(url, filePath) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }

  const buffer = await response.buffer();
  await fs.promises.writeFile(filePath, buffer);
}

async function sanitizePrompt(prompt) {
  // Minimal safe sanitizer (replace with LLM if needed)
  return prompt
    .replace(/blood|gore|nude|explicit/gi, "")
    .trim();
}

/**
 * Global throttler for Imagen generations.
 * Every 10 generations, pauses for 1 minute.
 */
async function throttleImagen() {
  // If already throttling, wait for it to finish
  if (isThrottling && throttlePromise) {
    console.log("⏳ Waiting for global Imagen throttling to finish...");
    await throttlePromise;
  }

  imagenCounter++;
  console.log(`📈 Imagen Count: ${imagenCounter}/10`);

  if (imagenCounter >= 10) {
    console.warn("🛑 Imagen limit reached (10). Pausing for 1 minute...");
    isThrottling = true;

    throttlePromise = (async () => {
      await sleep(60000); // 1 minute pause
      imagenCounter = 0;
      isThrottling = false;
      throttlePromise = null;
      console.log("✅ Throttling period over. Resetting count.");
    })();

    await throttlePromise;
  }
}

/* --------------------------------------------------
   GEMINI / IMAGEN
-------------------------------------------------- */

async function generateWithImagen({
  prompt,
  index,
  tempDir,
  aspectRatio = "16:9",
  activeModelTier,
}) {
  await ensureDir(tempDir);

  const enhancedPrompt = `High quality cinematic story illustration: ${prompt}`;

  // Fallback chain: Imagen Fast -> Gemini 3 Pro
  const fallbackChain =
    activeModelTier === "PREMIUM"
      ? [MODELS.PREMIUM]
      : [MODELS.FAST, MODELS.PREMIUM];

  let lastError = null;
  let updatedTier = activeModelTier;

  for (const modelId of fallbackChain) {
    const isFast = modelId === MODELS.FAST;
    const maxRetries = isFast ? 1 : 1; // Simplified retries as requested

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (isFast) {
          await throttleImagen();
        }

        console.log(`📡 [${modelId}] Attempt ${attempt}/${maxRetries}`);

        const response = await ai.models.generateImages({
          model: modelId,
          prompt: enhancedPrompt,
          config: {
            numberOfImages: 1,
            aspectRatio,
          },
        });

        const imageBytes =
          response.generatedImages?.[0]?.image?.imageBytes;

        if (!imageBytes) {
          throw new Error(`${modelId} returned empty image`);
        }

        const filePath = path.join(
          tempDir,
          `scene_${String(index).padStart(3, "0")}.png`
        );

        await fs.promises.writeFile(
          filePath,
          Buffer.from(imageBytes, "base64")
        );

        return { filePath, activeModelTier: updatedTier };
      } catch (err) {
        lastError = err;

        const isQuota =
          err.status === 429 ||
          err.message?.toLowerCase().includes("quota");

        if (isQuota && isFast) {
          console.warn(`⚠️ ${modelId} quota hit. Switching to ${MODELS.PREMIUM}`);
          updatedTier = "PREMIUM";
          break; // Break attempt loop to switch to next model in chain
        }

        if (isQuota && modelId === MODELS.PREMIUM) {
          console.warn(`⚠️ ${modelId} quota hit. Falling back to MidJourney.`);
          throw err; // Propagate to orchestrator for MidJourney fallback
        }

        throw err;
      }
    }
  }

  throw lastError;
}

/* --------------------------------------------------
   MIDJOURNEY
-------------------------------------------------- */

async function generateWithMidjourney({
  prompt,
  index,
  tempDir,
  aspectRatio = "16:9",
}) {
  await ensureDir(tempDir);

  if (!process.env.MIDJOURNEY_API_KEY) {
    throw new Error("MIDJOURNEY_API_KEY not set in environment");
  }

  const payload = {
    taskType: "mj_txt2img",
    speed: "relaxed",
    prompt: prompt,
    fileUrls: [],
    aspectRatio: aspectRatio,
    version: "7",
    variety: 10,
    stylization: 500,
    weirdness: 1,
    waterMark: "",
    enableTranslation: false,
    callBackUrl: "",
  };

  // Start MidJourney task
  const startRes = await fetch(`${MIDJOURNEY_API_BASE}/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const rawStart = await startRes.text();

  if (!startRes.ok) {
    throw new Error(
      `MidJourney API start failed (${startRes.status}): ${rawStart}`
    );
  }

  let startData;
  try {
    startData = JSON.parse(rawStart);
  } catch {
    throw new Error(`Invalid JSON from MidJourney: ${rawStart}`);
  }

  const taskId = startData?.data?.taskId;
  if (!taskId) {
    console.error("MidJourney start response:", startData);
    throw new Error("No taskId returned from MidJourney");
  }

  console.log(`🆔 MidJourney taskId: ${taskId}`);

  // Polling loop
  const maxPolls = 60;
  let polls = 0;

  while (polls < maxPolls) {
    polls++;
    await sleep(5000);

    const statusRes = await fetch(
      `${MIDJOURNEY_API_BASE}/record-info?taskId=${taskId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const rawStatus = await statusRes.text();

    if (!statusRes.ok) {
      throw new Error(`MidJourney status check failed: ${rawStatus}`);
    }

    let statusData;
    try {
      statusData = JSON.parse(rawStatus);
    } catch {
      throw new Error(`Invalid status JSON: ${rawStatus}`);
    }

    const successFlag = statusData?.data?.successFlag;

    // Success
    if (successFlag === 1) {
      const resultInfo = statusData.data.resultInfoJson;
      const imageUrl = resultInfo?.resultUrls?.[0]?.resultUrl;
      if (!imageUrl) {
        throw new Error("MidJourney completed but no image url found");
      }

      const filePath = path.join(
        tempDir,
        `scene_${String(index).padStart(3, "0")}.png`
      );

      await downloadImage(imageUrl, filePath);
      return filePath;
    }

    // Failed
    if (successFlag === 2 || successFlag === 3) {
      throw new Error(
        statusData?.data?.errorMessage || "MidJourney generation failed"
      );
    }
  }

  throw new Error("MidJourney polling timeout");
}


/* --------------------------------------------------
   MULTI IMAGE ORCHESTRATOR
-------------------------------------------------- */

export async function generateMultiImages(
  prompts,
  tempDir,
  aspectRatio = "16:9"
) {
  let activeModelTier = null;
  const results = [];

  for (let i = 0; i < prompts.length; i++) {
    const safePrompt = prompts[i];
    try {
      const result = await generateWithImagen({
        prompt: safePrompt,
        index: i + 1,
        tempDir,
        aspectRatio,
        activeModelTier,
      });

      activeModelTier = result.activeModelTier;

      results.push({
        imageUrl: result.filePath,
        error: null,
      });
    } catch (err) {
      console.warn("Gemini/Imagen failed. Trying MidJourney...");

      try {
        const filePath = await generateWithMidjourney({
          prompt: safePrompt,
          index: i + 1,
          tempDir,
          aspectRatio,
        });

        results.push({ imageUrl: filePath, error: null });
      } catch (mjErr) {
        results.push({
          imageUrl: null,
          error: mjErr.message,
        });
      }
    }
  }

  return results;
}

/* --------------------------------------------------
   SINGLE IMAGE ORCHESTRATOR
-------------------------------------------------- */

export async function generateImage(
  prompt,
  index = 1,
  tempDir,
  aspectRatio = "16:9"
) {
  let safePrompt = prompt;
  let lastError = null;
  let activeModelTier = null;

  // Gemini attempts
  for (let i = 0; i < 3; i++) {
    try {
      const result = await generateWithImagen({
        prompt: safePrompt,
        index,
        tempDir,
        aspectRatio,
        activeModelTier,
      });

      return { imageUrl: result.filePath, error: null };
    } catch (err) {
      lastError = err;
      safePrompt = await sanitizePrompt(safePrompt);
    }
  }

  // MidJourney fallback
  for (let i = 0; i < 3; i++) {
    try {
      const filePath = await generateWithMidjourney({
        prompt: safePrompt,
        index,
        tempDir,
        aspectRatio,
      });

      return { imageUrl: filePath, error: null };
    } catch (err) {
      lastError = err;
      safePrompt = await sanitizePrompt(safePrompt);
    }
  }

  return { imageUrl: null, error: lastError?.message };
}
