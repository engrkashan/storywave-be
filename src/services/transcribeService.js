import OpenAI from "openai";
import fs from "fs";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Transcribes a local audio file and returns the content in SRT format
 * using OpenAI's Whisper API.
 *
 * @param {string} audioPath - Path to the local MP3 audio file.
 * @returns {Promise<string>} The transcription result in SRT format (a string).
 */
export async function transcribeWithTimestamps(audioPath) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found at path: ${audioPath}`);
  }

  try {
    console.log("🗣️ Calling Whisper API for SRT transcription...");

    // The file is read as a stream
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
      response_format: "srt", // Requesting SRT format directly
    });

    // The result is the SRT content as a string
    return transcription;
  } catch (error) {
    console.error("❌ Whisper API Transcription Error:", error.message);
    throw new Error("Failed to generate SRT via Whisper API.");
  }
}
