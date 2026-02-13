import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

if (process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
  // Prevent SDK conflict
  delete process.env.GOOGLE_API_KEY;
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Extraction Logic (Identity & Environment Focus)
 * Analyzes story text to identify specific visual constraints.
 */
export async function extractStoryMetadata(storyText) {
  const prompt = `
    Analyze the following story text and extract visual metadata for cinematic generation.
    Focus on physical identity, environment, and specific physical reactions.

    Extraction Rules:
    - The Demographic Lock: Identify the specific race, ethnicity, and sex of the protagonist as explicitly stated or culturally implied.
    - The Environmental Reflection: Direct visual extension of the setting (flora, architecture, lighting, era).
    - The Physicality: Pinpoint the exact physical reaction (clenched jaw, shaking hand, eyes reflecting fire).
    - The Story Anchor: A specific object or environmental detail that must be in the immediate foreground.
    - The Sensory Detail: Texture (damp skin, rusted metal, velvet) that reinforces the setting.

    Story: ${storyText}

    Return the result as JSON with keys: demographic, environment, physicality, anchor, texture.
    Return ONLY JSON.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    let text = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
    // Clean JSON if needed
    text = text.replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (err) {
    console.error("❌ Failed to extract story metadata:", err);
    return {
      demographic: "A person matching the story's context",
      environment: "A setting accurate to the narrative",
      physicality: "A natural reaction",
      anchor: "An object from the story",
      texture: "Realistic textures",
    };
  }
}

/**
 * Generates the Universal Story-to-Cover Master Prompts (v5.0)
 */
export function generateMasterPrompts(metadata, title, aspectRatio = "16:9") {
  const { demographic, environment, physicality, anchor, texture } = metadata;

  // [PROMPT 1: THE 1:1 ICONIC POSTER]
  const prompt1 = `
    A high-impact 1:1 iconic poster featuring an extreme close-up (ECU) of the central character, focusing on the raw emotional peak.
    Character Identity: ${demographic}. Features must be rendered with absolute accuracy to the narrative.
    Physical Action: ${physicality}.
    Shot Detail: 85mm lens compression, making the subject feel intimate and physically close. Every pore, bead of sweat, and individual hair is crisp and tactile with ${texture} texture.
    Background: ${environment}. The environment subtly reflects the specific textures, architecture, or lighting.
    Lighting: Intense cinematic "Key Lighting" that casts deep, dramatic shadows, highlighting the contours of the face.
    Typography: Bold, stylized 3D typography for the title "${title}" is placed with a "shallow depth of field," allowing it to sit naturally within the scene's atmosphere. STRICT RULE: Use the title exactly as provided.
    Aesthetic: Hyper-saturated colors reflecting the specific mood of the written narrative.
  `.trim();

  // [PROMPT 2: THE 16:9 CINEMATIC WIDE-CLOSE]
  const prompt2 = `
    A breathtaking 16:9 cinematic "Medium-Close" shot prioritizing immersive detail.
    Character Identity: ${demographic}, in the immediate foreground reacting to the story's climax with ${physicality}.
    Story Anchor: ${anchor} must be in the immediate foreground.
    Environmental Storytelling: ${environment}. Detailed, hyper-realistic. Every light source and reflection must be grounded in the world.
    Aesthetic: High-saturation color grading with "Anamorphic" lens flares and heavy "Bokeh" (background blur).
    Technical: Hyper-realistic textures with electric luminescence and ray-traced reflections. Feeling of a high-budget film still.
    Constraint: STRICTLY NO TEXT, words, or letters.
  `.trim();

  return { poster: prompt1, cinematic: prompt2 };
}
