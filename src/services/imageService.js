import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { GoogleGenAI } from "@google/genai";
import { config } from "../config/workflow.config.js";
import { createLogger } from "../utils/logger.js";
import { withExponentialBackoff } from "../utils/retry.js";

const logger = createLogger("ImageService");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  timeout: 180000 // 180 seconds for high-res images
});
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

/* --------------------------------------------------
   CHARACTER REF: Fetch remote image → base64 for Gemini multimodal
-------------------------------------------------- */
async function fetchImageAsBase64(url) {
  // If it's already a base64 data URL from the frontend, parse it directly
  if (url.startsWith("data:image")) {
    const match = url.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
    if (match) {
      return { mimeType: match[1], base64: match[2] };
    }
  }

  // Otherwise, fetch it (for backward compatibility with old Cloudinary URLs)
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch character reference: ${response.statusText}`);
  const buffer = await response.buffer();
  const mimeType = response.headers.get("content-type") || "image/jpeg";
  return { base64: buffer.toString("base64"), mimeType };
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
  characterReferences = [],
  sceneCharacters = [],
  styleUrl = null,
  onCheckCancelled = null,
}) {

  await ensureDir(tempDir);
  logger.info(`🎨 Generating image for scene ${index} with prompt: "${prompt.slice(0, 80)}..."`);

  const styleSection = styleUrl
    ? `\n# STYLE REFERENCE ANCHOR:\nMatch the exact visual style, color grading, film grain, lens characteristics, and lighting mood of this reference image: ${styleUrl}. Every output image MUST look visually consistent with it.`
    : "";

  let characterTextSection = "";
  if (sceneCharacters.length > 0 && characterReferences.length > 0) {
    characterTextSection = `\n# CHARACTER LIKENESS REFERENCES:\nThe attached reference image(s) define what these characters LOOK LIKE — their face, skin tone, hair texture, body structure, age, and distinctive physical features ONLY.
    
CRITICAL INSTRUCTION FOR AI IMAGE GENERATOR:
1. Extract ONLY the facial features, skin tone, and body structure from the reference image.
2. COMPLETELY IGNORE the action, pose, clothing, and expression shown in the reference image.
3. The characters MUST be performing the exact action and showing the exact expression described in the SCENE DESCRIPTION below.
4. If the scene says they are running, they must be running. If it says they are crying, they must be crying. Do NOT make them stand still like the reference image!`;
  } else if (characterReferences.length > 0) {
    characterTextSection = `\n# CHARACTER LIKENESS REFERENCE:\nThe attached reference image defines what the main character LOOKS LIKE — face, skin tone, hair texture, body structure, age, and features ONLY.
    
CRITICAL INSTRUCTION FOR AI IMAGE GENERATOR:
1. Extract ONLY the facial features, skin tone, and body structure from the reference image.
2. COMPLETELY IGNORE the action, pose, clothing, and expression shown in the reference image.
3. The character MUST be performing the exact action and showing the exact expression described in the SCENE DESCRIPTION below.
4. If the scene says they are running, they must be running. If it says they are crying, they must be crying. Do NOT make them stand still like the reference image!`;
  }

  const finalPrompt = `
# VISUAL STYLE GUIDE: 
${commonPrompt || "Cinematic, hyper-realistic, professional photography"}
${styleSection}
${characterTextSection}

# SCENE DESCRIPTION: 
${prompt}

# TECHNICAL SPECS: 
Shot on Arri Alexa, 8K detail, sharp focus, volumetric lighting, masterpiece quality.
STRICTLY NO TEXT, words, or letters in the image.
${aspectRatio ? `Aspect Ratio: ${aspectRatio}` : ""}
`;

  logger.info(`📝 Final prompt (first 200 chars): ${finalPrompt.slice(0, 200)}`);

  // Pre-fetch character references as base64
  let inlineImages = [];
  try {
    if (sceneCharacters && sceneCharacters.length > 0) {
      for (const charId of sceneCharacters) {
        const ref = characterReferences.find(c => c.id === charId);
        if (ref && ref.url) {
          const charData = await fetchImageAsBase64(ref.url);
          inlineImages.push({ mimeType: charData.mimeType, base64: charData.base64 });
        }
      }
    } else if (characterReferences.length > 0 && characterReferences[0].url) {
       // Fallback for single character mode if sceneCharacters is empty
       const charData = await fetchImageAsBase64(characterReferences[0].url);
       inlineImages.push({ mimeType: charData.mimeType, base64: charData.base64 });
    }
  } catch (err) {
    logger.warn(`⚠️ Could not fetch some character reference images: ${err.message}`);
  }

  // Fallback chain: Gemini Premium -> Imagen Fast
  const fallbackChain =
    activeModelTier === "PREMIUM"
      ? [MODELS.PREMIUM]
      : [MODELS.PREMIUM, MODELS.FAST];

  let lastError = null;

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
          // Build multimodal contents: text + optional character reference images
          const parts = [{ text: finalPrompt }];
          for (const inlineImg of inlineImages) {
            parts.push({
              inlineData: {
                mimeType: inlineImg.mimeType,
                data: inlineImg.base64,
              },
            });
          }
          if (inlineImages.length > 0) {
            logger.info(`🖼️ ${inlineImages.length} character reference image(s) included as inline data`);
          }

          const response = await ai.models.generateContent({
            model: "gemini-3.1-flash-image-preview",
            contents: [{ role: "user", parts }],
            config: {
              generationConfig: {
                candidateCount: 1,
                quality: "pro",
              },
              imageConfig: {
                aspectRatio: aspectRatio,
                imageSize: "4K",
                responseMimeType: "image/png",
              },
            }
          });

          const part = response.candidates?.[0]?.content?.parts?.find(
            (p) => p.inlineData,
          );

          imageBytes = part?.inlineData?.data;
        } else {
          // Imagen Fast — text-only (no multimodal support), character ref is embedded in prompt text
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
        logger.info(`✅ Image generated successfully with ${modelId}: ${filePath}`);
        return { filePath, activeModelTier: isPro ? "PREMIUM" : "FAST" };
      } catch (err) {
        lastError = err;
        logger.info(
          `❌ Image generation failed for ${modelId} (Attempt ${attempt}/${maxRetries}): ${err.message || err}`,
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
          if (onCheckCancelled) await onCheckCancelled(); // Check cancellation between retries
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
  characterUrl = null,
  styleUrl = null,
}) {
  await ensureDir(tempDir);

  if (!process.env.MIDJOURNEY_API_KEY) {
    throw new Error("MIDJOURNEY_API_KEY not set in environment");
  }

  let finalPrompt = prompt;
  if (characterUrl) finalPrompt += ` --cref ${characterUrl}`;
  if (styleUrl) finalPrompt += ` --sref ${styleUrl}`;

  const payload = {
    taskType: "mj_txt2img",
    speed: "relaxed",
    prompt: finalPrompt,
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
  commonPrompt = null,
  characterReferences = [],
  styleUrl = null,
  onCheckCancelled = null,
  onImageReady = null,
  checkpointManager = null
) {
  const concurrencyLimit = config.workflow.imageConcurrency || 3;
  logger.info(`🚀 Starting bounded parallel image generation. Total: ${prompts.length}, Concurrency: ${concurrencyLimit}`);
  
  const results = new Array(prompts.length).fill(null);
  let activeModelTier = null;

  async function processImage(promptObj, index) {
    if (onCheckCancelled) await onCheckCancelled();

    const sceneId = `scene_${String(index + 1).padStart(3, "0")}`;
    const expectedFilePath = path.join(tempDir, `${sceneId}.png`);

    // Phase 2.5: Resume / Checkpoint logic
    if (checkpointManager && checkpointManager.isImageCompleted(sceneId) && fs.existsSync(expectedFilePath)) {
      logger.info(`⏩ [Multi-Image ${index + 1}/${prompts.length}] Skipping generated image (Checkpoint)`);
      results[index] = expectedFilePath;
      if (onImageReady) await onImageReady(expectedFilePath, index);
      return;
    }

    if (checkpointManager) checkpointManager.markImageRunning(sceneId);

    let safePrompt = typeof promptObj === "object" ? promptObj.prompt : promptObj;
    const sceneCharacters = typeof promptObj === "object" ? promptObj.charactersInScene || [] : [];
    
    let success = false;
    let imgResult = { imageUrl: null, error: null };

    // Phase 3: Exponential Backoff Retry Loop
    try {
      logger.info(`🎨 [Multi-Image ${index + 1}/${prompts.length}] Starting generation...`);
      const result = await withExponentialBackoff(async () => {
        return await generateWithImagen({
          prompt: safePrompt,
          commonPrompt,
          index: index + 1,
          tempDir,
          aspectRatio,
          activeModelTier,
          characterReferences,
          sceneCharacters,
          styleUrl,
          onCheckCancelled,
        });
      }, `Image ${index + 1}`, 6, 8000);

      activeModelTier = result.activeModelTier; 
      logger.info(`✅ [Multi-Image ${index + 1}/${prompts.length}] Successfully generated: ${result.filePath}`);
      imgResult = { imageUrl: result.filePath, error: null };
      success = true;
    } catch (err) {
      logger.warn(`🔄 [Multi-Image ${index + 1}/${prompts.length}] Gemini exhausted all backoff retries. Falling back to MidJourney...`);
      
      const mjPrompt = commonPrompt ? `${commonPrompt} ${safePrompt}` : safePrompt;
      try {
        const filePath = await withExponentialBackoff(async () => {
          return await generateWithMidjourney({
             prompt: mjPrompt,
             index: index + 1,
             tempDir,
             aspectRatio,
             characterUrl: characterReferences.length > 0 ? characterReferences[0].url : null,
             styleUrl,
          });
        }, `MidJourney ${index + 1}`);
        
        logger.info(`✅ [Multi-Image ${index + 1}/${prompts.length}] MidJourney succeeded: ${filePath}`);
        imgResult = { imageUrl: filePath, error: null };
        success = true;
      } catch (mjErr) {
        logger.info(`❌ [Multi-Image ${index + 1}/${prompts.length}] MidJourney also failed: ${mjErr.message}`);
        imgResult = { imageUrl: null, error: mjErr.message };
      }
    }

    if (success && checkpointManager) checkpointManager.markImageCompleted(sceneId);
    if (!success && checkpointManager) checkpointManager.markImageFailed(sceneId);

    results[index] = imgResult.imageUrl;
    
    // Phase 2: Pipeline Streaming -> Trigger the segment render immediately
    if (success && onImageReady) {
      await onImageReady(imgResult.imageUrl, index);
    }
  }

  // Bounded worker pool implementation
  const executing = new Set();
  for (let i = 0; i < prompts.length; i++) {
    const p = processImage(prompts[i], i);
    executing.add(p);
    
    p.finally(() => executing.delete(p));
    
    if (executing.size >= concurrencyLimit) {
      await Promise.race(executing);
    }
  }

  // Wait for any remaining tasks to finish
  await Promise.all(executing);

  logger.info(`🏁 Completed multi-image generation for all ${prompts.length} images.`);
  return results.map(r => r ? { imageUrl: r } : { imageUrl: null });
}

/* --------------------------------------------------
   SINGLE IMAGE ORCHESTRATOR
-------------------------------------------------- */

export async function generateImage(
  prompt,
  index,
  tempDir,
  aspectRatio = "16:9",
  commonPrompt = null,
  characterReferences = [],
  styleUrl = null
) {
  const promptObj = prompt;
  let safePrompt = typeof promptObj === "object" ? promptObj.prompt : promptObj;
  const sceneCharacters = typeof promptObj === "object" ? promptObj.charactersInScene || [] : [];

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
        characterReferences,
        sceneCharacters,
        styleUrl,
      });
      logger.info(`✅ [Single Image] Gemini succeeded: ${result.filePath}`);
      return { imageUrl: result.filePath, error: null };
    } catch (err) {
      lastError = err;
      logger.info(`⚠️ [Single Image] Gemini Attempt ${i + 1} failed: ${err.message || err}`);
      if (i < 2) {
        logger.info(`🧼 Sanitizing prompt before retry...`);
        safePrompt = await sanitizePrompt(safePrompt);
        logger.info(`⏳ Waiting 8s before retrying Gemini...`);
        await new Promise((res) => setTimeout(res, 8000));
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
        characterUrl: characterReferences.length > 0 ? characterReferences[0].url : null,
        styleUrl,
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
