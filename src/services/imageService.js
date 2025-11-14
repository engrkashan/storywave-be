// import fs from "fs";
// import path from "path";
// import OpenAI from "openai";

// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// // Ensure temp folders exist
// const TEMP_DIR = path.join(process.cwd(), "temp");
// const IMAGE_DIR = path.join(TEMP_DIR, "images");
// fs.mkdirSync(IMAGE_DIR, { recursive: true });

// // Basic sanitizer
// function sanitizePrompt(prompt) {
//   const blocked = [
//     "sex", "nudity", "violence", "gore", "abuse",
//     "drugs", "weapon", "blood", "kill", "murder"
//   ];
//   let sanitized = prompt;
//   for (const w of blocked) {
//     sanitized = sanitized.replace(new RegExp(w, "gi"), "[REDACTED]");
//   }
//   return sanitized;
// }

// // One-time rewrite if moderation flags it
// async function makeSafePrompt(prompt) {
//   const sanitized = sanitizePrompt(prompt);

//   const mod = await openai.moderations.create({
//     model: "omni-moderation-latest",
//     input: sanitized,
//   });

//   const flagged = mod.results?.[0]?.flagged;
//   if (!flagged) return sanitized;

//   console.log("⚠️ Prompt flagged — rewriting safely...");
//   const response = await openai.chat.completions.create({
//     model: "gpt-4o-mini",
//     messages: [
//       {
//         role: "system",
//         content:
//           "Rewrite the user prompt in a fully safe, non-violent, non-explicit way. Keep same theme or mood but avoid unsafe or sensitive content.",
//       },
//       { role: "user", content: sanitized },
//     ],
//   });

//   const rewritten = response.choices[0].message.content.trim();
//   return sanitizePrompt(rewritten);
// }

// export async function generateImage(prompt, index = 1) {
//   try {
//     const safePrompt = await makeSafePrompt(prompt);
//     console.log("✅ Safe prompt:", safePrompt);
//     const result = await openai.images.generate({
//       model: "gpt-image-1",
//       prompt: safePrompt,
//       size: "1024x1024",
//       quality: "high",
//     });

//     const base64 = result.data?.[0]?.b64_json;
//     if (!base64) throw new Error("No image data returned");

//     const filePath = path.join(IMAGE_DIR, `scene_${String(index).padStart(3, "0")}.png`);
//     fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
//     console.log(`✅ Image saved: ${filePath}`);
//     return filePath;

//   } catch (err) {
//     console.error("❌ Image generation failed:", err.message);
//     throw err;
//   }
// }

import fs from "fs";
import path from "path";

// const MIDJOURNEY_API_ENDPOINT = "https://cl.imagineapi.dev/items/images/";
const MIDJOURNEY_API_ENDPOINT = " https://api.midapi.ai/api/v1/mj/generate";

// Ensure temp folders exist
const TEMP_DIR = path.join(process.cwd(), "temp");
const IMAGE_DIR = path.join(TEMP_DIR, "images");
fs.mkdirSync(IMAGE_DIR, { recursive: true });

// Basic sanitizer
function sanitizePrompt(prompt) {
  const blocked = [
    // "sex", "nudity", "violence", "gore", "abuse",
    // "drugs", "weapon", "blood", "kill", "murder"
  ];
  let sanitized = prompt;
  for (const w of blocked) {
    sanitized = sanitized.replace(new RegExp(w, "gi"), "[REDACTED]");
  }
  return sanitized;
}

// Download helper
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

export async function generateImage(prompt, index = 1) {
  try {
    const safePrompt = sanitizePrompt(prompt) + " --ar 16:9";
    console.log("✅ Safe prompt:", safePrompt);

    const data = { prompt: safePrompt };

    // Start generation
    const postResponse = await fetch(MIDJOURNEY_API_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });

    if (!postResponse.ok) {
      const text = await postResponse.text();
      console.log("DEBUG BODY:", text);
      throw new Error(`Failed to start generation: ${postResponse.statusText}`);
    }

    const postData = await postResponse.json();
    const imageId = postData.data.id;

    // Poll for completion
    let result;
    while (true) {
      const getResponse = await fetch(`${MIDJOURNEY_API_ENDPOINT}${imageId}`, {
        headers: {
          Authorization: `Bearer ${process.env.MIDJOURNEY_API_KEY}`,
          "Content-Type": "application/json",
        },
      });

      if (!getResponse.ok) {
        throw new Error(`Failed to get status: ${getResponse.statusText}`);
      }

      const getData = await getResponse.json();
      const status = getData.data.status;

      if (status === "completed") {
        result = getData.data;
        break;
      } else if (status === "failed") {
        throw new Error("Generation failed");
      }

      // Wait 5 seconds before next poll
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Select the first upscaled image URL (Midjourney generates variations)
    const imageUrl = result.upscaled_urls?.[0];
    if (!imageUrl) {
      throw new Error("No upscaled image URL available");
    }

    const filePath = path.join(
      IMAGE_DIR,
      `scene_${String(index).padStart(3, "0")}.png`
    );
    await downloadImage(imageUrl, filePath);
    console.log(`✅ Image saved: ${filePath}`);
    return filePath;
  } catch (err) {
    console.error("❌ Image generation failed:", err.message);
    throw err;
  }
}
