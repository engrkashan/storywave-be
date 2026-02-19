// import fs from "fs";
// import path from "path";
// import OpenAI from "openai";
// import { GoogleGenAI } from "@google/genai";

// const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// const MIDJOURNEY_API_BASE = "https://api.midapi.ai/api/v1/mj";

// /* --------------------------------------------------
//    PROMPT SANITIZER (MidJourney only)
// -------------------------------------------------- */
// async function sanitizePrompt(prompt) {
//   const response = await openai.chat.completions.create({
//     model: "gpt-4o-mini",
//     messages: [
//       {
//         role: "system",
//         content:
//           "Rewrite prompts to comply with OpenAI policies. Keep creativity, remove unsafe or disallowed content.",
//       },
//       {
//         role: "user",
//         content: `Rewrite safely: "${prompt}"`,
//       },
//     ],
//     temperature: 0.7,
//   });

//   return response.choices[0].message.content;
// }

// /* --------------------------------------------------
//    IMAGE DOWNLOADER
// -------------------------------------------------- */
// async function downloadImage(url, filePath) {
//   const response = await fetch(url);
//   if (!response.ok) {
//     throw new Error(`Image download failed: ${response.statusText}`);
//   }

//   const buffer = Buffer.from(await response.arrayBuffer());
//   fs.writeFileSync(filePath, buffer);
// }


// /* --------------------------------------------------
//    TIERED MODEL STRATEGY
// -------------------------------------------------- */
// const MODELS = {
//   PREMIUM: "gemini-3-pro-image", // Nano Banana Pro (Best for complex story scenes)
//   FAST: "imagen-4.0-fast-generate",   // Fast Imagen 4 (Different quota bucket)
//   STABLE: "gemini-2.5-flash-image",       // Nano Banana (Most reliable fallback)
// };

// async function generateWithImagen(prompt, index, tempDir, aspectRatio = "16:9") {
//   fs.mkdirSync(tempDir, { recursive: true });

//   const enhancedPrompt = `High quality story illustration, cinematic lighting: ${prompt}`;

//   // Array of models to try in order if a Quota (429) or 404 is hit
//   const modelFallbackChain = [MODELS.FAST, MODELS.PREMIUM, MODELS.STABLE];
//   let lastError = null;

//   for (const modelId of modelFallbackChain) {
//     try {
//       console.log(`📡 Attempting generation with: ${modelId}`);

//       const response = await ai.models.generateImages({
//         model: modelId,
//         prompt: enhancedPrompt,
//         config: {
//           numberOfImages: 1,
//           aspectRatio: aspectRatio,
//         },
//       });

//       const imageData = response.generatedImages?.[0]?.image?.imageBytes;
//       if (!imageData) throw new Error(`${modelId} returned no image bytes`);

//       const filePath = path.join(tempDir, `scene_${String(index).padStart(3, "0")}.png`);
//       fs.writeFileSync(filePath, Buffer.from(imageData, "base64"));

//       console.log(`✅ Success with ${modelId}`);
//       return filePath;

//     } catch (err) {
//       lastError = err;
//       // If error is 429 (Quota) or 404 (Not Found/Retired), move to next model
//       if (err.status === 429 || err.message.includes("404") || err.message.includes("quota")) {
//         console.warn(`⚠️ ${modelId} failed (Quota/Retired). Switching to next fallback...`);
//         continue;
//       }
//       // If it's a safety block or other error, throw it to trigger sanitization
//       throw err;
//     }
//   }

//   throw lastError; // If all Gemini/Imagen models in the chain fail
// }

// // /* --------------------------------------------------
// //    MIDJOURNEY GENERATOR
// // -------------------------------------------------- */
// async function generateWithMidjourney(prompt, index, tempDir, aspectRatio = "16:9") {
//   fs.mkdirSync(tempDir, { recursive: true });

//   const payload = {
//     taskType: "mj_txt2img",
//     prompt: prompt,
//     speed: "fast",
//     aspectRatio: aspectRatio === "9:16" ? "9:16" : "16:9",
//     version: "6.1",
//     stylization: 200,
//     chaos: 30,
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
//   if (!postResponse.ok) {
//     throw new Error(postData?.message || "MidJourney start failed");
//   }

//   const taskId = postData?.data?.taskId;
//   if (!taskId) throw new Error("MidJourney taskId missing");

//   console.log("🆔 MidJourney task:", taskId);

//   const POLL_INTERVAL = 10000;
//   const MAX_POLL_TIME = 120000;
//   const start = Date.now();

//   while (true) {
//     if (Date.now() - start > MAX_POLL_TIME) {
//       throw new Error("MidJourney polling timeout");
//     }

//     const qualityPrefix = "Ultra HD, 8k, HDR, cinematic lighting, masterpiece, highly detailed, ";
//     const finalPrompt = `${qualityPrefix}${prompt}`;

//     const statusResponse = await fetch(
//       `${MIDJOURNEY_API_BASE}/record-info?taskId=${taskId}`,
//       {
//         headers: {
//           Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
//         },
//       },
//     );

//     const statusData = await statusResponse.json();
//     const flag = statusData?.data?.successFlag;

//     if (flag === 1) {
//       const imageUrl =
//         statusData?.data?.resultInfoJson?.resultUrls?.[0]?.resultUrl;

//       if (!imageUrl) throw new Error("MidJourney returned no image URL");

//       const filePath = path.join(
//         tempDir,
//         `scene_${String(index).padStart(3, "0")}.png`,
//       );

//       await downloadImage(imageUrl, filePath);
//       console.log("✅ MidJourney success:", filePath);

//       return filePath;
//     }

//     if (flag === 2 || flag === 3) {
//       throw new Error(statusData?.data?.errorMessage || "MidJourney failed");
//     }

//     await new Promise((r) => setTimeout(r, POLL_INTERVAL));
//   }
// }


import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MIDJOURNEY_API_BASE = "https://api.midapi.ai/api/v1/mj";

// Global state to track model health across a single loop execution
let activeModelTier = null;

const MODELS = {
  // Nano Banana Pro: Best for text rendering & complex reasoning
  PREMIUM: "gemini-3-pro-image-preview",
  // Imagen 4 Fast: High-speed, dedicated quota
  FAST: "imagen-4.0-fast-generate-001",
};

/* --------------------------------------------------
   IMAGE GENERATION (GEMINI / IMAGEN)
-------------------------------------------------- */
async function generateWithImagen(prompt, index, tempDir, aspectRatio = "16:9") {
  fs.mkdirSync(tempDir, { recursive: true });
  const enhancedPrompt = `High quality story illustration, cinematic lighting: ${prompt}`;

  // If a previous failure in this loop pushed us to PREMIUM, stay there.
  const modelFallbackChain = activeModelTier === "PREMIUM"
    ? [MODELS.PREMIUM]
    : [MODELS.FAST, MODELS.PREMIUM];

  let lastError = null;

  for (const modelId of modelFallbackChain) {
    // Retry logic specifically for the FAST model
    const maxRetries = modelId === MODELS.FAST ? 2 : 1;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`📡 [${modelId}] Attempt ${attempt}/${maxRetries}`);

        const response = await ai.models.generateImages({
          model: modelId,
          prompt: enhancedPrompt,
          config: { numberOfImages: 1, aspectRatio: aspectRatio },
        });

        const imageData = response.generatedImages?.[0]?.image?.imageBytes;
        if (!imageData) throw new Error(`${modelId} returned no image bytes`);

        const filePath = path.join(tempDir, `scene_${String(index).padStart(3, "0")}.png`);
        fs.writeFileSync(filePath, Buffer.from(imageData, "base64"));

        console.log(`✅ Success with ${modelId}`);
        return filePath;

      } catch (err) {
        lastError = err;
        const isQuotaError = err.status === 429 || err.message.toLowerCase().includes("quota");

        if (isQuotaError && modelId === MODELS.FAST && attempt < maxRetries) {
          console.warn(`⏳ Imagen 4 Quota hit. Waiting 30s before retry...`);
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }

        if (isQuotaError) {
          console.warn(`⚠️ ${modelId} exhausted. Falling back permanently for this loop.`);
          activeModelTier = "PREMIUM"; // Stick to the fallback for the rest of the loop
          break; // Move to the next model in the chain
        }

        throw err; // For safety blocks, exit immediately to sanitize
      }
    }
  }
  throw lastError;
}

/* --------------------------------------------------
   MIDJOURNEY (Updated for MidAPI v1)
-------------------------------------------------- */
async function generateWithMidjourney(prompt, index, tempDir, aspectRatio = "16:9") {
  fs.mkdirSync(tempDir, { recursive: true });

  // Fixed prompt: Move quality tags to the actual payload prompt
  const qualityPrefix = "Ultra HD, 8k, HDR, cinematic lighting, masterpiece, ";
  const fullPrompt = `${qualityPrefix}${prompt}`;

  const payload = {
    taskType: "mj_txt2img",
    prompt: fullPrompt,
    aspectRatio: aspectRatio === "9:16" ? "9:16" : "16:9",
    speed: "fast",
    processMode: "relax", // Using relax to avoid credit exhaustion if fast fails
    buttons: []
  };

  const postResponse = await fetch(`${MIDJOURNEY_API_BASE}/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const postData = await postResponse.json();
  if (!postResponse.ok) throw new Error(postData?.message || "MidJourney start failed");

  const taskId = postData?.data?.taskId;
  console.log("🆔 MidJourney task created:", taskId);

  // Polling logic
  const start = Date.now();
  while (Date.now() - start < 180000) { // 3 min timeout
    const statusResponse = await fetch(`${MIDJOURNEY_API_BASE}/record-info?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}` },
    });

    const statusData = await statusResponse.json();
    const flag = statusData?.data?.successFlag; // 1: Success, 2: Failed, 3: Expired

    if (flag === 1) {
      const imageUrl = statusData?.data?.resultInfoJson?.resultUrls?.[0]?.resultUrl;
      const filePath = path.join(tempDir, `scene_${String(index).padStart(3, "0")}.png`);
      await downloadImage(imageUrl, filePath);
      return filePath;
    }

    if (flag === 2 || flag === 3) throw new Error("MidJourney task failed internally");

    await new Promise(r => setTimeout(r, 15000)); // Poll every 15s
  }
  throw new Error("MidJourney polling timeout");
}

/* --------------------------------------------------
   MAIN ORCHESTRATOR
-------------------------------------------------- */
export async function generateMultiImages(prompts, tempDir, aspectRatio = "16:9") {
  activeModelTier = null; // Reset fallback status for new batch
  const results = [];

  for (let i = 0; i < prompts.length; i++) {
    let currentPrompt = prompts[i];
    let success = false;

    // Outer try/catch for the tiered Gemini -> MJ flow
    try {
      const path = await generateWithImagen(currentPrompt, i + 1, tempDir, aspectRatio);
      results.push({ imageUrl: path, error: null });
      success = true;
    } catch (err) {
      console.error(`Gemini cluster failed. Trying MidJourney...`);
      try {
        const path = await generateWithMidjourney(currentPrompt, i + 1, tempDir, aspectRatio);
        results.push({ imageUrl: path, error: null });
        success = true;
      } catch (mjErr) {
        results.push({ imageUrl: null, error: mjErr.message });
      }
    }
  }
  return results;
}



/* --------------------------------------------------
   MAIN ORCHESTRATOR
-------------------------------------------------- */
export async function generateImage(prompt, index = 1, tempDir, aspectRatio = "16:9") {
  let imageUrl = null;
  let imageError = null;

  let safePrompt = prompt;

  // --- GEMINI attempts ---
  for (let i = 1; i <= 3; i++) {
    try {
      console.log(`🌈 Gemini attempt ${i}/3`);
      imageUrl = await generateWithImagen(safePrompt, index, tempDir, aspectRatio);
      return { imageUrl, error: null };
    } catch (err) {
      console.error(`❌ Gemini attempt ${i} failed:`, err.message);
      safePrompt = await sanitizePrompt(safePrompt);
      imageError = err;
    }
  }

  // --- MIDJOURNEY fallback ---
  for (let i = 1; i <= 3; i++) {
    try {
      console.log(`🎨 MidJourney attempt ${i}/3`);
      imageUrl = await generateWithMidjourney(safePrompt, index, tempDir, aspectRatio);
      return { imageUrl, error: null };
    } catch (err) {
      console.error(`❌ MidJourney attempt ${i} failed:`, err.message);
      safePrompt = await sanitizePrompt(safePrompt);
      imageError = err;
    }
  }

  // --- All image attempts failed ---
  console.warn("⚠️ All image generation attempts failed. Skipping scene.");
  return { imageUrl: null, error: imageError };
}

