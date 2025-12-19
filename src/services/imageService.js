// import fs from "fs";
// import path from "path";
// import OpenAI from "openai";
// import { GoogleGenAI } from "@google/genai";

// const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// const MIDJOURNEY_API_BASE = "https://api.midapi.ai/api/v1/mj";

// // -----------------------------------
// // PROMPT SANITIZER
// // -----------------------------------z
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

// // -----------------------------------
// // IMAGE DOWNLOADER
// // -----------------------------------
// async function downloadImage(url, filePath) {
//   try {
//     const response = await fetch(url);
//     if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);

//     const buffer = Buffer.from(await response.arrayBuffer());
//     fs.writeFileSync(filePath, buffer);
//   } catch (err) {
//     console.error("❌ Image download failed:", err.message);
//     throw err;
//   }
// }

// // -----------------------------------
// // GEMINI IMAGE GENERATOR
// // -----------------------------------

// export async function generateWithImagen(prompt, index = 1, tempDir) {
//   fs.mkdirSync(tempDir, { recursive: true });

//   const enhancedPrompt = `
// High quality, cinematic, ultra-detailed.
// Wide horizontal composition, 16:9 aspect ratio.
// ${prompt}
// `.trim();

//   const response = await ai.models.generateImages({
//     model: "imagen-4.0-generate-001",
//     prompt: enhancedPrompt,
//     config: {
//       numberOfImages: 1,
//       aspectRatio: "16:9",
//     },
//   });

//   const generatedImage = response.generatedImages?.[0];
//   if (!generatedImage?.image?.imageBytes) {
//     throw new Error("Imagen returned no image bytes");
//   }

//   const buffer = Buffer.from(
//     generatedImage.image.imageBytes,
//     "base64"
//   );

//   const filePath = path.join(
//     tempDir,
//     `scene_${String(index).padStart(3, "0")}.png`
//   );

//   fs.writeFileSync(filePath, buffer);

//   console.log("✅ Imagen image saved:", filePath);
//   return filePath;
// }


// // -----------------------------------
// // MAIN IMAGE GENERATOR
// // -----------------------------------
// export async function generateImage(prompt, index = 1, tempDir) {
//   fs.mkdirSync(tempDir, { recursive: true });

//   // -------- Retry Logic --------
//   const MAX_RETRIES = 3;
//   let attempt = 0;

//   while (attempt < MAX_RETRIES) {
//     attempt++;
//     console.log(`⚡ Attempt ${attempt}/${MAX_RETRIES}`);

//     try {
//       const safePrompt = await sanitizePrompt(prompt);
//       console.log("✅ Safe prompt:", safePrompt);

//       const payload = {
//         taskType: "mj_txt2img",
//         prompt: safePrompt,
//         speed: "fast",
//         aspectRatio: "16:9",
//         version: "6.1",
//         stylization: 200,
//         chaos: 30
//       };


//       // -----------------------------------
//       // START GENERATION
//       // -----------------------------------
//       const postResponse = await fetch(`${MIDJOURNEY_API_BASE}/generate`, {
//         method: "POST",
//         headers: {
//           Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
//           "Content-Type": "application/json",
//         },
//         body: JSON.stringify(payload),
//       });

//       const postData = await postResponse.json();

//       if (!postResponse.ok) {
//         console.error("❌ API Error Response:", postData);
//         throw new Error(postData?.message || "Failed to start generation");
//       }

//       const taskId = postData?.data?.taskId;
//       if (!taskId) throw new Error("No taskId returned by API");

//       console.log("🆔 Task started with ID:", taskId);

//       // -----------------------------------
//       // POLLING
//       // -----------------------------------
//       let result;
//       const POLL_INTERVAL = 10000; // 10 seconds
//       const MAX_POLL_TIME = 120 * 1000; // 120 seconds
//       const pollStart = Date.now();

//       while (true) {
//         if (Date.now() - pollStart > MAX_POLL_TIME) {
//           throw new Error("Polling timed out after 120s");
//         }

//         console.log(`⏳ Polling for: ${taskId}`);

//         const getResponse = await fetch(
//           `${MIDJOURNEY_API_BASE}/record-info?taskId=${taskId}`,
//           {
//             headers: {
//               Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
//               "Content-Type": "application/json",
//             },
//           }
//         );

//         if (!getResponse.ok) throw new Error("Failed to get status from API");

//         const statusData = await getResponse.json();
//         const flag = statusData?.data?.successFlag;

//         if (flag === 1) {
//           result = statusData.data.resultInfoJson;
//           break;
//         }

//         if (flag === 2 || flag === 3) {
//           throw new Error(statusData?.data?.errorMessage || "Image generation failed");
//         }

//         await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
//       }

//       // -----------------------------------
//       // SAVE IMAGE
//       // -----------------------------------
//       const imageUrl = result?.resultUrls?.[0]?.resultUrl;
//       if (!imageUrl) throw new Error("No image URL returned");

//       const filePath = path.join(tempDir, `scene_${String(index).padStart(3, "0")}.png`);
//       await downloadImage(imageUrl, filePath);

//       console.log(`✅ Image saved to: ${filePath}`);
//       return filePath;
//     } catch (err) {
//       console.error(`❌ Attempt ${attempt} failed:`, err.message);

//       if (attempt === MAX_RETRIES) {
//         console.log("⚠️ MidJourney failed. Switching to Imagen...");
//         return await generateWithImagen(prompt, index, tempDir);
//       }

//       await new Promise((resolve) => setTimeout(resolve, 30000));
//     }
//   }
// }



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
async function generateWithImagen(prompt, index, tempDir) {
  fs.mkdirSync(tempDir, { recursive: true });

  const enhancedPrompt = `
High quality, cinematic, ultra-detailed.
Wide horizontal composition, 16:9 aspect ratio.
${prompt}
`.trim();

  const response = await ai.models.generateImages({
    model: "imagen-4.0-generate-001",
    prompt: enhancedPrompt,
    config: {
      numberOfImages: 1,
      aspectRatio: "16:9",
    },
  });

  const image = response.generatedImages?.[0]?.image?.imageBytes;
  if (!image) throw new Error("Imagen returned no image bytes");

  const buffer = Buffer.from(image, "base64");
  const filePath = path.join(
    tempDir,
    `scene_${String(index).padStart(3, "0")}.png`
  );

  fs.writeFileSync(filePath, buffer);
  console.log("✅ Imagen success:", filePath);

  return filePath;
}

/* --------------------------------------------------
   MIDJOURNEY GENERATOR
-------------------------------------------------- */
async function generateWithMidjourney(prompt, index, tempDir) {
  fs.mkdirSync(tempDir, { recursive: true });

  const payload = {
    taskType: "mj_txt2img",
    prompt: prompt,
    speed: "fast",
    aspectRatio: "16:9",
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

    const statusResponse = await fetch(
      `${MIDJOURNEY_API_BASE}/record-info?taskId=${taskId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
        },
      }
    );

    const statusData = await statusResponse.json();
    const flag = statusData?.data?.successFlag;

    if (flag === 1) {
      const imageUrl =
        statusData?.data?.resultInfoJson?.resultUrls?.[0]?.resultUrl;

      if (!imageUrl) throw new Error("MidJourney returned no image URL");

      const filePath = path.join(
        tempDir,
        `scene_${String(index).padStart(3, "0")}.png`
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
export async function generateImage(prompt, index = 1, tempDir) {
  let imageUrl = null;
  let imageError = null;

  const safePrompt = prompt;

  // GEMINI attempts
  for (let i = 1; i <= 3; i++) {
    try {
      console.log(`🌈 Gemini attempt ${i}/3`);
      imageUrl = await generateWithImagen(safePrompt, index, tempDir);
      return { imageUrl, error: null };
    } catch (err) {
      console.error(`❌ Gemini attempt ${i} failed:`, err);
      safePrompt = await sanitizePrompt(safePrompt);
      imageError = err; // Save the exact error
    }
  }

  // MIDJOURNEY fallback
  for (let i = 1; i <= 3; i++) {
    try {
      console.log(`🎨 MidJourney attempt ${i}/3`);
      imageUrl = await generateWithMidjourney(safePrompt, index, tempDir);
      return { imageUrl, error: null };
    } catch (err) {
      console.error(`❌ MidJourney attempt ${i} failed:`, err);
      safePrompt = await sanitizePrompt(safePrompt);
      imageError = err;
    }
  }

  console.warn("⚠️ All image generation attempts failed. Skipping scene.");
  return { imageUrl: null, error: imageError }; // Return the exact error
}
