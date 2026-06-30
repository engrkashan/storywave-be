import fs from "fs";
import path from "path";
import { createMultiMediaVideo } from "../src/services/videoService.js";

async function stitchManual() {
  // Grab the folder path from command line arguments
  const targetDir = process.argv[2];
  
  if (!targetDir || !fs.existsSync(targetDir)) {
    console.error("❌ Please provide a valid directory path.");
    console.error("Usage: node scripts/manual_stitch.js /var/www/storywave-be/temp/YOUR_ID");
    process.exit(1);
  }

  try {
    // 1. Identify the aspect ratio folder (16_9 or 9_16)
    const ratioFolder = fs.existsSync(path.join(targetDir, "16_9")) ? "16_9" : 
                        fs.existsSync(path.join(targetDir, "9_16")) ? "9_16" : null;
    
    if (!ratioFolder) {
      throw new Error("Could not find a 16_9 or 9_16 folder containing the images.");
    }

    const aspectRatio = ratioFolder === "16_9" ? "16:9" : "9:16";

    // 2. Gather images
    const imagesDir = path.join(targetDir, ratioFolder);
    const mediaItems = fs.readdirSync(imagesDir)
      .filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.mp4'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) // Sort naturally
      .map(f => path.join(imagesDir, f));

    if (mediaItems.length === 0) throw new Error("No images found in the ratio folder.");

    // 3. Find Audio (Prioritize mixed audio)
    const filesInTemp = fs.readdirSync(targetDir);
    const mixedAudio = filesInTemp.find(f => f.startsWith("mixed-") && f.endsWith(".mp3"));
    const rawAudio = filesInTemp.find(f => f.endsWith(".mp3") && !f.startsWith("mixed-") && !f.startsWith("bg-music"));
    const audioPath = path.join(targetDir, mixedAudio || rawAudio);

    if (!mixedAudio && !rawAudio) throw new Error("No primary audio (.mp3) found.");

    // 4. Find SRT
    const srtFile = filesInTemp.find(f => f.endsWith(".srt"));
    let srtPath = srtFile ? path.join(targetDir, srtFile) : null;
    
    if (!srtPath) {
      console.warn("⚠️ No SRT file found in root! Checking inside image folder...");
      const srtInFolder = fs.readdirSync(imagesDir).find(f => f.endsWith(".srt"));
      srtPath = srtInFolder ? path.join(imagesDir, srtInFolder) : null;
      if (!srtPath) {
         console.warn("⚠️ No SRT file found anywhere! Subtitles will be skipped or may crash if required by logic.");
      }
    }

    // 5. Output Path
    const outputPath = path.join(targetDir, "final_stitched_video.mp4");

    console.log(`🎬 Initiating Manual Stitch for ${mediaItems.length} items...`);
    console.log(`- Aspect Ratio: ${aspectRatio}`);
    console.log(`- Audio: ${audioPath}`);
    console.log(`- Subtitles: ${srtPath}`);
    console.log(`- Output: ${outputPath}`);

    await createMultiMediaVideo(mediaItems, audioPath, outputPath, srtPath, aspectRatio);

    console.log(`✅ Success! Video saved to: ${outputPath}`);
  } catch (error) {
    console.error("❌ Stitching Failed:", error);
  }
}

stitchManual();
