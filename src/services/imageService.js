import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateImage(prompt, index = 1) {
  const result = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size: "1024x1024",
    // response_format: "b64_json", 
  });

  // Prefer base64 to avoid `undefined` URLs
  const imageBase64 = result.data[0].b64_json;
  if (!imageBase64) {
    throw new Error("Image generation failed: no data returned from OpenAI");
  }

  const buffer = Buffer.from(imageBase64, "base64");

  const imagesDir = path.join(process.cwd(), "public", "images");
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  const filename = `frame_${String(index).padStart(3, "0")}.png`;
  const filePath = path.join(imagesDir, filename);

  fs.writeFileSync(filePath, buffer);
  return filePath;
}
