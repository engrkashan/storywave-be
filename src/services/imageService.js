import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("ImageService");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MIDJOURNEY_API_BASE = "https://api.midapi.ai/api/v1/mj";

const MODELS = {
  PREMIUM: "gemini-3.1-flash-image-preview",
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
    .replace(/blood|gore|nude|explicit|violence|fighting|weapon|kill|death|scary|horror/gi, "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Global throttler for Imagen generations.
 * Every 10 generations, pauses for 1 minute.
 */
async function throttleImagen() {
  // If already throttling, wait for it to finish
  if (isThrottling && throttlePromise) {
    logger.info("⏳ Waiting for global Imagen throttling to finish...");
    await throttlePromise;
  }

  imagenCounter++;
  logger.info(`📈 Imagen Count: ${imagenCounter}/10`);

  if (imagenCounter >= 10) {
    logger.warn("🛑 Imagen limit reached (10). Pausing for 1 minute...");
    isThrottling = true;

    throttlePromise = (async () => {
      await sleep(60000); // 1 minute pause
      imagenCounter = 0;
      isThrottling = false;
      throttlePromise = null;
      logger.info("✅ Throttling period over. Resetting count.");
    })();

    await throttlePromise;
  }
}

/* --------------------------------------------------
   GEMINI / IMAGEN
-------------------------------------------------- */

async function generateWithImagen({
  prompt,
  commonPrompt,
  index,
  tempDir,
  aspectRatio = "16:9",
  activeModelTier,
  resolution = "4K",
}) {
  await ensureDir(tempDir);
  logger.info(`🎨 Generating image for scene ${index} with prompt: ${prompt} with common prompt: ${commonPrompt}`);

  const finalPrompt = `
# VISUAL STYLE GUIDE: 
${commonPrompt || "Cinematic, hyper-realistic, professional photography"}

# SCENE DESCRIPTION: 
${prompt}

# TECHNICAL SPECS: 
Shot on Arri Alexa, 8K detail, sharp focus, volumetric lighting, masterpiece quality.
${aspectRatio ? `Aspect Ratio: ${aspectRatio}` : ""}
`;

  logger.info(`Final prompt: ${finalPrompt}`);

  // Fallback chain: Gemini Premium -> Imagen Fast
  const fallbackChain =
    activeModelTier === "PREMIUM"
      ? [MODELS.PREMIUM]
      : [MODELS.PREMIUM, MODELS.FAST];

  let lastError = null;
  let updatedTier = activeModelTier;

  for (const modelId of fallbackChain) {
    const isFast = modelId === MODELS.FAST;
    const isPro = modelId === MODELS.PREMIUM;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (isFast) {
          await throttleImagen();
        }

        logger.info(`📡 [${modelId}] Attempt ${attempt}/${maxRetries}`);

        let imageBytes = null;
        if (isPro) {
          // const response = await ai.models.generateContent({
          //   model: "gemini-3.1-flash-image-preview",
          //   contents: finalPrompt,
          //   generationConfig: {
          //     candidateCount: 1,
          //     quality: "pro",
          //   },
          //   imageConfig: {
          //     aspectRatio: aspectRatio,
          //     imageSize: "4K",
          //     responseMimeType: "image/png",
          //   },
          // });

          const response = await ai.models.generateContent({
            model: "gemini-3.1-flash-image-preview",
            contents: finalPrompt,
            generationConfig: {
              candidateCount: 1,
              // Move these inside generationConfig
              quality: "pro",
              imageSize: "4K",
              aspectRatio: aspectRatio,
            },
            // Keep this as a duplicate safety measure
            imageConfig: {
              aspectRatio: aspectRatio,
              imageSize: "4K",
              responseMimeType: "image/png",
            },
            parameters: {
              "sampleCount": 1,
              "includeDescription": true,
              "outputOptions": {
                "resolution": "4K",
                "fileFormat": "png"
              }
            }
          });

          // Wait for response to resolve and grab the part
          const part = response.candidates?.[0]?.content?.parts?.find(
            (p) => p.inlineData,
          );

          imageBytes = part?.inlineData?.data;
        } else {
          // imagen-4.0-fast uses generateImages
          const response = await ai.models.generateImages({
            model: "imagen-4.0-fast-generate-001",
            prompt: finalPrompt,
            config: {
              numberOfImages: 1,
              aspectRatio: aspectRatio,
              personGeneration: "allow_all",
            },
          });
          imageBytes = response.generatedImages?.[0]?.image?.imageBytes;
        }

        if (!imageBytes) {
          throw new Error(`${modelId} returned empty image`);
        }

        const filePath = path.join(
          tempDir,
          `scene_${String(index).padStart(3, "0")}.png`,
        );

        await fs.promises.writeFile(
          filePath,
          Buffer.from(imageBytes, "base64"),
        );
        logger.info(
          `✅ Image generated successfully with ${modelId}:`,
          filePath,
        );
        // Add this right after you save the file
        const stats = await fs.promises.stat(filePath);
        logger.info(`💾 File saved. Size on disk: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        // If the file is ~1MB, it's 1024x1024. If it's >10MB, it's likely 4K.
        return { filePath, activeModelTier: isPro ? "PREMIUM" : "FAST" };
      } catch (err) {
        lastError = err;
        logger.info(
          `❌ Image generation failed for ${modelId} (Attempt ${attempt}/${maxRetries}):`,
          err.message || err,
        );

        if (attempt === maxRetries) {
          if (isPro && fallbackChain.length > 1 && modelId === fallbackChain[0]) {
            logger.warn(
              `⚠️ ${modelId} failed max retries (${err.message || "Unknown Error"}). Switching to ${MODELS.FAST}`,
            );
            break; // Break attempt loop for Premium to move to Fast
          }

          if (isFast) {
            logger.warn(
              `⚠️ ${modelId} failed max retries. Falling back to MidJourney.`,
            );
          }
          throw err;
        } else {
          logger.info(`⏳ Waiting 2 seconds before retrying...`);
          await sleep(2000);
        }
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
    logger.error("MidJourney start response:", startData);
    throw new Error("No taskId returned from MidJourney");
  }

  logger.info(`🆔 MidJourney taskId: ${taskId}`);

  // Polling loop
  const maxPolls = 60;
  let polls = 0;

  while (polls < maxPolls) {
    polls++;
    await sleep(5000);
    logger.info(`📡 [MidJourney] Attempt ${polls}/${maxPolls}`);

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
  aspectRatio = "16:9",
  commonPrompt = null
) {
  let activeModelTier = null;
  const results = [];

  for (let i = 0; i < prompts.length; i++) {
    let safePrompt = prompts[i];
    let success = false;

    // Retry Gemini up to 3 times for each image
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        logger.info(`🎨 [Multi-Image ${i + 1}/${prompts.length}] Gemini Attempt ${attempt}/3...`);
        const result = await generateWithImagen({
          prompt: safePrompt,
          commonPrompt,
          index: i + 1,
          tempDir,
          aspectRatio,
          activeModelTier,
        });

        activeModelTier = result.activeModelTier;
        logger.info(`✅ [Multi-Image ${i + 1}/${prompts.length}] Successfully generated: ${result.filePath} (Tier: ${activeModelTier})`);
        results.push({
          imageUrl: result.filePath,
          error: null,
        });
        success = true;
        break;
      } catch (err) {
        logger.warn(`⚠️ [Multi-Image ${i + 1}/${prompts.length}] Gemini Attempt ${attempt} failed: ${err.message || err}`);
        if (attempt < 3) {
          logger.info(`🧼 Sanitizing prompt before retry...`);
          safePrompt = await sanitizePrompt(safePrompt);
        }
      }
    }

    if (!success) {
      logger.warn(`🔄 [Multi-Image ${i + 1}/${prompts.length}] Gemini failed all retries. Falling back to MidJourney...`);

      const mjPrompt = commonPrompt ? `${commonPrompt} ${safePrompt}` : safePrompt;

      try {
        const filePath = await generateWithMidjourney({
          prompt: mjPrompt,
          index: i + 1,
          tempDir,
          aspectRatio,
        });
        logger.info(`✅ [Multi-Image ${i + 1}/${prompts.length}] MidJourney succeeded: ${filePath}`);
        results.push({ imageUrl: filePath, error: null });
      } catch (mjErr) {
        logger.info(`❌ [Multi-Image ${i + 1}/${prompts.length}] MidJourney also failed: ${mjErr.message}`);
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
  aspectRatio = "16:9",
  commonPrompt = null
) {
  let safePrompt = prompt;
  let lastError = null;
  let activeModelTier = null;
  let resolution = "4K";

  // Gemini attempts
  for (let i = 0; i < 3; i++) {
    try {
      logger.info(`🎨 [Single Image] Gemini Attempt ${i + 1}/3...`);
      const result = await generateWithImagen({
        prompt: safePrompt,
        commonPrompt,
        index,
        tempDir,
        aspectRatio,
        activeModelTier,
        resolution,
      });
      logger.info(`✅ [Single Image] Gemini succeeded: ${result.filePath}`);
      return { imageUrl: result.filePath, error: null };
    } catch (err) {
      lastError = err;
      logger.info(`⚠️ [Single Image] Gemini Attempt ${i + 1} failed: ${err.message || err}`);
      if (i < 2) {
        logger.info(`🧼 Sanitizing prompt before retry...`);
        safePrompt = await sanitizePrompt(safePrompt);
      }
    }
  }

  logger.info("🔄 [Single Image] Gemini failed all retries. Trying MidJourney...");
  // MidJourney fallback
  for (let i = 0; i < 3; i++) {
    try {
      logger.info(`🎨 [Single Image] MidJourney Attempt ${i + 1}/3...`);
      const filePath = await generateWithMidjourney({
        prompt: safePrompt,
        index,
        tempDir,
        aspectRatio,
        resolution,
      });
      logger.info(`✅ [Single Image] MidJourney succeeded: ${filePath}`);
      return { imageUrl: filePath, error: null };
    } catch (err) {
      lastError = err;
      logger.info(`⚠️ [Single Image] MidJourney Attempt ${i + 1} failed: ${err.message || err}`);
      if (i < 2) {
        logger.info(`🧼 Sanitizing prompt before retry...`);
        safePrompt = await sanitizePrompt(safePrompt);
      }
    }
  }

  return { imageUrl: null, error: lastError?.message };
}
