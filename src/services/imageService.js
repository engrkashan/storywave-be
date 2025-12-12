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

// --------------------------
// UNIVERSAL FETCH (RETRY + TIMEOUT)
// --------------------------
async function fetchSafe(url, options = {}, retries = 3, timeout = 20000) {
  for (let i = 1; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);

      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);

      if (res.ok) return res;
      throw new Error(`Status ${res.status}`);
    } catch (err) {
      console.log(`⚠️ fetchSafe attempt ${i} failed:`, err.message);
      if (i === retries) return null;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// --------------------------
// SANITIZE PROMPT (OPTIONAL, OpenAI GPT-4O-mini)
// --------------------------
async function sanitizePrompt(prompt) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Rewrite prompts safely, remove disallowed content but keep original intent.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.6,
    });

    return response.choices[0].message.content;
  } catch (err) {
    console.log("⚠️ Prompt sanitization failed, using original prompt.");
    return prompt;
  }
}

// --------------------------
// TIER 1 — MIDJOURNEY
// --------------------------
async function generateViaMidjourney(prompt, tempPath) {
  try {
    const postRes = await fetchSafe(`${MIDJOURNEY_API_BASE}/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        taskType: "mj_txt2img",
        prompt,
        speed: "fast",
        version: "7",
        aspectRatio: "16:9",
        stylization: 500,
      }),
    });

    if (!postRes) throw new Error("MJ POST failed");

    const postData = await postRes.json();
    const taskId = postData?.data?.taskId;
    if (!taskId) throw new Error("No taskId returned from MJ");

    console.log("🟦 MJ Task ID:", taskId);

    // Polling
    const start = Date.now();
    const MAX_TIME = 1000 * 60 * 2; // 2 mins

    let result = null;
    while (Date.now() - start < MAX_TIME) {
      const pollRes = await fetchSafe(
        `${MIDJOURNEY_API_BASE}/record-info?taskId=${taskId}`,
        { headers: { Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}` } }
      );
      if (!pollRes) {
        await new Promise((r) => setTimeout(r, 4000));
        continue;
      }

      const pollData = await pollRes.json();
      const flag = pollData?.data?.successFlag;

      if (flag === 1) {
        result = pollData.data.resultInfoJson;
        break;
      }
      if (flag === 2 || flag === 3) {
        throw new Error(pollData?.data?.errorMessage || "MJ failed");
      }

      await new Promise((r) => setTimeout(r, 4000));
    }

    const imageUrl = result?.resultUrls?.[0]?.resultUrl;
    if (!imageUrl) throw new Error("MJ result missing URL");

    const img = await fetchSafe(imageUrl, {}, 3);
    if (!img) throw new Error("MJ image download failed");

    fs.writeFileSync(tempPath, Buffer.from(await img.arrayBuffer()));
    return tempPath;
  } catch (err) {
    console.log("⚠️ MidJourney failed:", err.message);
    return null;
  }
}

// --------------------------
// TIER 2 — OPENAI FALLBACK (16:9, MJ-style prompt enhancer)
// --------------------------
async function generateViaOpenAI(prompt, tempPath) {
  const enhancedPrompt = `
Cinematic ultra-detailed ${prompt}, midjourney v6 style,
16:9 aspect ratio, 8K resolution, hyper-realistic, dramatic lighting,
volumetric lighting, octane render, ultra sharp details, atmospheric depth,
global illumination, highly stylized composition.
`;

  for (let i = 1; i <= 5; i++) {
    try {
      console.log(`🟩 OpenAI fallback try ${i}`);
      const response = await openai.images.generate({
        model: "gpt-image-1",
        prompt: enhancedPrompt,
        size: "1024x576", // 16:9 for YouTube thumbnail
      });

      const url = response.data[0].url;
      const img = await fetchSafe(url);
      if (!img) throw new Error("OpenAI download failed");

      fs.writeFileSync(tempPath, Buffer.from(await img.arrayBuffer()));
      return tempPath;
    } catch (err) {
      console.log("⚠️ OpenAI fallback error:", err.message);
      if (i === 5) throw new Error("OpenAI fallback failed completely");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// --------------------------
// MAIN FUNCTION
// --------------------------
export async function generateImage(prompt, index = 1, tempDir) {
  fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `scene_${String(index).padStart(3, "0")}.png`);

  const safePrompt = await sanitizePrompt(prompt);

  // 1️⃣ Try MidJourney
  const mj = await generateViaMidjourney(safePrompt, tempPath);
  if (mj) {
    console.log("✅ Final: MidJourney Success");
    return mj;
  }

  // 2️⃣ Fallback → OpenAI
  console.log("🔄 Switching to OpenAI fallback...");
  const dalle = await generateViaOpenAI(safePrompt, tempPath);

  console.log("🟢 Final: OpenAI Success (Fallback)");
  return dalle;
}
