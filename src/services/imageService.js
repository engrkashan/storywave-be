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
import { GoogleGenAI } from "@google/genai"; // 1. Add Google Gen AI SDK

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }); // Initialize Gemini Client

const MIDJOURNEY_API_BASE = "https://api.midapi.ai/api/v1/mj";
const MAX_RETRIES = 3; // Maximum retries for Midjourney before falling back
const MIDJOURNEY_QUOTA_ERROR_CODES = [403, 429]; // Example error codes for quota/rate limit

// Basic sanitizer (Remains the same)
async function sanitizePrompt(prompt) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "You are an AI assistant that rewrites prompts to fully comply with OpenAI content policies. " +
          "Keep the original idea, context, and creativity, but remove or reword anything that violates policy, " +
          "including graphic violence, gore, sexual content, or illegal activities."
      },
      {
        role: "user",
        content: `Please rewrite this prompt safely while keeping its intent intact: "${prompt}"`
      }
    ],
    temperature: 0.7
  });

  return response.choices[0].message.content;
}

// Download helper (Remains the same)
async function downloadImage(url, filePath) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(filePath, buffer);
  } catch (err) {
    console.error("❌ Image download failed:", err.message);
    throw err;
  }
}

// 3. New Function for Gemini (Imagen) Fallback
async function generateImageWithGemini(safePrompt, index, tempDir) {
  console.log("➡️ Falling back to Gemini image generation...");

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image", // Model for image generation
      contents: [safePrompt],
      config: {
        responseMimeType: "image/png",
        // Optional: Aspect ratio is often controlled via prompt for Gemini image models,
        // but you can try to influence it here if the SDK supports a config for it.
      }
    });

    const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (!part || !part.inlineData) {
      throw new Error("Gemini image generation failed: No image data returned.");
    }

    const { data: base64Data, mimeType } = part.inlineData;
    const buffer = Buffer.from(base64Data, 'base64');

    // Determine file extension
    const ext = mimeType.split('/')[1] || 'png';
    const filePath = path.join(
      tempDir,
      `scene_${String(index).padStart(3, "0")}_gemini.${ext}`
    );

    fs.writeFileSync(filePath, buffer);
    console.log(`✅ Image saved from Gemini: ${filePath}`);
    return filePath;

  } catch (err) {
    console.error("❌ Gemini image generation failed:", err.message);
    throw new Error(`Fallback failed: ${err.message}`); // Final failure
  }
}


// 4. Main function with Retry and Fallback Logic
export async function generateImage(prompt, index = 1, tempDir) {
  // Ensure temp folder exists
  fs.mkdirSync(tempDir, { recursive: true });

  const safePrompt = await sanitizePrompt(prompt);
  console.log("✅ Safe prompt:", safePrompt);

  let midjourneyError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      console.log(`\nAttempt ${attempt}/${MAX_RETRIES + 1}: Starting Midjourney generation...`);

      const data = {
        taskType: "mj_txt2img",
        prompt: safePrompt,
        speed: "fast",
        aspectRatio: "16:9",
        version: "7",
        stylization: 500
      };

      // --- Start generation ---
      const postResponse = await fetch(`${MIDJOURNEY_API_BASE}/generate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });

      if (!postResponse.ok) {
        const status = postResponse.status;
        const text = await postResponse.text();
        console.log("DEBUG BODY:", text);

        const error = new Error(`Midjourney: Failed to start generation (Status ${status}): ${postResponse.statusText}`);
        error.isQuotaError = MIDJOURNEY_QUOTA_ERROR_CODES.includes(status);
        error.midjourneyResponseText = text;

        if (error.isQuotaError) {
          midjourneyError = error; // Store the quota error for UX
          break; // Break the loop immediately for quota/rate limit error
        }

        throw error; // Throw other errors to trigger retry
      }

      const postData = await postResponse.json();
      const taskId = postData?.data?.taskId;
      if (!taskId) {
        throw new Error("Midjourney: No taskId returned, cannot poll.");
      }

      // --- Poll for completion ---
      let result;
      const MAX_POLL_ATTEMPTS = 60; // Max polling for 5 mins (60 * 5s)
      for (let pollAttempt = 0; pollAttempt < MAX_POLL_ATTEMPTS; pollAttempt++) {
        console.log(`Polling for taskId: ${taskId}`);
        const getResponse = await fetch(`${MIDJOURNEY_API_BASE}/record-info?taskId=${taskId}`, {
          headers: {
            Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
            "Content-Type": "application/json",
          },
        });

        if (!getResponse.ok) {
          throw new Error(`Midjourney: Failed to get status: ${getResponse.statusText}`);
        }

        const getData = await getResponse.json();
        const successFlag = getData?.data?.successFlag;

        if (successFlag === 1) {
          result = getData.data.resultInfoJson;
          break; // Generation complete
        } else if (successFlag === 2 || successFlag === 3) {
          throw new Error(`Midjourney: Generation failed: ${getData?.data?.errorMessage || 'Unknown error'}`);
        }

        // Wait 5 seconds before next poll
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      if (!result) {
        throw new Error("Midjourney: Polling timed out. Image not generated within expected time.");
      }

      // --- Download image ---
      const imageUrl = result.resultUrls?.[0]?.resultUrl;
      if (!imageUrl) {
        throw new Error("Midjourney: No image URL available");
      }

      const filePath = path.join(
        tempDir,
        `scene_${String(index).padStart(3, "0")}_midjourney.png`
      );
      await downloadImage(imageUrl, filePath);
      console.log(`✅ Image saved: ${filePath}`);

      return { filePath, source: 'Midjourney', midjourneyError: null };

    } catch (err) {
      midjourneyError = err; // Store the error from this attempt
      console.error(`❌ Midjourney attempt ${attempt} failed:`, err.message);

      if (attempt <= MAX_RETRIES) {
        // Retry logic: wait for exponential backoff before next attempt (simple: wait 5s * attempt)
        const delay = attempt * 5000;
        console.log(`Retrying Midjourney in ${delay / 1000}s...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        // Max retries reached or immediate break (quota error)
        break;
      }
    }
  }

  // --- Fallback to Gemini if Midjourney failed (after retries or on quota error) ---
  if (midjourneyError) {
    console.warn("⚠️ Midjourney failed after all retries or due to a quota error. Falling back to Gemini...");

    // Call the new Gemini function
    const geminiFilePath = await generateImageWithGemini(safePrompt, index, tempDir);

    // Return the Gemini result along with the Midjourney error for better UX messaging
    return {
      filePath: geminiFilePath,
      source: 'Gemini',
      midjourneyError: midjourneyError.isQuotaError
        ? `Midjourney Quota Exceeded (Status ${midjourneyError.status}): ${midjourneyError.midjourneyResponseText}`
        : midjourneyError.message,
    };
  }

  // This line should be unreachable if the logic is correct, but added as a final safeguard
  throw new Error("Image generation failed with both Midjourney (no retries left) and Gemini.");
}