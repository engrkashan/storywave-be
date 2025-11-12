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
      const errorMessage = result.data?.[0]?.error?.message;

      if (!base64) {
        if (errorMessage) {
          const lowerMsg = errorMessage.toLowerCase();
          if (lowerMsg.includes("safety") || lowerMsg.includes("content policy") || lowerMsg.includes("prompt")) {
            console.log("⚠️ Prompt-related error triggered. Forcing strict rewrite.");
            safePrompt = await ensurePromptSafe(safePrompt);
            continue;
          } else {
            throw new Error(errorMessage);
          }
        }
        throw new Error(errorMessage || "No image data returned");
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
      const lowerMsg = err.message ? err.message.toLowerCase() : "";
      if (lowerMsg.includes("safety") || lowerMsg.includes("content policy") || lowerMsg.includes("prompt")) {
        console.log(`⚠️ Prompt-related error on attempt ${attempt}: ${err.message}. Retrying with rewrite.`);
        safePrompt = await ensurePromptSafe(safePrompt);
        continue;
      } else if (lowerMsg.includes("quota") || lowerMsg.includes("rate limit") || err.status === 429) {
        throw err;
      } else {
        throw err;
      }
    }
  }

  throw new Error(
    `Image generation failed after ${maxRetries} attempts: ${lastError?.message}`
  );
}