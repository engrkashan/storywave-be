/**
 * promptHistoryTracker.js — Sequence History Tracker for PQA Pipeline
 *
 * Stores and manages beat history across a video sequence to enable
 * cross-beat repetition detection for dialogue, actions, camera, and environment.
 */

export class PromptHistoryTracker {
  constructor() {
    this.records = new Map();
  }

  /**
   * Records completed/audited beat prompt data into history.
   *
   * @param {number} beatIndex
   * @param {object} promptObj
   */
  recordBeat(beatIndex, promptObj = {}) {
    const rawPrompt = promptObj.prompt || "";
    const spokenText = promptObj.narration || promptObj.speechAllocation?.spokenText || "";
    const action = promptObj._beat?.action || promptObj._beat?.narrative || "";
    const camera = promptObj._directorObject?.cameraPlan?.rig || promptObj._directorObject?.cameraPlan?.movement || "";
    const environment = promptObj._beat?.location || "";

    this.records.set(beatIndex, {
      beatIndex,
      prompt: rawPrompt,
      spokenText,
      action,
      camera,
      environment,
      promptObj,
    });
  }

  /**
   * Retrieves cross-beat context for the given beat index.
   *
   * @param {number} currentIndex
   * @param {object} nextBeat
   * @returns {object} History context
   */
  getHistoryContext(currentIndex, nextBeat = null) {
    const prevRecord = this.records.get(currentIndex - 1) || null;
    const historyRecords = Array.from(this.records.values()).sort((a, b) => a.beatIndex - b.beatIndex);

    // Fix J-1: Cap to last 3 beats only — unbounded history caused false "Repeated Dialogue/Action"
    // flags when a common phrase from beat 1 reappeared in beat 12+.
    const previousDialogues = historyRecords.slice(-3).map(r => r.spokenText).filter(Boolean);
    const previousActions = historyRecords.slice(-3).map(r => r.action).filter(Boolean);
    const previousCameras = historyRecords.slice(-3).map(r => r.camera).filter(Boolean);
    const previousEnvironments = historyRecords.slice(-3).map(r => r.environment).filter(Boolean);

    return {
      previousBeat: prevRecord,
      previousPrompt: prevRecord ? prevRecord.prompt : "",
      previousDialogue: prevRecord ? prevRecord.spokenText : "",
      previousAction: prevRecord ? prevRecord.action : "",
      previousCamera: prevRecord ? prevRecord.camera : "",
      previousEnvironment: prevRecord ? prevRecord.environment : "",
      nextBeatSummary: nextBeat ? (nextBeat.narrative || nextBeat.action || "") : "",
      historyRecords,
      previousDialogues,
      previousActions,
      previousCameras,
      previousEnvironments,
    };
  }
}
