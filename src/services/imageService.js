import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TEMP_DIR = path.join(process.cwd(), "temp", "images");
fs.mkdirSync(TEMP_DIR, { recursive: true });

// Simple prompt sanitizer: remove words likely to trigger safety system
function sanitizePrompt(prompt) {
  const blockedWords = [
    "sex",
    "nudity",
    "violence",
    "gore",
    "abuse",
    "drugs",
    "weapon",
  ];
  let sanitized = prompt;
  blockedWords.forEach((word) => {
    const regex = new RegExp(word, "gi");
    sanitized = sanitized.replace(regex, "[REDACTED]");
  });
  return sanitized;
}

// export async function generateImage(prompt, index, maxRetries = Infinity) {
//   let attempt = 0;
//   let lastError = null;
//   let currentPrompt = prompt;

//   while (attempt < maxRetries) {
//     attempt++;
//     try {
//       const result = await openai.images.generate({
//         model: "gpt-image-1",
//         prompt: currentPrompt,
//         size: "1024x1024",
//         quality: "high",
//       });

//       const imageBase64 = result.data?.[0]?.b64_json;

//       if (!imageBase64) {
//         const errorMessage = result.data?.[0]?.error?.message || "No image data returned";
//         if (errorMessage.includes("safety system")) {
//           console.log(`⚠️ Safety system triggered, sanitizing prompt and retrying (Attempt ${attempt})`);
//           currentPrompt = sanitizePrompt(currentPrompt);
//           continue; // retry
//         }
//         throw new Error("Image generation failed: " + errorMessage);
//       }

//       // Success
//       const buffer = Buffer.from(imageBase64, "base64");
//       const filename = `scene_${String(index).padStart(3, "0")}.png`;
//       const filePath = path.join(TEMP_DIR, filename);

//       fs.writeFileSync(filePath, buffer);

//       console.log(`🖼️ Image saved: ${filePath}`);
//       return filePath;

//     } catch (err) {
//       lastError = err;
//       console.warn(`Attempt ${attempt} failed: ${err.message}`);
//       currentPrompt = sanitizePrompt(currentPrompt);
//     }
//   }

//   // If all retries fail
//   throw new Error(`Image generation failed after ${maxRetries} attempts: ${lastError.message}`);
// }

async function rewritePrompt(prompt, level = 1) {
  const systemMessage = {
    1: "Rewrite the prompt to remove anything that violates image safety policies (violence, adult content, gore, minors in risky situations, political figures, hate, self-harm, drugs, weapons). Keep theme and mood.",
    2: "Rewrite the prompt in a strictly safe form. Remove any people if needed. Preserve setting, atmosphere, colors, objects.",
    3: "Rewrite the prompt in a maximum-safe version. Only describe scenery, mood, objects or environments. No humans. Keep the general vibe of the story without referencing unsafe elements.",
  };

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemMessage[level] },
      { role: "user", content: prompt },
    ],
  });

  return res.choices[0].message.content.trim();
}

async function ensurePromptSafe(prompt) {
  // First moderation scan
  let mod = await openai.moderations.create({
    model: "omni-moderation-latest",
    input: prompt,
  });

  if (!mod.results?.[0]?.flagged) return prompt;

  // Rewrite level 1
  let rewritten = await rewritePrompt(prompt, 1);

  // Check again
  mod = await openai.moderations.create({
    model: "omni-moderation-latest",
    input: rewritten,
  });
  if (!mod.results?.[0]?.flagged) return rewritten;

  // Rewrite level 2 (stricter)
  rewritten = await rewritePrompt(rewritten, 2);

  mod = await openai.moderations.create({
    model: "omni-moderation-latest",
    input: rewritten,
  });
  if (!mod.results?.[0]?.flagged) return rewritten;

  // Final rewrite level 3 (maximum safe)
  rewritten = await rewritePrompt(rewritten, 3);

  return rewritten; // guaranteed safe
}

export async function generateImage(prompt, index, maxRetries = 10) {
  let attempt = 0;
  let safePrompt = await ensurePromptSafe(prompt);
  let lastError = null;

  while (attempt < maxRetries) {
    attempt++;

    try {
      const result = await openai.images.generate({
        model: "gpt-image-1",
        prompt: safePrompt,
        size: "1024x1024",
        quality: "high",
      });

      const base64 = result.data?.[0]?.b64_json;
      const err = result.data?.[0]?.error?.message;

      if (!base64) {
        if (err?.includes("safety")) {
          console.log("⚠️ Safety triggered again. Forcing strict rewrite.");
          safePrompt = await ensurePromptSafe(safePrompt);
          continue;
        }
        throw new Error(err || "No image data returned");
      }

      // Save file
      const buffer = Buffer.from(base64, "base64");
      const filename = `scene_${String(index).padStart(3, "0")}.png`;
      const filePath = path.join(TEMP_DIR, filename);

      fs.writeFileSync(filePath, buffer);
      console.log(`✅ Image saved: ${filePath}`);
      return filePath;
    } catch (err) {
      lastError = err;
      console.log(`Attempt ${attempt} failed: ${err.message}`);
      safePrompt = await ensurePromptSafe(safePrompt);
    }
  }

  throw new Error(
    `Image generation failed after ${maxRetries} attempts: ${lastError?.message}`
  );
}
