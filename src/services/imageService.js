import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ensure temp folders exist
const TEMP_DIR = path.join(process.cwd(), "temp");
const IMAGE_DIR = path.join(TEMP_DIR, "images");
fs.mkdirSync(IMAGE_DIR, { recursive: true });

// Basic sanitizer
function sanitizePrompt(prompt) {
  const blocked = [
    "sex", "nudity", "violence", "gore", "abuse",
    "drugs", "weapon", "blood", "kill", "murder"
  ];
  let sanitized = prompt;
  for (const w of blocked) {
    sanitized = sanitized.replace(new RegExp(w, "gi"), "[REDACTED]");
  }
  return sanitized;
}

// One-time rewrite if moderation flags it
async function makeSafePrompt(prompt) {
  const sanitized = sanitizePrompt(prompt);

  const mod = await openai.moderations.create({
    model: "omni-moderation-latest",
    input: sanitized,
  });

  const flagged = mod.results?.[0]?.flagged;
  if (!flagged) return sanitized;

  console.log("⚠️ Prompt flagged — rewriting safely...");
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Rewrite the user prompt in a fully safe, non-violent, non-explicit way. Keep same theme or mood but avoid unsafe or sensitive content.",
      },
      { role: "user", content: sanitized },
    ],
  });

  const rewritten = response.choices[0].message.content.trim();
  return sanitizePrompt(rewritten);
}

export async function generateImage(prompt, index = 1) {
  try {
    const safePrompt = await makeSafePrompt(prompt);
    console.log("✅ Safe prompt:", safePrompt);
    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt: safePrompt,
      size: "1024x1024",
      quality: "high",
    });

    const base64 = result.data?.[0]?.b64_json;
    if (!base64) throw new Error("No image data returned");

    const filePath = path.join(IMAGE_DIR, `scene_${String(index).padStart(3, "0")}.png`);
    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    console.log(`✅ Image saved: ${filePath}`);
    return filePath;

  } catch (err) {
    console.error("❌ Image generation failed:", err.message);
    throw err;
  }
}
