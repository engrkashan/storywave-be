import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TEMP_DIR = path.join(process.cwd(), "temp", "images");
fs.mkdirSync(TEMP_DIR, { recursive: true });

// Simple prompt sanitizer
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

// Limit rewriting depth and detect when prompt stops changing
async function ensurePromptSafe(prompt, maxDepth = 3) {
  let currentPrompt = sanitizePrompt(prompt);
  let lastPrompt = "";

  for (let level = 1; level <= maxDepth; level++) {
    const mod = await openai.moderations.create({
      model: "omni-moderation-latest",
      input: currentPrompt,
    });

    if (!mod.results?.[0]?.flagged) {
      return currentPrompt;
    }

    console.log(`⚠️ Prompt flagged at level ${level}, rewriting...`);
    const rewritten = await rewritePrompt(currentPrompt, level);

    // If model produces same text again, stop looping
    if (rewritten.trim() === lastPrompt.trim()) {
      console.log("🚫 Prompt unchanged after rewrite, forcing safe fallback.");
      return sanitizePrompt(rewritten);
    }

    lastPrompt = currentPrompt;
    currentPrompt = rewritten;
  }

  console.log("✅ Returning maximum-safe sanitized prompt.");
  return sanitizePrompt(currentPrompt);
}

// Small delay helper to avoid rapid looping
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateImage(prompt, index, maxRetries = 5) {
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
          if (
            lowerMsg.includes("safety") ||
            lowerMsg.includes("content policy") ||
            lowerMsg.includes("prompt")
          ) {
            console.log("⚠️ Prompt-related error triggered. Retrying safely...");
            safePrompt = await ensurePromptSafe(safePrompt);
            await sleep(1000); // prevent tight retry loop
            continue;
          } else {
            throw new Error(errorMessage);
          }
        }
        throw new Error("No image data returned");
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
      const msg = err.message?.toLowerCase() || "";
      if (
        msg.includes("safety") ||
        msg.includes("content policy") ||
        msg.includes("prompt")
      ) {
        console.log(`⚠️ Attempt ${attempt}: safety issue, rewriting prompt.`);
        safePrompt = await ensurePromptSafe(safePrompt);
        await sleep(1000);
        continue;
      } else if (
        msg.includes("quota") ||
        msg.includes("rate limit") ||
        err.status === 429
      ) {
        console.log("⏳ Rate limit or quota issue, aborting retries.");
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
