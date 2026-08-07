/**
 * test-video-planner-pipeline.js
 *
 * Comprehensive integration test for the Video Planner + PQA pipeline.
 * Runs a 30-second story through every stage up to prompt generation.
 * Does NOT call any image/video generation APIs.
 *
 * Run with:  node --experimental-vm-modules test-video-planner-pipeline.js
 *        OR: node src/tests/test-video-planner-pipeline.js  (from storywave-be root)
 *
 * Requires .env to be loaded (uses OPENAI_API_KEY for narrativeTimeline LLM call).
 */

import "dotenv/config";
import { buildUnifiedSpeechTimeline, allocateSpeechToBeats } from "../services/videoPlanner/speechTimelineService.js";
import { generateNarrativeTimeline } from "../services/videoPlanner/narrativeTimelineService.js";
import { planAtomicBeats } from "../services/videoPlanner/atomicBeatPlanner.js";
import { planBeatDurations } from "../services/videoPlanner/durationPlanner.js";
import { allocateSpeechToBeats as speechAllocate } from "../services/videoPlanner/speechTimelineService.js";
import { validateBeatContinuity } from "../services/videoPlanner/promptValidator.js";
import { initializeSceneState, updateSceneState } from "../services/videoPlanner/sceneStateEngine.js";
import { buildStateBasedPrompt } from "../services/videoPlanner/promptBuilder.js";
import { runPromptQualityPipeline, processSinglePromptPqa } from "../services/videoPlanner/pqa/promptQualityPipeline.js";
import { PromptHistoryTracker } from "../services/videoPlanner/pqa/promptHistoryTracker.js";
import { auditPrompt } from "../services/videoPlanner/pqa/promptAuditor.js";
import { calculatePromptScore } from "../services/videoPlanner/pqa/promptScorer.js";
import { initializeSceneState as initScene } from "../services/videoPlanner/sceneStateEngine.js";

// ─── ANSI colors for terminal output ──────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  bgDark: "\x1b[40m",
};

function section(title) {
  console.log(`\n${C.bold}${C.cyan}${"═".repeat(70)}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`);
  console.log(`${C.bold}${C.cyan}${"═".repeat(70)}${C.reset}`);
}

function step(num, label) {
  console.log(`\n${C.bold}${C.blue}  ▶ STEP ${num}: ${label}${C.reset}`);
}

function ok(label, value) {
  const val = typeof value !== "undefined" ? ` → ${C.white}${value}${C.reset}` : "";
  console.log(`    ${C.green}✓${C.reset} ${label}${val}`);
}

function warn(label, value) {
  const val = typeof value !== "undefined" ? ` → ${C.yellow}${value}${C.reset}` : "";
  console.log(`    ${C.yellow}⚠${C.reset} ${label}${val}`);
}

function fail(label, value) {
  const val = typeof value !== "undefined" ? ` → ${C.red}${value}${C.reset}` : "";
  console.log(`    ${C.red}✗${C.reset} ${label}${val}`);
}

function info(label) {
  console.log(`    ${C.dim}${label}${C.reset}`);
}

function printPromptPreview(prompt, maxLen = 350) {
  const preview = typeof prompt === "string" ? prompt.substring(0, maxLen) : "(empty)";
  const truncated = typeof prompt === "string" && prompt.length > maxLen;
  console.log(`${C.dim}${C.bgDark}    ┌${"─".repeat(68)}┐`);
  const lines = preview.split("\n").flatMap(l => {
    const words = l.split(/\s+/);
    const rows = [];
    let row = "";
    for (const w of words) {
      if ((row + " " + w).trim().length > 65) { rows.push(row.trim()); row = w; }
      else row += (row ? " " : "") + w;
    }
    if (row) rows.push(row.trim());
    return rows.length ? rows : [""];
  });
  for (const l of lines) console.log(`    │ ${l.padEnd(66)} │`);
  if (truncated) console.log(`    │ ${"... (truncated)".padEnd(66)} │`);
  console.log(`    └${"─".repeat(68)}┘${C.reset}`);
}

// ─── TEST DATA ────────────────────────────────────────────────────────────────

const TEST_SCRIPT = `
Marcus Chen, a seasoned detective, steps out of his unmarked police car and stares at the abandoned warehouse ahead. 
The building looms against the stormy night sky, rain falling in heavy sheets. 
He pulls his badge from his coat pocket and checks it briefly, then tucks it back. 
Marcus walks toward the rusted front door, hand moving to his holster. 
He pushes the door open slowly and steps inside, scanning the dark interior with his flashlight. 
The beam catches movement in the corner — a figure crouching behind old wooden crates. 
Marcus shouts: "Police! Don't move! Show me your hands right now!" 
The figure slowly stands, raising both hands above their head. 
It's a young woman, terrified, barely nineteen years old, wearing a torn jacket. 
Marcus lowers his flashlight slightly and walks toward her carefully.
`.trim();

const TEST_STORY_BIBLE = {
  synopsis: "A hardened detective discovers an unexpected truth during a late-night warehouse investigation.",
  characters: [
    {
      id: "char_001",
      name: "Marcus Chen",
      role: "Detective protagonist",
      appearance: "Mid-40s East Asian man, sharp angular face, greying temples",
      // MGE materialized fields (Fix I-3 reads these)
      sketch_artist_appearance: {
        age_range: "mid-40s",
        gender_presentation: "male",
        face_structure: "angular jaw, prominent cheekbones",
        hair: "black with grey at temples, short cropped",
        canonical_skin_tone: "medium warm olive",
        permanent_identifiers: "thin scar on left eyebrow",
      },
      identity_culture: { race: "East Asian" },
      base_clothing: "dark navy coat over charcoal suit, black turtleneck, worn leather dress shoes",
    },
    {
      id: "char_002",
      name: "Young Woman",
      role: "Witness",
      appearance: "Nineteen-year-old woman, frightened expression, torn jacket",
      base_clothing: "torn denim jacket, dark jeans, sneakers",
    },
  ],
  locations: [
    {
      id: "loc_001",
      name: "Abandoned Warehouse",
      description: "Derelict industrial warehouse on the city outskirts",
      // MGE materialized fields (Fix I-4 reads these)
      full_standalone_description: "Large disused industrial warehouse, corrugated metal walls, broken skylights, rain pooling on cracked concrete floors, dim emergency lighting flickering in far corners",
      geographic_cultural_id: { city_district: "Harbor Industrial District, south waterfront" },
    },
    {
      id: "loc_002",
      name: "Warehouse Interior",
      full_description: "Dark cavernous interior with wooden crates, rusted machinery, shadows, flashlight beams cutting through dust motes",
    },
  ],
};

// Simulated Whisper word timestamps for 30-second narration (~75 words, ~0.4s/word)
const TEST_WHISPER_WORDS = TEST_SCRIPT.split(/\s+/).map((word, i) => ({
  word: word.replace(/[.,!?]/g, ""),
  start: i * 0.38,
  end: (i + 1) * 0.38,
}));

// ─── MAIN TEST RUNNER ─────────────────────────────────────────────────────────

async function runTest() {
  section("STORYWAVE VIDEO PLANNER + PQA PIPELINE — INTEGRATION TEST");
  console.log(`  Script length: ${TEST_SCRIPT.split(/\s+/).length} words`);
  console.log(`  Story: ${TEST_STORY_BIBLE.synopsis}`);
  console.log(`  Characters: ${TEST_STORY_BIBLE.characters.map(c => c.name).join(", ")}`);
  console.log(`  Target duration: ~30 seconds → ~6 scenes @ 5s each`);

  const TARGET_SCENE_COUNT = 6;
  const TOTAL_AUDIO_DURATION = 30.0;
  const results = {
    passed: [],
    failed: [],
    warnings: [],
  };

  // ──────────────────────────────────────────────────────────────────────────
  step(1, "buildUnifiedSpeechTimeline — Whisper Word-Level Timeline");
  // ──────────────────────────────────────────────────────────────────────────

  let speechTimeline;
  try {
    speechTimeline = buildUnifiedSpeechTimeline(
      TEST_SCRIPT,
      TEST_WHISPER_WORDS,
      TEST_STORY_BIBLE,
      { characterTalk: false }
    );

    ok("Speech timeline built", `${speechTimeline.segments.length} segments`);
    ok("Total duration", `${speechTimeline.totalDuration.toFixed(2)}s`);
    ok("Total words", speechTimeline.totalWords);

    // Check each segment has required fields
    let segOk = 0, segFail = 0;
    for (const seg of speechTimeline.segments) {
      if (seg.segmentId && seg.text && seg.startSec >= 0 && seg.durationSec > 0) segOk++;
      else segFail++;
    }
    if (segFail === 0) ok(`All ${segOk} segments valid`, "segmentId, text, startSec, durationSec ✓");
    else fail(`${segFail} segments missing required fields`);

    // Show first 2 segments
    for (const s of speechTimeline.segments.slice(0, 2)) {
      info(`  [${s.segmentId}] "${s.text.substring(0, 60)}..." (${s.startSec.toFixed(1)}s–${s.endSec.toFixed(1)}s)`);
    }

    results.passed.push("buildUnifiedSpeechTimeline");
  } catch (err) {
    fail("buildUnifiedSpeechTimeline threw", err.message);
    results.failed.push("buildUnifiedSpeechTimeline");
    process.exit(1);
  }

  // ──────────────────────────────────────────────────────────────────────────
  step(2, "generateNarrativeTimeline — LLM Beat Planning (gpt-5.6)");
  // ──────────────────────────────────────────────────────────────────────────

  let rawBeats;
  console.log(`    ${C.yellow}  [LLM CALL — this may take 5-15s...]${C.reset}`);
  const lllStart = Date.now();
  try {
    rawBeats = await generateNarrativeTimeline(TEST_SCRIPT, TEST_STORY_BIBLE, TARGET_SCENE_COUNT);
    const llmMs = Date.now() - lllStart;
    ok("LLM call succeeded", `${llmMs}ms`);
    ok("Beats returned", rawBeats.length);

    // Validate beat fields
    let beatOk = 0, beatMissing = [];
    for (const b of rawBeats) {
      const hasRequired = b.beatIndex !== undefined && b.narrative && b.action;
      if (hasRequired) beatOk++;
      else beatMissing.push(b.beatIndex);
    }
    if (beatMissing.length === 0) ok(`All ${beatOk} beats have required fields`, "beatIndex, narrative, action ✓");
    else warn(`${beatMissing.length} beats missing fields`, `indices: ${beatMissing.join(",")}`);

    // Show all beats brief
    console.log(`\n    ${C.bold}Beat Summary:${C.reset}`);
    for (const b of rawBeats) {
      const spoken = b.spokenText ? `"${b.spokenText.substring(0, 35)}..."` : "(no dialogue)";
      info(`    [Beat ${b.beatIndex}] ${(b.action || b.narrative || "").substring(0, 55)}... | Dialogue: ${spoken}`);
    }

    results.passed.push("generateNarrativeTimeline");
  } catch (err) {
    fail("generateNarrativeTimeline threw", err.message);
    warn("Falling back to sentence-split mock beats for test continuation");
    rawBeats = TEST_SCRIPT.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, TARGET_SCENE_COUNT).map((s, i) => ({
      beatIndex: i, narrative: s, action: s, spokenText: s,
      characterName: "Marcus Chen", characterId: "char_001",
      location: "Abandoned Warehouse", emotion: "tense",
    }));
    results.failed.push("generateNarrativeTimeline (LLM)");
  }

  // ──────────────────────────────────────────────────────────────────────────
  step(3, "planAtomicBeats — Compound Beat Decomposition");
  // ──────────────────────────────────────────────────────────────────────────

  let atomicBeats;
  try {
    atomicBeats = planAtomicBeats(rawBeats, TARGET_SCENE_COUNT);
    ok("Atomic beats planned", atomicBeats.length);

    const atomized = atomicBeats.filter(b => b.isAtomized);
    if (atomized.length > 0) warn("Some beats were atomized", `${atomized.length} compound beats split`);
    else ok("No compound beats found — all beats already atomic");

    // Verify sequential indexing
    const indexedCorrectly = atomicBeats.every((b, i) => b.beatIndex === i);
    if (indexedCorrectly) ok("Beat indices sequential", "✓");
    else fail("Beat indices out of order");

    results.passed.push("planAtomicBeats");
  } catch (err) {
    fail("planAtomicBeats threw", err.message);
    atomicBeats = rawBeats;
    results.failed.push("planAtomicBeats");
  }

  // ──────────────────────────────────────────────────────────────────────────
  step(4, "planBeatDurations — Duration Estimation (Fix I-6 verified)");
  // ──────────────────────────────────────────────────────────────────────────

  let durationBeats;
  try {
    durationBeats = planBeatDurations(atomicBeats, TARGET_SCENE_COUNT, TOTAL_AUDIO_DURATION);
    ok("Duration beats planned", durationBeats.length);

    // Fix I-6 verification: no 10-word spoken line should produce 5.0s (which would cause splitting)
    let splitCount = 0;
    for (const b of durationBeats) {
      const wordCount = (b.spokenText || "").split(/\s+/).filter(Boolean).length;
      const dur = b.timing?.durationSec || 5.0;
      if (wordCount > 0 && wordCount <= 14 && dur >= 5.0 && b.isSplitPhase) {
        splitCount++;
        warn(`Beat ${b.beatIndex}: ${wordCount}-word line produced split (still at 5.0s+)`, `action: ${(b.action || "").substring(0, 40)}`);
      }
    }
    if (splitCount === 0) ok("Fix I-6 verified: no unnecessary beat splits from spoken word rate");
    else warn(`Fix I-6: ${splitCount} beats still splitting (investigate)`);

    // Show duration distribution
    const durs = durationBeats.map(b => b.timing?.durationSec || 0);
    const totalEstDuration = durs.reduce((a, b) => a + b, 0);
    info(`  Total estimated duration: ${totalEstDuration.toFixed(1)}s (target: ${TOTAL_AUDIO_DURATION}s)`);
    info(`  Per-beat durations: [${durs.map(d => d.toFixed(1)).join(", ")}]s`);

    results.passed.push("planBeatDurations");
  } catch (err) {
    fail("planBeatDurations threw", err.message);
    durationBeats = atomicBeats.map((b, i) => ({ ...b, timing: { startSec: i * 5, endSec: (i + 1) * 5, durationSec: 5.0 } }));
    results.failed.push("planBeatDurations");
  }

  // ──────────────────────────────────────────────────────────────────────────
  step(5, "allocateSpeechToBeats — Speech Segment Assignment");
  // ──────────────────────────────────────────────────────────────────────────

  let speechBeats;
  try {
    speechBeats = allocateSpeechToBeats(durationBeats, speechTimeline);
    ok("Speech allocated to beats", speechBeats.length);

    const withSpeech = speechBeats.filter(b => b.speechAllocation?.hasSpeech);
    ok("Beats with active speech", withSpeech.length);

    for (const b of speechBeats.slice(0, 3)) {
      const alloc = b.speechAllocation || {};
      info(`  [Beat ${b.beatIndex}] hasSpeech=${alloc.hasSpeech} | "${(alloc.spokenText || "").substring(0, 50)}"`);
    }

    results.passed.push("allocateSpeechToBeats");
  } catch (err) {
    fail("allocateSpeechToBeats threw", err.message);
    speechBeats = durationBeats;
    results.failed.push("allocateSpeechToBeats");
  }

  // ──────────────────────────────────────────────────────────────────────────
  step(6, "validateBeatContinuity — Gap Detection & Transition Insertion");
  // ──────────────────────────────────────────────────────────────────────────

  let validatedBeats;
  try {
    validatedBeats = validateBeatContinuity(speechBeats, TARGET_SCENE_COUNT);
    const inserted = validatedBeats.filter(b => b.isAutoInsertedTransition);

    ok("Beat continuity validated", `${validatedBeats.length} total beats`);
    if (inserted.length > 0) warn("Auto-inserted transition beats", `${inserted.length} gaps detected`);
    else ok("No missing transitions detected");

    results.passed.push("validateBeatContinuity");
  } catch (err) {
    fail("validateBeatContinuity threw", err.message);
    validatedBeats = speechBeats;
    results.failed.push("validateBeatContinuity");
  }

  // ──────────────────────────────────────────────────────────────────────────
  step(7, "initializeSceneState — SceneState Init (Fixes I-2, I-3, I-4)");
  // ──────────────────────────────────────────────────────────────────────────

  let sceneState;
  try {
    sceneState = initializeSceneState(TEST_STORY_BIBLE, validatedBeats[0] || {});

    ok("SceneState initialized");
    info(`  identityLock: "${sceneState.activeCharacter.identityLock}"`);
    info(`  costumeState: "${sceneState.activeCharacter.costumeState}"`);
    info(`  locationDetails: "${sceneState.locationDetails}"`);
    info(`  currentPose: "${sceneState.currentPose}"`);

    // Fix I-3 verification
    const hasRichIdentity = sceneState.activeCharacter.identityLock.includes("angular") ||
      sceneState.activeCharacter.identityLock.includes("olive") ||
      sceneState.activeCharacter.identityLock.includes("East Asian");
    if (hasRichIdentity) ok("Fix I-3 verified: identityLock uses MGE materialized fields");
    else warn("Fix I-3: identityLock may still be shallow — check character.sketch_artist_appearance");

    // Fix I-4 verification
    const hasRichLocation = sceneState.locationDetails.length > 20 &&
      !/^cinematic environment$/i.test(sceneState.locationDetails);
    if (hasRichLocation) ok("Fix I-4 verified: locationDetails resolved from MGE fallback chain");
    else warn("Fix I-4: locationDetails still generic — check location fields");

    // Fix I-3 costume verification
    const hasRichCostume = sceneState.activeCharacter.costumeState !== "standard wardrobe";
    if (hasRichCostume) ok("Fix I-3 verified: costumeState resolved from base_clothing");
    else warn("Fix I-3: costumeState still 'standard wardrobe'");

    results.passed.push("initializeSceneState");
  } catch (err) {
    fail("initializeSceneState threw", err.message);
    sceneState = {
      completedActions: [], currentPose: "Standing", currentLocation: "Warehouse",
      locationDetails: "Dark warehouse", activeCharacter: { id: "char_001", name: "Marcus", identityLock: "Detective", costumeState: "suit" },
      camera: { shotSize: "Medium", angle: "Eye Level", movement: "Static" },
      emotion: "tense", environment: "dark", nextAction: "investigate",
      conversationState: {},
    };
    results.failed.push("initializeSceneState");
  }

  // ──────────────────────────────────────────────────────────────────────────
  step(8, "buildStateBasedPrompt — Prompt Generation per Beat");
  // ──────────────────────────────────────────────────────────────────────────

  const rawPrompts = [];
  let currentState = sceneState;

  try {
    console.log(`\n    ${C.bold}Generating ${validatedBeats.length} prompts:${C.reset}`);

    for (let i = 0; i < validatedBeats.length; i++) {
      const beat = validatedBeats[i];
      const nextBeat = validatedBeats[i + 1] || null;
      const promptObj = buildStateBasedPrompt(beat, currentState, nextBeat, TEST_STORY_BIBLE, { characterTalk: false, aspectRatio: "9:16" });
      rawPrompts.push(promptObj);

      const hasStartingPose = promptObj.prompt.includes("STARTING POSE:");
      const hasBoundary = promptObj.prompt.includes("ACTION CONTINUITY & BOUNDARY:");
      const hasVisuals = promptObj.prompt.includes("SCENE VISUALS:");
      const hasRatio = promptObj.prompt.includes("FRAME ASPECT RATIO & COMPOSITION: Generate natively in VERTICAL 9:16 orientation");
      const poseOk = hasStartingPose ? "✓" : "✗";
      const boundaryOk = hasBoundary ? "✓" : "✗";
      const visualsOk = hasVisuals ? "✓" : "✗";
      const ratioOk = hasRatio ? "✓" : "✗";

      info(`  [Beat ${i}] len=${promptObj.prompt.length} | STARTING_POSE=${poseOk} | BOUNDARY=${boundaryOk} | VISUALS=${visualsOk} | RATIO_9_16=${ratioOk}`);

      // Update scene state for next beat
      currentState = updateSceneState(currentState, beat, nextBeat, i, validatedBeats.length);
    }

    ok("All prompts generated", `${rawPrompts.length} prompt objects`);

    // Show first prompt in full
    console.log(`\n    ${C.bold}First Prompt Preview (Beat 0):${C.reset}`);
    printPromptPreview(rawPrompts[0]?.prompt);

    results.passed.push("buildStateBasedPrompt");
  } catch (err) {
    fail("buildStateBasedPrompt threw", err.message);
    console.error(err);
    results.failed.push("buildStateBasedPrompt");
  }

  // ──────────────────────────────────────────────────────────────────────────
  step(9, "Fix I-2 deriveEndingPose — Pose Propagation Verification");
  // ──────────────────────────────────────────────────────────────────────────

  const poseTestCases = [
    { action: "Marcus walks toward the door", expect: /arrived|destination|standing|weight/i },
    { action: "Marcus shouts at the figure", expect: /mouth|speaking|chin|jaw|rest/i },
    { action: "He pushes the door open slowly", expect: /door|pass through|partially/i },
    { action: "The young woman stands raising both hands", expect: /stand|upright|feet|weight/i },
    { action: "Marcus reaches for his holster", expect: /hand|extended|fingers|arm/i },
    { action: "Marcus crawls under the barrier", expect: /crouch|low|hands|ground/i },
    { action: "He turns to check behind him", expect: /facing|turned|direction|weight/i },
    { action: "She smiles nervously at him", expect: /smile|expression|mouth|relax/i },
    { action: "Marcus picks up the evidence bag", expect: /held|item|arm|level/i },
    { action: "She collapses from exhaustion", expect: /fall|ground|surface|fallen/i },
  ];

  const { updateSceneState: updateFn } = await import("../services/videoPlanner/sceneStateEngine.js");
  let poseOkCount = 0, poseFallbackCount = 0;
  for (const tc of poseTestCases) {
    // Simulate a single beat update to get the derived pose
    const mockBeat = { action: tc.action, narrative: tc.action, location: "Warehouse", emotion: "tense" };
    const tempState = initializeSceneState(TEST_STORY_BIBLE, mockBeat);
    const updated = updateSceneState(tempState, mockBeat, null, 0, 1);
    const pose = updated.currentPose;
    const isGeneric = pose.startsWith("Positioned at completion of:");
    const matchesExpected = tc.expect.test(pose);

    if (matchesExpected) {
      ok(`"${tc.action.substring(0, 40)}"`, `"${pose}"`);
      poseOkCount++;
    } else if (isGeneric) {
      warn(`"${tc.action.substring(0, 40)}" → generic fallback`, `"${pose}"`);
      poseFallbackCount++;
    } else {
      fail(`"${tc.action.substring(0, 40)}" → unexpected`, `"${pose}"`);
      results.failed.push(`deriveEndingPose: "${tc.action}"`);
    }
  }
  ok(`Fix I-2 result`, `${poseOkCount}/${poseTestCases.length} poses matched, ${poseFallbackCount} generic fallback`);

  // ──────────────────────────────────────────────────────────────────────────
  step(10, "PQA — Full Pipeline Pass (Fixes J-1 through J-6)");
  // ──────────────────────────────────────────────────────────────────────────

  let pqaPrompts = [];
  try {
    pqaPrompts = runPromptQualityPipeline(rawPrompts, validatedBeats, TEST_STORY_BIBLE, {});

    ok("PQA pipeline completed", `${pqaPrompts.length} prompts processed`);

    const scores = pqaPrompts.map(p => p._pqaReport?.score || 0);
    const approved = pqaPrompts.filter(p => p._pqaReport?.approved);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    ok("Avg PQA score", `${avgScore.toFixed(1)}/100`);
    ok("Approved prompts", `${approved.length}/${pqaPrompts.length}`);
    info(`  Scores: [${scores.join(", ")}]`);

    results.passed.push("runPromptQualityPipeline");
  } catch (err) {
    fail("runPromptQualityPipeline threw", err.message);
    console.error(err);
    results.failed.push("runPromptQualityPipeline");
  }

  // ──────────────────────────────────────────────────────────────────────────
  step(11, "PQA Unit Tests — Individual Fix Verifications");
  // ──────────────────────────────────────────────────────────────────────────

  // J-1: History window capped to 3
  {
    const tracker = new PromptHistoryTracker();
    for (let i = 0; i < 10; i++) {
      tracker.recordBeat(i, {
        prompt: `Prompt ${i}`,
        narration: `He walked to the spot number ${i}`,
        _beat: { action: `action_${i}`, narrative: `narrative_${i}` },
        _directorObject: { cameraPlan: { rig: "Steadicam" } },
      });
    }
    const ctx = tracker.getHistoryContext(10, null);
    if (ctx.previousDialogues.length <= 3) ok("Fix J-1: history window capped to 3", `got ${ctx.previousDialogues.length} entries`);
    else fail("Fix J-1: history not capped", `got ${ctx.previousDialogues.length} entries`);
  }

  // J-2: False positive on substring containment
  {
    const tracker = new PromptHistoryTracker();
    // Record "He walked" as a prior dialogue
    tracker.recordBeat(0, {
      prompt: "prompt text",
      narration: "He walked",
      _beat: { action: "walk", narrative: "walk" },
      _directorObject: { cameraPlan: { rig: "Static" } },
    });
    const ctx = tracker.getHistoryContext(1, null);
    // "He walked quickly to the door" contains "He walked" as substring — old code would flag this
    const mockPromptObj = {
      prompt: `SCENE VISUALS: Marcus Chen. CINEMATOGRAPHY: 35mm lens. STARTING POSE: Standing. COMPLETE ACTION VISUALS: Marcus walks forward. ACTION CONTINUITY & BOUNDARY: Perform action. Conclude clip smoothly at t=5.0s. VISUAL STYLE: Cinematic.`,
      narration: "He walked quickly to the door and entered",
      speechAllocation: { spokenText: "He walked quickly to the door and entered" },
      durationSec: 5.0,
      _beat: { action: "walk to door", narrative: "walks" },
      _sceneState: { currentLocation: "Warehouse Interior", currentPose: "Standing" },
      _directorObject: { cameraPlan: { rig: "Tracking Shot" } },
    };
    const report = auditPrompt(mockPromptObj, ctx);
    const falsePositive = report.issues.some(i => i.type === "Repeated Dialogue");
    if (!falsePositive) ok("Fix J-2: no false positive on substring containment", "'He walked' ⊄ 'He walked quickly...' false flag suppressed");
    else fail("Fix J-2: still flagging substring as repeated dialogue");
  }

  // J-4: "Prompt Too Short" maps to 'length' not 'continuity'
  {
    const { calculatePromptScore: calcScore } = await import("../services/videoPlanner/pqa/promptScorer.js");
    const testIssues = [
      { type: "Prompt Too Short", severity: "High" },
      { type: "Repeated Cinematic Language", severity: "Low" },
      { type: "Conflicting Actions", severity: "High" },
    ];
    const { score, categories } = calcScore({}, testIssues);
    const lengthDeducted = categories.length < 100;
    const readabilityDeducted = categories.readability < 100;
    const actionDeducted = categories.action < 100;
    if (lengthDeducted) ok("Fix J-4: 'Prompt Too Short' deducts from length category", `length=${categories.length}`);
    else fail("Fix J-4: 'Prompt Too Short' not deducting from length", `length=${categories.length}`);
    if (readabilityDeducted) ok("Fix J-4: 'Repeated Cinematic Language' deducts from readability", `readability=${categories.readability}`);
    else fail("Fix J-4: 'Repeated Cinematic Language' not deducting from readability");
    if (actionDeducted) ok("Fix J-4: 'Conflicting Actions' deducts from action category", `action=${categories.action}`);
    else fail("Fix J-4: 'Conflicting Actions' not deducting from action");
  }

  // J-5: Hyphenated buzzword replacement
  {
    const { optimizePrompt: optimize } = await import("../services/videoPlanner/pqa/promptOptimizer.js");
    const testPromptObj = {
      prompt: `SCENE VISUALS: Medium Shot, Eye Level. Marcus Chen (East Asian detective). Location: Abandoned Warehouse. Lighting: natural. CINEMATOGRAPHY: 35mm lens, Steadicam. STARTING POSE: Standing upright. COMPLETE ACTION VISUALS: Marcus walks. ACTION CONTINUITY & BOUNDARY: Perform ONLY current action. Conclude clip smoothly at t=5.0s. VISUAL STYLE: photorealistic hyper-realistic hyper-realistic 8k ultra-detailed 8k ultra-detailed 8k ultra-detailed cinematic.`,
      narration: "",
      durationSec: 5.0,
      _beat: { action: "walk", narrative: "walk", location: "Warehouse" },
      _sceneState: { currentLocation: "Abandoned Warehouse", currentPose: "Standing" },
      _directorObject: { cameraPlan: { rig: "Steadicam" } },
    };
    const mockReport = { score: 70, issues: [{ type: "Repeated Cinematic Language", severity: "Low" }] };
    const optimized = optimize(testPromptObj, mockReport, {});
    const hyperCount = (optimized.prompt.toLowerCase().match(/hyper-realistic/g) || []).length;
    if (hyperCount <= 1) ok("Fix J-5: hyper-realistic cleaned to ≤1 occurrence", `found ${hyperCount}`);
    else fail("Fix J-5: hyper-realistic still has multiple occurrences", `found ${hyperCount}`);
    const ultraCount = (optimized.prompt.match(/8k ultra-detailed/gi) || []).length;
    if (ultraCount <= 1) ok("Fix J-5: '8k ultra-detailed' cleaned to ≤1 occurrence", `found ${ultraCount}`);
    else fail("Fix J-5: '8k ultra-detailed' not cleaned", `found ${ultraCount}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  step(12, "Final Prompt Quality Inspection — Per-Beat Report");
  // ──────────────────────────────────────────────────────────────────────────

  if (pqaPrompts.length > 0) {
    console.log();
    for (let i = 0; i < pqaPrompts.length; i++) {
      const p = pqaPrompts[i];
      const report = p._pqaReport || {};
      const status = report.approved ? `${C.green}✓ APPROVED${C.reset}` : `${C.yellow}⚠ MAX_ITER${C.reset}`;
      const issueList = report.issues?.length > 0 ? report.issues.map(iss => `${iss.type}(${iss.severity})`).join(", ") : "None";
      console.log(`    Beat ${String(i).padStart(2)}: ${status} | Score: ${String(report.score || 0).padStart(3)}/100 | Opts: ${report.iterations || 0}/3 | Issues: ${issueList}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  section("TEST RESULTS SUMMARY");
  // ──────────────────────────────────────────────────────────────────────────

  console.log(`\n  ${C.bold}${C.green}Passed: ${results.passed.length}${C.reset}`);
  for (const p of results.passed) info(`    ✓ ${p}`);

  if (results.warnings.length > 0) {
    console.log(`\n  ${C.bold}${C.yellow}Warnings: ${results.warnings.length}${C.reset}`);
    for (const w of results.warnings) info(`    ⚠ ${w}`);
  }

  if (results.failed.length > 0) {
    console.log(`\n  ${C.bold}${C.red}Failed: ${results.failed.length}${C.reset}`);
    for (const f of results.failed) info(`    ✗ ${f}`);
  }

  console.log();
  const allOk = results.failed.length === 0;
  if (allOk) {
    console.log(`  ${C.bold}${C.green}🎉 ALL TESTS PASSED — Pipeline is functioning correctly.${C.reset}`);
  } else {
    console.log(`  ${C.bold}${C.red}⚠  ${results.failed.length} stage(s) failed. Review errors above.${C.reset}`);
  }
  console.log();
}

// Run
runTest().catch(err => {
  console.error(`\n${C.red}${C.bold}FATAL TEST ERROR: ${err.message}${C.reset}`);
  console.error(err.stack);
  process.exit(1);
});
