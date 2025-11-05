import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TEMP_DIR = path.join(process.cwd(), "temp", "images");
fs.mkdirSync(TEMP_DIR, { recursive: true });

// Simple prompt sanitizer: remove words likely to trigger safety system
function sanitizePrompt(prompt) {
  const blockedWords = [
    "sex", "nudity", "violence", "gore", "abuse", "drugs", "weapon"
  ];
  let sanitized = prompt;
  blockedWords.forEach((word) => {
    const regex = new RegExp(word, "gi");
    sanitized = sanitized.replace(regex, "[REDACTED]");
  });
  return sanitized;
}

export async function generateImage(prompt, index, maxRetries = 3) {
  let attempt = 0;
  let lastError = null;
  let currentPrompt = prompt;

  while (attempt < maxRetries) {
    attempt++;
    try {
      const result = await openai.images.generate({
        model: "gpt-image-1",
        prompt: currentPrompt,
        size: "1024x1024",
        quality: "high",
      });

      const imageBase64 = result.data?.[0]?.b64_json;

      if (!imageBase64) {
        const errorMessage = result.data?.[0]?.error?.message || "No image data returned";
        if (errorMessage.includes("safety system")) {
          console.log(`⚠️ Safety system triggered, sanitizing prompt and retrying (Attempt ${attempt})`);
          currentPrompt = sanitizePrompt(currentPrompt);
          continue; // retry
        }
        throw new Error("Image generation failed: " + errorMessage);
      }

      // Success
      const buffer = Buffer.from(imageBase64, "base64");
      const filename = `scene_${String(index).padStart(3, "0")}.png`;
      const filePath = path.join(TEMP_DIR, filename);

      fs.writeFileSync(filePath, buffer);

      console.log(`🖼️ Image saved: ${filePath}`);
      return filePath;

    } catch (err) {
      lastError = err;
      console.warn(`Attempt ${attempt} failed: ${err.message}`);
      currentPrompt = sanitizePrompt(currentPrompt);
    }
  }

  // If all retries fail
  throw new Error(`Image generation failed after ${maxRetries} attempts: ${lastError.message}`);
}
