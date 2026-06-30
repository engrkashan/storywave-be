/**
 * perfLogger.js — High-resolution workflow performance instrumentation
 *
 * Usage:
 *   import { perfStorage, createPerfSession } from './perfLogger.js';
 *
 *   // In workflowService._runWorkflow(), wrap the body:
 *   const session = createPerfSession(workflowId);
 *   await perfStorage.run(session, async () => { ... workflow code ... });
 *
 *   // In any service, retrieve the session (no prop drilling):
 *   import { getPerfSession } from './perfLogger.js';
 *   const t = getPerfSession()?.start('category', 'label');
 *   await doWork();
 *   t?.();          // stops the timer, records event
 */

import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from './logger.js';

const logger = createLogger('PerfLogger');

// AsyncLocalStorage — propagates session through the entire async call tree
// without modifying any function signatures.
export const perfStorage = new AsyncLocalStorage();

/** Retrieve the current workflow's PerfSession (returns null if not inside a run) */
export function getPerfSession() {
  return perfStorage.getStore() ?? null;
}

/** Create a new PerfSession and optionally start it inside perfStorage.run() */
export function createPerfSession(workflowId) {
  return new PerfSession(workflowId);
}

// ─────────────────────────────────────────────────────────────────────────────

class PerfSession {
  constructor(workflowId) {
    this.workflowId = workflowId;
    this.events = [];              // All timing events
    this.ffmpegEvents = [];        // Detailed FFmpeg events
    this.queueEvents = [];         // Semaphore queue metrics
    this.sessionStart = process.hrtime.bigint();
    this.wallStart = Date.now();
    this.diskBytesWritten = 0;
    this.diskBytesRead = 0;
    this.tempFilesCreated = 0;
    this.tempFilesDeleted = 0;
  }

  /**
   * Start a high-resolution timer.
   * Returns a stop function that records the event and returns duration in ms.
   *
   * @param {string} category  — e.g. 'image', 'audio', 'video', 'ffmpeg', 'upload'
   * @param {string} label     — human-readable name of the operation
   * @param {object} meta      — arbitrary metadata (sceneIndex, args, etc.)
   * @returns {Function}       — call to stop the timer
   */
  start(category, label, meta = {}) {
    const hrStart = process.hrtime.bigint();
    const wallStart = Date.now();

    return (extraMeta = {}) => {
      const hrEnd = process.hrtime.bigint();
      const durationMs = Number(hrEnd - hrStart) / 1_000_000;
      const event = {
        category,
        label,
        wallStart,
        wallEnd: Date.now(),
        durationMs: Math.round(durationMs),
        meta: { ...meta, ...extraMeta },
      };
      this.events.push(event);

      logger.info(
        `⏱️  [PERF][${category}] ${label}: ${(durationMs / 1000).toFixed(2)}s (${Math.round(durationMs)}ms)`,
      );
      return durationMs;
    };
  }

  /**
   * Specialized timer for FFmpeg processes. Captures args, output size, stderr.
   *
   * @param {string}   label  — description of what this FFmpeg job does
   * @param {string[]} args   — the args array passed to spawn('ffmpeg', args)
   * @param {object}   meta   — sceneIndex, inputFile, outputFile, etc.
   * @returns {{ stop: Function }} — call stop(exitCode, errorLog, outputPath)
   */
  startFfmpeg(label, args, meta = {}) {
    const hrStart = process.hrtime.bigint();
    const wallStart = Date.now();

    logger.info(`🎬 [PERF][ffmpeg] START: ${label}`);

    return (exitCode = 0, errorLog = '', outputPath = null) => {
      const hrEnd = process.hrtime.bigint();
      const durationMs = Number(hrEnd - hrStart) / 1_000_000;

      let outputSizeBytes = 0;
      if (outputPath) {
        try { outputSizeBytes = fs.statSync(outputPath).size; } catch (_) {}
      }

      // Try to extract frame count and FPS from the input args
      const durationFlag = (() => {
        const tIdx = args.indexOf('-t');
        return tIdx !== -1 ? parseFloat(args[tIdx + 1]) : null;
      })();
      const estimatedFrames = durationFlag ? Math.round(durationFlag * 30) : null;
      const renderSpeedX = durationFlag && durationMs > 0
        ? (durationFlag / (durationMs / 1000)).toFixed(2)
        : null;
      const avgFps = estimatedFrames && durationMs > 0
        ? (estimatedFrames / (durationMs / 1000)).toFixed(1)
        : null;

      const event = {
        label,
        wallStart,
        wallEnd: Date.now(),
        durationMs: Math.round(durationMs),
        exitCode,
        args,
        outputSizeBytes,
        outputSizeMB: (outputSizeBytes / 1024 / 1024).toFixed(2),
        estimatedFrames,
        avgFps,
        renderSpeedX: renderSpeedX ? `${renderSpeedX}x` : null,
        hasError: exitCode !== 0,
        errorLog: errorLog.slice(-500), // Keep last 500 chars of stderr
        meta,
      };
      this.ffmpegEvents.push(event);
      this.events.push({ category: 'ffmpeg', label, wallStart, wallEnd: Date.now(), durationMs: Math.round(durationMs), meta });

      logger.info(
        `⏱️  [PERF][ffmpeg] END: ${label} — ` +
        `${(durationMs / 1000).toFixed(2)}s | ` +
        `size=${(outputSizeBytes / 1024 / 1024).toFixed(1)}MB | ` +
        `speed=${renderSpeedX ?? 'N/A'}x | ` +
        `fps=${avgFps ?? 'N/A'} | ` +
        `exit=${exitCode}`,
      );
      return durationMs;
    };
  }

  /**
   * Record a semaphore queue event (segment waits, active slots, etc.)
   */
  recordQueueEvent(semaphoreName, type, waiting, active, max) {
    this.queueEvents.push({
      semaphoreName,
      type,       // 'acquire' | 'release' | 'queued'
      waiting,
      active,
      max,
      wallTime: Date.now(),
    });
  }

  /** Track disk bytes written */
  trackWrite(bytes) { this.diskBytesWritten += bytes; this.tempFilesCreated++; }
  /** Track disk bytes read */
  trackRead(bytes) { this.diskBytesRead += bytes; }
  /** Track temp file deletion */
  trackDelete() { this.tempFilesDeleted++; }

  /**
   * Generate and save all reports to temp/{workflowId}/perf-{ts}.json and .txt
   */
  generateReport(outputDir) {
    const totalMs = Number(process.hrtime.bigint() - this.sessionStart) / 1_000_000;

    // ── Summary table ──────────────────────────────────────────────────────────
    const byCategory = {};
    for (const ev of this.events) {
      if (!byCategory[ev.category]) {
        byCategory[ev.category] = { calls: 0, totalMs: 0, maxMs: 0, label: ev.category };
      }
      byCategory[ev.category].calls++;
      byCategory[ev.category].totalMs += ev.durationMs;
      byCategory[ev.category].maxMs = Math.max(byCategory[ev.category].maxMs, ev.durationMs);
    }

    const summaryRows = Object.values(byCategory)
      .map(r => ({
        ...r,
        avgMs: Math.round(r.totalMs / r.calls),
        pct: ((r.totalMs / totalMs) * 100).toFixed(1),
      }))
      .sort((a, b) => b.totalMs - a.totalMs);

    // ── Per-event list ─────────────────────────────────────────────────────────
    const detailedRows = [...this.events]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 30);

    // ── Flame-graph tree ───────────────────────────────────────────────────────
    const flamePct = (ms) => ((ms / totalMs) * 100).toFixed(1);

    // ── Timeline ───────────────────────────────────────────────────────────────
    const timelineWidth = 80;
    const timelineEvents = this.events
      .filter(ev => ev.durationMs > 500) // Only show events > 0.5s
      .sort((a, b) => a.wallStart - b.wallStart);
    const tMin = this.wallStart;
    const tMax = tMin + totalMs;
    const tSpan = tMax - tMin;

    const timelineLines = timelineEvents.map(ev => {
      const startPct = (ev.wallStart - tMin) / tSpan;
      const endPct = (ev.wallStart + ev.durationMs - tMin) / tSpan;
      const startCol = Math.floor(startPct * timelineWidth);
      const endCol = Math.max(startCol + 1, Math.floor(endPct * timelineWidth));
      const bar = ' '.repeat(startCol) + '█'.repeat(endCol - startCol);
      const label = `[${ev.category}] ${ev.label}`.substring(0, 35).padEnd(36);
      const duration = `${(ev.durationMs / 1000).toFixed(1)}s`.padStart(6);
      return `${label} ${duration} |${bar}|`;
    });

    // ── FFmpeg segment report ─────────────────────────────────────────────────
    const segmentRows = this.ffmpegEvents
      .filter(e => e.label.startsWith('Segment'))
      .sort((a, b) => {
        const aIdx = parseInt(a.meta?.sceneIndex ?? 0);
        const bIdx = parseInt(b.meta?.sceneIndex ?? 0);
        return aIdx - bIdx;
      });

    // ── Build text report ──────────────────────────────────────────────────────
    const line = '─'.repeat(100);
    const lines = [
      `PERFORMANCE REPORT — Workflow: ${this.workflowId}`,
      `Generated: ${new Date().toISOString()}`,
      `Total Duration: ${(totalMs / 1000).toFixed(1)}s (${(totalMs / 60000).toFixed(1)} min)`,
      line,
      '',
      '═══ SECTION 1: SUMMARY TABLE (sorted by total time) ═══',
      '',
      'Category'.padEnd(30) + 'Calls'.padStart(7) + 'Total'.padStart(10) + 'Avg'.padStart(8) + 'Max'.padStart(8) + '% Total'.padStart(10),
      '─'.repeat(73),
      ...summaryRows.map(r =>
        r.label.padEnd(30) +
        String(r.calls).padStart(7) +
        `${(r.totalMs / 1000).toFixed(1)}s`.padStart(10) +
        `${(r.avgMs / 1000).toFixed(1)}s`.padStart(8) +
        `${(r.maxMs / 1000).toFixed(1)}s`.padStart(8) +
        `${r.pct}%`.padStart(10)
      ),
      '',
      line,
      '',
      '═══ SECTION 2: TOP 30 SLOWEST INDIVIDUAL OPERATIONS ═══',
      '',
      'Label'.padEnd(50) + 'Category'.padEnd(15) + 'Duration'.padStart(10),
      '─'.repeat(75),
      ...detailedRows.map(ev =>
        ev.label.substring(0, 49).padEnd(50) +
        ev.category.padEnd(15) +
        `${(ev.durationMs / 1000).toFixed(2)}s`.padStart(10)
      ),
      '',
      line,
      '',
      '═══ SECTION 3: EXECUTION TIMELINE (>0.5s events) ═══',
      `Span: ${(totalMs / 1000).toFixed(0)}s total  |← ${' '.repeat(38)}→|`,
      '',
      ...timelineLines,
      '',
      line,
      '',
      '═══ SECTION 4: FFMPEG SEGMENT REPORT ═══',
      '',
      'Scene'.padEnd(8) + 'Duration'.padStart(10) + 'Render'.padStart(10) + 'Speed'.padStart(8) + 'FPS'.padStart(6) + 'SizeMB'.padStart(8) + 'Exit'.padStart(6),
      '─'.repeat(56),
      ...segmentRows.map(ev =>
        `#${ev.meta?.sceneIndex ?? '?'}`.padEnd(8) +
        `${ev.meta?.clipDuration?.toFixed(2) ?? '?'}s`.padStart(10) +
        `${(ev.durationMs / 1000).toFixed(1)}s`.padStart(10) +
        `${ev.renderSpeedX ?? 'N/A'}`.padStart(8) +
        `${ev.avgFps ?? 'N/A'}`.padStart(6) +
        `${ev.outputSizeMB}`.padStart(8) +
        `${ev.exitCode}`.padStart(6)
      ),
      '',
      line,
      '',
      '═══ SECTION 5: FLAME GRAPH ═══',
      '',
      `Total Workflow: ${(totalMs / 1000).toFixed(1)}s (100%)`,
      ...summaryRows.map(r => `  └─ ${r.label}: ${(r.totalMs / 1000).toFixed(1)}s (${r.pct}%)`),
      '',
      line,
      '',
      '═══ SECTION 6: QUEUE METRICS ═══',
      '',
      `Total queue events: ${this.queueEvents.length}`,
      ...(() => {
        const byName = {};
        for (const ev of this.queueEvents) {
          if (!byName[ev.semaphoreName]) byName[ev.semaphoreName] = { maxWaiting: 0, maxActive: 0, events: 0 };
          byName[ev.semaphoreName].maxWaiting = Math.max(byName[ev.semaphoreName].maxWaiting, ev.waiting);
          byName[ev.semaphoreName].maxActive = Math.max(byName[ev.semaphoreName].maxActive, ev.active);
          byName[ev.semaphoreName].events++;
        }
        return Object.entries(byName).map(([name, d]) =>
          `  ${name}: events=${d.events}, peakWaiting=${d.maxWaiting}, peakActive=${d.maxActive}`
        );
      })(),
      '',
      line,
      '',
      '═══ SECTION 7: DISK I/O ═══',
      '',
      `Bytes Written:  ${(this.diskBytesWritten / 1024 / 1024).toFixed(1)} MB`,
      `Bytes Read:     ${(this.diskBytesRead / 1024 / 1024).toFixed(1)} MB`,
      `Files Created:  ${this.tempFilesCreated}`,
      `Files Deleted:  ${this.tempFilesDeleted}`,
      '',
      line,
    ];

    const txtReport = lines.join('\n');

    const jsonReport = {
      workflowId: this.workflowId,
      generatedAt: new Date().toISOString(),
      totalDurationMs: Math.round(totalMs),
      summaryTable: summaryRows,
      events: this.events,
      ffmpegEvents: this.ffmpegEvents,
      queueEvents: this.queueEvents,
      disk: {
        bytesWritten: this.diskBytesWritten,
        bytesRead: this.diskBytesRead,
        filesCreated: this.tempFilesCreated,
        filesDeleted: this.tempFilesDeleted,
      },
    };

    // ── Write to disk ──────────────────────────────────────────────────────────
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      const ts = Date.now();
      const txtPath = path.join(outputDir, `perf-${ts}.txt`);
      const jsonPath = path.join(outputDir, `perf-${ts}.json`);
      fs.writeFileSync(txtPath, txtReport, 'utf8');
      fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');
      logger.info(`📊 [PERF] Report saved → ${txtPath}`);
      logger.info(`📊 [PERF] JSON saved  → ${jsonPath}`);
    } catch (err) {
      logger.error(`[PERF] Failed to write report: ${err.message}`);
    }

    // Also print the summary to the console/log
    logger.info('\n' + lines.slice(0, 30).join('\n'));

    return { txtReport, jsonReport };
  }
}
