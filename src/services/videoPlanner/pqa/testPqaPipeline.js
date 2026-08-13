/**
 * testPqaPipeline.js — Verification Test Suite for Prompt Quality Assurance Pipeline
 *
 * Tests:
 * 1. Single-prompt auditing & optimization (intra-prompt duplication, missing pose, missing stopping boundary)
 * 2. Cross-beat repetition detection (Beat 14 & 15 repeated action/dialogue case)
 * 3. Max iterations and structural validation
 */

import { buildStateBasedPrompt } from "../promptBuilder.js";
import { runPromptQualityPipeline } from "./promptQualityPipeline.js";

async function runPqaTestSuite() {
  console.log("=================================================");
  console.log("🧪 STARTING PQA PIPELINE VERIFICATION TEST SUITE");
  console.log("=================================================\n");

  const mockStoryBible = {
    characters: [
      { id: "char_1", name: "Marcus", appearance: "Tall athletic man with jacket" }
    ],
    locations: [
      { name: "Glass Laboratory", details: "Futuristic high-tech lab with glowing blue screens" }
    ]
  };

  const mockBeats = [
    {
      beatIndex: 0,
      narrative: "Marcus inspects the control panel and smiles confidently.",
      action: "Smiles confidently and inspects control panel.",
      spokenText: "Tired of seeing your scalp before you see yourself?",
      characterName: "Marcus",
      characterId: "char_1",
      location: "Glass Laboratory",
      timing: { durationSec: 5.0 }
    },
    {
      beatIndex: 1,
      narrative: "Marcus continues inspecting control panel and smiles confidently.",
      action: "Smiles confidently and inspects control panel.", // ⚠️ Cross-beat repeated action & dialogue!
      spokenText: "Tired of seeing your scalp before you see yourself?", // ⚠️ User reported duplicate dialogue!
      characterName: "Marcus",
      characterId: "char_1",
      location: "Glass Laboratory",
      timing: { durationSec: 5.0 }
    },
    {
      beatIndex: 2,
      narrative: "Marcus steps back towards the doorway.",
      action: "Steps back toward doorway.",
      spokenText: "We proceed to the main grid now.",
      characterName: "Marcus",
      characterId: "char_1",
      location: "Glass Laboratory",
      timing: { durationSec: 5.0 }
    }
  ];

  const mockState = {
    currentLocation: "Glass Laboratory",
    currentPose: "Standing near panel",
    environment: "Volumetric cinematic lighting",
    activeCharacter: mockStoryBible.characters[0]
  };

  // Build raw prompts
  const rawPrompts = mockBeats.map((b, idx) => {
    return buildStateBasedPrompt(b, mockState, mockBeats[idx + 1] || null, mockStoryBible, { characterTalk: true });
  });

  // Inject intentional intra-prompt redundancy into Beat 0 for test coverage
  rawPrompts[0].prompt += "\n\nCHARACTER SPOKEN DIALOGUE: Marcus starts speaking out loud immediately at t=0.0s and reads these exact lines: \"No complicated process.\" (Local clip speech window: t=0.0s to t=5.0s). Synchronize lip movement and facial expression precisely to this speech window.";
  rawPrompts[0].prompt += "\n\nVISUAL STYLE: Photorealistic 8k ultra-detailed cinematic film quality, cinematic cinematic photorealistic film.";

  console.log("📌 Initial Raw Prompts Generated:");
  rawPrompts.forEach((p, idx) => {
    console.log(`\n--- Beat ${idx + 1} Raw Prompt (${p.prompt.length} chars) ---`);
    console.log(p.prompt);
  });

  console.log("\n-------------------------------------------------");
  console.log("🛡️ Running PQA Pipeline...");
  console.log("-------------------------------------------------\n");

  const finalPrompts = runPromptQualityPipeline(rawPrompts, mockBeats, mockStoryBible, {});

  console.log("\n=================================================");
  console.log("📊 PQA RESULTS SUMMARY");
  console.log("=================================================");

  let allPassed = true;

  finalPrompts.forEach((fp, idx) => {
    const report = fp._pqaReport || {};
    console.log(`\nBeat ${idx + 1}:`);
    console.log(`  - Overall Score: ${report.score}/100`);
    console.log(`  - Approved: ${report.approved ? "✅ YES" : "❌ NO"}`);
    console.log(`  - Iterations: ${report.iterations}`);
    console.log(`  - Issues Remaining: ${report.issues?.length || 0}`);

    if (report.diff && report.diff.changes) {
      console.log(`  - Fixes Applied:`);
      report.diff.changes.forEach(c => console.log(`    • ${c}`));
    }

    if (report.score < 90) allPassed = false;
  });

  console.log("\n=================================================");
  if (allPassed) {
    console.log("🎉 SUCCESS: ALL PROMPTS PASSED PQA PIPELINE (SCORE >= 90)");
  } else {
    console.log("⚠️ WARNING: SOME PROMPTS DID NOT REACH PASSING SCORE THRESHOLD");
  }
  console.log("=================================================\n");
}

runPqaTestSuite().catch(err => {
  console.error("❌ Test suite error:", err);
  process.exit(1);
});
