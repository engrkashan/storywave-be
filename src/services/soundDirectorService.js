import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { getAudioDuration } from "./audioService.js";
import { sfxElevenLabs } from "./generateVoiceoverService.js";

const logger = createLogger("SoundDirectorService");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Clean word for matching against transcript (lowercase, trim punctuation)
 */
function cleanWord(w) {
  return (w || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

/**
 * Match target word to Whisper transcript word list to get exact start timestamp.
 */
function findWordTimestamp(targetWord, words, fallbackIndex = 0) {
  if (!words || words.length === 0) return 0;
  const cleanedTarget = cleanWord(targetWord);
  if (!cleanedTarget) {
    return words[Math.min(fallbackIndex, words.length - 1)]?.start || 0;
  }

  // 1. Exact clean match
  for (let i = 0; i < words.length; i++) {
    if (cleanWord(words[i].word) === cleanedTarget) {
      return words[i].start;
    }
  }

  // 2. Partial includes match
  for (let i = 0; i < words.length; i++) {
    const wClean = cleanWord(words[i].word);
    if (wClean && (wClean.includes(cleanedTarget) || cleanedTarget.includes(wClean))) {
      return words[i].start;
    }
  }

  // 3. Fallback to ratio position in word list
  const ratioIndex = Math.min(fallbackIndex, words.length - 1);
  return words[ratioIndex]?.start || 0;
}

/**
 * Analyze script narrative, emotion, environment, and tension to generate a Master Soundscape Plan.
 */
export async function analyzeNarrativeAndPlanSoundscape({ script, words, storyMetadata = {} }) {
  logger.info("🧠 [AI Sound Director] Analyzing narrative and planning cinematic soundscape...");

  const storyType = storyMetadata.genre || storyMetadata.storyType || "cinematic";
  const voiceTone = storyMetadata.voiceTone || "dramatic";

  const wordsPreview = (words || []).map((w, idx) => `[${idx}] "${w.word.trim()}" (${w.start.toFixed(2)}s)`).join(" ");

  const prompt = `You are an Oscar-winning Cinematic Sound Director and Audio Lead.
Your goal is NOT to simply detect keywords. Your goal is to intelligently design a complete, layered cinematic soundscape for this story.

STORY GENRE/TYPE: ${storyType}
TONE/MOOD: ${voiceTone}

FULL NARRATION SCRIPT:
"""
${script}
"""

WHISPER WORD TIMELINE (Use word strings & index references for word-level sync):
${wordsPreview.slice(0, 10000)}

DESIGN INSTRUCTIONS & RULES:
1. NARRATIVE & SCENE ANALYSIS: Analyze the story step-by-step for actions, objects, environment, emotional state, tension level, camera perspective, and pacing.
2. AMBIENT LAYERS: Identify AT MOST ONE single subtle continuous background ambience layer for the entire story (e.g. quiet room tone or soft wind draft). Do NOT create multiple ambient tracks. Ambient volume must be soft and unobtrusive (0.10 - 0.18).
3. FOLEY & SOUND EVENTS (MAX 1 OR 2 TOTAL FOR A 3-MINUTE STORY):
   - BE EXTREMELY SPARING AND MINIMAL. Most narration sentences MUST NOT produce any sound effects.
   - For stories under 3 minutes (< 180s), select AT MOST 1 sound event TOTAL for the ENTIRE story (only the single climax moment like a gunshot).
   - For stories 3 minutes or longer (>= 180s), select AT MOST 2 sound events TOTAL for the ENTIRE story.
   - Sound effects MUST be separated by a wide gap of at least 90 seconds.
   - If there is no major dramatic climax sound, return 0 sound events. Do NOT add sound for ordinary actions.
   - Specify 'targetStartWord' as the exact word in the narration script where the sound begins.
   - Assign 'importance': "critical", "high", "medium", or "low".
   - Assign 'priority': 1 (low) to 5 (critical, e.g. gunshot=5, door slam=4).
   - Assign 'layer': "foreground" or "midground".
   - Set 'fadeInSec', 'fadeOutSec', 'volume' to a subtle, soft level (0.15 to 0.35). SFX must NEVER overpower narration voice.
4. MUSIC INTERACTION: Specify if background music should duck during key SFX (e.g., gunshot, whisper).

Return STRICT VALID JSON in this format:
{
  "narrative_analysis": [
    {
      "sentence": "Sentence text...",
      "action": "action name",
      "environment": "setting description",
      "emotion": "emotional tone",
      "tension_level": 0.5,
      "pacing": "slow/fast"
    }
  ],
  "scene_environments": [
    {
      "id": "amb_1",
      "type": "room_tone_old_house",
      "prompt": "Eerie quiet room tone inside an old creaky wooden house with subtle low wind draft",
      "startWord": "It",
      "endWord": "silence",
      "volume": 0.30,
      "fadeInSec": 1.0,
      "fadeOutSec": 1.5,
      "layer": "background_ambience"
    }
  ],
  "sound_events": [
    {
      "id": "sfx_1",
      "type": "door_open",
      "description": "Old heavy wooden bedroom door slowly creaking open on rusty hinges in suspenseful quiet room",
      "material": "wood",
      "condition": "old",
      "speed": "slow",
      "emotion": "suspense",
      "importance": "medium",
      "priority": 3,
      "targetStartWord": "pushed",
      "targetPeakWord": "door",
      "targetEndWord": "open",
      "layer": "foreground",
      "fadeInSec": 0.3,
      "fadeOutSec": 0.6,
      "volume": 0.65,
      "duckMusic": false,
      "overlapNarration": true
    }
  ],
  "tension_cues": [
    {
      "id": "tension_1",
      "type": "horror_subtle_drone",
      "description": "Low frequency cinematic sub-bass rumble swell for rising suspense",
      "targetStartWord": "darkness",
      "durationSec": 4.0,
      "volume": 0.40,
      "fadeInSec": 1.5,
      "fadeOutSec": 1.0,
      "layer": "tension_drone"
    }
  ]
}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.6",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const plan = JSON.parse(res.choices[0].message.content.trim());
    logger.info(`✅ [AI Sound Director] Plan generated: ${plan.sound_events?.length || 0} SFX events, ${plan.scene_environments?.length || 0} ambient layers, ${plan.tension_cues?.length || 0} tension cues.`);
    return plan;
  } catch (err) {
    logger.error("❌ Soundscape planning failed:", err.message);
    // Return fallback soundscape plan
    return {
      narrative_analysis: [],
      scene_environments: [
        {
          id: "amb_default",
          type: "room_tone",
          prompt: "Subtle quiet room tone background ambience",
          startWord: "",
          volume: 0.25,
          fadeInSec: 1.0,
          fadeOutSec: 1.0,
          layer: "background_ambience"
        }
      ],
      sound_events: [],
      tension_cues: []
    };
  }
}

/**
 * Generate/fetch audio assets for all planned sound events, ambient layers, and tension cues,
 * calculating exact word-level start timestamps (delayMs).
 */
export async function buildSoundscapeAssets({ soundscapePlan, words, tempDir }) {
  logger.info("🎵 [AI Sound Director] Building soundscape audio assets & word-level timeline...");
  fs.mkdirSync(tempDir, { recursive: true });

  const totalDuration = words && words.length > 0 ? (words[words.length - 1].end || 10) + 2 : 30;
  const soundscapeAssets = [];

  // 1. Process Ambient Layer (Max 1 subtle background track for entire story)
  const ambList = (soundscapePlan.scene_environments || []).slice(0, 1);
  for (let i = 0; i < ambList.length; i++) {
    const amb = ambList[i];
    try {
      const startSec = amb.startWord ? findWordTimestamp(amb.startWord, words, 0) : 0;
      const endSec = amb.endWord ? findWordTimestamp(amb.endWord, words, words.length - 1) : totalDuration;
      const dur = Math.max(2.0, endSec - startSec);

      logger.info(`  🌌 Ambient [${i + 1}/${ambList.length}]: "${amb.prompt || amb.type}" (${startSec.toFixed(2)}s -> ${endSec.toFixed(2)}s)`);

      const sfxBuf = await sfxElevenLabs(amb.prompt || amb.type);
      if (sfxBuf && sfxBuf.length > 0) {
        const ambPath = path.join(tempDir, `ambience_${Date.now()}_${i}.mp3`);
        fs.writeFileSync(ambPath, sfxBuf);

        soundscapeAssets.push({
          id: amb.id || `amb_${i}`,
          type: "ambience",
          file: ambPath,
          delayMs: startSec * 1000,
          targetDurationSec: dur,
          volume: Math.min(0.20, amb.volume || 0.15),
          fadeInSec: amb.fadeInSec || 1.0,
          fadeOutSec: amb.fadeOutSec || 1.0,
          layer: "background_ambience",
          duckMusic: false,
        });
      }
    } catch (err) {
      logger.warn(`⚠️ Failed to build ambient asset "${amb.type}": ${err.message}`);
    }
  }

  // 2. Process & Filter Sound Events (Foley, actions, key SFX)
  const rawSfxList = soundscapePlan.sound_events || [];

  // ULTRA-MINIMALIST CAP: 1 sound event max for stories under 3 mins (< 180s), 2 max for 3 mins or longer (>= 180s)
  const maxSFXCount = totalDuration >= 180 ? 2 : 1;

  // Score candidate events by importance & priority for rate-limiting
  const sfxCandidates = rawSfxList.map((sfx, idx) => {
    const startSec = findWordTimestamp(sfx.targetStartWord, words, Math.floor((idx / Math.max(1, rawSfxList.length)) * words.length));
    const prioMap = { critical: 5, high: 4, medium: 3, low: 1 };
    const importanceScore = prioMap[sfx.importance?.toLowerCase()] || (sfx.priority || 3);
    return {
      ...sfx,
      startSec,
      importanceScore
    };
  });

  // Sort by highest importance/priority first
  sfxCandidates.sort((a, b) => b.importanceScore - a.importanceScore);

  // Select top priority SFX respecting maxSFXCount and minimum 90s spacing gap between sound events
  const filteredSfxList = [];
  for (const sfx of sfxCandidates) {
    if (filteredSfxList.length >= maxSFXCount) break;

    const hasSpacingOverlap = filteredSfxList.some(
      (selected) => Math.abs(selected.startSec - sfx.startSec) < 90.0
    );

    if (!hasSpacingOverlap) {
      filteredSfxList.push(sfx);
    }
  }

  // Sort selected SFX chronologically for rendering
  filteredSfxList.sort((a, b) => a.startSec - b.startSec);

  logger.info(`🔍 [SFX Prioritizer] Selected ${filteredSfxList.length}/${rawSfxList.length} top key SFX events (Max allowed TOTAL for ${totalDuration.toFixed(1)}s story: ${maxSFXCount})`);

  for (let i = 0; i < filteredSfxList.length; i++) {
    const sfx = filteredSfxList[i];
    try {
      const startSec = sfx.startSec;
      logger.info(`  🔊 SFX [${i + 1}/${filteredSfxList.length}]: "${sfx.type}" ("${sfx.description || sfx.type}") queued at ${startSec.toFixed(2)}s (Word: "${sfx.targetStartWord}")`);

      const sfxBuf = await sfxElevenLabs(sfx.description || sfx.type);
      if (sfxBuf && sfxBuf.length > 0) {
        const sfxPath = path.join(tempDir, `sfx_${Date.now()}_${i}.mp3`);
        fs.writeFileSync(sfxPath, sfxBuf);

        const realDur = await getAudioDuration(sfxPath);

        soundscapeAssets.push({
          id: sfx.id || `sfx_${i}`,
          type: sfx.type || "sfx",
          file: sfxPath,
          delayMs: startSec * 1000,
          durationSec: realDur,
          volume: Math.min(0.35, sfx.volume || 0.30),
          fadeInSec: sfx.fadeInSec || 0.1,
          fadeOutSec: sfx.fadeOutSec || 0.4,
          layer: sfx.layer || "foreground",
          priority: sfx.priority || 3,
          duckMusic: sfx.duckMusic ?? false,
          overlapNarration: sfx.overlapNarration ?? true,
        });
      }
    } catch (err) {
      logger.warn(`⚠️ Failed to build SFX asset "${sfx.type}": ${err.message}`);
    }
  }

  // 3. Process Tension Cues (Max 1 subtle tension cue total for entire story)
  const tensionList = (soundscapePlan.tension_cues || []).slice(0, 1);
  for (let i = 0; i < tensionList.length; i++) {
    const t = tensionList[i];
    try {
      const startSec = findWordTimestamp(t.targetStartWord, words, 0);
      logger.info(`  🎻 Tension Cue [${i + 1}/${tensionList.length}]: "${t.description || t.type}" queued at ${startSec.toFixed(2)}s`);

      const sfxBuf = await sfxElevenLabs(t.description || t.type || "subtle horror drone");
      if (sfxBuf && sfxBuf.length > 0) {
        const tPath = path.join(tempDir, `tension_${Date.now()}_${i}.mp3`);
        fs.writeFileSync(tPath, sfxBuf);

        const realDur = await getAudioDuration(tPath);

        soundscapeAssets.push({
          id: t.id || `tension_${i}`,
          type: "tension",
          file: tPath,
          delayMs: startSec * 1000,
          durationSec: realDur,
          volume: Math.min(0.35, t.volume || 0.30),
          fadeInSec: t.fadeInSec || 1.0,
          fadeOutSec: t.fadeOutSec || 1.0,
          layer: t.layer || "tension_drone",
          duckMusic: true,
        });
      }
    } catch (err) {
      logger.warn(`⚠️ Failed to build tension cue "${t.type}": ${err.message}`);
    }
  }

  return soundscapeAssets;
}
