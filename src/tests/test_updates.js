import { config } from "../config/workflow.config.js";
import { sfxElevenLabs } from "../services/generateVoiceoverService.js";
import { generateBackgroundMusic } from "../services/generateBackgroundMusicService.js";
import fs from "fs";
import path from "path";

async function runTests() {
  console.log("==========================================");
  console.log("🧪 STORYWAVE SYSTEM VERIFICATION TEST SUITE");
  console.log("==========================================\n");

  let passed = 0;
  let total = 0;

  function assert(condition, message) {
    total++;
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
    }
  }

  // 1. Verify Config & Model Tiers
  console.log("--- 1. Testing Config & OpenAI Model Tiers ---");
  assert(config.ai.openai.complexAnalysisModel === "gpt-5.6-terra", "Complex Analysis Model is gpt-5.6-terra");
  assert(config.ai.openai.promptCreationModel === "gpt-5.6-terra", "Prompt Creation Model is gpt-5.6-terra");
  assert(config.ai.openai.simpleTaskModel === "gpt-5.6-luna", "Simple Task Model is gpt-5.6-luna");
  assert(config.ai.image.primaryModel === "gemini-3-pro-image", "Primary Image Model is gemini-3-pro-image");
  assert(config.ai.image.fallbackModel === "gemini-3.1-flash-image-preview", "Fallback Image Model is gemini-3.1-flash-image-preview");
  assert(config.ai.image.openaiRepairModel === "gpt-5.6-luna", "OpenAI Repair Model is gpt-5.6-luna");

  // 2. Verify Strategy 4 SFX Canonical Key Caching
  console.log("\n--- 2. Testing Strategy 4 SFX Canonical Key Caching ---");
  const cacheDir = path.join(process.cwd(), "public", "sfx_cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const testFile = path.join(cacheDir, "gunshot.mp3");
  const dummyBuffer = Buffer.from("dummy-sfx-audio-content");
  fs.writeFileSync(testFile, dummyBuffer);

  const resBuffer = await sfxElevenLabs("heavy gunshot in dark room");
  assert(resBuffer.toString() === "dummy-sfx-audio-content", "SFX hit canonical key cache ('gunshot') without API call");

  fs.unlinkSync(testFile);

  // 3. Verify Strategy 4 Background Music Caching
  console.log("\n--- 3. Testing Strategy 4 Background Music Caching ---");
  const bgCacheDir = path.join(process.cwd(), "public", "bg_music_cache");
  fs.mkdirSync(bgCacheDir, { recursive: true });

  const bgTestFile = path.join(bgCacheDir, "bg_true_crime.mp3");
  const dummyBgBuffer = Buffer.from("dummy-bg-audio-content");
  fs.writeFileSync(bgTestFile, dummyBgBuffer);

  const tempDir = path.join(process.cwd(), "temp_test");
  fs.mkdirSync(tempDir, { recursive: true });

  const resultPath = await generateBackgroundMusic({
    title: "Test True Crime Story",
    storyType: "true_crime_fiction_cinematic",
    tempDir,
  });

  assert(resultPath && fs.existsSync(resultPath), "BGM service returned a valid track path");
  if (resultPath) {
    const readContent = fs.readFileSync(resultPath).toString();
    assert(readContent === "dummy-bg-audio-content", "BGM hit Strategy 4 local cache ('bg_true_crime.mp3') without Suno API call");
    if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
  }
  if (fs.existsSync(bgTestFile)) fs.unlinkSync(bgTestFile);
  fs.rmSync(tempDir, { recursive: true, force: true });

  console.log("\n==========================================");
  console.log(`📊 TEST RESULTS: ${passed}/${total} PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log("==========================================");

  if (passed !== total) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});

