import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function generateImage(prompt, index = 1) {
    const result = await openai.images.generate({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024"
    });
    return result.data[0].url;
}
