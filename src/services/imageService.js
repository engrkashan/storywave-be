import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateImage(prompt, index = 1) {
    const result = await openai.images.generate({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024"
    });

    const imageUrl = result.data[0].url;

    // Save locally for ffmpeg
    const response = await fetch(imageUrl);
    const buffer = await response.arrayBuffer();

    const imagesDir = path.join(process.cwd(), "public", "images");
    if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
    }

    const filename = `frame_${String(index).padStart(3, "0")}.png`;
    const filePath = path.join(imagesDir, filename);

    fs.writeFileSync(filePath, Buffer.from(buffer));
    return filePath;
}
