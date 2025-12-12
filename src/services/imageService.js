// // imageService.js
// import fs from "fs";
// import path from "path";
// import OpenAI from "openai";

// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// const MIDJOURNEY_API_BASE = "https://api.midapi.ai/api/v1/mj";

// // Basic sanitizer
// async function sanitizePrompt(prompt) {
//   const response = await openai.chat.completions.create({
//     model: "gpt-4o-mini",
//     messages: [
//       {
//         role: "system",
//         content: "You are an AI assistant that rewrites prompts to fully comply with OpenAI content policies. " +
//           "Keep the original idea, context, and creativity, but remove or reword anything that violates policy, " +
//           "including graphic violence, gore, sexual content, or illegal activities."
//       },
//       {
//         role: "user",
//         content: `Please rewrite this prompt safely while keeping its intent intact: "${prompt}"`
//       }
//     ],
//     temperature: 0.7
//   });

//   return response.choices[0].message.content;
// }

// // Download helper
// async function downloadImage(url, filePath) {
//   try {
//     const response = await fetch(url);
//     if (!response.ok) {
//       throw new Error(`Failed to download image: ${response.statusText}`);
//     }
//     const arrayBuffer = await response.arrayBuffer();
//     const buffer = Buffer.from(arrayBuffer);
//     fs.writeFileSync(filePath, buffer);
//   } catch (err) {
//     console.error("❌ Image download failed:", err.message);
//     throw err;
//   }
// }

// export async function generateImage(prompt, index = 1, tempDir) {
//   // Ensure temp folder exists
//   fs.mkdirSync(tempDir, { recursive: true });

//   try {
//     const safePrompt = await sanitizePrompt(prompt);
//     console.log("✅ Safe prompt:", safePrompt);

//     const data = {
//       taskType: "mj_txt2img",
//       prompt: safePrompt,
//       speed: "fast", // Options: "relaxed", "fast", "turbo"
//       aspectRatio: "16:9",
//       version: "7", // Recommended latest version
//       stylization: 500 // Default stylization level
//     };

//     // Start generation
//     const postResponse = await fetch(`${MIDJOURNEY_API_BASE}/generate`, {
//       method: "POST",
//       headers: {
//         Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify(data),
//     });

//     if (!postResponse.ok) {
//       const text = await postResponse.text();
//       console.log("DEBUG BODY:", text);
//       throw new Error(`Failed to start generation: ${postResponse.statusText}`);
//     }

//     const postData = await postResponse.json();
//     console.log("DEBUG POST DATA:", JSON.stringify(postData, null, 2));
//     const taskId = postData?.data?.taskId;
//     if (!taskId) {
//       console.error(
//         "❌ No taskId returned from API:",
//         JSON.stringify(postData, null, 2)
//       );
//       throw new Error("No taskId returned, cannot poll.");
//     }

//     // Poll for completion
//     let result;
//     while (true) {
//       console.log(`Polling for taskId: ${taskId}`);
//       const getResponse = await fetch(`${MIDJOURNEY_API_BASE}/record-info?taskId=${taskId}`, {
//         headers: {
//           Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
//           "Content-Type": "application/json",
//         },
//       });

//       if (!getResponse.ok) {
//         throw new Error(`Failed to get status: ${getResponse.statusText}`);
//       }

//       const getData = await getResponse.json();
//       const successFlag = getData?.data?.successFlag;

//       if (successFlag === 1) {
//         result = getData.data.resultInfoJson;
//         break;
//       } else if (successFlag === 2 || successFlag === 3) {
//         throw new Error(`Generation failed: ${getData?.data?.errorMessage || 'Unknown error'}`);
//       }

//       // Wait 5 seconds before next poll
//       await new Promise((resolve) => setTimeout(resolve, 5000));
//     }

//     // Select the first image URL (API generates 4 variations)
//     const imageUrl = result.resultUrls?.[0]?.resultUrl;
//     if (!imageUrl) {
//       throw new Error("No image URL available");
//     }
//     console.log("DEBUG RESULT POLLING:", JSON.stringify(result, null, 2));
//     const filePath = path.join(
//       tempDir,
//       `scene_${String(index).padStart(3, "0")}.png`
//     );
//     await downloadImage(imageUrl, filePath);
//     console.log(`✅ Image saved: ${filePath}`);
//     return filePath;
//   } catch (err) {
//     console.error("❌ Image generation failed:", err.message);
//     throw err;
//   }
// }

// imageService.js


import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MIDJOURNEY_API_BASE = "https://api.midapi.ai/api/v1/mj";

// -----------------------------------
// PROMPT SANITIZER
// -----------------------------------
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

// -----------------------------------
// IMAGE DOWNLOADER
// -----------------------------------
async function downloadImage(url, filePath) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download image: ${response.statusText}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
  } catch (err) {
    console.error("❌ Image download failed:", err.message);
    throw err;
  }
}

// -----------------------------------
// MAIN IMAGE GENERATOR
// -----------------------------------
export async function generateImage(prompt, index = 1, tempDir) {
  fs.mkdirSync(tempDir, { recursive: true });

  // -------- Retry Logic --------
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    attempt++;
    console.log(`⚡ Attempt ${attempt}/${MAX_RETRIES}`);

    try {
      const safePrompt = await sanitizePrompt(prompt);
      console.log("✅ Safe prompt:", safePrompt);

      const payload = {
        taskType: "mj_txt2img",
        prompt: safePrompt,
        speed: "fast",
        aspectRatio: "16:9",
        version: "7",
        stylization: 500,
      };

      // -----------------------------------
      // START GENERATION
      // -----------------------------------
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
        console.error("❌ API Error Response:", postData);
        throw new Error(postData?.message || "Failed to start generation");
      }

      const taskId = postData?.data?.taskId;
      if (!taskId) throw new Error("No taskId returned by API");

      console.log("🆔 Task started with ID:", taskId);

      // -----------------------------------
      // POLLING
      // -----------------------------------
      let result;
      const POLL_INTERVAL = 10000; // 10 seconds
      const MAX_POLL_TIME = 120 * 1000; // 120 seconds
      const pollStart = Date.now();

      while (true) {
        if (Date.now() - pollStart > MAX_POLL_TIME) {
          throw new Error("Polling timed out after 120s");
        }

        console.log(`⏳ Polling for: ${taskId}`);

        const getResponse = await fetch(
          `${MIDJOURNEY_API_BASE}/record-info?taskId=${taskId}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (!getResponse.ok) throw new Error("Failed to get status from API");

        const statusData = await getResponse.json();
        const flag = statusData?.data?.successFlag;

        if (flag === 1) {
          result = statusData.data.resultInfoJson;
          break;
        }

        if (flag === 2 || flag === 3) {
          throw new Error(statusData?.data?.errorMessage || "Image generation failed");
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      }

      // -----------------------------------
      // SAVE IMAGE
      // -----------------------------------
      const imageUrl = result?.resultUrls?.[0]?.resultUrl;
      if (!imageUrl) throw new Error("No image URL returned");

      const filePath = path.join(tempDir, `scene_${String(index).padStart(3, "0")}.png`);
      await downloadImage(imageUrl, filePath);

      console.log(`✅ Image saved to: ${filePath}`);
      return filePath;
    } catch (err) {
      console.error(`❌ Attempt ${attempt} failed:`, err.message);

      if (attempt < MAX_RETRIES) {
        console.log("⏳ Waiting 30 seconds before retry...");
        await new Promise((resolve) => setTimeout(resolve, 30000));
      } else {
        throw new Error("❌ All retries failed. " + err.message);
      }
    }
  }
}
