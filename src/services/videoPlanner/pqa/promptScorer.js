/**
 * promptScorer.js — Prompt Scoring Engine for PQA Pipeline
 *
 * Calculates per-category scores (0–100) and overall quality score
 * based on detected issues, severity levels, and structural compliance.
 */

export function calculatePromptScore(categories = {}, issues = []) {
  const defaultCategoryScores = {
    continuity: 100,
    dialogue: 100,
    camera: 100,
    action: 100,
    scene: 100,
    length: 100,
    readability: 100,
    ...categories,
  };

  // Deduct points based on issues if not already factored into category scores
  const scoreMap = { ...defaultCategoryScores };

  for (const issue of issues) {
    const categoryKey = mapIssueTypeToCategory(issue.type);
    let penalty = 10;
    if (issue.severity === "High" || issue.severity === "Critical") penalty = 25;
    else if (issue.severity === "Medium") penalty = 12;
    else if (issue.severity === "Low") penalty = 5;

    if (categoryKey && scoreMap[categoryKey] !== undefined) {
      scoreMap[categoryKey] = Math.max(0, scoreMap[categoryKey] - penalty);
    }
  }

  // Calculate weighted overall score
  const weights = {
    continuity: 0.20,
    dialogue: 0.20,
    action: 0.20,
    camera: 0.15,
    scene: 0.10,
    length: 0.08,
    readability: 0.07,
  };

  let totalWeightedScore = 0;
  let totalWeight = 0;

  for (const [cat, weight] of Object.entries(weights)) {
    const catScore = scoreMap[cat] !== undefined ? scoreMap[cat] : 100;
    totalWeightedScore += catScore * weight;
    totalWeight += weight;
  }

  const overallScore = Math.round(totalWeightedScore / totalWeight);

  return {
    score: Math.max(0, Math.min(100, overallScore)),
    categories: scoreMap,
  };
}

function mapIssueTypeToCategory(issueType = "") {
  const t = issueType.toLowerCase();
  if (t.includes("dialogue") || t.includes("speech")) return "dialogue";
  if (t.includes("action") || t.includes("conflicting")) return "action";
  if (t.includes("camera") || t.includes("motion") || t.includes("transition")) return "camera";
  if (t.includes("scene") || t.includes("environment") || t.includes("lighting") || t.includes("wardrobe") || t.includes("identity")) return "scene";
  if (t.includes("continuity") || t.includes("pose") || t.includes("scenestate") || t.includes("boundary") || t.includes("conversation")) return "continuity";
  // Fix J-4: Explicit mappings for issue types previously falling through to 'continuity'
  if (t.includes("too short") || t.includes("too long")) return "length";
  if (t.includes("verbosity") || t.includes("adjective") || t.includes("cinematic") || t.includes("repetition") || t.includes("repeated cinematic")) return "readability";
  return "continuity"; // True default for unknown types
}
