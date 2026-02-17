import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MIDJOURNEY_API_BASE = "https://api.midapi.ai/api/v1/mj";

/* --------------------------------------------------
   PROMPT SANITIZER (MidJourney only)
-------------------------------------------------- */
async function sanitizePrompt(prompt) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Rewrite prompts to comply with OpenAI policies. Keep creativity, remove unsafe or disallowed content.",
      },
      {
        role: "user",
        content: `Rewrite safely: "${prompt}"`,
      },
    ],
    temperature: 0.7,
  });

  return response.choices[0].message.content;
}

/* --------------------------------------------------
   IMAGE DOWNLOADER
-------------------------------------------------- */
async function downloadImage(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image download failed: ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);
}

/* --------------------------------------------------
   GEMINI (IMAGEN) GENERATOR
-------------------------------------------------- */
async function generateWithImagen(prompt, index, tempDir, aspectRatio = "16:9") {
  fs.mkdirSync(tempDir, { recursive: true });

  const enhancedPrompt = `
High quality, cinematic, ultra-detailed.
${aspectRatio === "16:9" ? "Wide horizontal composition, 16:9 aspect ratio." : "Portrait vertical composition, 9:16 aspect ratio."}
${prompt}
`.trim();

  const response = await ai.models.generateImages({
    model: "imagen-4.0-generate-001",
    prompt: enhancedPrompt,
    config: {
      numberOfImages: 1,
      aspectRatio: aspectRatio === "9:16" ? "9:16" : "16:9",
    },
  });

  const image = response.generatedImages?.[0]?.image?.imageBytes;
  if (!image) throw new Error("Imagen returned no image bytes");

  const buffer = Buffer.from(image, "base64");
  const filePath = path.join(
    tempDir,
    `scene_${String(index).padStart(3, "0")}.png`,
  );

  fs.writeFileSync(filePath, buffer);
  console.log(`✅ Imagen success (${aspectRatio}):`, filePath);

  return filePath;
}

/* --------------------------------------------------
   MIDJOURNEY GENERATOR
-------------------------------------------------- */
async function generateWithMidjourney(prompt, index, tempDir, aspectRatio = "16:9") {
  fs.mkdirSync(tempDir, { recursive: true });

  const payload = {
    taskType: "mj_txt2img",
    prompt: prompt,
    speed: "fast",
    aspectRatio: aspectRatio === "9:16" ? "9:16" : "16:9",
    version: "6.1",
    stylization: 200,
    chaos: 30,
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
  if (!postResponse.ok) {
    throw new Error(postData?.message || "MidJourney start failed");
  }

  const taskId = postData?.data?.taskId;
  if (!taskId) throw new Error("MidJourney taskId missing");

  console.log("🆔 MidJourney task:", taskId);

  const POLL_INTERVAL = 10000;
  const MAX_POLL_TIME = 120000;
  const start = Date.now();

  while (true) {
    if (Date.now() - start > MAX_POLL_TIME) {
      throw new Error("MidJourney polling timeout");
    }

    const qualityPrefix = "Ultra HD, 8k, HDR, cinematic lighting, masterpiece, highly detailed, ";
    const finalPrompt = `${qualityPrefix}${prompt}`;

    const statusResponse = await fetch(
      `${MIDJOURNEY_API_BASE}/record-info?taskId=${taskId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
        },
      },
    );

    const statusData = await statusResponse.json();
    const flag = statusData?.data?.successFlag;

    if (flag === 1) {
      const imageUrl =
        statusData?.data?.resultInfoJson?.resultUrls?.[0]?.resultUrl;

      if (!imageUrl) throw new Error("MidJourney returned no image URL");

      const filePath = path.join(
        tempDir,
        `scene_${String(index).padStart(3, "0")}.png`,
      );

      await downloadImage(imageUrl, filePath);
      console.log("✅ MidJourney success:", filePath);

      return filePath;
    }

    if (flag === 2 || flag === 3) {
      throw new Error(statusData?.data?.errorMessage || "MidJourney failed");
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
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

/**
 * Generate multiple images for a set of prompts
 */
export async function generateMultiImages(prompts, tempDir, aspectRatio = "16:9") {
  const results = [];
  for (let i = 0; i < prompts.length; i++) {
    console.log(`🖼️ Generating image ${i + 1}/${prompts.length}...`);
    const result = await generateImage(prompts[i], i + 1, tempDir, aspectRatio);
    results.push(result);
  }
  return results;
}
