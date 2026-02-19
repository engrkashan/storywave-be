// import fs from "fs";
// import path from "path";
// import OpenAI from "openai";
// import { GoogleGenAI } from "@google/genai";

// const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// const MIDJOURNEY_API_BASE = "https://api.midapi.ai/api/v1/mj";

// // Global state to track model health across a single loop execution
// let activeModelTier = null;

// const MODELS = {
//   // Nano Banana Pro: Best for text rendering & complex reasoning
//   PREMIUM: "gemini-3-pro-image-preview",
//   // Imagen 4 Fast: High-speed, dedicated quota
//   FAST: "imagen-4.0-fast-generate-001",
// };

// /* --------------------------------------------------
//    IMAGE GENERATION (GEMINI / IMAGEN)
// -------------------------------------------------- */
// async function generateWithImagen(prompt, index, tempDir, aspectRatio = "16:9") {
//   fs.mkdirSync(tempDir, { recursive: true });
//   const enhancedPrompt = `High quality story illustration, cinematic lighting: ${prompt}`;

//   // If a previous failure in this loop pushed us to PREMIUM, stay there.
//   const modelFallbackChain = activeModelTier === "PREMIUM"
//     ? [MODELS.PREMIUM]
//     : [MODELS.FAST, MODELS.PREMIUM];

//   let lastError = null;

//   for (const modelId of modelFallbackChain) {
//     // Retry logic specifically for the FAST model
//     const maxRetries = modelId === MODELS.FAST ? 2 : 1;

//     for (let attempt = 1; attempt <= maxRetries; attempt++) {
//       try {
//         console.log(`📡 [${modelId}] Attempt ${attempt}/${maxRetries}`);

//         const response = await ai.models.generateImages({
//           model: modelId,
//           prompt: enhancedPrompt,
//           config: { numberOfImages: 1, aspectRatio: aspectRatio },
//         });

//         const imageData = response.generatedImages?.[0]?.image?.imageBytes;
//         if (!imageData) throw new Error(`${modelId} returned no image bytes`);

//         const filePath = path.join(tempDir, `scene_${String(index).padStart(3, "0")}.png`);
//         fs.writeFileSync(filePath, Buffer.from(imageData, "base64"));

//         console.log(`✅ Success with ${modelId}`);
//         return filePath;

//       } catch (err) {
//         lastError = err;
//         const isQuotaError = err.status === 429 || err.message.toLowerCase().includes("quota");

//         if (isQuotaError && modelId === MODELS.FAST && attempt < maxRetries) {
//           console.warn(`⏳ Imagen 4 Quota hit. Waiting 30s before retry...`);
//           await new Promise(r => setTimeout(r, 30000));
//           continue;
//         }

//         if (isQuotaError) {
//           console.warn(`⚠️ ${modelId} exhausted. Falling back permanently for this loop.`);
//           activeModelTier = "PREMIUM"; // Stick to the fallback for the rest of the loop
//           break; // Move to the next model in the chain
//         }

//         throw err; // For safety blocks, exit immediately to sanitize
//       }
//     }
//   }
//   throw lastError;
// }

// /* --------------------------------------------------
//    MIDJOURNEY (Updated for MidAPI v1)
// -------------------------------------------------- */
// async function generateWithMidjourney(prompt, index, tempDir, aspectRatio = "16:9") {
//   fs.mkdirSync(tempDir, { recursive: true });

//   // Fixed prompt: Move quality tags to the actual payload prompt
//   const qualityPrefix = "Ultra HD, 8k, HDR, cinematic lighting, masterpiece, ";
//   const fullPrompt = `${qualityPrefix}${prompt}`;

//   const payload = {
//     taskType: "mj_txt2img",
//     prompt: fullPrompt,
//     aspectRatio: aspectRatio === "9:16" ? "9:16" : "16:9",
//     speed: "fast",
//     processMode: "relax", // Using relax to avoid credit exhaustion if fast fails
//     buttons: []
//   };

//   const postResponse = await fetch(`${MIDJOURNEY_API_BASE}/generate`, {
//     method: "POST",
//     headers: {
//       Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
//       "Content-Type": "application/json",
//     },
//     body: JSON.stringify(payload),
//   });

//   const postData = await postResponse.json();
//   if (!postResponse.ok) throw new Error(postData?.message || "MidJourney start failed");

//   const taskId = postData?.data?.taskId;
//   console.log("🆔 MidJourney task created:", taskId);

//   // Polling logic
//   const start = Date.now();
//   while (Date.now() - start < 180000) { // 3 min timeout
//     const statusResponse = await fetch(`${MIDJOURNEY_API_BASE}/record-info?taskId=${taskId}`, {
//       headers: { Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}` },
//     });

//     const statusData = await statusResponse.json();
//     const flag = statusData?.data?.successFlag; // 1: Success, 2: Failed, 3: Expired

//     if (flag === 1) {
//       const imageUrl = statusData?.data?.resultInfoJson?.resultUrls?.[0]?.resultUrl;
//       const filePath = path.join(tempDir, `scene_${String(index).padStart(3, "0")}.png`);
//       await downloadImage(imageUrl, filePath);
//       return filePath;
//     }

//     if (flag === 2 || flag === 3) throw new Error("MidJourney task failed internally");

//     await new Promise(r => setTimeout(r, 15000)); // Poll every 15s
//   }
//   throw new Error("MidJourney polling timeout");
// }

// /* --------------------------------------------------
//    MAIN ORCHESTRATOR
// -------------------------------------------------- */
// export async function generateMultiImages(prompts, tempDir, aspectRatio = "16:9") {
//   activeModelTier = null; // Reset fallback status for new batch
//   const results = [];

//   for (let i = 0; i < prompts.length; i++) {
//     let currentPrompt = prompts[i];
//     let success = false;

//     // Outer try/catch for the tiered Gemini -> MJ flow
//     try {
//       const path = await generateWithImagen(currentPrompt, i + 1, tempDir, aspectRatio);
//       results.push({ imageUrl: path, error: null });
//       success = true;
//     } catch (err) {
//       console.error(`Gemini cluster failed. Trying MidJourney...`);
//       try {
//         const path = await generateWithMidjourney(currentPrompt, i + 1, tempDir, aspectRatio);
//         results.push({ imageUrl: path, error: null });
//         success = true;
//       } catch (mjErr) {
//         results.push({ imageUrl: null, error: mjErr.message });
//       }
//     }
//   }
//   return results;
// }



// /* --------------------------------------------------
//    MAIN ORCHESTRATOR
// -------------------------------------------------- */
// export async function generateImage(prompt, index = 1, tempDir, aspectRatio = "16:9") {
//   let imageUrl = null;
//   let imageError = null;

//   let safePrompt = prompt;

//   // --- GEMINI attempts ---
//   for (let i = 1; i <= 3; i++) {
//     try {
//       console.log(`🌈 Gemini attempt ${i}/3`);
//       imageUrl = await generateWithImagen(safePrompt, index, tempDir, aspectRatio);
//       return { imageUrl, error: null };
//     } catch (err) {
//       console.error(`❌ Gemini attempt ${i} failed:`, err.message);
//       safePrompt = await sanitizePrompt(safePrompt);
//       imageError = err;
//     }
//   }

//   // --- MIDJOURNEY fallback ---
//   for (let i = 1; i <= 3; i++) {
//     try {
//       console.log(`🎨 MidJourney attempt ${i}/3`);
//       imageUrl = await generateWithMidjourney(safePrompt, index, tempDir, aspectRatio);
//       return { imageUrl, error: null };
//     } catch (err) {
//       console.error(`❌ MidJourney attempt ${i} failed:`, err.message);
//       safePrompt = await sanitizePrompt(safePrompt);
//       imageError = err;
//     }
//   }

//   // --- All image attempts failed ---
//   console.warn("⚠️ All image generation attempts failed. Skipping scene.");
//   return { imageUrl: null, error: imageError };
// }



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

  const fallbackChain =
    activeModelTier === "PREMIUM"
      ? [MODELS.PREMIUM]
      : [MODELS.FAST, MODELS.PREMIUM];

  let lastError = null;
  let updatedTier = activeModelTier;

  for (const modelId of fallbackChain) {
    const maxRetries = modelId === MODELS.FAST ? 2 : 1;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
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

        if (isQuota && modelId === MODELS.FAST && attempt < maxRetries) {
          console.warn("⏳ FAST quota hit. Retrying in 20s...");
          await sleep(20000);
          continue;
        }

        if (isQuota) {
          console.warn(
            `⚠️ ${modelId} exhausted. Switching permanently to PREMIUM.`
          );
          updatedTier = "PREMIUM";
          break;
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
    console.warn("Gemini failed. Trying MidJourney...");

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

  return { imageUrl: null, error: lastError?.message };
}
